'use strict';

/** @type {Map<string, string>} */
const livingUrls = new Map();

/**
 * In-progress chunked transfers (avoid one giant base64 message).
 * @type {Map<string, { mime: string, chunks: Uint8Array[], received: number, totalBytes: number }>}
 */
const transfers = new Map();

/**
 * Streaming ZIP builds: content sends files one-by-one; offscreen holds JSZip.
 * @type {Map<string, {
 *   zip: import('jszip'),
 *   fileCount: number,
 *   pending: null | { entryName: string, chunks: Uint8Array[], received: number, totalBytes: number }
 * }>}
 */
const zipSessions = new Map();

function getJSZip() {
  const ctor = typeof JSZip !== 'undefined' ? JSZip : globalThis.JSZip;
  if (!ctor) throw new Error('JSZip não carregou no offscreen');
  return ctor;
}

function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * @param {Uint8Array[]} chunks
 * @param {number} totalBytes
 */
function concatChunks(chunks, totalBytes) {
  const out = new Uint8Array(totalBytes > 0 ? totalBytes : chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out.subarray(0, offset);
}

/**
 * @param {Uint8Array} u8
 * @param {string} mime
 */
function createLivingBlobUrl(u8, mime) {
  if (!u8.length) {
    throw new Error('ZIP vazio (decode)');
  }
  const blob = new Blob([u8], { type: mime });
  const url = URL.createObjectURL(blob);
  livingUrls.set(url, url);
  return url;
}

/**
 * @param {Blob} blob
 * @param {string} mime
 */
function createLivingBlobUrlFromBlob(blob, mime) {
  if (!blob || !blob.size) {
    throw new Error('ZIP vazio (sem bytes)');
  }
  const typed = mime && blob.type !== mime ? new Blob([blob], { type: mime }) : blob;
  const url = URL.createObjectURL(typed);
  livingUrls.set(url, url);
  return url;
}

/**
 * Never overwrite an existing ZIP path; uniquify with "name (2).ext".
 * @param {{ zip: import('jszip'), fileCount: number }} session
 * @param {string} entryName
 * @param {Uint8Array} data
 */
function addZipEntryUnique(session, entryName, data) {
  const base = String(entryName || '').trim() || 'anexo.bin';
  let name = base;
  let n = 2;
  while (session.zip.file(name)) {
    const m = base.match(/^(.*)(\.[^.]+)$/);
    name = m ? `${m[1]} (${n})${m[2]}` : `${base} (${n})`;
    n += 1;
    if (n > 9999) throw new Error('colisao de nomes no ZIP');
  }
  session.zip.file(name, data);
  session.fileCount += 1;
  return name;
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
      const url = createLivingBlobUrl(u8, mime);
      sendResponse({ ok: true, url });
    } catch (err) {
      sendResponse({
        ok: false,
        error: String(err && err.message ? err.message : err),
      });
    }
    return true;
  }

  if (msg.type === 'OFFSCREEN_BLOB_BEGIN') {
    try {
      const transferId = String(msg.transferId || '');
      if (!transferId) {
        sendResponse({ ok: false, error: 'transferId vazio' });
        return true;
      }
      const mime = String(msg.mime || 'application/zip');
      const totalBytes = Math.max(0, Number(msg.totalBytes) || 0);
      transfers.set(transferId, { mime, chunks: [], received: 0, totalBytes });
      sendResponse({ ok: true });
    } catch (err) {
      sendResponse({
        ok: false,
        error: String(err && err.message ? err.message : err),
      });
    }
    return true;
  }

  if (msg.type === 'OFFSCREEN_BLOB_CHUNK') {
    try {
      const transferId = String(msg.transferId || '');
      const t = transfers.get(transferId);
      if (!t) {
        sendResponse({ ok: false, error: 'transferência desconhecida' });
        return true;
      }
      const base64 = String(msg.base64 || '');
      if (!base64) {
        sendResponse({ ok: false, error: 'chunk vazio' });
        return true;
      }
      const u8 = base64ToUint8Array(base64);
      t.chunks.push(u8);
      t.received += u8.length;
      sendResponse({ ok: true, received: t.received });
    } catch (err) {
      sendResponse({
        ok: false,
        error: String(err && err.message ? err.message : err),
      });
    }
    return true;
  }

  if (msg.type === 'OFFSCREEN_BLOB_FINISH') {
    try {
      const transferId = String(msg.transferId || '');
      const t = transfers.get(transferId);
      if (!t) {
        sendResponse({ ok: false, error: 'transferência desconhecida' });
        return true;
      }
      transfers.delete(transferId);
      if (!t.chunks.length || t.received === 0) {
        sendResponse({ ok: false, error: 'ZIP vazio (sem chunks)' });
        return true;
      }
      const u8 = concatChunks(t.chunks, t.totalBytes || t.received);
      t.chunks.length = 0;
      const url = createLivingBlobUrl(u8, t.mime);
      sendResponse({ ok: true, url, bytes: u8.length });
    } catch (err) {
      sendResponse({
        ok: false,
        error: String(err && err.message ? err.message : err),
      });
    }
    return true;
  }

  if (msg.type === 'OFFSCREEN_BLOB_ABORT') {
    const transferId = String(msg.transferId || '');
    if (transferId) transfers.delete(transferId);
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'OFFSCREEN_ZIP_BEGIN') {
    try {
      const sessionId = String(msg.sessionId || '');
      if (!sessionId) {
        sendResponse({ ok: false, error: 'sessionId vazio' });
        return true;
      }
      const JSZipCtor = getJSZip();
      const existing = zipSessions.get(sessionId);
      if (existing) {
        existing.pending = null;
        zipSessions.delete(sessionId);
      }
      zipSessions.set(sessionId, {
        zip: new JSZipCtor(),
        fileCount: 0,
        pending: null,
      });
      sendResponse({ ok: true });
    } catch (err) {
      sendResponse({
        ok: false,
        error: String(err && err.message ? err.message : err),
      });
    }
    return true;
  }

  if (msg.type === 'OFFSCREEN_ZIP_ADD') {
    try {
      const sessionId = String(msg.sessionId || '');
      const session = zipSessions.get(sessionId);
      if (!session) {
        sendResponse({ ok: false, error: 'sessão ZIP desconhecida' });
        return true;
      }
      if (session.pending) {
        session.pending = null;
      }
      const entryName = String(msg.entryName || '').trim();
      if (!entryName) {
        sendResponse({ ok: false, error: 'nome de arquivo vazio' });
        return true;
      }
      const base64 = String(msg.base64 || '');
      if (!base64) {
        sendResponse({ ok: false, error: 'arquivo vazio' });
        return true;
      }
      const u8 = base64ToUint8Array(base64);
      const finalName = addZipEntryUnique(session, entryName, u8);
      sendResponse({
        ok: true,
        fileCount: session.fileCount,
        bytes: u8.length,
        entryName: finalName,
      });
    } catch (err) {
      sendResponse({
        ok: false,
        error: String(err && err.message ? err.message : err),
      });
    }
    return true;
  }

  if (msg.type === 'OFFSCREEN_ZIP_FILE_BEGIN') {
    try {
      const sessionId = String(msg.sessionId || '');
      const session = zipSessions.get(sessionId);
      if (!session) {
        sendResponse({ ok: false, error: 'sessão ZIP desconhecida' });
        return true;
      }
      if (session.pending) {
        // Drop orphaned transfer so a failed chunked add cannot block the session.
        session.pending = null;
      }
      const entryName = String(msg.entryName || '').trim();
      if (!entryName) {
        sendResponse({ ok: false, error: 'nome de arquivo vazio' });
        return true;
      }
      const totalBytes = Math.max(0, Number(msg.totalBytes) || 0);
      session.pending = { entryName, chunks: [], received: 0, totalBytes };
      sendResponse({ ok: true });
    } catch (err) {
      sendResponse({
        ok: false,
        error: String(err && err.message ? err.message : err),
      });
    }
    return true;
  }

  if (msg.type === 'OFFSCREEN_ZIP_FILE_CHUNK') {
    try {
      const sessionId = String(msg.sessionId || '');
      const session = zipSessions.get(sessionId);
      if (!session || !session.pending) {
        sendResponse({ ok: false, error: 'arquivo pendente desconhecido' });
        return true;
      }
      const base64 = String(msg.base64 || '');
      if (!base64) {
        sendResponse({ ok: false, error: 'chunk vazio' });
        return true;
      }
      const u8 = base64ToUint8Array(base64);
      session.pending.chunks.push(u8);
      session.pending.received += u8.length;
      sendResponse({ ok: true, received: session.pending.received });
    } catch (err) {
      sendResponse({
        ok: false,
        error: String(err && err.message ? err.message : err),
      });
    }
    return true;
  }

  if (msg.type === 'OFFSCREEN_ZIP_FILE_FINISH') {
    try {
      const sessionId = String(msg.sessionId || '');
      const session = zipSessions.get(sessionId);
      if (!session || !session.pending) {
        sendResponse({ ok: false, error: 'arquivo pendente desconhecido' });
        return true;
      }
      const pending = session.pending;
      session.pending = null;
      if (!pending.chunks.length || pending.received === 0) {
        sendResponse({ ok: false, error: 'arquivo vazio (sem chunks)' });
        return true;
      }
      const u8 = concatChunks(pending.chunks, pending.totalBytes || pending.received);
      pending.chunks.length = 0;
      const finalName = addZipEntryUnique(session, pending.entryName, u8);
      sendResponse({
        ok: true,
        fileCount: session.fileCount,
        bytes: u8.length,
        entryName: finalName,
      });
    } catch (err) {
      sendResponse({
        ok: false,
        error: String(err && err.message ? err.message : err),
      });
    }
    return true;
  }

  if (msg.type === 'OFFSCREEN_ZIP_FILE_ABORT') {
    const sessionId = String(msg.sessionId || '');
    const session = zipSessions.get(sessionId);
    if (session) session.pending = null;
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'OFFSCREEN_ZIP_FINISH') {
    const sessionId = String(msg.sessionId || '');
    (async () => {
      try {
        const session = zipSessions.get(sessionId);
        if (!session) {
          sendResponse({ ok: false, error: 'sessão ZIP desconhecida' });
          return;
        }
        if (session.pending) {
          sendResponse({ ok: false, error: 'arquivo pendente na sessão ZIP' });
          return;
        }
        if (session.fileCount === 0) {
          zipSessions.delete(sessionId);
          sendResponse({ ok: false, error: 'ZIP vazio (nenhum arquivo)' });
          return;
        }

        // Count real entries (guards against any overwrite / accounting drift).
        let realCount = 0;
        session.zip.forEach((relativePath, file) => {
          if (!file.dir) realCount += 1;
        });
        if (realCount !== session.fileCount) {
          console.error(
            '[Hagap BMDs] ZIP fileCount mismatch',
            session.fileCount,
            'vs real',
            realCount
          );
          session.fileCount = realCount;
        }
        if (session.fileCount === 0) {
          zipSessions.delete(sessionId);
          sendResponse({ ok: false, error: 'ZIP vazio (nenhum arquivo)' });
          return;
        }

        // PDFs are already compressed; STORE is faster and uses less peak CPU/RAM.
        const zipBlob = await session.zip.generateAsync({
          type: 'blob',
          compression: 'STORE',
        });
        const fileCount = session.fileCount;
        zipSessions.delete(sessionId);

        const url = createLivingBlobUrlFromBlob(zipBlob, 'application/zip');
        sendResponse({
          ok: true,
          url,
          bytes: zipBlob.size,
          fileCount,
        });
      } catch (err) {
        zipSessions.delete(sessionId);
        sendResponse({
          ok: false,
          error: String(err && err.message ? err.message : err),
        });
      }
    })();
    return true;
  }

  if (msg.type === 'OFFSCREEN_ZIP_ABORT') {
    const sessionId = String(msg.sessionId || '');
    if (sessionId) zipSessions.delete(sessionId);
    sendResponse({ ok: true });
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
