import { BUFFER_HIGH_WATER, DEFAULT_ICE_SERVERS } from '../config.js';
import { describeCandidate, describeCandidatePair, describeIceUrl, summarizeIceServers } from '../utils/webrtc-diagnostics.js';

export function createPeerService({ elements, state, statusUI, sendService, receiveService, getSignalApi, getCallApi }) {
  const {
    log,
    updateChannelStatus,
    updateConnectionPill,
    updateConnectionTypeStatus,
    updatePeerStatus,
    updateReconnectAvailability,
    updateSignalStatus,
  } = statusUI;

  function ensurePeerConnection(isOfferer, iceServers = DEFAULT_ICE_SERVERS) {
    if (state.connection) return state.connection;

    const pc = new RTCPeerConnection({ iceServers });
    state.connection = pc;
    state.iceLocalCandidateCount = 0;
    state.iceRemoteCandidateCount = 0;
    log(`[诊断] 创建 RTCPeerConnection：role=${isOfferer ? 'offerer' : 'answerer'}，ICE=${summarizeIceServers(iceServers)}`);

    pc.addEventListener('icecandidate', (event) => {
      if (!event.candidate) {
        log(`[诊断] 本地 ICE candidate 收集结束，共 ${state.iceLocalCandidateCount} 个`);
        return;
      }

      state.iceLocalCandidateCount += 1;
      log(`[诊断] 本地 ICE candidate #${state.iceLocalCandidateCount}：${describeCandidate(event.candidate)}`);
      if (state.remotePeerId) {
        getSignalApi().sendSignal({ type: 'candidate', to: state.remotePeerId, candidate: event.candidate });
      } else {
        log('[诊断] 本地 candidate 暂未发送：remotePeerId 为空');
      }
    });

    pc.addEventListener('icecandidateerror', (event) => {
      const urlText = event.url ? describeIceUrl(event.url) : '未知 ICE URL';
      log(`[诊断] ICE candidate error：url=${urlText}, code=${event.errorCode || 'unknown'}, text=${event.errorText || 'unknown'}`);
    });

    pc.addEventListener('icegatheringstatechange', () => {
      log(`[诊断] ICE gatheringState=${pc.iceGatheringState}`);
    });

    pc.addEventListener('iceconnectionstatechange', () => {
      log(`[诊断] ICE connectionState=${pc.iceConnectionState}`);
      if (['connected', 'completed', 'failed'].includes(pc.iceConnectionState)) {
        logSelectedCandidatePair(pc, `ICE ${pc.iceConnectionState}`);
      }
    });

    pc.addEventListener('signalingstatechange', () => {
      log(`[诊断] signalingState=${pc.signalingState}`);
    });

    pc.addEventListener('connectionstatechange', () => {
      log(`[诊断] PeerConnection connectionState=${pc.connectionState}, ice=${pc.iceConnectionState}, signaling=${pc.signalingState}, gathering=${pc.iceGatheringState}`);
      const statusMap = {
        new: '准备中',
        connecting: '连接中',
        connected: '已连接',
        disconnected: '已断开',
        failed: '连接失败',
        closed: '已关闭',
      };
      updatePeerStatus(statusMap[pc.connectionState] || pc.connectionState);
      if (pc.connectionState === 'connected') {
        updateConnectionPill('已连接', 'ok');
        updateConnectionTypeStatus('识别中');
        updateReconnectAvailability(false);
        elements.peerHint.textContent = '连接成功，正在识别连接方式。';
        updateConnectionTypeFromStats(pc);
      }
      if (pc.connectionState === 'disconnected') {
        state.connectionType = '';
        updateConnectionTypeStatus('已断开');
        updateConnectionPill('连接不稳定', 'error');
        updateReconnectAvailability(true);
        elements.peerHint.textContent = '与对端连接中断，可点击“局部重连”恢复。';
      }
      if (pc.connectionState === 'failed') {
        state.connectionType = '';
        updateConnectionTypeStatus('未建立');
        updateConnectionPill('连接失败', 'error');
        updateReconnectAvailability(true);
        elements.peerHint.textContent = '连接失败，可点击“局部重连”重建连接。';
        log('连接失败：请确认两台设备在同一局域网，且浏览器支持 WebRTC');
        logSelectedCandidatePair(pc, '连接失败');
      }
      if (pc.connectionState === 'closed') {
        state.connectionType = '';
        updateConnectionTypeStatus('未建立');
        updateReconnectAvailability(true);
      }
      getCallApi().updateCallButtons();
    });

    pc.addEventListener('datachannel', (event) => {
      setupDataChannel(event.channel);
    });

    pc.addEventListener('track', (event) => {
      getCallApi().handleRemoteTrack(event);
    });

    pc.addEventListener('negotiationneeded', () => {
      if (state.hasLocalMedia || state.mediaSenders.length) {
        getSignalApi().requestNegotiation('negotiationneeded');
      }
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
      updateConnectionTypeStatus('识别中');
      updateReconnectAvailability(false);
      elements.peerHint.textContent = '连接成功，正在识别连接方式。';
      elements.dropZone.classList.add('enabled');
      updateConnectionTypeFromStats();
      getCallApi().updateCallButtons();
      log('文件传输通道已建立');
      sendService.processSendQueue();
    });

    channel.addEventListener('close', () => {
      cleanupTransferRuntime();
      state.connectionType = '';
      updateChannelStatus('已关闭');
      updateConnectionTypeStatus('未建立');
      updateConnectionPill('连接中断', 'error');
      updateReconnectAvailability(true);
      elements.peerHint.textContent = '文件传输通道已关闭，可点击“局部重连”恢复。';
      elements.dropZone.classList.remove('enabled');
      getCallApi().updateCallButtons();
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
      receiveService.enqueueIncomingMessage(event);
    });
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
    state.connectionType = '';
    state.pendingCandidates = [];
    state.iceLocalCandidateCount = 0;
    state.iceRemoteCandidateCount = 0;
    state.makingOffer = false;
    state.ignoreOffer = false;
    updateChannelStatus('重新建链中');
    updateConnectionTypeStatus('重新建链中');
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

  async function updateConnectionTypeFromStats(pc = state.connection, attempt = 0) {
    if (!pc || !canUpdateConnectionType(pc)) return;

    try {
      const stats = await pc.getStats();
      const pair = getSelectedCandidatePair(stats);
      const localCandidate = pair?.localCandidateId ? stats.get(pair.localCandidateId) : null;
      const remoteCandidate = pair?.remoteCandidateId ? stats.get(pair.remoteCandidateId) : null;

      if (!localCandidate || !remoteCandidate) {
        if (attempt < 6 && canUpdateConnectionType(pc)) {
          setTimeout(() => updateConnectionTypeFromStats(pc, attempt + 1), 500);
        }
        return;
      }

      const connectionType = getConnectionTypeText(localCandidate, remoteCandidate);
      if (!connectionType || !canUpdateConnectionType(pc)) return;

      updateConnectionTypeStatus(connectionType);
      elements.peerHint.textContent = `连接方式：${connectionType}，可以开始发送文件。`;
      log(`[诊断] 已选中候选对：${describeCandidatePair(localCandidate, remoteCandidate)}`);
      if (state.connectionType !== connectionType) {
        state.connectionType = connectionType;
        log(`P2P 连接方式：${connectionType}`);
      }
    } catch (error) {
      if (canUpdateConnectionType(pc)) {
        updateConnectionTypeStatus('识别失败');
        log(`连接方式识别失败：${error.message}`);
      }
    }
  }

  function canUpdateConnectionType(pc) {
    return pc === state.connection && !['closed', 'failed', 'disconnected'].includes(pc.connectionState);
  }

  function getSelectedCandidatePair(stats) {
    let selectedPair = null;

    stats.forEach((report) => {
      if (report.type === 'transport' && report.selectedCandidatePairId) {
        selectedPair = stats.get(report.selectedCandidatePairId) || selectedPair;
      }
    });
    if (selectedPair) return selectedPair;

    stats.forEach((report) => {
      if (report.type === 'candidate-pair' && (report.selected || (report.nominated && report.state === 'succeeded'))) {
        selectedPair = report;
      }
    });
    if (selectedPair) return selectedPair;

    stats.forEach((report) => {
      if (!selectedPair && report.type === 'candidate-pair' && report.state === 'succeeded') {
        selectedPair = report;
      }
    });
    return selectedPair;
  }

  function getConnectionTypeText(localCandidate, remoteCandidate) {
    const candidateTypes = [localCandidate?.candidateType, remoteCandidate?.candidateType].filter(Boolean);
    if (candidateTypes.includes('relay')) return 'TURN 中转';
    if (candidateTypes.includes('srflx') || candidateTypes.includes('prflx')) return 'STUN P2P 直连';
    if (candidateTypes.includes('host')) return '局域网';
    return '';
  }

  async function logSelectedCandidatePair(pc, reason) {
    try {
      const stats = await pc.getStats();
      const pair = getSelectedCandidatePair(stats);
      if (!pair) {
        log(`[诊断] ${reason}：未找到 selected candidate pair`);
        return;
      }

      const localCandidate = pair.localCandidateId ? stats.get(pair.localCandidateId) : null;
      const remoteCandidate = pair.remoteCandidateId ? stats.get(pair.remoteCandidateId) : null;
      log(`[诊断] ${reason} 候选对：state=${pair.state || 'unknown'}, nominated=${Boolean(pair.nominated)}, bytesSent=${pair.bytesSent || 0}, bytesReceived=${pair.bytesReceived || 0}, ${describeCandidatePair(localCandidate, remoteCandidate)}`);
    } catch (error) {
      log(`[诊断] ${reason} 候选对读取失败：${error.message}`);
    }
  }

  function closePeerConnection() {
    getCallApi().cleanupMedia({ removeSenders: false });
    cleanupTransferRuntime();
    state.channel?.close();
    state.connection?.close();
    state.channel = null;
    state.connection = null;
    state.connectionType = '';
    state.pendingCandidates = [];
    state.iceLocalCandidateCount = 0;
    state.iceRemoteCandidateCount = 0;
    state.makingOffer = false;
    state.ignoreOffer = false;
    state.isSettingRemoteAnswerPending = false;
    state.remotePeerId = '';
    updateConnectionTypeStatus('未建立');
    elements.dropZone.classList.remove('enabled');
    getCallApi().updateCallButtons();
  }

  function reconnectSession() {
    if (state.manualReconnectInProgress) return;
    state.manualReconnectInProgress = true;
    updateReconnectAvailability(false, '重连中...');
    updateSignalStatus('重连中');
    updatePeerStatus('重连中');
    updateChannelStatus('重建中');
    state.connectionType = '';
    updateConnectionTypeStatus('重建中');
    updateConnectionPill('正在重连', 'pending');
    elements.peerHint.textContent = '正在局部重连，已完成文件和日志会保留。';
    log('开始局部重连');

    teardownConnectionForReconnect();
    getSignalApi().connectSignal({ preservePeer: true });
  }

  function teardownConnectionForReconnect() {
    getSignalApi().clearSignalHeartbeat();
    clearTimeout(state.signalReconnectTimer);

    const socket = state.socket;
    state.socket = null;
    if (socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(socket.readyState)) {
      state.suppressSocketCloseReconnect = true;
      socket.close();
    }

    closePeerConnection();
  }

  function cleanupTransferRuntime() {
    sendService.cleanupInterruptedSends();
    receiveService.cleanupInterruptedReceives();
  }

  function getConnection() {
    return state.connection;
  }

  return {
    ensurePeerConnection,
    closePeerConnection,
    reconnectSession,
    hasActivePeerConnection,
    resetStalePeerConnection,
    isChannelReady,
    sendData,
    updateConnectionTypeFromStats,
    getConnection,
  };
}
