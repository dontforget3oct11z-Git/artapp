// Works are kept in IndexedDB on this device. Images are stored as Blobs.
const DB_NAME = "artscan";
const STORE = "works";
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const s = db.createObjectStore(STORE, { keyPath: "id" });
        s.createIndex("createdAt", "createdAt");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx(mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const s = t.objectStore(STORE);
    let out;
    Promise.resolve(fn(s)).then(v => { out = v; });
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export function all() {
  return tx("readonly", s => new Promise((res, rej) => {
    const r = s.getAll();
    r.onsuccess = () => res(r.result.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)));
    r.onerror = () => rej(r.error);
  }));
}
export function put(work) { return tx("readwrite", s => { s.put(work); }); }
export function del(id) { return tx("readwrite", s => { s.delete(id); }); }

// Ask the browser not to clear our data under storage pressure.
export async function persist() {
  try { if (navigator.storage?.persist) return await navigator.storage.persist(); } catch {}
  return false;
}

// ---- backup ----
function blobToDataUrl(b) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(b); });
}
async function dataUrlToBlob(u) { return (await fetch(u)).blob(); }
const BLOB_KEYS = ["image", "thumb", "labelImage"];

export async function exportJson() {
  const works = await all();
  const out = [];
  for (const w of works) {
    const c = { ...w };
    for (const k of BLOB_KEYS) if (c[k] instanceof Blob) c[k] = await blobToDataUrl(c[k]);
    out.push(c);
  }
  return JSON.stringify({ app: "artscan", version: 1, exportedAt: new Date().toISOString(), works: out });
}

export async function importJson(text) {
  const data = JSON.parse(text);
  if (data?.app !== "artscan" || !Array.isArray(data.works)) throw new Error("ArtMuseのバックアップファイルではありません");
  let n = 0;
  for (const w of data.works) {
    if (!w?.id) continue;
    const c = { ...w };
    for (const k of BLOB_KEYS) if (typeof c[k] === "string" && c[k].startsWith("data:")) c[k] = await dataUrlToBlob(c[k]);
    await put(c);
    n++;
  }
  return n;
}
