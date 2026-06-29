import { CHUNK_SIZE, MAX_CONCURRENT_SENDS } from '../config.js';
import {
  buildTransferMeta,
  createTaskId,
  createTransferStats,
  formatBytes,
  updateTransferStats,
} from '../utils/common.js';

export function createSendService({ elements, state, statusUI, transferUI, channelApi, onTransferActivity = () => {} }) {
  const { log, notify } = statusUI;
  const { createTransferItem, updateTransferItem, updateOverallProgress } = transferUI;

  function sendFiles(files) {
    const validFiles = files.filter(Boolean);
    if (!validFiles.length) return;

    state.sendQueue.push(...validFiles.map(createSendTask));
    log(`已加入发送队列：${validFiles.length} 个文件`);
    notifyTransferActivity();

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
      interrupted: false,
      resumePending: false,
      resumeAcked: false,
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
      if (channelApi.isChannelReady() && hasRunnableQueuedTask()) {
        processSendQueue();
      }
    }
  }

  function fillActiveSendTasks() {
    while (state.activeSendTasks.length < MAX_CONCURRENT_SENDS && state.sendQueue.length) {
      const task = state.sendQueue[0];
      if (!task || task.done) {
        state.sendQueue.shift();
        continue;
      }

      if (task.interrupted && task.metaSent && !task.resumeAcked) {
        requestTaskResume(task);
        break;
      }

      state.sendQueue.shift();
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
    notifyTransferActivity();
  }

  async function sendNextChunk(task) {
    if (task.done || task.interrupted || task.offset >= task.size) return;

    await waitForBuffer();
    if (!channelApi.isChannelReady()) return;

    const chunk = await task.file.slice(task.offset, task.offset + CHUNK_SIZE).arrayBuffer();
    if (!channelApi.isChannelReady() || task.interrupted) return;
    channelApi.sendData({ type: 'file-chunk', id: task.id, size: chunk.byteLength, seq: task.seq });
    channelApi.sendData(chunk);
    task.offset += chunk.byteLength;
    task.seq += 1;
    updateTransferStats(task, task.offset);
    updateTransferItem(task.element, task.size ? task.offset / task.size : 1, buildTransferMeta(task, task.offset, task.size));
    notifyTransferActivity();
  }

  function finishSendTask(task) {
    if (task.done) return;
    task.done = true;
    task.interrupted = false;
    task.resumePending = false;
    task.resumeAcked = false;
    state.sendQueue = state.sendQueue.filter((queuedTask) => queuedTask !== task);
    if (channelApi.isChannelReady()) {
      channelApi.sendData({ type: 'file-end', id: task.id });
    }
    updateTransferItem(task.element, 1, `${formatBytes(task.size)} · 已发送`);
    notifyTransferActivity();
    log(`已发送：${task.name}`);
  }

  function waitForBuffer() {
    const channel = channelApi.getChannel();
    if (!channel || channel.bufferedAmount < channelApi.bufferHighWater) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const cleanup = () => {
        channel.removeEventListener('bufferedamountlow', cleanup);
        channel.removeEventListener('close', cleanup);
        channel.removeEventListener('error', cleanup);
        resolve();
      };
      channel.addEventListener('bufferedamountlow', cleanup);
      channel.addEventListener('close', cleanup);
      channel.addEventListener('error', cleanup);
    });
  }

  function cleanupInterruptedSends({ preserveTransfers = true } = {}) {
    state.isSending = false;
    const activeTasks = state.activeSendTasks.filter((task) => !task.done);
    state.activeSendTasks = [];
    resetQueuedResumeState();

    if (preserveTransfers) {
      const resumableTasks = activeTasks.filter((task) => task.metaSent || task.offset > 0);
      for (const task of resumableTasks) {
        markTaskInterrupted(task, '等待重连续传');
      }
      prependUniqueSendTasks(resumableTasks);
      if (resumableTasks.length) {
        notify('面对面快传', '传输已中断，回到页面后可点击局部重连续传。');
      }
    } else {
      for (const task of activeTasks) {
        updateTransferItem(task.element, task.size ? task.offset / task.size : 0, `${formatBytes(task.offset)} · 传输中断`);
      }
    }

    notifyTransferActivity();
  }

  function resetQueuedResumeState() {
    for (const task of state.sendQueue) {
      if (!task.done && task.interrupted) {
        task.resumePending = false;
        task.resumeAcked = false;
      }
    }
  }

  function markTaskInterrupted(task, status) {
    task.interrupted = true;
    task.resumePending = false;
    task.resumeAcked = false;
    updateTransferItem(task.element, task.size ? task.offset / task.size : 0, `${formatBytes(task.offset)} / ${formatBytes(task.size)} · ${status}`);
  }

  function prependUniqueSendTasks(tasks) {
    if (!tasks.length) return;
    const taskSet = new Set(tasks);
    state.sendQueue = state.sendQueue.filter((task) => !taskSet.has(task));
    state.sendQueue.unshift(...tasks);
  }

  function resumeInterruptedSends() {
    if (!channelApi.isChannelReady()) return;
    requestNextInterruptedTaskResume();
    processSendQueue();
  }

  function requestNextInterruptedTaskResume() {
    const task = state.sendQueue.find((queuedTask) => queuedTask.interrupted && queuedTask.metaSent && !queuedTask.done && !queuedTask.resumeAcked);
    if (task) requestTaskResume(task);
  }

  function requestTaskResume(task) {
    if (!channelApi.isChannelReady() || task.resumePending) return;
    task.resumePending = true;
    task.resumeAcked = false;
    channelApi.sendData({ type: 'file-resume-offer', id: task.id, name: task.name, size: task.size, mime: task.mime });
    updateTransferItem(task.element, task.size ? task.offset / task.size : 0, `${formatBytes(task.offset)} / ${formatBytes(task.size)} · 正在协商续传`);
    notifyTransferActivity();
    log(`请求续传：${task.name}`);
  }

  function handleResumeAck(message) {
    const task = state.sendTasks.get(message.id);
    if (!task || task.done) return;

    const offset = clampOffset(message.offset, task.size);
    const seq = Number.isFinite(Number(message.seq)) && Number(message.seq) >= 0
      ? Number(message.seq)
      : Math.floor(offset / CHUNK_SIZE);

    task.offset = offset;
    task.seq = seq;
    task.interrupted = false;
    task.resumePending = false;
    task.resumeAcked = true;
    task.transferStats = createTransferStats();
    updateTransferItem(task.element, task.size ? task.offset / task.size : 0, buildTransferMeta(task, task.offset, task.size));
    notifyTransferActivity();
    notify('面对面快传', `已恢复续传：${task.name}`);
    log(`已确认续传：${task.name}，从 ${formatBytes(task.offset)} 继续`);

    if (task.offset >= task.size) {
      finishSendTask(task);
    }
    processSendQueue();
  }

  function clampOffset(value, size) {
    const offset = Number(value);
    if (!Number.isFinite(offset) || offset <= 0) return 0;
    return Math.min(Math.max(0, Math.floor(offset)), size);
  }

  function hasRunnableQueuedTask() {
    const task = state.sendQueue.find((queuedTask) => !queuedTask.done);
    if (!task) return false;
    return !(task.interrupted && task.metaSent && task.resumePending && !task.resumeAcked);
  }

  function notifyTransferActivity() {
    updateOverallProgress();
    onTransferActivity();
  }

  return {
    sendFiles,
    processSendQueue,
    resumeInterruptedSends,
    handleResumeAck,
    cleanupInterruptedSends,
  };
}
