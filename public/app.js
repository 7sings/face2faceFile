import { BUFFER_HIGH_WATER } from './modules/config.js';
import { elements } from './modules/elements.js';
import { state } from './modules/state.js';
import { createCallService } from './modules/features/call.js';
import { createExportActions } from './modules/features/exports.js';
import { createPeerService } from './modules/features/peer.js';
import { createReceiveService } from './modules/features/receive.js';
import { createSendService } from './modules/features/send.js';
import { createSignalingService } from './modules/features/signaling.js';
import { createStatusUI } from './modules/ui/status.js';
import { createTransferUI } from './modules/ui/transfers.js';
import { createRoomCode, normalizeRoomCode } from './modules/utils/common.js';

const statusUI = createStatusUI({ elements, state });
const exportActionsRef = {};
const callRef = {};
const peerRef = {};
const sendRef = {};
const signalingRef = {};

const transferUI = createTransferUI({
  elements,
  state,
  getExportActions: () => exportActionsRef.api,
});

const exportActions = createExportActions({
  elements,
  state,
  statusUI,
});
exportActionsRef.api = exportActions;

const receiveService = createReceiveService({
  elements,
  state,
  statusUI,
  transferUI,
  exportActions,
  channelApi: {
    isChannelReady: () => peerRef.api?.isChannelReady(),
    sendData: (data) => peerRef.api?.sendData(data),
  },
  getSendApi: () => sendRef.api,
  onTransferActivity: handleTransferActivity,
});

const sendService = createSendService({
  elements,
  state,
  statusUI,
  transferUI,
  channelApi: {
    isChannelReady: () => peerRef.api.isChannelReady(),
    sendData: (data) => peerRef.api.sendData(data),
    getChannel: () => state.channel,
    bufferHighWater: BUFFER_HIGH_WATER,
  },
  onTransferActivity: handleTransferActivity,
});
sendRef.api = sendService;

const callService = createCallService({
  elements,
  state,
  statusUI,
  getPeerApi: () => peerRef.api,
  getSignalApi: () => signalingRef.api,
});
callRef.api = callService;

peerRef.api = createPeerService({
  elements,
  state,
  statusUI,
  sendService,
  receiveService,
  getSignalApi: () => signalingRef.api,
  getCallApi: () => callRef.api,
});

signalingRef.api = createSignalingService({
  elements,
  state,
  statusUI,
  peerService: peerRef.api,
  getCallApi: () => callRef.api,
});

init();

function init() {
  statusUI.updateRoomUrl(state.roomId);
  statusUI.renderRoomInfo();
  bindEvents();
  exportActions.updateBatchActions();
  receiveService.updateReceiveModeStatus();
  transferUI.updateOverallProgress();
  bindPageLifecycle();
  callService.updateCallButtons();
  signalingRef.api.connectSignal();
}

function bindEvents() {
  elements.copyLinkBtn.addEventListener('click', statusUI.copyShareLink);
  elements.reconnectBtn.addEventListener('click', () => {
    void statusUI.requestNotificationPermission();
    peerRef.api.reconnectSession();
  });
  elements.resetRoomBtn.addEventListener('click', () => {
    window.location.href = `${window.location.pathname}?room=${createRoomCode()}`;
  });

  elements.joinForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const nextRoom = normalizeRoomCode(elements.joinRoomInput.value);
    if (!nextRoom) {
      statusUI.log('请输入有效房间码');
      return;
    }
    window.location.href = `${window.location.pathname}?room=${nextRoom}`;
  });

  elements.fileInput.addEventListener('change', () => {
    void statusUI.requestNotificationPermission();
    sendService.sendFiles([...elements.fileInput.files]);
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
    void statusUI.requestNotificationPermission();
    sendService.sendFiles([...event.dataTransfer.files]);
  });

  elements.selectReceiveDirBtn.addEventListener('click', receiveService.selectReceiveDirectory);

  elements.selectAllFiles.addEventListener('change', () => {
    exportActions.setAllReceivedSelection(elements.selectAllFiles.checked);
  });

  elements.downloadSelectedBtn.addEventListener('click', exportActions.downloadSelectedFilesDirectly);
  elements.saveImagesBtn.addEventListener('click', exportActions.saveSelectedImagesToAlbum);
  elements.downloadZipBtn.addEventListener('click', exportActions.downloadSelectedFilesAsZip);
  elements.startCallBtn.addEventListener('click', callService.startCall);
  elements.hangupCallBtn.addEventListener('click', callService.hangupCall);
  elements.toggleMicBtn.addEventListener('click', callService.toggleMic);
  elements.toggleCameraBtn.addEventListener('click', callService.toggleCamera);
  elements.clearLogBtn.addEventListener('click', statusUI.clearLog);
}

function bindPageLifecycle() {
  state.isPageHidden = document.visibilityState === 'hidden';
  document.addEventListener('visibilitychange', () => {
    state.isPageHidden = document.visibilityState === 'hidden';
    if (state.isPageHidden) {
      if (hasUnfinishedTransfers()) {
        elements.peerHint.textContent = '页面已进入后台，系统可能暂停传输；请尽量保持前台和屏幕点亮。';
        statusUI.log('页面已进入后台，移动端浏览器可能暂停传输');
      }
      return;
    }

    if (hasUnfinishedTransfers()) {
      elements.peerHint.textContent = '页面已回到前台，正在尝试保持屏幕常亮并继续传输。';
      void syncWakeLock();
    }
  });
}

function handleTransferActivity() {
  void syncWakeLock();
}

function hasUnfinishedTransfers() {
  for (const task of state.sendTasks.values()) {
    if (!task.done) return true;
  }
  return state.receiveTasks.size > 0;
}

async function syncWakeLock() {
  if (!hasUnfinishedTransfers()) {
    await releaseWakeLock();
    return;
  }

  if (document.visibilityState !== 'visible') return;
  if (!('wakeLock' in navigator)) {
    if (!state.wakeLockUnsupportedLogged) {
      state.wakeLockUnsupportedLogged = true;
      statusUI.log('当前浏览器不支持屏幕常亮，请手动保持屏幕点亮');
    }
    return;
  }
  if (state.wakeLockSentinel || state.wakeLockRequestInFlight) return;

  try {
    state.wakeLockRequestInFlight = navigator.wakeLock.request('screen');
    state.wakeLockSentinel = await state.wakeLockRequestInFlight;
    state.wakeLockErrorLogged = false;
    state.wakeLockSentinel.addEventListener('release', handleWakeLockRelease);
    statusUI.log('已启用屏幕常亮，传输期间请保持页面前台');
  } catch (error) {
    if (!state.wakeLockErrorLogged) {
      state.wakeLockErrorLogged = true;
      statusUI.log(`屏幕常亮启用失败：${error.message}`);
    }
  } finally {
    state.wakeLockRequestInFlight = null;
  }
}

async function releaseWakeLock() {
  if (!state.wakeLockSentinel) return;
  const sentinel = state.wakeLockSentinel;
  state.wakeLockSentinel = null;
  try {
    await sentinel.release();
  } catch {}
}

function handleWakeLockRelease() {
  state.wakeLockSentinel = null;
  if (hasUnfinishedTransfers() && document.visibilityState === 'visible') {
    statusUI.log('屏幕常亮已失效，页面回到前台时会重新尝试启用');
  }
}
