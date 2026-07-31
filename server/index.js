import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import {
  INPUT_RATE_LIMIT_PER_S, JWKS_URL, NODE_ENV, PORT, SERVICE_ID,
} from './config.js';
import { safeDiagnosticClaims, validateAccessToken } from './auth.js';
import { Room } from './Room.js';
import { serveStatic } from './static.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIST = path.join(ROOT, 'dist');
const rooms = new Map();
const RATE_BURST = 10;
const MAX_FRAME_BYTES = 8192;
const MAX_PREAUTH_MESSAGES = 8;
const MAX_PREAUTH_BYTES = 64 * 1024;
const AUTH_TIMEOUT_MS = 15_000;

process.on('unhandledRejection', (reason) => {
  console.error('[PROCESS] unhandledRejection', reason);
  setImmediate(() => process.exit(1));
});
process.on('uncaughtException', (err) => {
  console.error('[PROCESS] uncaughtException', err);
  process.exit(1);
});

const server = createServer((req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  if (!['GET', 'HEAD'].includes(req.method || 'GET')) {
    res.writeHead(405).end('Method not allowed');
    return;
  }
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      rooms: rooms.size,
      uptime_s: Math.floor(process.uptime()),
      region: process.env.RAILWAY_REPLICA_REGION || process.env.RAILWAY_REGION || 'local',
    }));
    return;
  }
  serveStatic(res, DIST, url.pathname, req.method);
});

const wss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false,
  maxPayload: MAX_FRAME_BYTES,
});

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url || '/', `http://localhost:${PORT}`);
  if (url.pathname !== '/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
});

function sendError(ws, code, message) {
  if (ws.readyState !== 1) return;
  ws.send(JSON.stringify({ type: 'error', payload: { code, message } }));
}

function takeToken(conn) {
  const now = Date.now();
  conn.tokens = Math.min(
    RATE_BURST,
    conn.tokens + (now - conn.refilledAt) / 1000 * INPUT_RATE_LIMIT_PER_S,
  );
  conn.refilledAt = now;
  if (conn.tokens < 1) return false;
  conn.tokens -= 1;
  return true;
}

wss.on('connection', (ws, request) => {
  const url = new URL(request.url || '/', `http://localhost:${PORT}`);
  const token = url.searchParams.get('token');
  const conn = {
    ws, userId: null, name: null, sessionId: null, room: null, spectator: false,
    lastSeenMs: Date.now(), lastSeq: 0,
    tokens: RATE_BURST, refilledAt: Date.now(), warned: false,
  };
  let authenticated = false;
  const buffered = [];
  let bufferedBytes = 0;
  const authTimer = setTimeout(() => {
    sendError(ws, 'AUTH_TIMEOUT', 'Authentication timed out');
    ws.close();
  }, AUTH_TIMEOUT_MS);
  authTimer.unref?.();

  const route = (message) => {
    const seq = Number(message?.seq);
    if (!Number.isSafeInteger(seq) || seq <= 0) {
      sendError(ws, 'BAD_SEQUENCE', 'seq must be a positive safe integer');
      return;
    }
    if (seq <= conn.lastSeq) return;
    conn.lastSeq = seq;
    conn.room?.handleMessage(conn, message);
  };

  ws.on('message', (bytes, isBinary) => {
    conn.lastSeenMs = Date.now();
    if (isBinary) {
      sendError(ws, 'BAD_MESSAGE', 'Binary frames are not supported');
      ws.close(1003, 'JSON text only');
      return;
    }
    if (!takeToken(conn)) {
      if (conn.warned) ws.close();
      else {
        conn.warned = true;
        sendError(ws, 'RATE_LIMITED', `Maximum ${INPUT_RATE_LIMIT_PER_S} messages/s`);
      }
      return;
    }
    let message;
    try {
      message = JSON.parse(String(bytes));
    } catch {
      sendError(ws, 'BAD_MESSAGE', 'Frames must be JSON');
      return;
    }
    if (!authenticated) {
      bufferedBytes += bytes.length;
      if (buffered.length >= MAX_PREAUTH_MESSAGES || bufferedBytes > MAX_PREAUTH_BYTES) {
        sendError(ws, 'AUTH_PENDING_OVERFLOW', 'Too many messages before authentication');
        ws.close(1009, 'Authentication pending');
        return;
      }
      buffered.push(message);
    } else route(message);
  });
  ws.on('close', () => {
    clearTimeout(authTimer);
    conn.room?.detach(conn);
  });
  ws.on('error', (err) => console.warn('[WS]', err?.message || err));

  if (!token) {
    sendError(ws, 'INVALID_TOKEN', 'Missing access token');
    ws.close();
    return;
  }
  validateAccessToken(token, { jwksUrl: JWKS_URL, serviceId: SERVICE_ID })
    .then((identity) => {
      clearTimeout(authTimer);
      if (ws.readyState !== 1) return;
      conn.userId = identity.sub;
      conn.name = identity.name;
      conn.sessionId = identity.session_id;
      let room = rooms.get(identity.room_id);
      if (!room) {
        room = new Room(identity.room_id, { onDestroy: (id) => rooms.delete(id) });
        rooms.set(identity.room_id, room);
      }
      conn.room = room;
      authenticated = true;
      for (const message of buffered) route(message);
      buffered.length = 0;
    })
    .catch((err) => {
      clearTimeout(authTimer);
      console.warn('[AUTH] rejected', err?.message || err, safeDiagnosticClaims(token));
      sendError(ws, 'INVALID_TOKEN', 'Token validation failed');
      ws.close();
    });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[KART-ROYALE] :${PORT} env=${NODE_ENV} service=${SERVICE_ID} jwks=${JWKS_URL}`);
});
