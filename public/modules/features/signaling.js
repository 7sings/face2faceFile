import { DEFAULT_ICE_SERVERS, ICE_CONFIG_CACHE_MS } from '../config.js';
import { iceConfigCache } from '../state.js';
import { parseJson } from '../utils/common.js';
import { describeCandidate, summarizeIceServers } from '../utils/webrtc-diagnostics.js';

export function createSignalingService({ elements, state, statusUI, peerService, getCallApi }) {
  const {
    log,
    updateChannelStatus,
    updateConnectionPill,
    updatePeerStatus,
    updateReconnectAvailability,
    updateSignalStatus,
  } = statusUI;

  function connectSignal({ preservePeer = false } = {}) {
    if (state.socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(state.socket.readyState)) return;

    if (!preservePeer) {
      peerService.closePeerConnection();
    }

    clearSignalHeartbeat();
    clearTimeout(state.signalReconnectTimer);
    updateSignalStatus('连接中');
    if (!peerService.isChannelReady()) {
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
      if (!peerService.isChannelReady()) {
        updateConnectionPill('等待对端', 'pending');
      }
      startSignalHeartbeat();
      log(`信令服务已连接：room=${state.roomId}, peer=${state.peerId}`);
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

      if (peerService.isChannelReady()) {
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
      if (!peerService.isChannelReady()) {
        updateConnectionPill('信令异常', 'error');
        elements.peerHint.textContent = '信令连接异常，可尝试局部重连。';
        updateReconnectAvailability(true);
      }
    });
  }

  async function handleSignal(message) {
    if (message.type === 'pong') return;

    if (message.type === 'ready') {
      if (message.scope === 'call') {
        getCallApi().handleCallControl(message);
      }
      return;
    }

    if (message.type === 'welcome') {
      log(`[诊断] 收到 welcome：peers=${message.peers.length}`);
      if (message.peers.length) {
        state.remotePeerId = message.peers[0];
        updateNegotiationRole();
        if (peerService.hasActivePeerConnection()) {
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
      log(`[诊断] peer-joined：remotePeerId=${state.remotePeerId}`);
      updateNegotiationRole();
      if (peerService.hasActivePeerConnection()) return;

      updatePeerStatus('已发现');
      elements.peerHint.textContent = '对端已加入，等待对端发起直连。';
      log('对端已加入房间');
      prefetchIceServers();
      getCallApi().updateCallButtons();
      return;
    }

    if (message.type === 'peer-left') {
      if (message.peerId === state.remotePeerId) {
        log('对端已离开房间');
        state.remotePeerId = '';
        updatePeerStatus('已离开');
        updateChannelStatus('未建立');
        updateConnectionPill('等待对端', 'pending');
        peerService.closePeerConnection();
        getCallApi().updateCallButtons();
      }
      return;
    }

    if (message.from && !state.remotePeerId) {
      state.remotePeerId = message.from;
      updateNegotiationRole();
    }

    if (message.type === 'offer') {
      await handleOffer(message);
      return;
    }

    if (message.type === 'answer') {
      await handleAnswer(message);
      return;
    }

    if (message.type === 'candidate' && message.candidate) {
      await handleCandidate(message.candidate);
    }
  }

  async function handleOffer(message) {
    peerService.resetStalePeerConnection();
    const iceServers = await getIceServers();
    const pc = peerService.ensurePeerConnection(false, iceServers);
    updateNegotiationRole();

    const readyForOffer = !state.makingOffer && (pc.signalingState === 'stable' || state.isSettingRemoteAnswerPending);
    const offerCollision = !readyForOffer;
    log(`[诊断] 收到 offer：reason=${message.reason || 'unknown'}, signaling=${pc.signalingState}, makingOffer=${state.makingOffer}, polite=${state.isPolite}, collision=${offerCollision}`);
    state.ignoreOffer = !state.isPolite && offerCollision;
    if (state.ignoreOffer) {
      log('已忽略一次冲突的通话协商请求');
      return;
    }
    state.ignoreOffer = false;

    try {
      if (offerCollision) {
        await pc.setLocalDescription({ type: 'rollback' });
      }
      await pc.setRemoteDescription(message.description);
      await flushPendingCandidates();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendSignal({ type: 'answer', to: message.from, description: pc.localDescription });
      log('已响应直连请求');
    } catch (error) {
      log(`处理协商请求失败：${error.message}`);
    } finally {
      state.ignoreOffer = false;
    }
  }

  async function handleAnswer(message) {
    if (!state.connection) return;

    log(`[诊断] 收到 answer：signaling=${state.connection.signalingState}, pendingCandidates=${state.pendingCandidates.length}`);
    try {
      state.isSettingRemoteAnswerPending = true;
      await state.connection.setRemoteDescription(message.description);
      state.ignoreOffer = false;
      await flushPendingCandidates();
      log('对端已接受直连请求');
    } catch (error) {
      log(`处理协商响应失败：${error.message}`);
    } finally {
      state.isSettingRemoteAnswerPending = false;
    }
  }

  async function handleCandidate(candidate) {
    if (state.ignoreOffer) return;

    state.iceRemoteCandidateCount += 1;
    const summary = describeCandidate(candidate);

    if (!state.connection) {
      state.pendingCandidates.push(candidate);
      log(`[诊断] 缓存远端 ICE candidate #${state.iceRemoteCandidateCount}：${summary}（等待 PeerConnection）`);
      return;
    }

    if (!state.connection.remoteDescription) {
      state.pendingCandidates.push(candidate);
      log(`[诊断] 缓存远端 ICE candidate #${state.iceRemoteCandidateCount}：${summary}（等待 remoteDescription）`);
      return;
    }

    try {
      await state.connection.addIceCandidate(candidate);
      log(`[诊断] 已添加远端 ICE candidate #${state.iceRemoteCandidateCount}：${summary}`);
    } catch (error) {
      if (!state.ignoreOffer) {
        log(`添加网络候选失败：${error.message}；candidate=${summary}`);
      }
    }
  }

  async function flushPendingCandidates() {
    if (!state.connection?.remoteDescription) return;
    const candidates = state.pendingCandidates.splice(0);
    if (candidates.length) {
      log(`[诊断] 开始添加缓存 ICE candidate：${candidates.length} 个`);
    }
    for (const candidate of candidates) {
      const summary = describeCandidate(candidate);
      try {
        await state.connection.addIceCandidate(candidate);
        log(`[诊断] 已添加缓存远端 ICE candidate：${summary}`);
      } catch (error) {
        if (!state.ignoreOffer) {
          log(`添加缓存网络候选失败：${error.message}；candidate=${summary}`);
        }
      }
    }
  }

  async function requestNegotiation(reason = 'manual') {
    const pc = state.connection;
    if (!pc || pc.signalingState === 'closed' || !state.remotePeerId) return;
    if (state.makingOffer) return;
    if (pc.signalingState !== 'stable') {
      state.pendingNegotiationReason = reason;
      log(`[诊断] 延迟 offer：reason=${reason}, signaling=${pc.signalingState}`);
      return;
    }

    try {
      state.makingOffer = true;
      log(`[诊断] 发起 offer：reason=${reason}, signaling=${pc.signalingState}, ice=${pc.iceConnectionState}`);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sendSignal({ type: 'offer', to: state.remotePeerId, description: pc.localDescription, reason });
    } catch (error) {
      log(`发起协商失败：${error.message}`);
    } finally {
      state.makingOffer = false;
    }
  }

  function updateNegotiationRole() {
    if (!state.remotePeerId) return;
    state.isPolite = state.peerId > state.remotePeerId;
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
        if (!silent) log(`已加载中继网络配置：${summarizeIceServers(iceServers)}`);
        return iceServers;
      })
      .catch((error) => {
        if (!silent) log(`中继网络配置获取失败，已降级为基础直连模式：${error.message}；fallback=${summarizeIceServers(DEFAULT_ICE_SERVERS)}`);
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
    peerService.resetStalePeerConnection();
    const iceServers = await getIceServers();
    peerService.ensurePeerConnection(true, iceServers);
    await requestNegotiation('initial');
    log('已发起直连请求');
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

  function sendSignal(message) {
    if (state.socket?.readyState === WebSocket.OPEN) {
      state.socket.send(JSON.stringify(message));
    }
  }

  return {
    connectSignal,
    sendSignal,
    clearSignalHeartbeat,
    getIceServers,
    prefetchIceServers,
    requestNegotiation,
  };
}
