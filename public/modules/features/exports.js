import { escapeHtml, formatDateForFileName, isImageFile } from '../utils/common.js';
import { createZipBlob } from '../utils/zip.js';

export function createExportActions({ elements, state, statusUI }) {
  const { log } = statusUI;

  function setAllReceivedSelection(checked) {
    for (const [fileId, file] of state.completedFiles) {
      if (!isBlobBackedFile(file)) continue;
      if (checked) {
        state.selectedFileIds.add(fileId);
      } else {
        state.selectedFileIds.delete(fileId);
      }
    }

    elements.receiveList.querySelectorAll('.transfer-item').forEach((item) => {
      const checkbox = item.querySelector('.file-checkbox');
      if (checkbox && !checkbox.disabled) {
        checkbox.checked = checked;
      }
    });

    updateBatchActions();
  }

  function updateBatchActions() {
    const total = [...state.completedFiles.values()].filter(isBlobBackedFile).length;
    const selected = getSelectedCompletedFiles().length;

    elements.selectAllFiles.disabled = total === 0;
    elements.selectAllFiles.checked = total > 0 && selected === total;
    elements.selectAllFiles.indeterminate = selected > 0 && selected < total;
    elements.downloadSelectedBtn.disabled = selected === 0;
    elements.saveImagesBtn.disabled = selected === 0;
    elements.downloadZipBtn.disabled = selected === 0;
  }

  function getSelectedCompletedFiles() {
    return [...state.selectedFileIds]
      .map((fileId) => state.completedFiles.get(fileId))
      .filter(isBlobBackedFile);
  }

  function isBlobBackedFile(file) {
    return Boolean(file?.blob && file?.url);
  }

  function downloadSelectedFilesDirectly() {
    const files = getSelectedCompletedFiles();
    if (!files.length) return;

    files.forEach((file, index) => {
      setTimeout(() => triggerDownload(file.url, file.name), index * 250);
    });
    log(`开始直接下载：${files.length} 个文件`);
  }

  function saveSelectedImagesToAlbum() {
    const files = getSelectedCompletedFiles();
    if (!files.length) return;

    const nonImages = files.filter((file) => !isImageFile(file));
    if (nonImages.length) {
      log(`保存到相册只支持图片，请取消勾选：${nonImages.map((file) => file.name).join('、')}`);
      return;
    }

    saveImagesToAlbum(files);
  }

  async function saveImagesToAlbum(files) {
    const images = files.filter(isImageFile);
    if (!images.length) {
      log('保存到相册只支持图片文件');
      return;
    }

    const shareFiles = images.map((file) => new File([file.blob], file.name, { type: file.mime }));

    if (navigator.canShare?.({ files: shareFiles }) && navigator.share) {
      try {
        await navigator.share({ files: shareFiles, title: '保存图片' });
        log(`已调起系统面板：${images.length} 张图片`);
        return;
      } catch (error) {
        if (error.name === 'AbortError') {
          log('已取消保存图片');
          return;
        }
        log(`调起系统面板失败：${error.message}`);
      }
    }

    if (images.length === 1) {
      openImagePreview(images[0]);
      log('当前浏览器不支持直接保存到相册，请在新页面长按图片保存');
      return;
    }

    log('当前浏览器不支持批量保存到相册，请单张点击“保存到相册”或使用直接下载');
  }

  function openImagePreview(file) {
    const preview = window.open('', '_blank');
    if (!preview) {
      window.open(file.url, '_blank');
      return;
    }

    preview.document.write(`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(file.name)}</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0f172a; color: white; font-family: -apple-system, BlinkMacSystemFont, sans-serif; }
    main { width: min(100% - 24px, 900px); text-align: center; }
    img { max-width: 100%; max-height: 82vh; border-radius: 16px; background: white; }
    p { color: #cbd5e1; }
  </style>
</head>
<body>
  <main>
    <img src="${file.url}" alt="${escapeHtml(file.name)}" />
    <p>如果没有出现系统保存面板，请长按图片选择“保存到照片”。</p>
  </main>
</body>
</html>`);
    preview.document.close();
  }

  async function downloadSelectedFilesAsZip() {
    const files = getSelectedCompletedFiles();
    if (!files.length) return;

    elements.downloadZipBtn.disabled = true;
    elements.downloadZipBtn.textContent = '打包中...';

    try {
      const zipBlob = await createZipBlob(files);
      const zipUrl = URL.createObjectURL(zipBlob);
      triggerDownload(zipUrl, `face2face-files-${formatDateForFileName(new Date())}.zip`);
      setTimeout(() => URL.revokeObjectURL(zipUrl), 60000);
      log(`已生成 ZIP：${files.length} 个文件`);
    } finally {
      elements.downloadZipBtn.textContent = '下载 ZIP';
      updateBatchActions();
    }
  }

  function triggerDownload(url, name) {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    anchor.style.display = 'none';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  }

  return {
    setAllReceivedSelection,
    updateBatchActions,
    getSelectedCompletedFiles,
    isBlobBackedFile,
    downloadSelectedFilesDirectly,
    saveSelectedImagesToAlbum,
    saveImagesToAlbum,
    openImagePreview,
    downloadSelectedFilesAsZip,
    triggerDownload,
  };
}
