// Register many photos you already took, in one go.
// Each photo is identified by the AI and saved automatically. Its date and place come from the photo.
// A label (caption) photo taken within 5 minutes after an artwork photo is attached to that artwork.
import * as store from "./store.js";
import * as ai from "./ai.js";
import * as sync from "./sync.js";
import * as P from "./places.js";
import { $, esc, toast, openSheet, closeSheet, onSheetClose, app, loadImg, toBlob, photoMeta, reverseGeocode, ymd } from "./ui.js";

const PAIR_MS = 5 * 60 * 1000;
const GEMINI_GAP_MS = 6500; // the free tier allows only a few requests per minute
let items = [], running = false, stopFlag = false;

const fingerprint = f => `${f.name}|${f.size}|${f.lastModified}`;

export function init() {
  $("#inBulk").onchange = async e => {
    const files = [...e.target.files]; e.target.value = "";
    if (!files.length) return;
    if (running) { toast("いまの登録が終わってから追加してください"); return; }
    await prepare(files);
  };
}

async function prepare(files) {
  const known = new Set(app.works().map(w => w.srcFile).filter(Boolean));
  items = [];
  for (const f of files) {
    if (!/^image\//.test(f.type) && !/\.(jpe?g|png|heic|heif|webp)$/i.test(f.name)) continue;
    const meta = await photoMeta(f);
    items.push({ f, meta, time: meta.time || f.lastModified || 0, state: known.has(fingerprint(f)) ? "dup" : "wait", msg: "" });
  }
  items.sort((a, b) => a.time - b.time);
  open();
}

function open() {
  const n = items.filter(i => i.state === "wait").length, dup = items.filter(i => i.state === "dup").length;
  const free = ai.isFree();
  openSheet(`<div class="bar"><button class="btn ghost" id="bkClose">← 戻る</button></div>
    <h2>まとめて登録</h2>
    <p class="small muted" style="margin:0">${items.length}枚の写真から作品を登録します${dup ? `（${dup}枚は登録済みなので飛ばします）` : ""}。撮影日と場所は写真から読み取ります。作品のすぐ後に撮ったラベルの写真は、その作品にまとめます。</p>
    <div class="field"><label for="bkMuseum">美術館（写真に位置情報がないときに使います・任意）</label><input id="bkMuseum" list="museumList" placeholder="例：国立西洋美術館"></div>
    <div class="status small">${free ? `Gemini無料枠の回数制限のため、1枚あたり7秒ほどかかります（${n}枚で約${Math.ceil(n * 7 / 60)}分）。` : `Claudeで識別します。1枚 約${ai.settings.modelFor("claude").includes("haiku") ? "0.3" : "5〜10"}円かかります。`}登録中はこの画面を開いたままにしてください。</div>
    <div class="row"><button class="btn primary" id="bkStart" ${n && ai.settings.apiKey ? "" : "disabled"}>${n}枚を登録する</button><button class="btn ghost" id="bkStop" hidden>止める</button></div>
    ${ai.settings.apiKey ? "" : `<div class="status err small">設定でAPIキーを入れてください。</div>`}
    <div class="bulk" id="bkList">${items.map(itemHtml).join("")}</div>`);
  items.forEach((it, i) => { const img = $(`#bk${i} img`); if (img) img.src = URL.createObjectURL(it.f); });
  $("#bkClose").onclick = () => closeSheet();
  $("#bkStart").onclick = run;
  $("#bkStop").onclick = () => { stopFlag = true; $("#bkStop").disabled = true; $("#bkStop").textContent = "止めています…"; };
}
onSheetClose(() => { stopFlag = true; });

const LABEL = { wait: "待機中", dup: "登録済み", work: "識別しています…", done: "登録しました", label: "前の作品のラベルとしてまとめました", review: "登録しました（要確認）", err: "失敗" };
function itemHtml(it, i) {
  return `<div class="bk ${it.state}" id="bk${i}"><img alt=""><div><div class="small"><b>${esc(LABEL[it.state] || "")}</b>${it.title ? ` ${esc(it.title)}` : ""}</div>
    <div class="small muted">${it.meta.date ? esc(it.meta.date.replace(/-/g, ".")) : ""}${it.place ? ` ・ ${esc(it.place)}` : ""}${it.msg ? ` ・ ${esc(it.msg)}` : ""}</div></div></div>`;
}
function update(i) {
  const el = $(`#bk${i}`); if (!el) return;
  const src = el.querySelector("img")?.src;
  el.outerHTML = itemHtml(items[i], i);
  const img = $(`#bk${i} img`); if (img && src) img.src = src;
}

async function run() {
  running = true; stopFlag = false;
  $("#bkStart").disabled = true; $("#bkStop").hidden = false;
  const fallbackMuseum = $("#bkMuseum").value.trim();
  let last = null; // the previous saved artwork, for label pairing
  let lastCall = 0, saved = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (stopFlag) break;
    if (it.state !== "wait") continue;
    it.state = "work"; update(i);
    try {
      if (ai.isFree()) { const wait = lastCall + GEMINI_GAP_MS - Date.now(); if (wait > 0) await new Promise(r => setTimeout(r, wait)); }
      const img = await loadImg(it.f);
      const art = await toBlob(img, 1568);
      // where
      let museum = "", museumId = "", place = "";
      if (Number.isFinite(it.meta.lat)) {
        const near = app.nearestMuseum(it.meta);
        if (near) { museum = near.name; museumId = near.id; }
        else place = await reverseGeocode(it.meta.lat, it.meta.lng);
      }
      museum ||= fallbackMuseum;
      it.place = museum || place;
      lastCall = Date.now();
      const res = await ai.identify({ art, museum, place, unknown: true });
      const r = app.normalize(res.data, museum || "");
      const isLabel = (r.tags || [])[0] === "ラベル" || (r.labelText.length > 15 && !r.lookFor.length);
      r.tags = (r.tags || []).filter(t => t !== "ラベル");
      // a label right after an artwork: attach it there
      if (isLabel && last && it.time && last.time && it.time - last.time < PAIR_MS && !last.w.labelImage) {
        const w = { ...last.w };
        w.labelImage = await toBlob(img, 1400, .8);
        w.labelText = r.labelText;
        w.src = { ...(w.src || {}) };
        for (const k of ["title", "artist", "year", "medium", "dimensions"]) {
          if (r[k] && r.basis?.[k] === "label") { w[k] = r[k]; w.src[k] = "label"; }
        }
        if (w.src.title === "label") w.confidence = "high";
        w.needsReview = w.confidence !== "high" && !w.verified;
        last.w = await store.put(w);
        it.state = "label"; it.title = w.title;
        const prev = items[last.i]; prev.state = w.needsReview ? "review" : "done"; prev.title = w.title; update(last.i);
        update(i); continue;
      }
      let v = null;
      if (r.title && r.artist) { try { v = await app.verify(r); } catch {} }
      const w = app.merge(r, v);
      delete w.alternatives; delete w.manual;
      w.id = "w" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      if (isLabel) { w.labelImage = await toBlob(img, 1400, .8); w.thumb = await toBlob(img, 520, .76); }
      else { w.image = await toBlob(img, 1600, .84); w.thumb = await toBlob(img, 520, .76); }
      w.visited = it.meta.date || (it.f.lastModified ? ymd(new Date(it.f.lastModified)) : "");
      w.createdAt = Date.now();
      w.byName = sync.myName();
      w.srcFile = fingerprint(it.f);
      if (Number.isFinite(it.meta.lat)) { w.lat = it.meta.lat; w.lng = it.meta.lng; w.place = place || museum; }
      w.museumId = museumId || P.museumIdFor(w) || "";
      w.needsReview = w.confidence !== "high" && !w.verified;
      const savedW = await store.put(w);
      last = isLabel ? null : { w: savedW, time: it.time, i };
      it.state = w.needsReview ? "review" : "done"; it.title = w.title || w.artist || "";
      saved++;
    } catch (e) {
      it.state = "err"; it.msg = e.message || "";
      if (e.code === "auth" || e.code === "credit" || e.code === "limit") { update(i); stopFlag = true; break; }
      it.retries = (it.retries || 0) + 1;
      if (e.code === "rate" && it.retries > 2) { it.msg = "無料枠の上限に達しました。時間をおいて続きを登録してください"; it.state = "wait"; update(i); stopFlag = true; break; }
      if (e.code === "rate") { it.state = "wait"; it.msg = "回数制限のため待っています"; update(i); await new Promise(r => setTimeout(r, 60000)); i--; continue; }
    }
    update(i);
  }
  running = false;
  const btn = $("#bkStop"); if (btn) btn.hidden = true;
  const left = items.filter(x => x.state === "wait").length;
  toast(stopFlag && left ? `${saved}点を登録しました（${left}枚は未登録）` : `${saved}点を登録しました`);
  if ($("#bkStart")) { $("#bkStart").textContent = left ? `残り${left}枚を登録する` : "完了"; $("#bkStart").disabled = !left; }
  await app.reload();
}
