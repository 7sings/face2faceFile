import { getFileBadge } from '../utils/common.js';

export function createTransferUI({ state, getExportActions }) {
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

  return {
    appendSavedLabel,
    appendTransferAction,
    createTransferItem,
    updateTransferItem,
    setTransferThumbnail,
    enableTransferSelection,
    hideTransferSelection,
  };
}
