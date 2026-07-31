import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

export function serveStatic(res, root, pathname, method = 'GET') {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }
  const rel = decoded === '/' ? '/index.html' : path.posix.normalize(decoded);
  let absolute = path.resolve(root, `.${rel}`);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  if (!existsSync(absolute) || !statSync(absolute).isFile()) {
    absolute = path.join(root, 'index.html');
  }
  if (!existsSync(absolute)) {
    res.writeHead(404).end('Not found');
    return;
  }
  const ext = path.extname(absolute).toLowerCase();
  const immutable = absolute.includes(`${path.sep}assets${path.sep}`);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': immutable
      ? 'public, max-age=31536000, immutable'
      : 'public, max-age=0, must-revalidate',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
  });
  if (method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(absolute).pipe(res);
}
