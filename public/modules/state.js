import { createPeerId, createRoomCode, getRoomFromUrl } from './utils/common.js';

export const iceConfigCache = {
  value: null,
  expiresAt: 0,
  inFlight: null,
};

export const state = {
  roomId: getRoomFromUrl() || createRoomCode(),
  peerId: createPeerId(),
  socket: null,
  remotePeerId: '',
  connection: null,
  channel: null,
  connectionType: '',
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
