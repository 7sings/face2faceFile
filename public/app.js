const CHUNK_SIZE = 64 * 1024;
const BUFFER_HIGH_WATER = 8 * 1024 * 1024;
const MAX_CONCURRENT_SENDS = 5;
const DEFAULT_ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
const ICE_CONFIG_CACHE_MS = 5 * 60 * 1000;

const elements = {
  connectionState: document.querySelector('#connectionState'),
  roomCode: document.querySelector('#roomCode'),
  shareLink: document.querySelector('#shareLink'),
  copyLinkBtn: document.querySelector('#copyLinkBtn'),
  joinForm: document.querySelector('#joinForm'),
  joinRoomInput: document.querySelector('#joinRoomInput'),
  resetRoomBtn: document.querySelector('#resetRoomBtn'),
  reconnectBtn: document.querySelector('#reconnectBtn'),
  signalStatus: document.querySelector('#signalStatus'),
  peerStatus: document.querySelector('#peerStatus'),
  channelStatus: document.querySelector('#channelStatus'),
  peerHint: document.querySelector('#peerHint'),
  dropZone: document.querySelector('#dropZone'),
  fileInput: document.querySelector('#fileInput'),
  sendList: document.querySelector('#sendList'),
  receiveList: document.querySelector('#receiveList'),
  receiveModeStatus: document.querySelector('#receiveModeStatus'),
  selectReceiveDirBtn: document.querySelector('#selectReceiveDirBtn'),
  selectAllFiles: document.querySelector('#selectAllFiles'),
  downloadSelectedBtn: document.querySelector('#downloadSelectedBtn'),
  saveImagesBtn: document.querySelector('#saveImagesBtn'),
  downloadZipBtn: document.querySelector('#downloadZipBtn'),
  clearLogBtn: document.querySelector('#clearLogBtn'),
  logList: document.querySelector('#logList'),
};

const iceConfigCache = {
  value: null,
  expiresAt: 0,
  inFlight: null,
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
  activeSendTasks: [],
  pendingChunkHeaders: [],
  dataMessageChain: Promise.resolve(),
  receiveDirectoryHandle: null,
  receiveOpfsRootHandle: null,
  manualReconnectInProgress: false,
  suppressSocketCloseReconnect: false,
  isSending: false,
};

init();

function init() {
  updateRoomUrl(state.roomId);
  renderRoomInfo();
  bindEvents();
  updateBatchActions();
  updateReceiveModeStatus();
  connectSignal();
}

function bindEvents() {
  elements.copyLinkBtn.addEventListener('click', copyShareLink);
  elements.reconnectBtn.addEventListener('click', reconnectSession);
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

  elements.selectReceiveDirBtn.addEventListener('click', selectReceiveDirectory);

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
  const socket = new WebSocket(url);
  state.socket = socket;

  socket.addEventListener('open', () => {
    state.manualReconnectInProgress = false;
    updateReconnectAvailability(false);
    updateSignalStatus('已连接');
    if (!isChannelReady()) {
      updateConnectionPill('等待对端', 'pending');
    }
    startSignalHeartbeat();
    log('信令服务已连接');
  });

  socket.addEventListener('message', async (event) => {
    const message = parseJson(event.data);
    if (!message) return;
    await handleSignal(message);
  });

  socket.addEventListener('close', () => {
    clearSignalHeartbeat();
    if (state.suppressSocketCloseReconnect && state.socket !== socket) {
      state.suppressSocketCloseReconnect = false;
      return;
    }

    if (state.socket === socket) {
      state.socket = null;
    }
    state.manualReconnectInProgress = false;
    updateSignalStatus('重连中');

    if (isChannelReady()) {
      elements.peerHint.textContent = '文件通道仍可用，正在后台重连信令服务。';
      updateReconnectAvailability(false);
      log('信令连接已断开，正在后台重连；已建立的文件通道不受影响');
    } else {
      updatePeerStatus('未发现');
      updateChannelStatus('未建立');
      updateConnectionPill('信令重连中', 'pending');
      updateReconnectAvailability(true);
      log('信令连接已断开，正在重连');
    }

    state.signalReconnectTimer = setTimeout(() => connectSignal({ preservePeer: true }), 1500);
  });

  socket.addEventListener('error', () => {
    state.manualReconnectInProgress = false;
    updateSignalStatus('连接异常');
    if (!isChannelReady()) {
      updateConnectionPill('信令异常', 'error');
      elements.peerHint.textContent = '信令连接异常，可尝试局部重连。';
      updateReconnectAvailability(true);
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
    prefetchIceServers();
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
    const iceServers = await getIceServers();
    const pc = ensurePeerConnection(false, iceServers);
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

function prefetchIceServers() {
  getIceServers({ silent: true });
}

async function getIceServers({ silent = false } = {}) {
  const now = Date.now();
  if (iceConfigCache.value && iceConfigCache.expiresAt > now) {
    return iceConfigCache.value;
  }

  if (iceConfigCache.inFlight) {
    return iceConfigCache.inFlight;
  }

  iceConfigCache.inFlight = fetch('/api/turn-credentials', {
    cache: 'no-store',
    credentials: 'same-origin',
  })
    .then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const iceServers = normalizeIceServers(data.iceServers);
      const serverExpiresAt = Date.parse(data.expiresAt);
      iceConfigCache.value = iceServers;
      iceConfigCache.expiresAt = Number.isFinite(serverExpiresAt)
        ? Math.max(Date.now() + 30000, serverExpiresAt - 10000)
        : Date.now() + ICE_CONFIG_CACHE_MS;
      if (!silent) log('已加载中继网络配置');
      return iceServers;
    })
    .catch((error) => {
      if (!silent) log(`中继网络配置获取失败，已降级为基础直连模式：${error.message}`);
      return DEFAULT_ICE_SERVERS;
    })
    .finally(() => {
      iceConfigCache.inFlight = null;
    });

  return iceConfigCache.inFlight;
}

function normalizeIceServers(value) {
  if (!Array.isArray(value)) throw new Error('ICE 配置格式异常');

  const servers = value
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const urls = Array.isArray(item.urls) ? item.urls : [item.urls];
      const validUrls = urls
        .filter((url) => typeof url === 'string')
        .map((url) => url.trim())
        .filter((url) => /^(stun|stuns|turn|turns):/i.test(url));
      if (!validUrls.length) return null;

      const username = typeof item.username === 'string' ? item.username : '';
      const credential = typeof item.credential === 'string' ? item.credential : '';
      if (Boolean(username) !== Boolean(credential)) return null;

      const server = { urls: validUrls.length === 1 ? validUrls[0] : validUrls };
      if (username) {
        server.username = username;
        server.credential = credential;
      }
      return server;
    })
    .filter(Boolean);

  if (!servers.length) throw new Error('ICE 配置为空');
  return servers;
}

async function startAsOfferer() {
  resetStalePeerConnection();
  const iceServers = await getIceServers();
  const pc = ensurePeerConnection(true, iceServers);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  sendSignal({ type: 'offer', to: state.remotePeerId, description: pc.localDescription });
  log('已发起直连请求');
}

function ensurePeerConnection(isOfferer, iceServers = DEFAULT_ICE_SERVERS) {
  if (state.connection) return state.connection;

  const pc = new RTCPeerConnection({ iceServers });
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
      updateReconnectAvailability(false);
      elements.peerHint.textContent = '直连成功，可以开始发送文件。';
    }
    if (pc.connectionState === 'disconnected') {
      updateConnectionPill('连接不稳定', 'error');
      updateReconnectAvailability(true);
      elements.peerHint.textContent = '与对端连接中断，可点击“局部重连”恢复。';
    }
    if (pc.connectionState === 'failed') {
      updateConnectionPill('直连失败', 'error');
      updateReconnectAvailability(true);
      elements.peerHint.textContent = '直连失败，可点击“局部重连”重建连接。';
      log('直连失败：请确认两台设备在同一局域网，且浏览器支持 WebRTC');
    }
    if (pc.connectionState === 'closed') {
      updateReconnectAvailability(true);
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
    updateReconnectAvailability(false);
    elements.peerHint.textContent = '直连成功，可以开始发送文件。';
    elements.dropZone.classList.add('enabled');
    log('文件传输通道已建立');
    processSendQueue();
  });

  channel.addEventListener('close', () => {
    cleanupTransferRuntime();
    updateChannelStatus('已关闭');
    updateConnectionPill('连接中断', 'error');
    updateReconnectAvailability(true);
    elements.peerHint.textContent = '文件传输通道已关闭，可点击“局部重连”恢复。';
    elements.dropZone.classList.remove('enabled');
    log('文件传输通道已关闭');
  });

  channel.addEventListener('error', () => {
    updateChannelStatus('异常');
    updateConnectionPill('通道异常', 'error');
    updateReconnectAvailability(true);
    elements.peerHint.textContent = '文件传输通道异常，可尝试局部重连。';
    log('文件传输通道异常');
  });

  channel.addEventListener('message', (event) => {
    state.dataMessageChain = state.dataMessageChain
      .then(() => handleDataMessage(event))
      .catch((error) => log(`处理传输消息失败：${error.message}`));
  });
}

function sendFiles(files) {
  const validFiles = files.filter(Boolean);
  if (!validFiles.length) return;

  state.sendQueue.push(...validFiles.map(createSendTask));
  log(`已加入发送队列：${validFiles.length} 个文件`);

  if (!isChannelReady()) {
    log('请等待直连通道建立后自动发送');
    return;
  }

  processSendQueue();
}

function createSendTask(file) {
  const fileId = createTaskId();
  const thumbnailUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : '';
  const element = createTransferItem(elements.sendList, {
    id: fileId,
    name: file.name,
    meta: `${formatBytes(file.size)} · 等待发送`,
    mime: file.type,
    thumbnailUrl,
  });

  const task = {
    id: fileId,
    file,
    name: file.name,
    size: file.size,
    mime: file.type,
    offset: 0,
    seq: 0,
    element,
    transferStats: createTransferStats(),
    metaSent: false,
    done: false,
  };
  state.sendTasks.set(fileId, task);
  return task;
}

async function processSendQueue() {
  if (state.isSending || !isChannelReady()) return;
  state.isSending = true;

  try {
    while (isChannelReady() && (state.sendQueue.length || state.activeSendTasks.length)) {
      fillActiveSendTasks();
      if (!state.activeSendTasks.length) break;

      for (const task of [...state.activeSendTasks]) {
        if (!isChannelReady()) break;
        await sendNextChunk(task);
        if (task.offset >= task.size) {
          finishSendTask(task);
        }
      }

      state.activeSendTasks = state.activeSendTasks.filter((task) => !task.done);
    }
  } finally {
    state.isSending = false;
    if (isChannelReady() && state.sendQueue.length) {
      processSendQueue();
    }
  }
}

function fillActiveSendTasks() {
  while (state.activeSendTasks.length < MAX_CONCURRENT_SENDS && state.sendQueue.length) {
    const task = state.sendQueue.shift();
    state.activeSendTasks.push(task);
    sendTaskMeta(task);
  }
}

function sendTaskMeta(task) {
  if (task.metaSent) return;
  task.metaSent = true;
  task.transferStats = createTransferStats();
  sendData({ type: 'file-meta', id: task.id, name: task.name, size: task.size, mime: task.mime });
  updateTransferItem(task.element, 0, buildTransferMeta(task, 0, task.size));
}

async function sendNextChunk(task) {
  if (task.done || task.offset >= task.size) return;

  await waitForBuffer();
  if (!isChannelReady()) return;

  const chunk = await task.file.slice(task.offset, task.offset + CHUNK_SIZE).arrayBuffer();
  sendData({ type: 'file-chunk', id: task.id, size: chunk.byteLength, seq: task.seq });
  sendData(chunk);
  task.offset += chunk.byteLength;
  task.seq += 1;
  updateTransferStats(task, task.offset);
  updateTransferItem(task.element, task.size ? task.offset / task.size : 1, buildTransferMeta(task, task.offset, task.size));
}

function finishSendTask(task) {
  if (task.done) return;
  task.done = true;
  sendData({ type: 'file-end', id: task.id });
  updateTransferItem(task.element, 1, `${formatBytes(task.size)} · 已发送`);
  log(`已发送：${task.name}`);
}

async function handleDataMessage(event) {
  if (typeof event.data === 'string') {
    const message = parseJson(event.data);
    if (!message) return;
    await handleControlMessage(message);
    return;
  }

  const header = state.pendingChunkHeaders.shift();
  if (!header) {
    log('收到缺少文件标识的分片，已忽略');
    return;
  }

  await handleFileChunk(header.id, event.data, header);
}

async function handleControlMessage(message) {
  if (message.type === 'file-meta') {
    await createReceiveTask(message);
    return;
  }

  if (message.type === 'file-chunk') {
    if (!message.id) {
      log('收到缺少文件 ID 的分片描述，已忽略');
      return;
    }
    state.pendingChunkHeaders.push({
      id: message.id,
      size: Number(message.size) || 0,
      seq: Number(message.seq) || 0,
    });
    return;
  }

  if (message.type === 'file-end') {
    await finishReceive(message.id);
  }
}

async function createReceiveTask(message) {
  const fileId = message.id;
  if (!fileId) return;

  const element = createTransferItem(elements.receiveList, {
    id: fileId,
    name: message.name || '未命名文件',
    meta: `${formatBytes(message.size)} · 接收中`,
    mime: message.mime,
    selectable: true,
    disabledSelection: true,
  });

  const task = {
    id: fileId,
    name: message.name || '未命名文件',
    size: Number(message.size) || 0,
    mime: message.mime || 'application/octet-stream',
    sinkType: 'blob',
    chunks: [],
    writer: null,
    fileHandle: null,
    writeChain: Promise.resolve(),
    received: 0,
    seqExpected: 0,
    transferStats: createTransferStats(),
    element,
  };

  state.receiveTasks.set(fileId, task);
  await setupReceiveSink(task);
  log(`开始接收：${task.name}`);
}

async function setupReceiveSink(task) {
  if (state.receiveDirectoryHandle && isDirectoryReceiveSupported()) {
    try {
      await setupWritableReceiveSink(task, state.receiveDirectoryHandle, 'fs', '流式接收中');
      return;
    } catch (error) {
      log(`流式保存到目录不可用，尝试浏览器本地暂存：${error.message}`);
    }
  }

  if (isOpfsReceiveSupported()) {
    try {
      const rootHandle = await getOpfsRootHandle();
      await setupWritableReceiveSink(task, rootHandle, 'opfs', '浏览器本地暂存中');
      return;
    } catch (error) {
      log(`浏览器本地暂存不可用，改用标准接收：${error.message}`);
    }
  }
}

async function setupWritableReceiveSink(task, directoryHandle, sinkType, statusText) {
  const { fileHandle, name } = await createAvailableReceiveFile(directoryHandle, task.name);
  const writer = await fileHandle.createWritable();
  task.sinkType = sinkType;
  task.chunks = null;
  task.writer = writer;
  task.fileHandle = fileHandle;
  task.name = name;
  task.element.querySelector('strong').textContent = name;
  updateTransferItem(task.element, 0, `${formatBytes(task.size)} · ${statusText}`);
}

async function createAvailableReceiveFile(directoryHandle, name) {
  const safeName = sanitizeFileName(name || `received-${Date.now()}`);

  for (let index = 0; index < 1000; index += 1) {
    const candidate = index === 0 ? safeName : appendFileNameSuffix(safeName, index + 1);
    try {
      await directoryHandle.getFileHandle(candidate);
    } catch (error) {
      if (error.name !== 'NotFoundError') throw error;
      const fileHandle = await directoryHandle.getFileHandle(candidate, { create: true });
      return { fileHandle, name: candidate };
    }
  }

  throw new Error('目录内同名文件过多');
}

async function getOpfsRootHandle() {
  if (!state.receiveOpfsRootHandle) {
    state.receiveOpfsRootHandle = await navigator.storage.getDirectory();
  }
  return state.receiveOpfsRootHandle;
}

async function removeOpfsPartialFile(task) {
  if (!task.name || !isOpfsReceiveSupported()) return;
  const rootHandle = await getOpfsRootHandle();
  await rootHandle.removeEntry(task.name);
}

async function handleFileChunk(fileId, chunk, header) {
  const task = state.receiveTasks.get(fileId);
  if (!task) {
    log('收到未知文件的分片，已忽略');
    return;
  }

  const buffer = await toArrayBuffer(chunk);
  if (header.size && header.size !== buffer.byteLength) {
    log(`分片大小异常：${task.name}`);
  }
  if (Number.isFinite(header.seq) && header.seq !== task.seqExpected) {
    log(`分片顺序异常：${task.name}`);
  }
  task.seqExpected += 1;

  if (task.writer) {
    task.writeChain = task.writeChain.then(() => task.writer.write(buffer));
    await task.writeChain;
  } else {
    task.chunks.push(buffer);
  }

  task.received += buffer.byteLength;
  updateTransferStats(task, task.received);
  updateTransferItem(task.element, task.size ? task.received / task.size : 0, buildTransferMeta(task, task.received, task.size));
}

async function finishReceive(fileId) {
  const task = state.receiveTasks.get(fileId);
  if (!task) return;

  if (task.sinkType === 'fs') {
    await finishFileSystemReceive(fileId, task);
    return;
  }

  if (task.sinkType === 'opfs') {
    await finishOpfsReceive(fileId, task);
    return;
  }

  const blob = new Blob(task.chunks, { type: task.mime });
  const url = URL.createObjectURL(blob);
  const safeName = sanitizeFileName(task.name || `received-${Date.now()}`);

  state.completedFiles.set(fileId, {
    id: fileId,
    name: safeName,
    mime: task.mime,
    blob,
    url,
    storage: 'blob',
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

async function finishFileSystemReceive(fileId, task) {
  try {
    await task.writeChain;
    await task.writer.close();
    state.completedFiles.set(fileId, {
      id: fileId,
      name: task.name,
      mime: task.mime,
      size: task.received,
      storage: 'fs',
    });
    updateTransferItem(task.element, 1, `${formatBytes(task.received)} · 已保存到目录`);
    appendSavedLabel(task.element);
    log(`已保存到目录：${task.name}`);
  } catch (error) {
    try {
      await task.writer?.abort();
    } catch {}
    updateTransferItem(task.element, task.size ? task.received / task.size : 0, `${formatBytes(task.received)} · 保存失败`);
    log(`保存失败：${task.name}，${error.message}`);
  } finally {
    state.receiveTasks.delete(fileId);
    updateBatchActions();
  }
}

async function finishOpfsReceive(fileId, task) {
  try {
    await task.writeChain;
    await task.writer.close();
    const fileFromOPFS = await task.fileHandle.getFile();
    const url = URL.createObjectURL(fileFromOPFS);

    state.completedFiles.set(fileId, {
      id: fileId,
      name: task.name,
      mime: task.mime,
      size: fileFromOPFS.size,
      blob: fileFromOPFS,
      url,
      storage: 'opfs',
      fileHandle: task.fileHandle,
    });

    updateTransferItem(task.element, 1, `${formatBytes(fileFromOPFS.size)} · 已接收`);
    setTransferThumbnail(task.element, { mime: task.mime, thumbnailUrl: task.mime.startsWith('image/') ? url : '' });
    enableTransferSelection(task.element, fileId);

    const action = document.createElement('a');
    action.href = url;
    action.download = task.name;
    action.className = 'download-link';
    action.textContent = '下载';
    task.element.append(action);

    const completedFile = state.completedFiles.get(fileId);
    if (isImageFile(completedFile)) {
      const saveAction = document.createElement('button');
      saveAction.type = 'button';
      saveAction.className = 'album-link';
      saveAction.textContent = '保存到相册';
      saveAction.addEventListener('click', () => saveImagesToAlbum([completedFile]));
      task.element.append(saveAction);
    }

    log(`已接收：${task.name}`);
  } catch (error) {
    try {
      await task.writer?.abort();
    } catch {}
    updateTransferItem(task.element, task.size ? task.received / task.size : 0, `${formatBytes(task.received)} · 保存失败`);
    log(`浏览器本地暂存失败：${task.name}，${error.message}`);
  } finally {
    state.receiveTasks.delete(fileId);
    updateBatchActions();
  }
}

function appendSavedLabel(item) {
  const label = document.createElement('span');
  label.className = 'saved-label';
  label.textContent = '已保存';
  item.append(label);
}

async function toArrayBuffer(chunk) {
  if (chunk instanceof ArrayBuffer) return chunk;
  if (chunk instanceof Blob) return chunk.arrayBuffer();
  if (ArrayBuffer.isView(chunk)) {
    return chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
  }
  return chunk.buffer;
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
  for (const [fileId, file] of state.completedFiles) {
    if (!isBlobBackedFile(file)) continue;
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
  const total = [...state.completedFiles.values()].filter(isBlobBackedFile).length;
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
    .filter(isBlobBackedFile);
}

function isBlobBackedFile(file) {
  return Boolean(file?.blob && file?.url);
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
  cleanupTransferRuntime();
  state.channel?.close();
  state.connection?.close();
  state.channel = null;
  state.connection = null;
  state.remotePeerId = '';
  elements.dropZone.classList.remove('enabled');
}

function reconnectSession() {
  if (state.manualReconnectInProgress) return;
  state.manualReconnectInProgress = true;
  updateReconnectAvailability(false, '重连中...');
  updateSignalStatus('重连中');
  updatePeerStatus('重连中');
  updateChannelStatus('重建中');
  updateConnectionPill('正在重连', 'pending');
  elements.peerHint.textContent = '正在局部重连，已完成文件和日志会保留。';
  log('开始局部重连');

  teardownConnectionForReconnect();
  connectSignal({ preservePeer: true });
}

function teardownConnectionForReconnect() {
  clearSignalHeartbeat();
  clearTimeout(state.signalReconnectTimer);

  const socket = state.socket;
  state.socket = null;
  if (socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(socket.readyState)) {
    state.suppressSocketCloseReconnect = true;
    socket.close();
  }

  closePeerConnection();
}

function updateReconnectAvailability(enabled, label = '局部重连') {
  elements.reconnectBtn.disabled = !enabled;
  elements.reconnectBtn.textContent = label;
}

function cleanupTransferRuntime() {
  state.pendingChunkHeaders = [];
  state.dataMessageChain = Promise.resolve();
  state.isSending = false;

  for (const task of state.activeSendTasks) {
    updateTransferItem(task.element, task.size ? task.offset / task.size : 0, `${formatBytes(task.offset)} · 传输中断`);
  }
  state.activeSendTasks = [];

  for (const task of state.receiveTasks.values()) {
    if (task.writer) {
      task.writer.abort().catch(() => {});
    }
    if (task.sinkType === 'opfs') {
      removeOpfsPartialFile(task).catch(() => {});
    }
    updateTransferItem(task.element, task.size ? task.received / task.size : 0, `${formatBytes(task.received)} · 接收中断`);
  }
  state.receiveTasks.clear();
}

async function selectReceiveDirectory() {
  if (!isDirectoryReceiveSupported()) {
    log('当前浏览器不支持选择接收目录，将继续使用浏览器本地暂存或标准接收');
    updateReceiveModeStatus();
    return;
  }

  try {
    state.receiveDirectoryHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
    updateReceiveModeStatus();
    log('已启用流式保存：后续接收文件会直接写入所选目录');
  } catch (error) {
    if (error.name === 'AbortError') {
      log('已取消选择接收目录');
      return;
    }
    log(`选择接收目录失败：${error.message}`);
  }
}

function isDirectoryReceiveSupported() {
  return typeof window.showDirectoryPicker === 'function';
}

function isOpfsReceiveSupported() {
  return typeof navigator.storage?.getDirectory === 'function';
}

function updateReceiveModeStatus() {
  if (state.receiveDirectoryHandle) {
    elements.receiveModeStatus.textContent = '流式保存到目录：页面内不再缓存这些文件';
    elements.selectReceiveDirBtn.disabled = false;
    elements.selectReceiveDirBtn.textContent = '更换接收目录';
    return;
  }

  if (isDirectoryReceiveSupported()) {
    elements.receiveModeStatus.textContent = isOpfsReceiveSupported()
      ? '流式接收：使用浏览器本地存储暂存，完成后生成下载链接'
      : '标准接收：完成后生成下载链接';
    elements.selectReceiveDirBtn.disabled = false;
    elements.selectReceiveDirBtn.textContent = '选择接收目录（可选）';
    return;
  }

  elements.selectReceiveDirBtn.disabled = true;
  if (isOpfsReceiveSupported()) {
    elements.receiveModeStatus.textContent = '流式接收：使用浏览器本地存储暂存，完成后生成下载链接';
  } else {
    elements.receiveModeStatus.textContent = '标准接收：完成后生成下载链接';
  }
  elements.selectReceiveDirBtn.textContent = '当前浏览器不支持选择目录';
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

function createTransferStats() {
  return {
    startedAt: Date.now(),
    speedBps: 0,
  };
}

function updateTransferStats(task, transferredBytes) {
  const elapsedSeconds = (Date.now() - task.transferStats.startedAt) / 1000;
  if (transferredBytes <= 0 || elapsedSeconds < 1) return;

  const averageSpeed = transferredBytes / elapsedSeconds;
  if (!Number.isFinite(averageSpeed) || averageSpeed <= 0) return;

  task.transferStats.speedBps = task.transferStats.speedBps
    ? task.transferStats.speedBps * 0.7 + averageSpeed * 0.3
    : averageSpeed;
}

function buildTransferMeta(task, transferredBytes, totalBytes) {
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

function formatDuration(seconds) {
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

  return appendFileNameSuffix(name, count + 1);
}

function appendFileNameSuffix(name, suffix) {
  const dotIndex = name.lastIndexOf('.');
  if (dotIndex <= 0) return `${name}-${suffix}`;
  return `${name.slice(0, dotIndex)}-${suffix}${name.slice(dotIndex)}`;
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
