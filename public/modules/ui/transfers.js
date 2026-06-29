import { formatBytes, getFileBadge } from '../utils/common.js';

export function createTransferUI({ elements, state, getExportActions }) {
  function appendSavedLabel(item) {
    const label = document.createElement('span');
    label.className = 'saved-label';
    label.textContent = '已保存';
    appendTransferAction(item, label);
  }

  function appendTransferAction(item, action) {
    item.querySelector('.transfer-actions').append(action);
  }

  function createTransferItem(container, file) {
    if (container.classList.contains('empty-list')) {
      container.classList.remove('empty-list');
      container.innerHTML = '';
    }

    const item = document.createElement('div');
    item.className = `transfer-item${file.selectable ? ' is-selectable' : ''}`;
    item.dataset.id = file.id;
    item.innerHTML = `
      ${file.selectable ? '<label class="file-select"><input class="file-checkbox" type="checkbox" disabled /></label>' : ''}
      <div class="file-thumb"></div>
      <div class="transfer-info">
        <strong></strong>
        <span></span>
        <div class="progress-track"><div class="progress-bar"></div></div>
      </div>
      <div class="transfer-actions"></div>
    `;
    item.querySelector('strong').textContent = file.name;
    item.querySelector('span').textContent = file.meta;
    setTransferThumbnail(item, file);
    container.prepend(item);
    return item;
  }

  function updateTransferItem(item, progress, meta) {
    item.querySelector('.progress-bar').style.width = `${Math.max(0, Math.min(1, progress)) * 100}%`;
    item.querySelector('span').textContent = meta;
  }

  function setTransferThumbnail(item, file) {
    const thumb = item.querySelector('.file-thumb');
    thumb.innerHTML = '';

    if (file.thumbnailUrl) {
      const image = document.createElement('img');
      image.src = file.thumbnailUrl;
      image.alt = '';
      thumb.append(image);
      return;
    }

    const badge = document.createElement('span');
    badge.textContent = getFileBadge(file.mime || '');
    thumb.append(badge);
  }

  function enableTransferSelection(item, fileId) {
    const checkbox = item.querySelector('.file-checkbox');
    if (!checkbox) return;

    checkbox.disabled = false;
    checkbox.checked = state.selectedFileIds.has(fileId);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) {
        state.selectedFileIds.add(fileId);
      } else {
        state.selectedFileIds.delete(fileId);
      }
      getExportActions().updateBatchActions();
    });
  }

  function hideTransferSelection(item) {
    item.querySelector('.file-select')?.remove();
    item.classList.remove('is-selectable');
  }

  function updateOverallProgress() {
    updateSendOverallProgress();
    updateReceiveOverallProgress();
  }

  function updateSendOverallProgress() {
    const tasks = [...state.sendTasks.values()];
    const total = tasks.reduce((sum, task) => sum + getTaskSize(task), 0);
    const transferred = tasks.reduce((sum, task) => sum + (task.done ? getTaskSize(task) : Math.min(getTaskSize(task), Number(task.offset) || 0)), 0);
    updateProgressSummary(elements.sendOverallBar, elements.sendOverallMeta, transferred, total, '暂无发送任务');
  }

  function updateReceiveOverallProgress() {
    const receiveTasks = [...state.receiveTasks.values()];
    const completedFiles = [...state.completedFiles.values()];
    const pendingTotal = receiveTasks.reduce((sum, task) => sum + getTaskSize(task), 0);
    const pendingReceived = receiveTasks.reduce((sum, task) => sum + Math.min(getTaskSize(task), Number(task.received) || 0), 0);
    const completedTotal = completedFiles.reduce((sum, file) => sum + getCompletedFileSize(file), 0);
    updateProgressSummary(elements.receiveOverallBar, elements.receiveOverallMeta, pendingReceived + completedTotal, pendingTotal + completedTotal, '暂无接收任务');
  }

  function updateProgressSummary(bar, meta, transferred, total, emptyText) {
    if (!bar || !meta) return;
    const progress = total > 0 ? Math.max(0, Math.min(1, transferred / total)) : 0;
    bar.style.width = `${progress * 100}%`;
    meta.textContent = total > 0
      ? `${formatBytes(transferred)} / ${formatBytes(total)} · ${Math.round(progress * 100)}%`
      : emptyText;
  }

  function getTaskSize(task) {
    return Math.max(0, Number(task?.size) || 0);
  }

  function getCompletedFileSize(file) {
    return Math.max(0, Number(file?.size) || Number(file?.blob?.size) || 0);
  }

  return {
    appendSavedLabel,
    appendTransferAction,
    createTransferItem,
    updateTransferItem,
    setTransferThumbnail,
    enableTransferSelection,
    hideTransferSelection,
    updateOverallProgress,
  };
}
