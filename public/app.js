import { BUFFER_HIGH_WATER } from './modules/config.js';
import { elements } from './modules/elements.js';
import { state } from './modules/state.js';
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
const peerRef = {};
const signalingRef = {};

const transferUI = createTransferUI({
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
});

peerRef.api = createPeerService({
  elements,
  state,
  statusUI,
  sendService,
  receiveService,
  getSignalApi: () => signalingRef.api,
});

signalingRef.api = createSignalingService({
  elements,
  state,
  statusUI,
  peerService: peerRef.api,
});

init();

function init() {
  statusUI.updateRoomUrl(state.roomId);
  statusUI.renderRoomInfo();
  bindEvents();
  exportActions.updateBatchActions();
  receiveService.updateReceiveModeStatus();
  signalingRef.api.connectSignal();
}

function bindEvents() {
  elements.copyLinkBtn.addEventListener('click', statusUI.copyShareLink);
  elements.reconnectBtn.addEventListener('click', peerRef.api.reconnectSession);
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
    sendService.sendFiles([...event.dataTransfer.files]);
  });

  elements.selectReceiveDirBtn.addEventListener('click', receiveService.selectReceiveDirectory);

  elements.selectAllFiles.addEventListener('change', () => {
    exportActions.setAllReceivedSelection(elements.selectAllFiles.checked);
  });

  elements.downloadSelectedBtn.addEventListener('click', exportActions.downloadSelectedFilesDirectly);
  elements.saveImagesBtn.addEventListener('click', exportActions.saveSelectedImagesToAlbum);
  elements.downloadZipBtn.addEventListener('click', exportActions.downloadSelectedFilesAsZip);
  elements.clearLogBtn.addEventListener('click', statusUI.clearLog);
}
