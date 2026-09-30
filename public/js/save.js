// "Save as" helper: lets the user name a file and choose a folder.
// Chrome/Edge (desktop): File System Access API — pick a folder once, then saves go straight there.
// Safari/Firefox/phones: falls back to a normal download with the chosen name
// (iPhone shows the share sheet → "Save to Files", where you pick the folder).

const canPickFolder = typeof window.showDirectoryPicker === 'function';
const canSaveAs = typeof window.showSaveFilePicker === 'function';

/* ---- tiny IndexedDB store so the chosen folder survives reloads ---- */
function idb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('newsgram', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function kvGet(key) {
  try {
    const db = await idb();
    return await new Promise((res) => {
      const q = db.transaction('kv').objectStore('kv').get(key);
      q.onsuccess = () => res(q.result);
      q.onerror = () => res(undefined);
    });
  } catch {
    return undefined;
  }
}
async function kvSet(key, val) {
  try {
    const db = await idb();
    await new Promise((res) => {
      const tx = db.transaction('kv', 'readwrite');
      val === undefined ? tx.objectStore('kv').delete(key) : tx.objectStore('kv').put(val, key);
      tx.oncomplete = res;
      tx.onerror = res;
    });
  } catch {}
}

let folder = null; // FileSystemDirectoryHandle
const listeners = new Set();
const notify = () => listeners.forEach((fn) => fn(folder));

export async function initSave() {
  if (canPickFolder) folder = (await kvGet('saveFolder')) || null;
  notify();
}
export const supportsFolders = () => canPickFolder;
export const folderName = () => folder?.name || '';
export function onFolderChange(fn) {
  listeners.add(fn);
  fn(folder);
}

export async function chooseFolder() {
  if (!canPickFolder) return null;
  try {
    const h = await window.showDirectoryPicker({ id: 'newsgram-save', mode: 'readwrite', startIn: folder || 'downloads' });
    folder = h;
    await kvSet('saveFolder', h);
    notify();
    return h;
  } catch (e) {
    if (e.name === 'AbortError') return null;
    throw e;
  }
}
export async function clearFolder() {
  folder = null;
  await kvSet('saveFolder', undefined);
  notify();
}

export function cleanName(name, fallback = 'newsgram') {
  const n = String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return n || fallback;
}

async function toBlobOrResponse(source) {
  if (source instanceof Blob) return source;
  const res = await fetch(source);
  if (!res.ok) throw new Error(`Couldn't fetch the file (${res.status})`);
  return res;
}

async function writeTo(handle, source) {
  const writable = await handle.createWritable();
  const src = await toBlobOrResponse(source);
  if (src instanceof Blob) {
    await writable.write(src);
    await writable.close();
  } else {
    await src.body.pipeTo(writable); // streams big videos without holding them in memory
  }
}

async function uniqueHandle(dir, base, ext) {
  for (let i = 0; i < 200; i++) {
    const name = i ? `${base} (${i + 1}).${ext}` : `${base}.${ext}`;
    try {
      await dir.getFileHandle(name); // exists → try next
    } catch {
      return { handle: await dir.getFileHandle(name, { create: true }), name };
    }
  }
  return { handle: await dir.getFileHandle(`${base}-${Date.now()}.${ext}`, { create: true }), name: `${base}-${Date.now()}.${ext}` };
}

function classicDownload(source, filename) {
  const a = document.createElement('a');
  const blobUrl = source instanceof Blob ? URL.createObjectURL(source) : null;
  a.href = blobUrl || source;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  if (blobUrl) setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
}

const MIME = { mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', jpg: 'image/jpeg', png: 'image/png' };

/**
 * Saves `source` (Blob or same-origin URL) as `<name>.<ext>`.
 * Returns { where: 'folder'|'picker'|'download', name, folder? } or null if cancelled.
 */
export async function saveFile(source, name, ext, { askWhere = false } = {}) {
  const base = cleanName(name);
  const file = `${base}.${ext}`;

  // 1) A folder was chosen before → write straight into it.
  if (folder && !askWhere) {
    let perm = await folder.queryPermission?.({ mode: 'readwrite' });
    if (perm !== 'granted') perm = await folder.requestPermission?.({ mode: 'readwrite' });
    if (perm === 'granted') {
      const { handle, name: finalName } = await uniqueHandle(folder, base, ext);
      await writeTo(handle, source);
      return { where: 'folder', name: finalName, folder: folder.name };
    }
  }
  // 2) Browser can show a real "Save as" dialog (pick folder + name).
  if (canSaveAs) {
    try {
      const handle = await window.showSaveFilePicker({
        id: 'newsgram-save',
        suggestedName: file,
        startIn: folder || 'downloads',
        types: MIME[ext] ? [{ description: ext.toUpperCase(), accept: { [MIME[ext]]: [`.${ext}`] } }] : undefined,
      });
      await writeTo(handle, source);
      return { where: 'picker', name: handle.name };
    } catch (e) {
      if (e.name === 'AbortError') return null;
      // e.g. the click was too long ago for the browser to allow a dialog — just download.
      if (e.name !== 'SecurityError' && e.name !== 'NotAllowedError') throw e;
    }
  }
  // 3) Everything else: normal download with the chosen name.
  classicDownload(source, file);
  return { where: 'download', name: file };
}
