// Screenshot capture helpers. captureVisibleTab needs only activeTab + a user
// gesture (action click, context-menu click, keyboard command) — no host perms.
// Works in the popup, side panel, and the background service worker
// (OffscreenCanvas — no DOM needed for cropping).

// Capture the visible area of the given window's active tab as a PNG Blob.
export async function captureVisible(windowId) {
  const dataUrl = await new Promise((resolve, reject) => {
    chrome.tabs.captureVisibleTab(windowId, { format: "png" }, (url) => {
      if (chrome.runtime.lastError || !url) {
        reject(new Error(chrome.runtime.lastError?.message || "capture failed"));
      } else {
        resolve(url);
      }
    });
  });
  return dataUrlToBlob(dataUrl);
}

// Crop a PNG blob to a CSS-pixel rect (scaled by devicePixelRatio).
export async function cropBlob(blob, rect, dpr = 1) {
  const bitmap = await createImageBitmap(blob);
  const sx = Math.max(0, Math.round(rect.x * dpr));
  const sy = Math.max(0, Math.round(rect.y * dpr));
  const sw = Math.min(bitmap.width - sx, Math.round(rect.width * dpr));
  const sh = Math.min(bitmap.height - sy, Math.round(rect.height * dpr));
  if (sw <= 0 || sh <= 0) throw new Error("empty selection");
  const canvas = new OffscreenCanvas(sw, sh);
  canvas.getContext("2d").drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
  bitmap.close();
  return canvas.convertToBlob({ type: "image/png" });
}

async function dataUrlToBlob(dataUrl) {
  const res = await fetch(dataUrl);
  return res.blob();
}

// Pixel dimensions of an image blob (used to size the Docs inline image).
export async function blobDimensions(blob) {
  const bitmap = await createImageBitmap(blob);
  const dims = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return dims;
}
