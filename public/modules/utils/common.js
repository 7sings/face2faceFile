export function getRoomFromUrl() {
  const url = new URL(window.location.href);
  return normalizeRoomCode(url.searchParams.get('room'));
}

export function normalizeRoomCode(value) {
  if (!value) return '';
  const room = String(value).trim().toUpperCase();
  return /^[A-Z0-9_-]{4,20}$/.test(room) ? room : '';
}

export function createRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 6 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
}

export function createPeerId() {
  const storageKey = 'face2face-file-transfer-peer-id';
  const storedPeerId = readStorageValue(storageKey);
  if (/^peer_\d+_\d+$/.test(storedPeerId)) return storedPeerId;

  const peerId = `peer_${crypto.getRandomValues(new Uint32Array(2)).join('_')}`;
  writeStorageValue(storageKey, peerId);
  return peerId;
}

function readStorageValue(key) {
  try {
    return window.localStorage.getItem(key) || '';
  } catch {
    return '';
  }
}

function writeStorageValue(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {}
}

export function createTaskId() {
  return `file_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

export function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export function createTransferStats() {
  return {
    startedAt: Date.now(),
    speedBps: 0,
  };
}

export function updateTransferStats(task, transferredBytes) {
  const elapsedSeconds = (Date.now() - task.transferStats.startedAt) / 1000;
  if (transferredBytes <= 0 || elapsedSeconds < 1) return;

  const averageSpeed = transferredBytes / elapsedSeconds;
  if (!Number.isFinite(averageSpeed) || averageSpeed <= 0) return;

  task.transferStats.speedBps = task.transferStats.speedBps
    ? task.transferStats.speedBps * 0.7 + averageSpeed * 0.3
    : averageSpeed;
}

export function buildTransferMeta(task, transferredBytes, totalBytes) {
  const transferred = Math.max(0, Number(transferredBytes) || 0);
  const total = Math.max(0, Number(totalBytes) || 0);
  const sizeText = `${formatBytes(transferred)} / ${formatBytes(total)}`;
  const speed = task.transferStats?.speedBps || 0;

  if (!total || transferred <= 0 || !Number.isFinite(speed) || speed <= 0) {
    return `${sizeText} · 估算中`;
  }

  const remainingSeconds = (total - transferred) / speed;
  const etaText = formatDuration(remainingSeconds);
  if (!etaText) {
    return `${sizeText} · ${formatBytes(speed)}/s · 估算中`;
  }

  return `${sizeText} · ${formatBytes(speed)}/s · 剩余 ${etaText}`;
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';

  const safeSeconds = Math.max(1, Math.ceil(seconds));
  if (safeSeconds < 60) return `${safeSeconds} 秒`;

  const minutes = Math.floor(safeSeconds / 60);
  const restSeconds = safeSeconds % 60;
  if (minutes < 60) return `${minutes} 分 ${String(restSeconds).padStart(2, '0')} 秒`;

  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return `${hours} 小时 ${String(restMinutes).padStart(2, '0')} 分`;
}

export function isImageFile(file) {
  return Boolean(file?.mime?.startsWith('image/'));
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
  })[char]);
}

export function getFileBadge(mime) {
  if (mime.startsWith('image/')) return 'IMG';
  if (mime.startsWith('video/')) return 'VID';
  if (mime.startsWith('audio/')) return 'AUD';
  if (mime.includes('pdf')) return 'PDF';
  if (mime.includes('zip') || mime.includes('compressed')) return 'ZIP';
  if (mime.includes('text')) return 'TXT';
  return 'FILE';
}

export function sanitizeFileName(name) {
  return String(name || '未命名文件').replace(/[\\/:*?"<>|]/g, '_');
}

export function createUniqueFileName(name, usedNames) {
  const count = usedNames.get(name) || 0;
  usedNames.set(name, count + 1);
  if (count === 0) return name;

  return appendFileNameSuffix(name, count + 1);
}

export function appendFileNameSuffix(name, suffix) {
  const dotIndex = name.lastIndexOf('.');
  if (dotIndex <= 0) return `${name}-${suffix}`;
  return `${name.slice(0, dotIndex)}-${suffix}${name.slice(dotIndex)}`;
}

export function formatDateForFileName(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export async function toArrayBuffer(chunk) {
  if (chunk instanceof ArrayBuffer) return chunk;
  if (chunk instanceof Blob) return chunk.arrayBuffer();
  if (ArrayBuffer.isView(chunk)) {
    return chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
  }
  return chunk.buffer;
}
