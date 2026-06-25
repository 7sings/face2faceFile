const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { URL } = require('url');
const WebSocket = require('ws');

loadEnvFile();

const PORT = Number(process.env.PORT || 8090);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const METERED_TURN_URL = 'https://rockwu.metered.live/api/v1/turn/credentials';
const TURN_CACHE_MS = 60 * 1000;
const TURN_FETCH_TIMEOUT_MS = 5000;

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

const rooms = new Map();

const server = http.createServer((req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const rawPathname = reqUrl.pathname;

  if (rawPathname === '/api/turn-credentials') {
    handleTurnCredentials(req, res);
    return;
  }

  const pathname = rawPathname === '/' ? '/index.html' : decodeURIComponent(rawPathname);
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': mimeTypes[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
});

const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (reqUrl.pathname !== '/signal' || !isAllowedSameOriginRequest(req)) {
    socket.destroy();
    return;
  }

  const roomId = normalizeToken(reqUrl.searchParams.get('room'));
  const peerId = normalizeToken(reqUrl.searchParams.get('peer'));

  if (!roomId || !peerId) {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req, { roomId, peerId });
  });
});

wss.on('connection', (ws, _req, { roomId, peerId }) => {
  ws.roomId = roomId;
  ws.peerId = peerId;
  ws.isAlive = true;

  const peers = getRoom(roomId);
  const oldPeer = peers.get(peerId);
  if (oldPeer && oldPeer.readyState === WebSocket.OPEN) {
    oldPeer.close(4000, 'same peer reconnected');
  }

  peers.set(peerId, ws);

  send(ws, {
    type: 'welcome',
    roomId,
    peerId,
    peers: [...peers.keys()].filter((id) => id !== peerId),
  });

  broadcast(roomId, { type: 'peer-joined', peerId }, peerId);

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw) => {
    const message = parseSignal(raw);
    if (!message) return;

    if (message.type === 'ping') {
      send(ws, { type: 'pong', now: Date.now() });
      return;
    }

    const allowedTypes = new Set(['ready', 'offer', 'answer', 'candidate']);
    if (!allowedTypes.has(message.type)) return;

    const target = normalizeToken(message.to);
    if (target) {
      const targetPeer = peers.get(target);
      if (targetPeer) {
        send(targetPeer, { ...message, from: peerId, to: target });
      }
      return;
    }

    broadcast(roomId, { ...message, from: peerId }, peerId);
  });

  ws.on('close', () => {
    const currentRoom = rooms.get(roomId);
    if (!currentRoom) return;

    if (currentRoom.get(peerId) === ws) {
      currentRoom.delete(peerId);
      broadcast(roomId, { type: 'peer-left', peerId }, peerId);
    }

    if (currentRoom.size === 0) {
      rooms.delete(roomId);
    }
  });
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, HOST, () => {
  console.log('面对面快传已启动');
  console.log(`本机访问: http://localhost:${PORT}`);
  for (const ip of getLocalIPv4List()) {
    console.log(`局域网访问: http://${ip}:${PORT}`);
  }
  console.log('让两台设备连接同一个 Wi-Fi，并用上面的局域网地址打开页面。');
});

function loadEnvFile() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;

  try {
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const equalIndex = trimmed.indexOf('=');
      if (equalIndex <= 0) continue;

      const key = trimmed.slice(0, equalIndex).trim();
      let value = trimmed.slice(equalIndex + 1).trim();
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key) || process.env[key] !== undefined) continue;
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  } catch (error) {
    console.warn(`读取 .env 失败：${error.message}`);
  }
}

function handleTurnCredentials(req, res) {
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET' });
    return;
  }

  if (!isAllowedSameOriginRequest(req)) {
    sendJson(res, 403, { error: 'forbidden' });
    return;
  }

  getTurnCredentials()
    .then((payload) => sendJson(res, 200, payload))
    .catch((error) => {
      const status = error.status || 502;
      const code = error.code || 'upstream_error';
      if (status >= 500) {
        console.warn(`TURN 凭证获取失败：${code}`);
      }
      sendJson(res, status, { error: code });
    });
}

function sendJson(res, status, payload, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    Vary: 'Origin, Host',
    ...headers,
  });
  res.end(JSON.stringify(payload));
}

const turnCache = {
  payload: null,
  expiresAt: 0,
  inFlight: null,
};

function getTurnCredentials() {
  const now = Date.now();
  if (turnCache.payload && turnCache.expiresAt > now) {
    return Promise.resolve(turnCache.payload);
  }
  if (turnCache.inFlight) {
    return turnCache.inFlight;
  }

  turnCache.inFlight = fetchMeteredIceServers()
    .then((iceServers) => {
      const expiresAt = Date.now() + TURN_CACHE_MS;
      const payload = { iceServers, expiresAt: new Date(expiresAt).toISOString() };
      turnCache.payload = payload;
      turnCache.expiresAt = expiresAt;
      return payload;
    })
    .finally(() => {
      turnCache.inFlight = null;
    });

  return turnCache.inFlight;
}

async function fetchMeteredIceServers() {
  const apiKey = process.env.METERED_API_KEY;
  if (!apiKey) {
    throw createHttpError(500, 'server_not_configured');
  }

  const url = new URL(METERED_TURN_URL);
  url.searchParams.set('apiKey', apiKey);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TURN_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw createHttpError(502, 'upstream_error');
    }

    const body = await response.text();
    if (body.length > 64 * 1024) {
      throw createHttpError(502, 'upstream_invalid_response');
    }

    return normalizeMeteredIceServers(JSON.parse(body));
  } catch (error) {
    if (error.name === 'AbortError') {
      throw createHttpError(504, 'upstream_timeout');
    }
    if (error.status) throw error;
    throw createHttpError(502, 'upstream_invalid_response');
  } finally {
    clearTimeout(timer);
  }
}

function normalizeMeteredIceServers(raw) {
  const source = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.iceServers)
      ? raw.iceServers
      : [];

  const iceServers = source
    .slice(0, 10)
    .map(normalizeIceServer)
    .filter(Boolean);

  if (!iceServers.length) {
    throw createHttpError(502, 'upstream_invalid_response');
  }

  return iceServers;
}

function normalizeIceServer(item) {
  if (!item || typeof item !== 'object') return null;

  const rawUrls = Array.isArray(item.urls) ? item.urls : [item.urls || item.url];
  const urls = rawUrls
    .filter((url) => typeof url === 'string')
    .map((url) => url.trim())
    .filter((url) => url && url.length <= 1024 && /^(stun|stuns|turn|turns):/i.test(url));

  if (!urls.length) return null;

  const username = typeof item.username === 'string' ? item.username : '';
  const credentialSource = item.credential ?? item.password;
  const credential = typeof credentialSource === 'string' ? credentialSource : '';
  if (Boolean(username) !== Boolean(credential)) return null;

  const server = { urls: urls.length === 1 ? urls[0] : urls };
  if (username) {
    server.username = username;
    server.credential = credential;
  }
  return server;
}

function createHttpError(status, code) {
  const error = new Error(code);
  error.status = status;
  error.code = code;
  return error;
}

function isAllowedSameOriginRequest(req) {
  const fetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (fetchSite === 'cross-site') return false;

  const requestHost = normalizeHost(req.headers.host);
  if (!requestHost) return false;

  const allowedHosts = getAllowedHosts();
  if (allowedHosts.size && !allowedHosts.has(requestHost)) return false;

  const origin = req.headers.origin;
  if (origin && !isAllowedUrlOrigin(origin, allowedHosts, requestHost)) return false;

  const referer = req.headers.referer;
  if (!origin && referer && !isAllowedUrlOrigin(referer, allowedHosts, requestHost)) return false;

  return true;
}

function isAllowedUrlOrigin(value, allowedHosts, requestHost) {
  try {
    const originHost = normalizeHost(new URL(value).host);
    if (!originHost) return false;
    return allowedHosts.size ? allowedHosts.has(originHost) : originHost === requestHost;
  } catch {
    return false;
  }
}

function getAllowedHosts() {
  const hosts = new Set();
  for (const origin of splitEnvList(process.env.APP_ORIGIN)) {
    const host = normalizeHostFromOrigin(origin);
    if (host) hosts.add(host);
  }
  for (const host of splitEnvList(process.env.ALLOWED_HOSTS)) {
    const normalized = normalizeHost(host);
    if (normalized) hosts.add(normalized);
  }
  return hosts;
}

function splitEnvList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeHostFromOrigin(value) {
  try {
    return normalizeHost(new URL(value).host);
  } catch {
    return normalizeHost(value);
  }
}

function normalizeHost(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '');
}

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, new Map());
  }
  return rooms.get(roomId);
}

function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function broadcast(roomId, data, exceptPeerId) {
  const peers = rooms.get(roomId);
  if (!peers) return;

  for (const [peerId, peer] of peers) {
    if (peerId !== exceptPeerId) {
      send(peer, data);
    }
  }
}

function parseSignal(raw) {
  try {
    const message = JSON.parse(raw.toString());
    return message && typeof message === 'object' ? message : null;
  } catch {
    return null;
  }
}

function normalizeToken(value) {
  if (typeof value !== 'string') return '';
  const token = value.trim();
  return /^[a-zA-Z0-9_-]{4,80}$/.test(token) ? token : '';
}

function getLocalIPv4List() {
  const ips = [];
  const interfaces = os.networkInterfaces();

  for (const addresses of Object.values(interfaces)) {
    for (const address of addresses || []) {
      if (address.family === 'IPv4' && !address.internal) {
        ips.push(address.address);
      }
    }
  }

  return ips.length ? ips : ['本机局域网 IP'];
}

let isShuttingDown = false;

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log('正在关闭面对面快传服务...');
  clearInterval(heartbeat);

  for (const ws of wss.clients) {
    ws.close(1001, 'server shutdown');
  }

  wss.close(() => {
    server.close(() => process.exit(0));
  });

  setTimeout(() => process.exit(0), 1000).unref();
}
