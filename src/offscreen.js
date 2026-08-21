'use strict';

/** @type {Map<string, string>} */
const livingUrls = new Map();

function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return false;

  if (msg.type === 'OFFSCREEN_CREATE_BLOB_URL') {
    try {
      const mime = String(msg.mime || 'application/zip');
      const base64 = String(msg.base64 || '');
      if (!base64) {
        sendResponse({ ok: false, error: 'ZIP vazio (sem bytes)' });
        return true;
      }
      const u8 = base64ToUint8Array(base64);
      if (!u8.length) {
        sendResponse({ ok: false, error: 'ZIP vazio (decode)' });
        return true;
      }
      const blob = new Blob([u8], { type: mime });
      const url = URL.createObjectURL(blob);
      livingUrls.set(url, url);
      sendResponse({ ok: true, url });
    } catch (err) {
      sendResponse({
        ok: false,
        error: String(err && err.message ? err.message : err),
      });
    }
    return true;
  }

  if (msg.type === 'OFFSCREEN_REVOKE_BLOB_URL') {
    const url = String(msg.url || '');
    if (url && livingUrls.has(url)) {
      try {
        URL.revokeObjectURL(url);
      } catch {
        /* ignore */
      }
      livingUrls.delete(url);
    }
    sendResponse({ ok: true });
    return true;
  }

  return false;
});
