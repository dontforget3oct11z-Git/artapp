// Register many photos you already took, in one go.
// The chosen photos go into a queue kept on this device (IndexedDB), so registering goes on
// after the sheet is closed, and after the app was closed it picks up where it stopped.
// (Phones pause web apps in the background; the queue resumes as soon as the app is shown again.)
// Each photo is identified by the AI and saved automatically. Its date and place come from the photo.
// A label (caption) photo taken within 5 minutes after an artwork photo is attached to that artwork.
import * as store from "./store.js";
import * as ai from "./ai.js";
import * as sync from "./sync.js";
import * as P from "./places.js";
import { $, esc, toast, openSheet, closeSheet, app, loadImg, toBlob, photoMeta, reverseGeocode, ymd } from "./ui.js";

const PAIR_MS = 5 * 60 * 1000;
const GEMINI_GAP_MS = 6500; // the free tier allows only a few requests per minute
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fingerprint = f => `${f.name}|${f.size}|${f.lastModified}`;
const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

let q = [];            // queue records, oldest batch first
let picked = [];       // photos chosen but not started yet
let running = false, wake = null, tick = null, lastCall = 0;
const urls = new Map(); // id -> object URL of the thumbnail

// ---------- time estimates ----------
// Average seconds per photo, learned from this device (starts from a typical value).
const avgSec = () => +lsGet("artscan.bulkAvg." + (ai.isFree() ? "g" : "c")) || (ai.isFree() ? 12 : 14);
function learn(sec) {
  if (!(sec > 1 && sec < 300)) return;
  lsSet("artscan.bulkAvg." + (ai.isFree() ? "g" : "c"), String(Math.round((avgSec() * 0.7 + sec * 0.3) * 10) / 10));
}
const fmt = s => s < 60 ? `${Math.max(5, Math.round(s / 5) * 5)}秒` : `${Math.ceil(s / 60)}分`;

const STAGES = {
  wait:  { t: "待機中", p: 0 },
  gap:   { t: "順番待ち（無料枠の間隔をあけています）", p: 8 },
  prep:  { t: "写真の場所と日付を確認中", p: 15 },
  ai:    { t: "AIが作品を調べています", p: 25 },
  check: { t: "Wikipediaで内容を確認中", p: 85 },
  save:  { t: "保存しています", p: 95 },
};
const DONE = { done: "登録しました", review: "登録しました（内容の確認をおすすめ）", label: "前の作品のラベルとしてまとめました", err: "登録できませんでした", dup: "登録済みのため飛ばしました" };

const pending = () => q.filter(x => x.state === "wait" || x.state === "work");
const pausedUntil = () => +lsGet("artscan.bulkPause") || 0;
const setPause = (until, why = "") => { lsSet("artscan.bulkPause", String(until)); lsSet("artscan.bulkPauseWhy", why); };

// ---------- start up ----------
export async function init() {
  $("#inBulk").onchange = async e => {
    const files = [...e.target.files]; e.target.value = "";
    if (files.length) await pick(files);
  };
  $("#bulkPill").onclick = () => openProgress();
  try { q = await store.qAll(); } catch { q = []; }
  q.sort((a, b) => a.batch - b.batch || a.seq - b.seq);
  // A photo that was being processed when the app closed starts again.
  for (const it of q) if (it.state === "work") { it.state = "wait"; it.stage = "wait"; await store.qPut(it); }
  // Finished photos are cleared from the list after two days.
  const old = Date.now() - 2 * 864e5;
  for (const it of q.filter(x => x.doneAt && x.doneAt < old)) await store.qDel(it.id);
  q = q.filter(x => !(x.doneAt && x.doneAt < old));
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { lockScreen(); kick(); } });
  window.addEventListener("online", () => kick());
  render();
  kick();
}

// ---------- choosing photos ----------
async function pick(files) {
  const known = new Set([...app.works().map(w => w.srcFile), ...q.map(x => x.fp)].filter(Boolean));
  picked = [];
  for (const f of files) {
    if (!/^image\//.test(f.type) && !/\.(jpe?g|png|heic|heif|webp)$/i.test(f.name)) continue;
    const meta = await photoMeta(f).catch(() => ({}));
    picked.push({ f, meta, time: meta.time || f.lastModified || 0, dup: known.has(fingerprint(f)) });
  }
  picked.sort((a, b) => a.time - b.time);
  const n = picked.filter(x => !x.dup).length, dup = picked.length - n;
  const busy = pending().length;
  openSheet(`<div class="bar"><button class="btn ghost" id="bkClose">← 戻る</button></div>
    <h2>まとめて登録</h2>
    <p class="small muted" style="margin:0">${picked.length}枚の写真から作品を登録します${dup ? `（${dup}枚は登録済みなので飛ばします）` : ""}。作品だけの写真も、ラベル（解説）の写真も、どちらでも大丈夫です。作品のすぐ後に撮ったラベルの写真は、その作品にまとめます。撮影日と場所は写真から読み取ります。</p>
    <div class="field"><label for="bkMuseum">美術館（写真に位置情報がないときに使います・任意）</label><input id="bkMuseum" list="museumList" placeholder="例：国立西洋美術館"></div>
    <div class="status small">${ai.isFree() ? "Gemini無料枠の回数制限のため、1枚ずつ順番に調べます。" : "Claudeで識別します（有料）。"}目安は${n}枚で<b>約${fmt((n + busy) * avgSec())}</b>${busy ? `（登録中の${busy}枚を含む）` : ""}。登録を始めたら、この画面を閉じてアプリを使っていて大丈夫です。</div>
    <div class="row"><button class="btn primary" id="bkStart" ${n && ai.settings.apiKey ? "" : "disabled"}>${n}枚の登録を始める</button></div>
    ${ai.settings.apiKey ? "" : `<div class="status err small">設定でAPIキーを入れてください。</div>`}
    <div class="bkgrid">${picked.map((p, i) => `<img id="bkp${i}" alt="" class="${p.dup ? "dup" : ""}">`).join("")}</div>`);
  picked.forEach((p, i) => { const img = $(`#bkp${i}`); if (img) img.src = URL.createObjectURL(p.f); });
  $("#bkClose").onclick = () => closeSheet();
  $("#bkStart").onclick = () => start();
}

// Put the chosen photos in the queue (resized copies, so they survive the app closing).
async function start() {
  const btn = $("#bkStart"); btn.disabled = true;
  const museum = $("#bkMuseum").value.trim();
  const todo = picked.filter(x => !x.dup);
  const batch = Date.now();
  let i = 0, bad = 0;
  for (const p of todo) {
    btn.textContent = `写真を準備しています… ${++i}/${todo.length}`;
    const rec = { id: "q" + batch.toString(36) + "-" + i, batch, seq: i, name: p.f.name, fp: fingerprint(p.f), meta: p.meta,
      time: p.time, lastModified: p.f.lastModified || 0, fallbackMuseum: museum, state: "wait", stage: "wait", addedAt: Date.now() };
    try {
      const img = await loadImg(p.f);
      rec.img = await toBlob(img, 1600, .86);
      rec.thumb = await toBlob(img, 240, .7);
      URL.revokeObjectURL(img.src);
    } catch { rec.state = "err"; rec.msg = "この写真は開けませんでした（JPEGかPNGで保存し直すと登録できます）"; rec.doneAt = Date.now(); bad++; }
    await store.qPut(rec);
    q.push(rec);
  }
  picked = [];
  if (bad) toast(`${bad}枚は開けない形式でした`);
  render();
  openProgress();
  kick();
}

// ---------- the worker ----------
function nextItem() { return q.find(x => x.state === "wait"); }

export async function kick() {
  if (running || document.hidden) return;
  if (!nextItem()) { render(); return; }
  if (!ai.settings.apiKey) { render(); return; }
  if (pausedUntil() > Date.now()) { render(); setTimeout(kick, Math.min(pausedUntil() - Date.now() + 500, 2 ** 31 - 1)); return; }
  running = true; lockScreen(); startTick();
  let saved = 0;
  try {
    for (;;) {
      if (document.hidden) break;           // paused by the phone; resumes when the app is shown again
      if (pausedUntil() > Date.now()) break;
      const it = nextItem(); if (!it) break;
      const ok = await processOne(it);
      if (ok === "stop") break;
      if (ok) saved++;
    }
  } finally {
    running = false; stopTick(); unlockScreen(); render();
    if (saved) await app.reload();
    if (!nextItem() && saved) toast(`写真の登録が終わりました（${saved}点）`);
    if (nextItem() && pausedUntil() > Date.now()) setTimeout(kick, Math.min(pausedUntil() - Date.now() + 500, 2 ** 31 - 1));
  }
}

async function setStage(it, stage) { it.stage = stage; it.stageAt = Date.now(); render(it); }

let reloadT = null;
const reloadSoon = () => { clearTimeout(reloadT); reloadT = setTimeout(() => app.reload(), 800); };

async function processOne(it) {
  it.state = "work"; it.startedAt = Date.now(); it.msg = "";
  await setStage(it, "gap");
  try {
    if (ai.isFree()) { const wait = lastCall + GEMINI_GAP_MS - Date.now(); if (wait > 0) await sleep(wait); }
    await setStage(it, "prep");
    const img = await loadImg(it.img);
    // where
    let museum = "", museumId = "", place = "";
    if (Number.isFinite(it.meta?.lat)) {
      const near = app.nearestMuseum(it.meta);
      if (near) { museum = near.name; museumId = near.id; }
      else place = await reverseGeocode(it.meta.lat, it.meta.lng).catch(() => "");
    }
    museum ||= it.fallbackMuseum || "";
    it.place = museum || place;
    await setStage(it, "ai");
    lastCall = Date.now();
    const res = await identifyWithRetry(it, { art: it.img, museum, place, unknown: true });
    const r = app.normalize(res.data, museum || "");
    const isLabel = r.photoKind === "label" || (r.tags || [])[0] === "ラベル";
    r.tags = (r.tags || []).filter(t => t !== "ラベル");

    // a label right after an artwork: attach it there
    const prev = q.filter(x => x.batch === it.batch && x.seq < it.seq).pop();
    if (isLabel && prev?.workId && !prev.isLabel && it.time && prev.time && it.time - prev.time < PAIR_MS) {
      const base = await store.get("works", prev.workId);
      if (base && !base.deleted && !base.labelImage) {
        await setStage(it, "save");
        const w = { ...base };
        w.labelImage = await toBlob(img, 1400, .8);
        w.labelText = r.labelText;
        w.src = { ...(w.src || {}) };
        for (const k of ["title", "artist", "year", "medium", "dimensions"]) if (r[k] && r.basis?.[k] === "label") { w[k] = r[k]; w.src[k] = "label"; }
        if (w.src.title === "label") w.confidence = "high";
        w.needsReview = w.confidence !== "high" && !w.verified;
        await store.put(w);
        prev.title = w.title; prev.state = w.needsReview ? "review" : "done"; await store.qPut(prev); render(prev);
        return finish(it, "label", { title: w.title, workId: w.id, isLabel: true });
      }
    }

    let v = null;
    if (r.title && r.artist) { await setStage(it, "check"); try { v = await app.verify(r); } catch {} }
    await setStage(it, "save");
    const w = app.merge(r, v);
    delete w.alternatives; delete w.manual; delete w.photoKind;
    w.id = "w" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    if (isLabel) w.labelImage = await toBlob(img, 1400, .8); else w.image = await toBlob(img, 1600, .84);
    w.thumb = await toBlob(img, 520, .76);
    w.visited = it.meta?.date || (it.lastModified ? ymd(new Date(it.lastModified)) : "");
    w.createdAt = Date.now();
    w.byName = sync.myName();
    w.srcFile = it.fp;
    if (Number.isFinite(it.meta?.lat)) { w.lat = it.meta.lat; w.lng = it.meta.lng; w.place = place || museum; }
    w.museumId = museumId || P.museumIdFor(w) || "";
    w.needsReview = w.confidence !== "high" && !w.verified;
    await store.put(w);
    return finish(it, w.needsReview ? "review" : "done", { title: w.title || w.artist || "作品名はわかりませんでした", workId: w.id, isLabel });
  } catch (e) {
    return failed(it, e);
  }
}

// The AI call, with a second try for a passing hiccup (an odd answer, a busy server).
async function identifyWithRetry(it, args) {
  for (let n = 0; ; n++) {
    try { return await ai.identify(args); }
    catch (e) {
      if (n < 1 && ["json", "server", "empty", "unknown", "timeout"].includes(e.code)) { it.msg = "もう一度試しています"; render(it); await sleep(4000); lastCall = Date.now(); continue; }
      throw e;
    }
  }
}

async function finish(it, state, extra) {
  Object.assign(it, extra, { state, stage: "", doneAt: Date.now(), msg: "" });
  learn((it.doneAt - it.startedAt) / 1000);
  delete it.img; // the work now has its own copy
  await store.qPut(it);
  render(it); reloadSoon();
  return true;
}

async function failed(it, e) {
  const code = e?.code || "";
  // The phone paused the app mid-request, or the connection dropped: just try again later.
  if (code === "network" || code === "aborted" || document.hidden) {
    it.state = "wait"; it.stage = "wait"; it.msg = navigator.onLine === false ? "電波が戻ったら続けます" : "";
    await store.qPut(it); render(it);
    if (!document.hidden) await sleep(8000);
    return "stop";
  }
  if (code === "rate") {
    it.rate = (it.rate || 0) + 1;
    it.state = "wait"; it.stage = "wait";
    if (it.rate <= 3) { it.msg = "回数制限のため1分待っています"; await store.qPut(it); render(it); await sleep(60000); return false; }
    it.rate = 0;
    it.msg = "";
    setPause(Date.now() + 60 * 60 * 1000, "Geminiの無料枠の上限に達しました。1時間ごとに自動で再開します（1日の上限なら日本時間の夕方16〜17時ごろにリセットされます）");
    await store.qPut(it); render();
    return "stop";
  }
  if (["auth", "no_key", "forbidden", "credit", "limit", "region"].includes(code)) {
    it.state = "wait"; it.stage = "wait"; await store.qPut(it);
    setPause(Date.now() + 365 * 864e5, e.message + "（設定を直したら「再開」を押してください）");
    render(); return "stop";
  }
  it.state = "err"; it.stage = ""; it.doneAt = Date.now();
  it.msg = code === "refusal" ? "AIがこの写真の処理を断りました" : code === "json" ? "AIの答えが読み取れませんでした" : (e?.message || "エラーが起きました");
  await store.qPut(it); render(it);
  return false;
}

// ---------- keep the screen on while registering (where supported) ----------
async function lockScreen() {
  if (!running || wake || document.hidden || !navigator.wakeLock) return;
  try { wake = await navigator.wakeLock.request("screen"); wake.addEventListener("release", () => { wake = null; }); } catch {}
}
function unlockScreen() { try { wake?.release(); } catch {} wake = null; }

// ---------- progress ----------
function itemPct(it) {
  if (it.state !== "work") return it.state === "wait" ? 0 : 100;
  const st = STAGES[it.stage] || STAGES.wait;
  if (it.stage === "ai") { // creep from 25% to 80% over the expected AI time
    const exp = Math.max(6, avgSec() - 6) * 1000;
    return Math.round(25 + 55 * Math.min(1, (Date.now() - (it.stageAt || Date.now())) / exp));
  }
  return st.p;
}
function itemLeft(it) { // seconds left for this photo
  if (it.state !== "work") return avgSec();
  return Math.max(3, avgSec() - (Date.now() - it.startedAt) / 1000);
}
function summary() {
  const all = q, wait = all.filter(x => x.state === "wait"), work = all.find(x => x.state === "work");
  const done = all.filter(x => ["done", "review", "label"].includes(x.state)).length, err = all.filter(x => x.state === "err").length;
  const total = all.length;
  const left = (work ? itemLeft(work) : 0) + wait.length * avgSec();
  return { total, wait: wait.length, work, done, err, left, pct: total ? Math.round(((done + err) * 100 + (work ? itemPct(work) : 0)) / total) : 0 };
}
function statusLine(s) {
  const pause = pausedUntil() > Date.now() && (s.wait || s.work) ? lsGet("artscan.bulkPauseWhy") : "";
  if (pause) return { text: pause, warn: true };
  if (!(s.wait || s.work)) return { text: `登録が終わりました（${s.done}点${s.err ? `・${s.err}枚は失敗` : ""}）` };
  if (!ai.settings.apiKey) return { text: "設定でAPIキーを入れると登録を続けます", warn: true };
  if (!running) return { text: `一時停止中：アプリを開いている間に続きを登録します（残り${s.wait}枚）` };
  return { text: `${s.done + s.err + 1}枚目を登録中（全${s.total}枚）・残り約${fmt(s.left)}` };
}

function waitEta(it) {
  const pos = q.filter(x => x.state === "wait").findIndex(x => x.id === it.id);
  const work = q.find(x => x.state === "work");
  if (pos < 0 || !running) return "";
  return `開始まであと約${fmt((work ? itemLeft(work) : 0) + pos * avgSec())}`;
}
const itemHtml = it => {
  const st = it.state === "work" ? (STAGES[it.stage] || STAGES.wait).t : it.state === "wait" ? (it.msg || "待機中") : DONE[it.state] || "";
  const pct = itemPct(it);
  const eta = it.state === "work" ? `あと約${fmt(itemLeft(it))}` : it.state === "wait" ? waitEta(it) : "";
  return `<div class="bk ${it.state === "work" ? "busy" : it.state}" id="bq-${it.id}" ${it.workId && !it.isLabel ? `data-work="${esc(it.workId)}"` : ""}>
    <img alt="" data-q="${esc(it.id)}"><div class="bkb">
    <div class="small"><b>${esc(st)}</b>${it.title ? ` ${esc(it.title)}` : ""}</div>
    <div class="bkbar"><i style="width:${pct}%"></i></div>
    <div class="small muted">${[eta, it.meta?.date ? it.meta.date.replace(/-/g, ".") : "", it.place, it.state === "work" && it.msg ? it.msg : "", it.state === "err" ? it.msg : ""].filter(Boolean).map(esc).join(" ・ ")}</div>
    </div>${it.state === "err" ? `<button class="btn small ghost" data-retry="${esc(it.id)}">やり直す</button>` : ""}</div>`;
};
function thumbUrl(it) {
  if (!it.thumb) return "";
  if (!urls.has(it.id)) urls.set(it.id, URL.createObjectURL(it.thumb));
  return urls.get(it.id);
}
function fillThumbs(root) { root.querySelectorAll("img[data-q]").forEach(img => { const it = q.find(x => x.id === img.dataset.q); if (it) img.src = thumbUrl(it); }); }

// Redraw the pill, and the progress sheet if it is open (only one row when given).
function render(only) {
  const s = summary(), line = statusLine(s);
  const pill = $("#bulkPill");
  if (pill) {
    const show = s.wait || s.work || (q.length && q.some(x => x.doneAt > Date.now() - 10 * 60 * 1000));
    pill.hidden = !show;
    pill.classList.toggle("warn", !!line.warn);
    pill.classList.toggle("fin", !(s.wait || s.work));
    pill.innerHTML = `<span>${s.wait || s.work ? `写真を登録中 ${s.done + s.err}/${s.total}${running ? `・残り約${fmt(s.left)}` : "・一時停止中"}` : `登録完了 ${s.done}点`}</span><i style="width:${s.pct}%"></i>`;
  }
  const list = $("#bqList");
  if (!list) return;
  $("#bqLine").textContent = line.text;
  $("#bqLine").classList.toggle("err", !!line.warn);
  $("#bqBar").style.width = s.pct + "%";
  $("#bqPct").textContent = `${s.done + s.err}/${s.total}枚 ・ ${s.pct}%`;
  $("#bqPause").hidden = !(s.wait || s.work);
  $("#bqPause").textContent = running ? "一時停止" : "再開";
  $("#bqClear").hidden = !q.some(x => x.doneAt);
  if (only) {
    const el = $(`#bq-${only.id}`);
    if (el) { el.outerHTML = itemHtml(only); fillThumbs($(`#bq-${only.id}`)); return; }
  }
  list.innerHTML = q.map(itemHtml).join("") || `<p class="small muted">登録待ちの写真はありません。</p>`;
  fillThumbs(list);
}

function startTick() { stopTick(); tick = setInterval(() => { const w = q.find(x => x.state === "work"); render(w); }, 1000); }
function stopTick() { clearInterval(tick); tick = null; }

export function openProgress() {
  openSheet(`<div class="bar"><button class="btn ghost" id="bqClose">← 戻る</button></div>
    <h2>写真の登録</h2>
    <div class="bqhead"><div class="bkbar big"><i id="bqBar"></i></div><div class="small muted" id="bqPct"></div></div>
    <div class="status small" id="bqLine"></div>
    <p class="small muted" style="margin:0">この画面は閉じても大丈夫です。アプリを閉じたり他のアプリに切り替えると、スマホの仕組みで一時停止し、次にアプリを開いたとき続きから自動で再開します。</p>
    <div class="row"><button class="btn small" id="bqPause">一時停止</button><button class="btn small ghost" id="bqClear">終わった写真を一覧から消す</button></div>
    <div class="bulk" id="bqList"></div>`);
  $("#bqClose").onclick = () => closeSheet();
  $("#bqPause").onclick = async () => {
    if (running) { setPause(Date.now() + 365 * 864e5, "一時停止しています。「再開」で続きを登録します"); render(); }
    else { setPause(0); kick(); render(); }
  };
  $("#bqClear").onclick = async () => {
    for (const it of q.filter(x => x.doneAt)) { await store.qDel(it.id); const u = urls.get(it.id); if (u) URL.revokeObjectURL(u); urls.delete(it.id); }
    q = q.filter(x => !x.doneAt); render();
  };
  $("#bqList").onclick = async e => {
    const r = e.target.closest("[data-retry]");
    if (r) {
      const it = q.find(x => x.id === r.dataset.retry);
      if (it && it.img) { it.state = "wait"; it.stage = "wait"; it.msg = ""; delete it.doneAt; await store.qPut(it); render(); kick(); }
      else if (it) toast("この写真はもう一度選び直してください");
      return;
    }
    const row = e.target.closest("[data-work]");
    if (row) { closeSheet(); app.go("collection"); app.openDetail(row.dataset.work); }
  };
  render();
}
