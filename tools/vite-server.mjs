/**
 * Shared dev-server lifecycle for every harness in this directory.
 *
 * These scripts used to spawn `npx vite ...` and call `p.kill()` when done.
 * That leaks: `npx` execs an `npm exec` shell which spawns the real vite as a
 * CHILD, so killing the handle kills the wrapper and orphans the server. The
 * orphan keeps port 5173 bound, and the next `npx vite` — or the user's own
 * `npm run dev` — dies with "Port 5173 is already in use" long after the
 * harness that started it has exited.
 *
 * Two fixes, both needed:
 *   1. spawn the vite binary directly, so the handle IS the server;
 *   2. tear it down on every exit path, including Ctrl-C and uncaught throws,
 *      not just the happy one.
 */
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;

export function portOpen(port, host = '127.0.0.1') {
  return new Promise((res) => {
    const s = createConnection({ port, host });
    s.on('connect', () => { s.destroy(); res(true); });
    s.on('error', () => res(false));
    setTimeout(() => { s.destroy(); res(false); }, 800);
  });
}

/**
 * Returns a handle with `.stop()`. If something is already serving the port we
 * adopt it and `.stop()` is a no-op — never kill a server we did not start,
 * which is usually the developer's own `npm run dev`.
 */
export async function startVite(port, { timeoutMs = 36000 } = {}) {
  if (await portOpen(port)) return { adopted: true, stop() {} };

  const bin = join(root, 'node_modules/.bin/vite');
  if (!existsSync(bin)) throw new Error(`vite binary not found at ${bin} — run npm install`);

  const proc = spawn(bin, ['--port', String(port), '--strictPort'], {
    cwd: root,
    stdio: 'ignore',
    // Own process group, so stop() can take down anything vite itself spawned.
    detached: true,
  });

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    try { process.kill(-proc.pid, 'SIGTERM'); } catch { /* already gone */ }
    try { proc.kill('SIGTERM'); } catch { /* already gone */ }
  };

  // Every exit path, not just the happy one.
  process.once('exit', stop);
  process.once('SIGINT', () => { stop(); process.exit(130); });
  process.once('SIGTERM', () => { stop(); process.exit(143); });
  process.once('uncaughtException', (e) => { stop(); console.error(e); process.exit(1); });
  process.once('unhandledRejection', (e) => { stop(); console.error(e); process.exit(1); });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400));
    if (await portOpen(port)) return { adopted: false, stop };
  }
  stop();
  throw new Error(`vite did not come up on port ${port} within ${timeoutMs}ms`);
}
