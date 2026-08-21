const DEFAULTS = {
  destinatario: '',
  filterMode: 'days',
  daysValue: '7',
  periodValue: 'week',
  customStart: '',
  customEnd: '',
};

const OFFSCREEN_PATH = 'src/offscreen.html';
/** @type {Promise<void> | null} */
let offscreenCreating = null;

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(null, (current) => {
    chrome.storage.sync.set({ ...DEFAULTS, ...current });
  });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return false;

  // Handled by the offscreen document, not the service worker.
  if (msg.type === 'OFFSCREEN_CREATE_BLOB_URL' || msg.type === 'OFFSCREEN_REVOKE_BLOB_URL') {
    return false;
  }

  if (msg.type === 'OPEN_OPTIONS') {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'DOWNLOAD_URL') {
    startDownload(String(msg.url || ''), msg.filename).then((res) => sendResponse(res));
    return true;
  }

  if (msg.type === 'DOWNLOAD_BATCH') {
    const items = Array.isArray(msg.items) ? msg.items : [];
    // Sequential enough for Chrome download shelf; still fast (no artificial sleeps).
    (async () => {
      const results = [];
      for (const item of items) {
        results.push(await startDownload(String(item?.url || ''), item?.filename));
      }
      sendResponse({
        ok: results.every((r) => r && r.ok),
        results,
      });
    })();
    return true;
  }

  if (msg.type === 'FETCH_ATTACHMENT') {
    const url = toSafeAttachmentUrl(String(msg.url || ''));
    (async () => {
      try {
        const res = await fetch(url, { credentials: 'include', redirect: 'follow', cache: 'no-store' });
        if (!res.ok) {
          sendResponse({ ok: false, error: `HTTP ${res.status}` });
          return;
        }
        const buf = await res.arrayBuffer();
        const bytes = Array.from(new Uint8Array(buf));
        sendResponse({
          ok: true,
          bytes,
          contentType: res.headers.get('content-type') || 'application/octet-stream',
        });
      } catch (err) {
        sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
      }
    })();
    return true;
  }

  /**
   * Content-script blob: URLs are unreliable with chrome.downloads / <a download>
   * after the user-gesture window closes. Decode bytes in an offscreen document
   * (MV3 SW has no URL.createObjectURL), then chrome.downloads so the native
   * shelf / bubble registers the file.
   */
  if (msg.type === 'DOWNLOAD_BYTES') {
    const filename = sanitizeFilename(msg.filename) || 'BMDs.zip';
    const mime = String(msg.mime || 'application/zip');
    const base64 = String(msg.base64 || '');
    (async () => {
      let objectUrl = '';
      let usedOffscreen = false;
      try {
        if (!base64) {
          sendResponse({ ok: false, error: 'ZIP vazio (sem bytes)' });
          return;
        }

        const built = await buildDownloadUrl(base64, mime);
        objectUrl = built.url;
        usedOffscreen = built.viaOffscreen;

        const uiOk = await ensureDownloadsUiEnabled();

        // Flat name in Downloads root so the zip shows clearly in chrome://downloads
        // and the native shelf/bubble (same as a normal Chrome download).
        // If another extension keeps the shelf/bubble disabled, use Save dialog
        // so the user still gets visible Chrome download UI.
        const forceSaveAs = !uiOk;
        let res = await startDownload(objectUrl, filename, {
          flat: true,
          saveAs: forceSaveAs,
          waitMs: 120000,
        });

        // If quiet download failed, force Save dialog (visible Chrome UI).
        if (!res.ok && !forceSaveAs) {
          console.warn('[Hagap BMDs] quiet download failed, retrying with saveAs', res.error);
          await ensureDownloadsUiEnabled();
          res = await startDownload(objectUrl, filename, {
            flat: true,
            saveAs: true,
            waitMs: 120000,
          });
        }

        sendResponse(res);
      } catch (err) {
        console.error('[Hagap BMDs] DOWNLOAD_BYTES failed', err);
        sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
      } finally {
        // Revoke only after chrome.downloads has finished (or failed). Early revoke
        // cancels the blob fetch and leaves a fake "success" with no file.
        if (objectUrl) {
          await revokeDownloadUrl(objectUrl, usedOffscreen);
        }
      }
    })();
    return true;
  }

  return false;
});

/**
 * Prefer offscreen blob: URL (works for large ZIPs). Fall back to data: URL when
 * offscreen is unavailable and payload is small enough for chrome.downloads.
 * @param {string} base64
 * @param {string} mime
 * @returns {Promise<{ url: string, viaOffscreen: boolean }>}
 */
async function buildDownloadUrl(base64, mime) {
  try {
    const url = await createBlobUrlViaOffscreen(base64, mime);
    return { url, viaOffscreen: true };
  } catch (offscreenErr) {
    console.warn('[Hagap BMDs] offscreen blob URL failed, trying data: URL', offscreenErr);
    // chrome.downloads data: URLs are limited (~few MB). Prefer fail loudly for huge ZIPs.
    const approxBytes = Math.floor((base64.length * 3) / 4);
    const DATA_URL_MAX = 25 * 1024 * 1024;
    if (approxBytes > DATA_URL_MAX) {
      throw new Error(
        `Offscreen indisponível e ZIP grande demais para data: URL (${Math.round(approxBytes / 1024 / 1024)} MB)`
      );
    }
    return {
      url: `data:${mime};base64,${base64}`,
      viaOffscreen: false,
    };
  }
}

async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_PATH);

  if (chrome.runtime.getContexts) {
    const existing = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [offscreenUrl],
    });
    if (existing.length > 0) return;
  }

  if (offscreenCreating) {
    await offscreenCreating;
    return;
  }

  offscreenCreating = chrome.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['BLOBS'],
      justification: 'Create blob URLs for ZIP downloads (URL.createObjectURL unavailable in MV3 service workers)',
    })
    .catch((err) => {
      const msg = String(err && err.message ? err.message : err);
      // Already open from a race: treat as success.
      if (/only a single offscreen/i.test(msg)) return;
      throw err;
    })
    .finally(() => {
      offscreenCreating = null;
    });

  await offscreenCreating;
}

/**
 * @param {string} base64
 * @param {string} mime
 * @returns {Promise<string>}
 */
function createBlobUrlViaOffscreen(base64, mime) {
  return ensureOffscreenDocument().then(
    () =>
      new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          { type: 'OFFSCREEN_CREATE_BLOB_URL', base64, mime },
          (res) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
              return;
            }
            if (!res || !res.ok || !res.url) {
              reject(new Error((res && res.error) || 'offscreen não criou blob URL'));
              return;
            }
            resolve(res.url);
          }
        );
      })
  );
}

/**
 * @param {string} url
 * @param {boolean} viaOffscreen
 */
async function revokeDownloadUrl(url, viaOffscreen) {
  if (!url) return;
  if (viaOffscreen && url.startsWith('blob:')) {
    try {
      await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'OFFSCREEN_REVOKE_BLOB_URL', url }, () => {
          void chrome.runtime.lastError;
          resolve();
        });
      });
    } catch {
      /* ignore */
    }
    return;
  }
  if (url.startsWith('blob:')) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      /* ignore */
    }
  }
}

function sanitizeFilename(name) {
  if (!name || typeof name !== 'string') return '';
  return name
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

/** Prefer Gmail attachment download disposition (not inline preview). */
function toSafeAttachmentUrl(url) {
  const raw = String(url || '');
  if (!raw || raw.startsWith('blob:') || raw.startsWith('data:')) return raw;
  try {
    const u = new URL(raw);
    if (
      u.hostname.includes('mail.google.com') ||
      u.hostname.includes('googleusercontent.com')
    ) {
      u.searchParams.set('disp', 'safe');
    }
    return u.toString();
  } catch {
    return raw;
  }
}

/**
 * Make sure Chrome's native Downloads UI (shelf or omnibox bubble) is allowed
 * to appear. Other extensions can disable it via setUiOptions/setShelfEnabled.
 * @returns {Promise<boolean>} true if UI enable succeeded (or API missing / noop)
 */
async function ensureDownloadsUiEnabled() {
  try {
    if (chrome.downloads.setUiOptions) {
      await chrome.downloads.setUiOptions({ enabled: true });
      return true;
    }
    if (chrome.downloads.setShelfEnabled) {
      chrome.downloads.setShelfEnabled(true);
      if (chrome.runtime.lastError) {
        console.warn('[Hagap BMDs] setShelfEnabled', chrome.runtime.lastError.message);
        return false;
      }
    }
    return true;
  } catch (err) {
    console.warn('[Hagap BMDs] ensureDownloadsUiEnabled', err);
    return false;
  }
}

/**
 * Start a download and wait until Chrome marks it complete or interrupted.
 * Queued-only / pending "success" was the silent failure: toast advanced with no
 * file and no native Downloads UI.
 *
 * @param {string} url
 * @param {string} [filename]
 * @param {{ flat?: boolean, saveAs?: boolean, waitMs?: number }} [options]
 */
function startDownload(url, filename, options = {}) {
  return new Promise((resolve) => {
    if (!url) {
      resolve({ ok: false, error: 'URL vazia' });
      return;
    }

    const finalUrl = toSafeAttachmentUrl(url);
    const flat = !!options.flat;
    const saveAs = !!options.saveAs;
    const waitMs = typeof options.waitMs === 'number' ? options.waitMs : 8000;

    /** @type {chrome.downloads.DownloadOptions} */
    const opts = {
      url: finalUrl,
      conflictAction: 'uniquify',
      saveAs,
    };

    const safeName = sanitizeFilename(filename);
    if (safeName) {
      opts.filename = flat ? safeName : `BMDs/${safeName}`;
    }

    chrome.downloads.download(opts, (downloadId) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      if (downloadId == null) {
        resolve({ ok: false, error: 'downloadId vazio' });
        return;
      }

      let settled = false;
      let sawInProgress = false;

      const finish = (res) => {
        if (settled) return;
        settled = true;
        chrome.downloads.onChanged.removeListener(onChanged);
        clearTimeout(timer);
        resolve(res);
      };

      const onChanged = (delta) => {
        if (delta.id !== downloadId) return;
        if (delta.state?.current === 'in_progress') {
          sawInProgress = true;
        }
        if (delta.state?.current === 'complete') {
          finish({ ok: true, id: downloadId, state: 'complete' });
        } else if (delta.state?.current === 'interrupted') {
          finish({
            ok: false,
            error: delta.error?.current || 'interrupted',
            id: downloadId,
          });
        }
      };

      chrome.downloads.onChanged.addListener(onChanged);

      // If already finished very fast
      chrome.downloads.search({ id: downloadId }, (results) => {
        const item = results && results[0];
        if (!item) return;
        if (item.state === 'in_progress') sawInProgress = true;
        if (item.state === 'complete') finish({ ok: true, id: downloadId, state: 'complete' });
        if (item.state === 'interrupted') {
          finish({ ok: false, error: item.error || 'interrupted', id: downloadId });
        }
      });

      const timer = setTimeout(() => {
        chrome.downloads.search({ id: downloadId }, (results) => {
          const item = results && results[0];
          if (item?.state === 'complete') {
            finish({ ok: true, id: downloadId, state: 'complete' });
            return;
          }
          if (item?.state === 'interrupted') {
            finish({ ok: false, error: item.error || 'interrupted', id: downloadId });
            return;
          }
          // Still in progress: accept only if Chrome registered a real download id
          // and we observed progress (native UI should already be visible).
          if (item?.state === 'in_progress' || sawInProgress) {
            finish({ ok: true, id: downloadId, state: 'in_progress' });
            return;
          }
          finish({
            ok: false,
            error: 'Download não confirmado pelo Chrome (sem progresso)',
            id: downloadId,
          });
        });
      }, waitMs);
    });
  });
}
