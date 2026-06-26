import { CHUNK_SIZE, MAX_CONCURRENT_SENDS } from '../config.js';
import {
  buildTransferMeta,
  createTaskId,
  createTransferStats,
  formatBytes,
  updateTransferStats,
} from '../utils/common.js';

export function createSendService({ elements, state, statusUI, transferUI, channelApi }) {
  const { log } = statusUI;
  const { createTransferItem, updateTransferItem } = transferUI;

  function sendFiles(files) {
    const validFiles = files.filter(Boolean);
    if (!validFiles.length) return;

    state.sendQueue.push(...validFiles.map(createSendTask));
    log(`已加入发送队列：${validFiles.length} 个文件`);

    if (!channelApi.isChannelReady()) {
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
    if (state.isSending || !channelApi.isChannelReady()) return;
    state.isSending = true;

    try {
      while (channelApi.isChannelReady() && (state.sendQueue.length || state.activeSendTasks.length)) {
        fillActiveSendTasks();
        if (!state.activeSendTasks.length) break;

        for (const task of [...state.activeSendTasks]) {
          if (!channelApi.isChannelReady()) break;
          await sendNextChunk(task);
          if (task.offset >= task.size) {
            finishSendTask(task);
          }
        }

        state.activeSendTasks = state.activeSendTasks.filter((task) => !task.done);
      }
    } finally {
      state.isSending = false;
      if (channelApi.isChannelReady() && state.sendQueue.length) {
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
    channelApi.sendData({ type: 'file-meta', id: task.id, name: task.name, size: task.size, mime: task.mime });
    updateTransferItem(task.element, 0, buildTransferMeta(task, 0, task.size));
  }

  async function sendNextChunk(task) {
    if (task.done || task.offset >= task.size) return;

    await waitForBuffer();
    if (!channelApi.isChannelReady()) return;

    const chunk = await task.file.slice(task.offset, task.offset + CHUNK_SIZE).arrayBuffer();
    channelApi.sendData({ type: 'file-chunk', id: task.id, size: chunk.byteLength, seq: task.seq });
    channelApi.sendData(chunk);
    task.offset += chunk.byteLength;
    task.seq += 1;
    updateTransferStats(task, task.offset);
    updateTransferItem(task.element, task.size ? task.offset / task.size : 1, buildTransferMeta(task, task.offset, task.size));
  }

  function finishSendTask(task) {
    if (task.done) return;
    task.done = true;
    channelApi.sendData({ type: 'file-end', id: task.id });
    updateTransferItem(task.element, 1, `${formatBytes(task.size)} · 已发送`);
    log(`已发送：${task.name}`);
  }

  function waitForBuffer() {
    const channel = channelApi.getChannel();
    if (!channel || channel.bufferedAmount < channelApi.bufferHighWater) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const handleLow = () => {
        channel.removeEventListener('bufferedamountlow', handleLow);
        resolve();
      };
      channel.addEventListener('bufferedamountlow', handleLow);
    });
  }

  function cleanupInterruptedSends() {
    state.isSending = false;

    for (const task of state.activeSendTasks) {
      updateTransferItem(task.element, task.size ? task.offset / task.size : 0, `${formatBytes(task.offset)} · 传输中断`);
    }
    state.activeSendTasks = [];
  }

  return {
    sendFiles,
    processSendQueue,
    cleanupInterruptedSends,
  };
}
