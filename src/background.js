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
  if (
    msg.type === 'OFFSCREEN_CREATE_BLOB_URL' ||
    msg.type === 'OFFSCREEN_REVOKE_BLOB_URL' ||
    msg.type === 'OFFSCREEN_BLOB_BEGIN' ||
    msg.type === 'OFFSCREEN_BLOB_CHUNK' ||
    msg.type === 'OFFSCREEN_BLOB_FINISH' ||
    msg.type === 'OFFSCREEN_BLOB_ABORT' ||
    msg.type === 'OFFSCREEN_ZIP_BEGIN' ||
    msg.type === 'OFFSCREEN_ZIP_ADD' ||
    msg.type === 'OFFSCREEN_ZIP_FILE_BEGIN' ||
    msg.type === 'OFFSCREEN_ZIP_FILE_CHUNK' ||
    msg.type === 'OFFSCREEN_ZIP_FILE_FINISH' ||
    msg.type === 'OFFSCREEN_ZIP_FINISH' ||
    msg.type === 'OFFSCREEN_ZIP_ABORT' ||
    msg.type === 'OFFSCREEN_ZIP_FILE_ABORT'
  ) {
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
      try {
        if (!base64) {
          sendResponse({ ok: false, error: 'ZIP vazio (sem bytes)' });
          return;
        }

        const built = await buildDownloadUrl(base64, mime);
        const res = await downloadObjectUrl(built.url, filename, built.viaOffscreen);
        sendResponse(res);
      } catch (err) {
        console.error('[Hagap BMDs] DOWNLOAD_BYTES failed', err);
        sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
      }
    })();
    return true;
  }

  /**
   * Chunked ZIP transfer: content sends BEGIN + many small CHUNKs + FINISH so a
   * large archive never hits chrome.runtime.sendMessage size limits (~64MB).
   */
  if (msg.type === 'DOWNLOAD_BYTES_BEGIN') {
    const transferId = String(msg.transferId || '');
    const mime = String(msg.mime || 'application/zip');
    const totalBytes = Math.max(0, Number(msg.totalBytes) || 0);
    (async () => {
      try {
        if (!transferId) {
          sendResponse({ ok: false, error: 'transferId vazio' });
          return;
        }
        await ensureOffscreenDocument();
        const res = await sendOffscreenMessage({
          type: 'OFFSCREEN_BLOB_BEGIN',
          transferId,
          mime,
          totalBytes,
        });
        sendResponse(res);
      } catch (err) {
        sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
      }
    })();
    return true;
  }

  if (msg.type === 'DOWNLOAD_BYTES_CHUNK') {
    const transferId = String(msg.transferId || '');
    const base64 = String(msg.base64 || '');
    (async () => {
      try {
        await ensureOffscreenDocument();
        const res = await sendOffscreenMessage({
          type: 'OFFSCREEN_BLOB_CHUNK',
          transferId,
          base64,
        });
        sendResponse(res);
      } catch (err) {
        sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
      }
    })();
    return true;
  }

  if (msg.type === 'DOWNLOAD_BYTES_FINISH') {
    const transferId = String(msg.transferId || '');
    const filename = sanitizeFilename(msg.filename) || 'BMDs.zip';
    (async () => {
      try {
        await ensureOffscreenDocument();
        const finished = await sendOffscreenMessage({
          type: 'OFFSCREEN_BLOB_FINISH',
          transferId,
        });
        if (!finished || !finished.ok || !finished.url) {
          sendResponse({
            ok: false,
            error: (finished && finished.error) || 'offscreen não montou o ZIP',
          });
          return;
        }
        const res = await downloadObjectUrl(finished.url, filename, true);
        sendResponse(res);
      } catch (err) {
        console.error('[Hagap BMDs] DOWNLOAD_BYTES_FINISH failed', err);
        try {
          await sendOffscreenMessage({ type: 'OFFSCREEN_BLOB_ABORT', transferId });
        } catch {
          /* ignore */
        }
        sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
      }
    })();
    return true;
  }

  if (msg.type === 'DOWNLOAD_BYTES_ABORT') {
    const transferId = String(msg.transferId || '');
    (async () => {
      try {
        await sendOffscreenMessage({ type: 'OFFSCREEN_BLOB_ABORT', transferId });
      } catch {
        /* ignore */
      }
      sendResponse({ ok: true });
    })();
    return true;
  }

  /**
   * Streaming ZIP: content ships files one-by-one (or in small base64 chunks).
   * Offscreen holds JSZip and emits ONE blob URL at the end.
   */
  if (msg.type === 'ZIP_BUILD_BEGIN') {
    const sessionId = String(msg.sessionId || '');
    (async () => {
      try {
        if (!sessionId) {
          sendResponse({ ok: false, error: 'sessionId vazio' });
          return;
        }
        await ensureOffscreenDocument();
        const res = await sendOffscreenMessage({ type: 'OFFSCREEN_ZIP_BEGIN', sessionId });
        sendResponse(res);
      } catch (err) {
        sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
      }
    })();
    return true;
  }

  if (msg.type === 'ZIP_BUILD_ADD') {
    const sessionId = String(msg.sessionId || '');
    const entryName = String(msg.entryName || '');
    const base64 = String(msg.base64 || '');
    (async () => {
      try {
        await ensureOffscreenDocument();
        const res = await sendOffscreenMessage({
          type: 'OFFSCREEN_ZIP_ADD',
          sessionId,
          entryName,
          base64,
        });
        sendResponse(res);
      } catch (err) {
        sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
      }
    })();
    return true;
  }

  if (msg.type === 'ZIP_BUILD_FILE_BEGIN') {
    const sessionId = String(msg.sessionId || '');
    const entryName = String(msg.entryName || '');
    const totalBytes = Math.max(0, Number(msg.totalBytes) || 0);
    (async () => {
      try {
        await ensureOffscreenDocument();
        const res = await sendOffscreenMessage({
          type: 'OFFSCREEN_ZIP_FILE_BEGIN',
          sessionId,
          entryName,
          totalBytes,
        });
        sendResponse(res);
      } catch (err) {
        sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
      }
    })();
    return true;
  }

  if (msg.type === 'ZIP_BUILD_FILE_CHUNK') {
    const sessionId = String(msg.sessionId || '');
    const base64 = String(msg.base64 || '');
    (async () => {
      try {
        await ensureOffscreenDocument();
        const res = await sendOffscreenMessage({
          type: 'OFFSCREEN_ZIP_FILE_CHUNK',
          sessionId,
          base64,
        });
        sendResponse(res);
      } catch (err) {
        sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
      }
    })();
    return true;
  }

  if (msg.type === 'ZIP_BUILD_FILE_FINISH') {
    const sessionId = String(msg.sessionId || '');
    (async () => {
      try {
        await ensureOffscreenDocument();
        const res = await sendOffscreenMessage({
          type: 'OFFSCREEN_ZIP_FILE_FINISH',
          sessionId,
        });
        sendResponse(res);
      } catch (err) {
        sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
      }
    })();
    return true;
  }

  if (msg.type === 'ZIP_BUILD_FILE_ABORT') {
    const sessionId = String(msg.sessionId || '');
    (async () => {
      try {
        await ensureOffscreenDocument();
        const res = await sendOffscreenMessage({
          type: 'OFFSCREEN_ZIP_FILE_ABORT',
          sessionId,
        });
        sendResponse(res);
      } catch (err) {
        sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
      }
    })();
    return true;
  }

  if (msg.type === 'ZIP_BUILD_FINISH') {
    const sessionId = String(msg.sessionId || '');
    const filename = sanitizeFilename(msg.filename) || 'BMDs.zip';
    (async () => {
      try {
        await ensureOffscreenDocument();
        const finished = await sendOffscreenMessage({
          type: 'OFFSCREEN_ZIP_FINISH',
          sessionId,
        });
        if (!finished || !finished.ok || !finished.url) {
          sendResponse({
            ok: false,
            error: (finished && finished.error) || 'offscreen não gerou o ZIP',
            fileCount: finished && finished.fileCount,
          });
          return;
        }
        const res = await downloadObjectUrl(finished.url, filename, true);
        sendResponse({
          ...res,
          fileCount: finished.fileCount,
          bytes: finished.bytes,
          zipName: filename,
        });
      } catch (err) {
        console.error('[Hagap BMDs] ZIP_BUILD_FINISH failed', err);
        try {
          await sendOffscreenMessage({ type: 'OFFSCREEN_ZIP_ABORT', sessionId });
        } catch {
          /* ignore */
        }
        sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
      }
    })();
    return true;
  }

  if (msg.type === 'ZIP_BUILD_ABORT') {
    const sessionId = String(msg.sessionId || '');
    (async () => {
      try {
        await sendOffscreenMessage({ type: 'OFFSCREEN_ZIP_ABORT', sessionId });
      } catch {
        /* ignore */
      }
      sendResponse({ ok: true });
    })();
    return true;
  }

  return false;
});

/**
 * Create blob URL (or data: fallback), trigger chrome.downloads, then revoke.
 * @param {string} objectUrl
 * @param {string} filename
 * @param {boolean} viaOffscreen
 */
async function downloadObjectUrl(objectUrl, filename, viaOffscreen) {
  try {
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

    return res;
  } finally {
    // Revoke only after chrome.downloads has finished (or failed). Early revoke
    // cancels the blob fetch and leaves a fake "success" with no file.
    if (objectUrl) {
      await revokeDownloadUrl(objectUrl, viaOffscreen);
    }
  }
}

/**
 * @param {object} payload
 * @returns {Promise<{ ok?: boolean, url?: string, error?: string, received?: number, bytes?: number }>}
 */
function sendOffscreenMessage(payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(payload, (res) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(res || { ok: false, error: 'sem resposta do offscreen' });
    });
  });
}

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
      justification:
        'Assemble one ZIP from streamed attachments and create blob URLs (unavailable in MV3 service workers)',
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
