export function createStatusUI({ elements, state }) {
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

  function updateConnectionTypeStatus(text) {
    elements.connectionTypeStatus.textContent = text;
  }

  function updateConnectionPill(text, type) {
    elements.connectionState.textContent = text;
    elements.connectionState.dataset.type = type;
  }

  function updateReconnectAvailability(enabled, label = '局部重连') {
    elements.reconnectBtn.disabled = !enabled;
    elements.reconnectBtn.textContent = label;
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

  function clearLog() {
    elements.logList.innerHTML = '';
  }

  function log(text) {
    const line = document.createElement('div');
    line.className = 'log-line';
    line.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
    elements.logList.prepend(line);
  }

  return {
    renderRoomInfo,
    updateRoomUrl,
    updateSignalStatus,
    updatePeerStatus,
    updateChannelStatus,
    updateConnectionTypeStatus,
    updateConnectionPill,
    updateReconnectAvailability,
    copyShareLink,
    clearLog,
    log,
  };
}
