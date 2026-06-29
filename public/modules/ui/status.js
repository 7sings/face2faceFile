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

  async function requestNotificationPermission() {
    if (!('Notification' in window)) return false;
    if (Notification.permission === 'granted') {
      state.notificationsEnabled = true;
      return true;
    }
    if (Notification.permission !== 'default') return false;

    try {
      const permission = await Notification.requestPermission();
      state.notificationsEnabled = permission === 'granted';
      return state.notificationsEnabled;
    } catch {
      return false;
    }
  }

  function notify(title, body) {
    if (!state.notificationsEnabled || !('Notification' in window) || Notification.permission !== 'granted') return;
    if (document.visibilityState === 'visible') return;

    try {
      new Notification(title, { body, tag: 'face2face-file-transfer' });
    } catch {}
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
    requestNotificationPermission,
    notify,
    log,
  };
}
