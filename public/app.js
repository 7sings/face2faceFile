const CHUNK_SIZE = 64 * 1024;
const BUFFER_HIGH_WATER = 8 * 1024 * 1024;

const elements = {
  connectionState: document.querySelector('#connectionState'),
  roomCode: document.querySelector('#roomCode'),
  shareLink: document.querySelector('#shareLink'),
  copyLinkBtn: document.querySelector('#copyLinkBtn'),
  joinForm: document.querySelector('#joinForm'),
  joinRoomInput: document.querySelector('#joinRoomInput'),
  resetRoomBtn: document.querySelector('#resetRoomBtn'),
  signalStatus: document.querySelector('#signalStatus'),
  peerStatus: document.querySelector('#peerStatus'),
  channelStatus: document.querySelector('#channelStatus'),
  peerHint: document.querySelector('#peerHint'),
  dropZone: document.querySelector('#dropZone'),
  fileInput: document.querySelector('#fileInput'),
  sendList: document.querySelector('#sendList'),
  receiveList: document.querySelector('#receiveList'),
  selectAllFiles: document.querySelector('#selectAllFiles'),
  downloadSelectedBtn: document.querySelector('#downloadSelectedBtn'),
  saveImagesBtn: document.querySelector('#saveImagesBtn'),
  downloadZipBtn: document.querySelector('#downloadZipBtn'),
  clearLogBtn: document.querySelector('#clearLogBtn'),
  logList: document.querySelector('#logList'),
};

const state = {
  roomId: getRoomFromUrl() || createRoomCode(),
  peerId: createPeerId(),
  socket: null,
  remotePeerId: '',
  connection: null,
  channel: null,
  signalHeartbeat: null,
  signalReconnectTimer: null,
  receiveTasks: new Map(),
  sendTasks: new Map(),
  completedFiles: new Map(),
  selectedFileIds: new Set(),
  sendQueue: [],
  isSending: false,
};

init();

function init() {
  updateRoomUrl(state.roomId);
  renderRoomInfo();
  bindEvents();
  updateBatchActions();
  connectSignal();
}

function bindEvents() {
  elements.copyLinkBtn.addEventListener('click', copyShareLink);
  elements.resetRoomBtn.addEventListener('click', () => {
    window.location.href = `${window.location.pathname}?room=${createRoomCode()}`;
  });

  elements.joinForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const nextRoom = normalizeRoomCode(elements.joinRoomInput.value);
    if (!nextRoom) {
      log('请输入有效房间码');
      return;
    }
    window.location.href = `${window.location.pathname}?room=${nextRoom}`;
  });

  elements.fileInput.addEventListener('change', () => {
    sendFiles([...elements.fileInput.files]);
    elements.fileInput.value = '';
  });

  ['dragenter', 'dragover'].forEach((eventName) => {
    elements.dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      elements.dropZone.classList.add('drag-over');
    });
  });

  ['dragleave', 'drop'].forEach((eventName) => {
    elements.dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      elements.dropZone.classList.remove('drag-over');
    });
  });

  elements.dropZone.addEventListener('drop', (event) => {
    sendFiles([...event.dataTransfer.files]);
  });

  elements.selectAllFiles.addEventListener('change', () => {
    setAllReceivedSelection(elements.selectAllFiles.checked);
  });

  elements.downloadSelectedBtn.addEventListener('click', downloadSelectedFilesDirectly);
  elements.saveImagesBtn.addEventListener('click', saveSelectedImagesToAlbum);
  elements.downloadZipBtn.addEventListener('click', downloadSelectedFilesAsZip);

  elements.clearLogBtn.addEventListener('click', () => {
    elements.logList.innerHTML = '';
  });
}

function connectSignal({ preservePeer = false } = {}) {
  if (state.socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(state.socket.readyState)) return;

  if (!preservePeer) {
    closePeerConnection();
  }

  clearSignalHeartbeat();
  clearTimeout(state.signalReconnectTimer);
  updateSignalStatus('连接中');
  if (!isChannelReady()) {
    updateConnectionPill('连接信令中', 'pending');
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${protocol}//${window.location.host}/signal?room=${encodeURIComponent(state.roomId)}&peer=${encodeURIComponent(state.peerId)}`;
  state.socket = new WebSocket(url);

  state.socket.addEventListener('open', () => {
    updateSignalStatus('已连接');
    if (!isChannelReady()) {
      updateConnectionPill('等待对端', 'pending');
    }
    startSignalHeartbeat();
    log('信令服务已连接');
  });

  state.socket.addEventListener('message', async (event) => {
    const message = parseJson(event.data);
    if (!message) return;
    await handleSignal(message);
  });

  state.socket.addEventListener('close', () => {
    clearSignalHeartbeat();
    updateSignalStatus('重连中');

    if (isChannelReady()) {
      elements.peerHint.textContent = '文件通道仍可用，正在后台重连信令服务。';
      log('信令连接已断开，正在后台重连；已建立的文件通道不受影响');
    } else {
      updatePeerStatus('未发现');
      updateChannelStatus('未建立');
      updateConnectionPill('信令重连中', 'pending');
      log('信令连接已断开，正在重连');
    }

    state.signalReconnectTimer = setTimeout(() => connectSignal({ preservePeer: true }), 1500);
  });

  state.socket.addEventListener('error', () => {
    updateSignalStatus('连接异常');
    if (!isChannelReady()) {
      updateConnectionPill('信令异常', 'error');
    }
  });
}

async function handleSignal(message) {
  if (message.type === 'pong') return;

  if (message.type === 'welcome') {
    if (message.peers.length) {
      state.remotePeerId = message.peers[0];
      if (hasActivePeerConnection()) {
        updatePeerStatus('已直连');
        return;
      }
      updatePeerStatus('已发现');
      elements.peerHint.textContent = '发现对端，正在建立直连通道。';
      await startAsOfferer();
    }
    return;
  }

  if (message.type === 'peer-joined') {
    state.remotePeerId = message.peerId;
    if (hasActivePeerConnection()) return;

    updatePeerStatus('已发现');
    elements.peerHint.textContent = '对端已加入，等待对端发起直连。';
    log('对端已加入房间');
    ensurePeerConnection(false);
    return;
  }

  if (message.type === 'peer-left') {
    if (message.peerId === state.remotePeerId) {
      log('对端已离开房间');
      state.remotePeerId = '';
      updatePeerStatus('已离开');
      updateChannelStatus('未建立');
      updateConnectionPill('等待对端', 'pending');
      closePeerConnection();
    }
    return;
  }

  if (message.from && !state.remotePeerId) {
    state.remotePeerId = message.from;
  }

  if (message.type === 'offer') {
    resetStalePeerConnection();
    const pc = ensurePeerConnection(false);
    await pc.setRemoteDescription(message.description);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    sendSignal({ type: 'answer', to: message.from, description: pc.localDescription });
    log('已响应直连请求');
    return;
  }

  if (message.type === 'answer') {
    if (state.connection) {
      await state.connection.setRemoteDescription(message.description);
      log('对端已接受直连请求');
    }
    return;
  }

  if (message.type === 'candidate' && message.candidate && state.connection) {
    try {
      await state.connection.addIceCandidate(message.candidate);
    } catch (error) {
      log(`添加网络候选失败：${error.message}`);
    }
  }
}

async function startAsOfferer() {
  resetStalePeerConnection();
  const pc = ensurePeerConnection(true);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  sendSignal({ type: 'offer', to: state.remotePeerId, description: pc.localDescription });
  log('已发起直连请求');
}

function ensurePeerConnection(isOfferer) {
  if (state.connection) return state.connection;

  const pc = new RTCPeerConnection({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
    ],
  });
  state.connection = pc;

  pc.addEventListener('icecandidate', (event) => {
    if (event.candidate && state.remotePeerId) {
      sendSignal({ type: 'candidate', to: state.remotePeerId, candidate: event.candidate });
    }
  });

  pc.addEventListener('connectionstatechange', () => {
    const statusMap = {
      new: '准备中',
      connecting: '连接中',
      connected: '已直连',
      disconnected: '已断开',
      failed: '连接失败',
      closed: '已关闭',
    };
    updatePeerStatus(statusMap[pc.connectionState] || pc.connectionState);
    if (pc.connectionState === 'connected') {
      updateConnectionPill('已直连', 'ok');
      elements.peerHint.textContent = '直连成功，可以开始发送文件。';
    }
    if (pc.connectionState === 'failed') {
      updateConnectionPill('直连失败', 'error');
      log('直连失败：请确认两台设备在同一局域网，且浏览器支持 WebRTC');
    }
  });

  pc.addEventListener('datachannel', (event) => {
    setupDataChannel(event.channel);
  });

  if (isOfferer) {
    const channel = pc.createDataChannel('file-transfer', { ordered: true });
    setupDataChannel(channel);
  }

  return pc;
}

function setupDataChannel(channel) {
  state.channel = channel;
  channel.binaryType = 'arraybuffer';
  channel.bufferedAmountLowThreshold = BUFFER_HIGH_WATER / 2;

  channel.addEventListener('open', () => {
    updateChannelStatus('已就绪');
    updateConnectionPill('可以传文件', 'ok');
    elements.dropZone.classList.add('enabled');
    log('文件传输通道已建立');
    processSendQueue();
  });

  channel.addEventListener('close', () => {
    updateChannelStatus('已关闭');
    elements.dropZone.classList.remove('enabled');
    log('文件传输通道已关闭');
  });

  channel.addEventListener('error', () => {
    updateChannelStatus('异常');
    log('文件传输通道异常');
  });

  channel.addEventListener('message', handleDataMessage);
}

function sendFiles(files) {
  const validFiles = files.filter(Boolean);
  if (!validFiles.length) return;

  state.sendQueue.push(...validFiles);
  log(`已加入发送队列：${validFiles.length} 个文件`);

  if (!isChannelReady()) {
    log('请等待直连通道建立后自动发送');
    return;
  }

  processSendQueue();
}

async function processSendQueue() {
  if (state.isSending || !isChannelReady()) return;
  state.isSending = true;

  while (state.sendQueue.length && isChannelReady()) {
    const file = state.sendQueue.shift();
    await sendFile(file);
  }

  state.isSending = false;
}

async function sendFile(file) {
  const fileId = createTaskId();
  const thumbnailUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : '';
  const task = createTransferItem(elements.sendList, {
    id: fileId,
    name: file.name,
    meta: `${formatBytes(file.size)} · 等待发送`,
    mime: file.type,
    thumbnailUrl,
  });

  state.sendTasks.set(fileId, task);
  sendData({ type: 'file-meta', id: fileId, name: file.name, size: file.size, mime: file.type });

  let offset = 0;
  while (offset < file.size) {
    const chunk = await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer();
    await waitForBuffer();
    sendData(chunk);
    offset += chunk.byteLength;
    updateTransferItem(task, offset / file.size, `${formatBytes(offset)} / ${formatBytes(file.size)}`);
  }

  sendData({ type: 'file-end', id: fileId });
  updateTransferItem(task, 1, `${formatBytes(file.size)} · 已发送`);
  log(`已发送：${file.name}`);
}

function handleDataMessage(event) {
  if (typeof event.data === 'string') {
    const message = parseJson(event.data);
    if (!message) return;
    handleControlMessage(message);
    return;
  }

  handleFileChunk(event.data);
}

function handleControlMessage(message) {
  if (message.type === 'file-meta') {
    const task = createTransferItem(elements.receiveList, {
      id: message.id,
      name: message.name,
      meta: `${formatBytes(message.size)} · 接收中`,
      mime: message.mime,
      selectable: true,
      disabledSelection: true,
    });

    state.receiveTasks.set(message.id, {
      id: message.id,
      name: message.name || '未命名文件',
      size: Number(message.size) || 0,
      mime: message.mime || 'application/octet-stream',
      chunks: [],
      received: 0,
      element: task,
    });
    log(`开始接收：${message.name}`);
    return;
  }

  if (message.type === 'file-end') {
    finishReceive(message.id);
  }
}

function handleFileChunk(chunk) {
  const task = [...state.receiveTasks.values()].find((item) => item.received < item.size);
  if (!task) return;

  const buffer = chunk instanceof ArrayBuffer ? chunk : chunk.buffer;
  task.chunks.push(buffer);
  task.received += buffer.byteLength;
  updateTransferItem(task.element, task.size ? task.received / task.size : 0, `${formatBytes(task.received)} / ${formatBytes(task.size)}`);
}

function finishReceive(fileId) {
  const task = state.receiveTasks.get(fileId);
  if (!task) return;

  const blob = new Blob(task.chunks, { type: task.mime });
  const url = URL.createObjectURL(blob);
  const safeName = sanitizeFileName(task.name || `received-${Date.now()}`);

  state.completedFiles.set(fileId, {
    id: fileId,
    name: safeName,
    mime: task.mime,
    blob,
    url,
  });

  updateTransferItem(task.element, 1, `${formatBytes(blob.size)} · 已接收`);
  setTransferThumbnail(task.element, { mime: task.mime, thumbnailUrl: task.mime.startsWith('image/') ? url : '' });
  enableTransferSelection(task.element, fileId);

  const action = document.createElement('a');
  action.href = url;
  action.download = safeName;
  action.className = 'download-link';
  action.textContent = '下载';
  task.element.append(action);

  state.receiveTasks.delete(fileId);
  if (isImageFile(state.completedFiles.get(fileId))) {
    const saveAction = document.createElement('button');
    saveAction.type = 'button';
    saveAction.className = 'album-link';
    saveAction.textContent = '保存到相册';
    saveAction.addEventListener('click', () => saveImagesToAlbum([state.completedFiles.get(fileId)]));
    task.element.append(saveAction);
  }

  updateBatchActions();
  log(`已接收：${safeName}`);
}

function createTransferItem(container, file) {
  if (container.classList.contains('empty-list')) {
    container.classList.remove('empty-list');
    container.innerHTML = '';
  }

  const item = document.createElement('div');
  item.className = `transfer-item${file.selectable ? ' is-selectable' : ''}`;
  item.dataset.id = file.id;
  item.innerHTML = `
    ${file.selectable ? '<label class="file-select"><input class="file-checkbox" type="checkbox" disabled /></label>' : ''}
    <div class="file-thumb"></div>
    <div class="transfer-info">
      <strong></strong>
      <span></span>
    </div>
    <div class="progress-track"><div class="progress-bar"></div></div>
  `;
  item.querySelector('strong').textContent = file.name;
  item.querySelector('span').textContent = file.meta;
  setTransferThumbnail(item, file);
  container.prepend(item);
  return item;
}

function updateTransferItem(item, progress, meta) {
  item.querySelector('.progress-bar').style.width = `${Math.max(0, Math.min(1, progress)) * 100}%`;
  item.querySelector('span').textContent = meta;
}

function setTransferThumbnail(item, file) {
  const thumb = item.querySelector('.file-thumb');
  thumb.innerHTML = '';

  if (file.thumbnailUrl) {
    const image = document.createElement('img');
    image.src = file.thumbnailUrl;
    image.alt = '';
    thumb.append(image);
    return;
  }

  const badge = document.createElement('span');
  badge.textContent = getFileBadge(file.mime || '');
  thumb.append(badge);
}

function enableTransferSelection(item, fileId) {
  const checkbox = item.querySelector('.file-checkbox');
  if (!checkbox) return;

  checkbox.disabled = false;
  checkbox.checked = state.selectedFileIds.has(fileId);
  checkbox.addEventListener('change', () => {
    if (checkbox.checked) {
      state.selectedFileIds.add(fileId);
    } else {
      state.selectedFileIds.delete(fileId);
    }
    updateBatchActions();
  });
}

function setAllReceivedSelection(checked) {
  for (const fileId of state.completedFiles.keys()) {
    if (checked) {
      state.selectedFileIds.add(fileId);
    } else {
      state.selectedFileIds.delete(fileId);
    }
  }

  elements.receiveList.querySelectorAll('.transfer-item').forEach((item) => {
    const checkbox = item.querySelector('.file-checkbox');
    if (checkbox && !checkbox.disabled) {
      checkbox.checked = checked;
    }
  });

  updateBatchActions();
}

function updateBatchActions() {
  const total = state.completedFiles.size;
  const selected = getSelectedCompletedFiles().length;

  elements.selectAllFiles.disabled = total === 0;
  elements.selectAllFiles.checked = total > 0 && selected === total;
  elements.selectAllFiles.indeterminate = selected > 0 && selected < total;
  elements.downloadSelectedBtn.disabled = selected === 0;
  elements.saveImagesBtn.disabled = selected === 0;
  elements.downloadZipBtn.disabled = selected === 0;
}

function getSelectedCompletedFiles() {
  return [...state.selectedFileIds]
    .map((fileId) => state.completedFiles.get(fileId))
    .filter(Boolean);
}

function downloadSelectedFilesDirectly() {
  const files = getSelectedCompletedFiles();
  if (!files.length) return;

  files.forEach((file, index) => {
    setTimeout(() => triggerDownload(file.url, file.name), index * 250);
  });
  log(`开始直接下载：${files.length} 个文件`);
}

function saveSelectedImagesToAlbum() {
  const files = getSelectedCompletedFiles();
  if (!files.length) return;

  const nonImages = files.filter((file) => !isImageFile(file));
  if (nonImages.length) {
    log(`保存到相册只支持图片，请取消勾选：${nonImages.map((file) => file.name).join('、')}`);
    return;
  }

  saveImagesToAlbum(files);
}

async function saveImagesToAlbum(files) {
  const images = files.filter(isImageFile);
  if (!images.length) {
    log('保存到相册只支持图片文件');
    return;
  }

  const shareFiles = images.map((file) => new File([file.blob], file.name, { type: file.mime }));

  if (navigator.canShare?.({ files: shareFiles }) && navigator.share) {
    try {
      await navigator.share({ files: shareFiles, title: '保存图片' });
      log(`已调起系统面板：${images.length} 张图片`);
      return;
    } catch (error) {
      if (error.name === 'AbortError') {
        log('已取消保存图片');
        return;
      }
      log(`调起系统面板失败：${error.message}`);
    }
  }

  if (images.length === 1) {
    openImagePreview(images[0]);
    log('当前浏览器不支持直接保存到相册，请在新页面长按图片保存');
    return;
  }

  log('当前浏览器不支持批量保存到相册，请单张点击“保存到相册”或使用直接下载');
}

function openImagePreview(file) {
  const preview = window.open('', '_blank');
  if (!preview) {
    window.open(file.url, '_blank');
    return;
  }

  preview.document.write(`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(file.name)}</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0f172a; color: white; font-family: -apple-system, BlinkMacSystemFont, sans-serif; }
    main { width: min(100% - 24px, 900px); text-align: center; }
    img { max-width: 100%; max-height: 82vh; border-radius: 16px; background: white; }
    p { color: #cbd5e1; }
  </style>
</head>
<body>
  <main>
    <img src="${file.url}" alt="${escapeHtml(file.name)}" />
    <p>如果没有出现系统保存面板，请长按图片选择“保存到照片”。</p>
  </main>
</body>
</html>`);
  preview.document.close();
}

async function downloadSelectedFilesAsZip() {
  const files = getSelectedCompletedFiles();
  if (!files.length) return;

  elements.downloadZipBtn.disabled = true;
  elements.downloadZipBtn.textContent = '打包中...';

  try {
    const zipBlob = await createZipBlob(files);
    const zipUrl = URL.createObjectURL(zipBlob);
    triggerDownload(zipUrl, `face2face-files-${formatDateForFileName(new Date())}.zip`);
    setTimeout(() => URL.revokeObjectURL(zipUrl), 60000);
    log(`已生成 ZIP：${files.length} 个文件`);
  } finally {
    elements.downloadZipBtn.textContent = '下载 ZIP';
    updateBatchActions();
  }
}

async function createZipBlob(files) {
  const encoder = new TextEncoder();
  const chunks = [];
  const centralDirectory = [];
  const usedNames = new Map();
  let offset = 0;

  for (const file of files) {
    const name = createUniqueFileName(sanitizeFileName(file.name), usedNames);
    const nameBytes = encoder.encode(name);
    const data = new Uint8Array(await file.blob.arrayBuffer());
    const crc = crc32(data);
    const { time, date } = getDosDateTime(new Date());

    const localHeader = [
      u32(0x04034b50),
      u16(20),
      u16(0x0800),
      u16(0),
      u16(time),
      u16(date),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(nameBytes.length),
      u16(0),
      nameBytes,
    ];

    const localHeaderSize = localHeader.reduce((sum, item) => sum + item.byteLength, 0);
    chunks.push(...localHeader, data);

    centralDirectory.push(
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(0x0800),
      u16(0),
      u16(time),
      u16(date),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(nameBytes.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      nameBytes,
    );

    offset += localHeaderSize + data.length;
  }

  const centralOffset = offset;
  const centralSize = centralDirectory.reduce((sum, item) => sum + item.byteLength, 0);
  const endOfCentralDirectory = [
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(centralSize),
    u32(centralOffset),
    u16(0),
  ];

  return new Blob([...chunks, ...centralDirectory, ...endOfCentralDirectory], { type: 'application/zip' });
}

function startSignalHeartbeat() {
  clearSignalHeartbeat();
  state.signalHeartbeat = setInterval(() => {
    sendSignal({ type: 'ping', now: Date.now() });
  }, 15000);
}

function clearSignalHeartbeat() {
  if (!state.signalHeartbeat) return;
  clearInterval(state.signalHeartbeat);
  state.signalHeartbeat = null;
}

function hasActivePeerConnection() {
  return state.connection?.connectionState === 'connected' || isChannelReady();
}

function resetStalePeerConnection() {
  if (!state.connection || hasActivePeerConnection()) return;

  state.channel?.close();
  state.connection.close();
  state.channel = null;
  state.connection = null;
  updateChannelStatus('重新建链中');
}

function waitForBuffer() {
  if (!state.channel || state.channel.bufferedAmount < BUFFER_HIGH_WATER) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const handleLow = () => {
      state.channel.removeEventListener('bufferedamountlow', handleLow);
      resolve();
    };
    state.channel.addEventListener('bufferedamountlow', handleLow);
  });
}

function sendSignal(message) {
  if (state.socket?.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify(message));
  }
}

function sendData(data) {
  if (typeof data === 'string' || data instanceof ArrayBuffer) {
    state.channel.send(data);
    return;
  }
  state.channel.send(JSON.stringify(data));
}

function isChannelReady() {
  return state.channel?.readyState === 'open';
}

function closePeerConnection() {
  state.channel?.close();
  state.connection?.close();
  state.channel = null;
  state.connection = null;
  state.remotePeerId = '';
  elements.dropZone.classList.remove('enabled');
}

async function copyShareLink() {
  try {
    await navigator.clipboard.writeText(elements.shareLink.value);
    log('分享链接已复制');
  } catch {
    elements.shareLink.select();
    document.execCommand('copy');
    log('分享链接已复制');
  }
}

function triggerDownload(url, name) {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.style.display = 'none';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

function renderRoomInfo() {
  elements.roomCode.textContent = state.roomId;
  elements.shareLink.value = window.location.href;
}

function updateRoomUrl(roomId) {
  const url = new URL(window.location.href);
  url.searchParams.set('room', roomId);
  window.history.replaceState(null, '', url);
}

function updateSignalStatus(text) {
  elements.signalStatus.textContent = text;
}

function updatePeerStatus(text) {
  elements.peerStatus.textContent = text;
}

function updateChannelStatus(text) {
  elements.channelStatus.textContent = text;
}

function updateConnectionPill(text, type) {
  elements.connectionState.textContent = text;
  elements.connectionState.dataset.type = type;
}

function log(text) {
  const line = document.createElement('div');
  line.className = 'log-line';
  line.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
  elements.logList.prepend(line);
}

function getRoomFromUrl() {
  const url = new URL(window.location.href);
  return normalizeRoomCode(url.searchParams.get('room'));
}

function normalizeRoomCode(value) {
  if (!value) return '';
  const room = String(value).trim().toUpperCase();
  return /^[A-Z0-9_-]{4,20}$/.test(room) ? room : '';
}

function createRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 6 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
}

function createPeerId() {
  return `peer_${crypto.getRandomValues(new Uint32Array(2)).join('_')}`;
}

function createTaskId() {
  return `file_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function isImageFile(file) {
  return Boolean(file?.mime?.startsWith('image/'));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
  })[char]);
}

function getFileBadge(mime) {
  if (mime.startsWith('image/')) return 'IMG';
  if (mime.startsWith('video/')) return 'VID';
  if (mime.startsWith('audio/')) return 'AUD';
  if (mime.includes('pdf')) return 'PDF';
  if (mime.includes('zip') || mime.includes('compressed')) return 'ZIP';
  if (mime.includes('text')) return 'TXT';
  return 'FILE';
}

function sanitizeFileName(name) {
  return String(name || '未命名文件').replace(/[\\/:*?"<>|]/g, '_');
}

function createUniqueFileName(name, usedNames) {
  const count = usedNames.get(name) || 0;
  usedNames.set(name, count + 1);
  if (count === 0) return name;

  const dotIndex = name.lastIndexOf('.');
  if (dotIndex <= 0) return `${name}-${count + 1}`;
  return `${name.slice(0, dotIndex)}-${count + 1}${name.slice(dotIndex)}`;
}

function formatDateForFileName(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function getDosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function u16(value) {
  const bytes = new Uint8Array(2);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, value, true);
  return bytes;
}

function u32(value) {
  const bytes = new Uint8Array(4);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, value >>> 0, true);
  return bytes;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC_TABLE = createCrcTable();

function createCrcTable() {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}
