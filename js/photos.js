// Several photos of one work (other angles, or taken by the other person).
// The first photo stays in w.image (as before). More photos live in w.photos = ["x…", …],
// each key holding its Blob (w["x…"]). w.blobAt[key] says when a photo was replaced, so sync
// knows to fetch it again.
import * as store from "./store.js";
import { loadImg, toBlob } from "./ui.js";

const norm = s => String(s || "").normalize("NFKC").toLowerCase().replace(/[\s・･.,，、。「」『』（）()〈〉《》"'’\-‐－—~〜]/g, "");
const newKey = () => "x" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// Keys of the photos of a work, in order (main first).
export const keysOf = w => [...(w.image ? ["image"] : []), ...(w.photos || []).filter(k => w[k])];
export const count = w => keysOf(w).length;

// Same work = same title and same artist (an untitled work is never "the same").
export function sameWork(a, b) {
  if (!a || !b || a.id === b.id) return false;
  const ta = norm(a.title), tb = norm(b.title);
  if (!ta || ta !== tb) return false;
  const aa = norm(a.artist), ab = norm(b.artist);
  return !!aa && aa === ab;
}
export const findSame = (works, w) => works.find(x => !x.deleted && !x.sample && sameWork(x, w)) || null;
export const sameAs = (works, w) => works.filter(x => !x.deleted && !x.sample && sameWork(x, w));

// A copy of a Blob held in memory. Safari can lose a photo that was read from one saved record
// and saved into another when the first record is deleted, so moved photos are always copied.
export async function fresh(b) {
  if (!(b instanceof Blob)) return b;
  try { return new Blob([await b.arrayBuffer()], { type: b.type || "image/jpeg" }); } catch { return null; }
}
async function freshAll(w) {
  for (const k of ["image", "thumb", "labelImage", ...(w.photos || [])]) {
    if (!(w[k] instanceof Blob)) continue;
    const c = await fresh(w[k]);
    if (c && c.size) w[k] = c; else { delete w[k]; if (k !== "thumb") w.blobsUp = (w.blobsUp || []).filter(x => x !== k); }
  }
  w.photos = (w.photos || []).filter(k => w[k]);
  return w;
}

const stamp = (w, k) => { w.blobAt = { ...(w.blobAt || {}), [k]: Date.now() }; w.blobsUp = (w.blobsUp || []).filter(x => x !== k); };

// Add photos (Blobs, already resized) to a work and save it.
export async function addPhotos(work, blobs) {
  const w = await freshAll({ ...work, photos: [...(work.photos || [])] });
  for (let b of blobs) {
    b = await fresh(b);
    if (!b || !b.size) continue;
    if (!w.image) { w.image = b; stamp(w, "image"); continue; }
    const k = newKey(); w[k] = b; w.photos.push(k); stamp(w, k);
  }
  if (!w.thumb && (w.image || w.labelImage)) { try { w.thumb = await toBlob(await loadImg(w.image || w.labelImage), 520, .76); } catch {} }
  return store.put(w);
}
// Photo files picked by the user -> resized Blobs.
export async function filesToBlobs(files) {
  const out = [];
  for (const f of files) { try { out.push(await toBlob(await loadImg(f), 1600, .84)); } catch {} }
  return out;
}

// Remove one photo. Removing the main photo makes the next one the main photo.
export async function removePhoto(work, key) {
  const w = await freshAll({ ...work, photos: (work.photos || []).filter(k => k !== key) });
  if (key === "image") {
    const next = w.photos.shift();
    if (next) { w.image = w[next]; delete w[next]; } else delete w.image;
    stamp(w, "image");
    w.thumb = w.image ? await toBlob(await loadImg(w.image), 520, .76).catch(() => w.thumb) : w.thumb;
  } else delete w[key];
  w.blobsUp = (w.blobsUp || []).filter(k => k !== key);
  return store.put(w);
}
// Show this photo first.
export async function makeMain(work, key) {
  if (key === "image" || !work[key]) return work;
  const w = await freshAll({ ...work, photos: [...(work.photos || [])] });
  if (!w[key]) return work;
  const old = w.image;
  w.image = w[key]; stamp(w, "image");
  if (old) { w[key] = old; stamp(w, key); } else { delete w[key]; w.photos = w.photos.filter(k => k !== key); }
  try { w.thumb = await toBlob(await loadImg(w.image), 520, .76); } catch {}
  return store.put(w);
}

// Put two records of the same work together: photos, label, note, Q&A, favourite. The other one is deleted.
export async function merge(target, other) {
  const blobs = [];
  for (const k of keysOf(other)) { const b = await fresh(other[k]); if (b && b.size) blobs.push(b); }
  let w = { ...target };
  if (!w.labelImage && other.labelImage) { const b = await fresh(other.labelImage); if (b && b.size) { w.labelImage = b; stamp(w, "labelImage"); } }
  for (const k of ["labelText", "description", "artistNote", "year", "medium", "dimensions", "museum", "originalTitle", "artistReading", "movement"]) if (!w[k] && other[k]) w[k] = other[k];
  if (other.note && other.note !== w.note) w.note = [w.note, other.note].filter(Boolean).join("\n");
  if (other.fav) w.fav = true;
  if ((other.qa || []).length) w.qa = [...(w.qa || []), ...other.qa].slice(-20);
  if (other.byName && other.byName !== w.byName && !(w.alsoBy || []).includes(other.byName)) w.alsoBy = [...(w.alsoBy || []), other.byName];
  if (!w.verified && other.verified) { for (const k of ["verified", "wiki", "wikidataUrl", "collection"]) w[k] = other[k]; }
  w = await addPhotos(w, blobs);
  await store.del(other.id);
  return w;
}

// A photo that can no longer be read: drop it, take it again from the shared space if possible,
// and make a new thumbnail. Returns the saved record, or null when nothing could be done.
export async function repair(work, fetchRemote) {
  const w = await freshAll({ ...work, photos: [...(work.photos || [])] });
  if (fetchRemote) {
    try {
      const got = await fetchRemote(work.id);
      for (const [k, b] of Object.entries(got || {})) {
        if (w[k] || !(b instanceof Blob)) continue;
        w[k] = b;
        if (k !== "image" && k !== "labelImage" && !w.photos.includes(k)) w.photos.push(k);
      }
    } catch {}
  }
  if (!w.image && w.photos.length) { const k = w.photos.shift(); w.image = w[k]; delete w[k]; stamp(w, "image"); }
  const src = w.image || w.labelImage;
  delete w.thumb;
  if (src) { try { w.thumb = await toBlob(await loadImg(src), 520, .76); } catch {} }
  return store.put(w);
}
