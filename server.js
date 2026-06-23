const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { URL } = require('url');
const WebSocket = require('ws');

const PORT = Number(process.env.PORT || 8090);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');

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
  const pathname = reqUrl.pathname === '/' ? '/index.html' : decodeURIComponent(reqUrl.pathname);
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

  if (reqUrl.pathname !== '/signal') {
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
