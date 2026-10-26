// Sharing between devices (for example, with your partner) through your own free Firebase project.
//
// How it works:
// - Each device signs in anonymously to Firebase. No account, no password.
// - Everything shared lives under spaces/{spaceId}. The space id is a long random code;
//   knowing it is what lets a device join (see the security rules in README.md).
// - The local IndexedDB stays the source for the screens. This module uploads local changes
//   and downloads the other device's changes every so often.
// - Photos go into Firestore documents too (the free plan has no Cloud Storage).
import * as store from "./store.js";

const LS = "artscan.sync";
const PULL_EVERY = 60 * 1000;
const MAX_BLOB = 900 * 1024; // Firestore documents are at most 1 MiB

let fb = null;       // the Firebase module
let app = null, auth = null, db = null, uid = null;
let timer = null, running = null, again = false;
const subs = new Set();
export const state = { on: false, phase: "off", last: 0, error: "", members: 0, names: {} };
const set = patch => { Object.assign(state, patch); subs.forEach(f => { try { f(state); } catch {} }); };
export const onState = f => { subs.add(f); return () => subs.delete(f); };

function readCfg() { try { return JSON.parse(localStorage.getItem(LS) || "null"); } catch { return null; } }
function writeCfg(c) { try { c ? localStorage.setItem(LS, JSON.stringify(c)) : localStorage.removeItem(LS); } catch {} }
export const config = () => readCfg();
export const myName = () => readCfg()?.name || "";
export const enabled = () => !!readCfg()?.space;

// ---------- Firebase config pasted from the console ----------
// Accepts the whole `const firebaseConfig = {...}` snippet, JSON, or an invite code.
export function parseFirebaseConfig(text) {
  const t = String(text || "");
  const out = {};
  for (const m of t.matchAll(/["']?(apiKey|authDomain|projectId|appId|storageBucket|messagingSenderId)["']?\s*:\s*["']([^"']+)["']/g)) out[m[1]] = m[2];
  if (!out.apiKey || !out.projectId) return null;
  out.authDomain ||= out.projectId + ".firebaseapp.com";
  return { apiKey: out.apiKey, authDomain: out.authDomain, projectId: out.projectId, appId: out.appId || "" };
}

const b64u = s => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = s => decodeURIComponent(escape(atob(s.replace(/-/g, "+").replace(/_/g, "/"))));
export function inviteCode() {
  const c = readCfg(); if (!c?.space) return "";
  return "ARTMUSE-" + b64u(JSON.stringify({ v: 1, c: c.fb, s: c.space }));
}
export function inviteLink() {
  return new URL("./", location.href).href + "#join=" + inviteCode();
}
export function parseInvite(text) {
  const m = String(text || "").match(/ARTMUSE-([A-Za-z0-9_-]+)/);
  if (!m) return null;
  try { const j = JSON.parse(unb64u(m[1])); return j?.s && j?.c?.apiKey ? { fb: j.c, space: j.s } : null; } catch { return null; }
}

// ---------- errors ----------
function friendly(e) {
  const c = String(e?.code || "");
  const m = String(e?.message || "");
  if (/admin-restricted-operation|operation-not-allowed/.test(c)) return "Firebaseで「匿名」ログインが有効になっていません（Authentication → ログイン方法）。";
  if (/api-key-not-valid|invalid-api-key/.test(c + m)) return "Firebaseの設定（apiKey）が正しくありません。もう一度コピーして貼り付けてください。";
  if (c === "permission-denied" || /permission/i.test(m)) return "共有スペースに入れませんでした。共有コードが正しいか、Firestoreのルールを設定したか確認してください。";
  if (c === "not-found") return "共有スペースが見つかりません。共有コードを確認してください。";
  if (c === "unavailable" || /network|offline|Failed to fetch/i.test(c + m)) return "インターネットにつながっていないため、あとで同期します。";
  if (c === "resource-exhausted") return "Firebaseの無料枠の1日の上限に達しました。明日もう一度同期します。";
  return "同期でエラーが起きました（" + (c || m || "不明") + "）。";
}

// ---------- connect ----------
async function connect(fbCfg) {
  if (!fb) fb = await import("../vendor/firebase.js");
  if (app) { try { await fb.deleteApp(app); } catch {} app = auth = db = null; }
  const cfg = { apiKey: fbCfg.apiKey, authDomain: fbCfg.authDomain, projectId: fbCfg.projectId, appId: fbCfg.appId };
  app = fb.initializeApp(cfg, "artmuse");
  auth = fb.initializeAuth(app, { persistence: [fb.indexedDBLocalPersistence, fb.browserLocalPersistence] });
  db = fb.getFirestore(app);
  if (fbCfg.emulator) { // tests only
    fb.connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
    fb.connectFirestoreEmulator(db, "127.0.0.1", 8080);
  }
  const user = await new Promise(res => { const off = fb.onAuthStateChanged(auth, u => { off(); res(u); }); });
  uid = (user || (await fb.signInAnonymously(auth)).user).uid;
  return uid;
}
const spaceRef = space => fb.doc(db, "spaces", space);
const col = (space, name) => fb.collection(db, "spaces", space, name);

const randomId = () => { const a = new Uint8Array(15); crypto.getRandomValues(a); return [...a].map(b => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join(""); };

// Start a new shared space on this device.
export async function create(fbCfg, name) {
  try {
    await connect(fbCfg);
    const space = randomId() + randomId();
    await fb.setDoc(spaceRef(space), { members: [uid], names: { [uid]: name || "" }, createdAt: fb.serverTimestamp() });
    writeCfg({ fb: fbCfg, space, name, since: {} });
    for (const n of store.STORES) await store.markAllDirty(n);
    start();
    return true;
  } catch (e) { throw new Error(friendly(e)); }
}

// Join with a code from the other device.
export async function join(invite, name) {
  try {
    await connect(invite.fb);
    await fb.updateDoc(spaceRef(invite.space), { members: fb.arrayUnion(uid), ["names." + uid]: name || "" });
    writeCfg({ fb: invite.fb, space: invite.space, name, since: {} });
    for (const n of store.STORES) await store.markAllDirty(n);
    start();
    return true;
  } catch (e) { throw new Error(friendly(e)); }
}

export function leave() {
  stop();
  writeCfg(null);
  set({ on: false, phase: "off", error: "", members: 0, names: {} });
}
export async function rename(name) {
  const c = readCfg(); if (!c) return;
  c.name = name; writeCfg(c);
  try { if (db) await fb.updateDoc(spaceRef(c.space), { ["names." + uid]: name }); } catch {}
}

// ---------- blobs ----------
async function shrink(blob) {
  if (blob.size <= MAX_BLOB) return blob;
  let bmp;
  try { bmp = await createImageBitmap(blob); } catch { return null; }
  let scale = Math.sqrt(MAX_BLOB / blob.size), q = 0.8, out = blob;
  for (let i = 0; i < 5 && out.size > MAX_BLOB; i++) {
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(bmp.width * scale)); c.height = Math.max(1, Math.round(bmp.height * scale));
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    out = await new Promise(r => c.toBlob(r, "image/jpeg", q));
    scale *= 0.85; q = Math.max(0.6, q - 0.05);
  }
  return out.size <= MAX_BLOB ? out : null;
}
const toBytes = async blob => fb.Bytes.fromUint8Array(new Uint8Array(await blob.arrayBuffer()));
const toBlob = (bytes, type) => new Blob([bytes.toUint8Array()], { type: type || "image/jpeg" });

// ---------- push ----------
function clean(v) {
  if (v === undefined || typeof v === "function") return undefined;
  if (v === null || typeof v !== "object") return Number.isNaN(v) ? null : v;
  if (v instanceof Blob) return undefined;
  if (Array.isArray(v)) return v.map(clean).filter(x => x !== undefined);
  const o = {};
  for (const [k, x] of Object.entries(v)) { if (k.startsWith("_") || k === "thumbUrl" || k === "imageUrl") continue; const c = clean(x); if (c !== undefined) o[k] = c; }
  return o;
}

async function pushOne(space, name, r) {
  const ref = fb.doc(col(space, name), r.id);
  if (r.deleted) {
    await fb.setDoc(ref, { id: r.id, deleted: true, updatedAt: r.updatedAt, by: uid, serverAt: fb.serverTimestamp() });
    if (name === "works") for (const k of ["image", "labelImage"]) { try { await fb.deleteDoc(fb.doc(col(space, "blobs"), r.id + "__" + k)); } catch {} }
    return null;
  }
  const doc = clean(r);
  let blobsUp = Array.isArray(r.blobsUp) ? [...r.blobsUp] : [];
  if (name === "works") {
    for (const k of ["image", "labelImage"]) {
      if (!(r[k] instanceof Blob) || blobsUp.includes(k)) continue;
      const b = await shrink(r[k]);
      if (!b) continue;
      await fb.setDoc(fb.doc(col(space, "blobs"), r.id + "__" + k), { data: await toBytes(b), type: b.type, updatedAt: r.updatedAt, serverAt: fb.serverTimestamp() });
      blobsUp.push(k);
    }
    doc.blobsUp = blobsUp;
    if (r.thumb instanceof Blob) { const t = await shrink(r.thumb); if (t && t.size < 200 * 1024) { doc.thumbBytes = await toBytes(t); doc.thumbType = t.type; } }
  }
  doc.serverAt = fb.serverTimestamp();
  doc.by ||= uid;
  await fb.setDoc(ref, doc);
  return name === "works" ? blobsUp : null;
}

async function push(space) {
  let n = 0;
  for (const name of store.STORES) {
    for (const r of await store.dirty(name)) {
      const blobsUp = await pushOne(space, name, r);
      if (blobsUp) await store.patchClean(name, r.id, r.updatedAt, { blobsUp });
      else await store.markClean(name, r.id, r.updatedAt);
      n++;
    }
  }
  return n;
}

// ---------- pull ----------
async function pull(space, since) {
  let changed = 0;
  for (const name of store.STORES) {
    let from = Math.max(0, (since[name] || 0) - 5 * 60 * 1000); // small overlap for clock and commit order
    for (let page = 0; page < 20; page++) {
      const q = fb.query(col(space, name), fb.where("serverAt", ">", fb.Timestamp.fromMillis(from)), fb.orderBy("serverAt"), fb.limit(200));
      const snap = await fb.getDocs(q);
      for (const d of snap.docs) {
        const r = d.data();
        const at = r.serverAt?.toMillis?.() || 0;
        from = Math.max(from, at);
        since[name] = Math.max(since[name] || 0, at);
        if (await applyOne(space, name, r)) changed++;
      }
      if (snap.size < 200) break;
    }
    if (changed) store.notify(name);
  }
  return changed;
}

async function applyOne(space, name, r) {
  const local = await store.get(name, r.id);
  if (local && (local.updatedAt || 0) >= (r.updatedAt || 0)) return false; // ours is the same or newer
  if (r.deleted) { if (local) await store.purge(name, r.id); return !!local; }
  const rec = { ...r };
  delete rec.serverAt;
  if (name === "works") {
    delete rec.thumbBytes; delete rec.thumbType;
    if (r.thumbBytes) rec.thumb = toBlob(r.thumbBytes, r.thumbType);
    else if (local?.thumb) rec.thumb = local.thumb;
    for (const k of ["image", "labelImage"]) {
      if (local?.[k] instanceof Blob) { rec[k] = local[k]; continue; }
      if (!(r.blobsUp || []).includes(k)) continue;
      try {
        const b = await fb.getDoc(fb.doc(col(space, "blobs"), r.id + "__" + k));
        if (b.exists()) rec[k] = toBlob(b.data().data, b.data().type);
      } catch {}
    }
  }
  await store.applyRemote(name, rec);
  return true;
}

// ---------- loop ----------
export async function syncNow() {
  const c = readCfg();
  if (!c?.space) return;
  if (running) { again = true; return running; }
  running = (async () => {
    set({ on: true, phase: "syncing", error: "" });
    try {
      if (!db) await connect(c.fb);
      const sp = await fb.getDoc(spaceRef(c.space));
      if (!sp.exists()) throw Object.assign(new Error("not-found"), { code: "not-found" });
      const members = sp.data().members || [];
      if (!members.includes(uid)) await fb.updateDoc(spaceRef(c.space), { members: fb.arrayUnion(uid), ["names." + uid]: c.name || "" });
      const names = sp.data().names || {};
      await push(c.space);
      const since = { ...(c.since || {}) };
      await pull(c.space, since);
      const cur = readCfg(); if (cur?.space === c.space) { cur.since = since; writeCfg(cur); }
      set({ phase: "ok", last: Date.now(), members: new Set(Object.values(names).filter(Boolean)).size || members.length, names });
    } catch (e) {
      set({ phase: "error", error: friendly(e) });
    } finally {
      running = null;
      if (again) { again = false; setTimeout(syncNow, 500); }
    }
  })();
  return running;
}

let debounce = null;
export function start() {
  if (!enabled()) return;
  set({ on: true });
  stop(true);
  timer = setInterval(() => { if (document.visibilityState === "visible") syncNow(); }, PULL_EVERY);
  syncNow();
}
export function stop(keepOn) { clearInterval(timer); timer = null; if (!keepOn) set({ on: false }); }

store.onChange((name, local) => {
  if (!local || !enabled()) return;
  clearTimeout(debounce);
  debounce = setTimeout(syncNow, 1500);
});
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && enabled()) syncNow(); });
window.addEventListener("online", () => { if (enabled()) syncNow(); });
