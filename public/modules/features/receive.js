import {
  appendFileNameSuffix,
  buildTransferMeta,
  createTransferStats,
  formatBytes,
  isImageFile,
  parseJson,
  sanitizeFileName,
  toArrayBuffer,
  updateTransferStats,
} from '../utils/common.js';

export function createReceiveService({ elements, state, statusUI, transferUI, exportActions }) {
  const { log } = statusUI;
  const {
    appendSavedLabel,
    appendTransferAction,
    createTransferItem,
    enableTransferSelection,
    hideTransferSelection,
    setTransferThumbnail,
    updateTransferItem,
  } = transferUI;

  function enqueueIncomingMessage(event) {
    state.dataMessageChain = state.dataMessageChain
      .then(() => handleDataMessage(event))
      .catch((error) => log(`处理传输消息失败：${error.message}`));
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
    if (sinkType === 'fs') {
      hideTransferSelection(task.element);
    }
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
    appendTransferAction(task.element, action);

    state.receiveTasks.delete(fileId);
    if (isImageFile(state.completedFiles.get(fileId))) {
      const saveAction = document.createElement('button');
      saveAction.type = 'button';
      saveAction.className = 'album-link';
      saveAction.textContent = '保存到相册';
      saveAction.addEventListener('click', () => exportActions.saveImagesToAlbum([state.completedFiles.get(fileId)]));
      appendTransferAction(task.element, saveAction);
    }

    exportActions.updateBatchActions();
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
      exportActions.updateBatchActions();
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
      appendTransferAction(task.element, action);

      const completedFile = state.completedFiles.get(fileId);
      if (isImageFile(completedFile)) {
        const saveAction = document.createElement('button');
        saveAction.type = 'button';
        saveAction.className = 'album-link';
        saveAction.textContent = '保存到相册';
        saveAction.addEventListener('click', () => exportActions.saveImagesToAlbum([completedFile]));
        appendTransferAction(task.element, saveAction);
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
      exportActions.updateBatchActions();
    }
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

  function cleanupInterruptedReceives() {
    state.pendingChunkHeaders = [];
    state.dataMessageChain = Promise.resolve();

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

  return {
    enqueueIncomingMessage,
    selectReceiveDirectory,
    updateReceiveModeStatus,
    cleanupInterruptedReceives,
  };
}
