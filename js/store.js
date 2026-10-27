// Everything is kept in IndexedDB on this device. Images are stored as Blobs.
// When sharing is on, js/sync.js copies changes to and from the shared space.
//
// Stores:
//   works    作品
//   museums  美術館ごとの「行った／行きたい」と自分で追加した美術館
//   marks    展示ごとの「行きたい／行った」と行く予定日
//   events   自分で追加した展示
//   meta     sync bookkeeping
//   queue    photos waiting to be registered by js/bulk.js (this device only, never shared)
// Every record carries updatedAt. Local changes set _dirty until they are uploaded.
// Deleting leaves a small tombstone ({id, deleted: true}) so the delete reaches the other device.
const DB_NAME = "artscan";
export const STORES = ["works", "museums", "marks", "events"];
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 3);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("works")) db.createObjectStore("works", { keyPath: "id" }).createIndex("createdAt", "createdAt");
      for (const s of ["museums", "marks", "events", "meta", "queue"]) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx(name, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(name, mode);
    const s = t.objectStore(name);
    let out;
    Promise.resolve(fn(s)).then(v => { out = v; });
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}
const req2p = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

// ---- change listeners (the UI reloads when sync brings something new) ----
const listeners = new Set();
export const onChange = fn => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = (name, local) => listeners.forEach(fn => { try { fn(name, local); } catch {} });

// ---- generic ----
export function rawAll(name) { return tx(name, "readonly", s => req2p(s.getAll())); }
export async function list(name) {
  const rows = (await rawAll(name)).filter(r => !r.deleted);
  return name === "works" ? rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)) : rows;
}
export function get(name, id) { return tx(name, "readonly", s => req2p(s.get(id))); }

// A change made on this device.
export async function save(name, rec) {
  const r = { ...rec, updatedAt: Math.max(Date.now(), (rec.updatedAt || 0) + 1), _dirty: 1 };
  delete r.deleted;
  await tx(name, "readwrite", s => { s.put(r); });
  emit(name, true);
  return r;
}
export async function remove(name, id) {
  const old = await get(name, id).catch(() => null);
  // a work keeps its photo list, so sync can also delete the extra photos in the shared space
  await tx(name, "readwrite", s => { s.put({ id, deleted: true, updatedAt: Date.now(), _dirty: 1, ...(old?.photos?.length ? { photos: old.photos } : {}) }); });
  emit(name, true);
}
// A change that came from the shared space: keep its updatedAt and don't upload it again.
export async function applyRemote(name, rec) {
  await tx(name, "readwrite", s => { const r = { ...rec }; delete r._dirty; s.put(r); });
}
export const notify = name => emit(name, false);
// After an upload: clear the flag unless the record changed again meanwhile.
export function markClean(name, id, updatedAt) {
  return tx(name, "readwrite", async s => {
    const r = await req2p(s.get(id));
    if (!r || r.updatedAt !== updatedAt) return;
    if (r.deleted) s.delete(id); // the tombstone now lives in the shared space
    else { delete r._dirty; s.put(r); }
  });
}
// Same, and also remember fields that only sync needs (which photos are uploaded).
export function patchClean(name, id, updatedAt, patch) {
  return tx(name, "readwrite", async s => {
    const r = await req2p(s.get(id));
    if (!r) return;
    Object.assign(r, patch);
    if (r.updatedAt === updatedAt) delete r._dirty;
    s.put(r);
  });
}
export function purge(name, id) { return tx(name, "readwrite", s => { s.delete(id); }); }
export async function dirty(name) { return (await rawAll(name)).filter(r => r._dirty); }
export function markAllDirty(name) {
  return tx(name, "readwrite", async s => { for (const r of await req2p(s.getAll())) { r._dirty = 1; s.put(r); } });
}

// ---- meta ----
export async function metaGet(id, d = null) { const r = await tx("meta", "readonly", s => req2p(s.get(id))); return r ? r.v : d; }
export function metaSet(id, v) { return tx("meta", "readwrite", s => { s.put({ id, v }); }); }

// ---- works (kept for the existing screens) ----
export const all = () => list("works");
export const put = w => save("works", w);
export const del = id => remove("works", id);

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
export const BLOB_KEYS = ["image", "thumb", "labelImage"];

export async function exportJson() {
  const works = await all();
  const out = [];
  for (const w of works) {
    const c = { ...w };
    delete c._dirty;
    for (const k of [...BLOB_KEYS, ...(c.photos || [])]) if (c[k] instanceof Blob) c[k] = await blobToDataUrl(c[k]);
    out.push(c);
  }
  const extra = {};
  for (const n of ["museums", "marks", "events"]) extra[n] = (await list(n)).map(r => { const c = { ...r }; delete c._dirty; return c; });
  return JSON.stringify({ app: "artscan", version: 2, exportedAt: new Date().toISOString(), works: out, ...extra });
}

export async function importJson(text) {
  const data = JSON.parse(text);
  if (data?.app !== "artscan" || !Array.isArray(data.works)) throw new Error("ArtMuseのバックアップファイルではありません");
  let n = 0;
  for (const w of data.works) {
    if (!w?.id) continue;
    const c = { ...w };
    for (const k of [...BLOB_KEYS, ...(c.photos || [])]) if (typeof c[k] === "string" && c[k].startsWith("data:")) c[k] = await dataUrlToBlob(c[k]);
    await save("works", c);
    n++;
  }
  for (const name of ["museums", "marks", "events"]) for (const r of data[name] || []) if (r?.id) await save(name, r);
  return n;
}

// ---- photo queue (local only) ----
export const qAll = () => rawAll("queue");
export const qPut = rec => tx("queue", "readwrite", s => { s.put(rec); return rec; });
export const qDel = id => tx("queue", "readwrite", s => { s.delete(id); });
