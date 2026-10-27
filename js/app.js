import * as store from "./store.js";
import * as ai from "./ai.js";
import { verify, merge } from "./verify.js";
import * as sync from "./sync.js";
import * as P from "./places.js";
import * as museumsTab from "./museums.js";
import * as calendarTab from "./calendar.js";
import * as eventsTab from "./events.js";
import * as bulk from "./bulk.js";
import { $, esc, today, toast, openSheet, closeSheet, onSheetClose, app, loadImg, toBlob, reverseGeocode, photoMeta, dist } from "./ui.js";
const yen = usd => { const y = usd * ai.USD_JPY; return "¥" + (y < 10 ? y.toFixed(1) : Math.round(y).toLocaleString("ja-JP")); };

/* ================= sample works (only while the collection is empty) ================= */
function swatch(colors, kind) {
  const c = document.createElement("canvas"); c.width = 240; c.height = 300;
  const g = c.getContext("2d");
  const lg = g.createLinearGradient(0, 0, 0, 300); colors.forEach((col, i) => lg.addColorStop(i / (colors.length - 1), col));
  g.fillStyle = lg; g.fillRect(0, 0, 240, 300); g.globalAlpha = .55;
  if (kind === "wave") { g.fillStyle = "#f4f7f8"; for (let i = 0; i < 7; i++) { g.beginPath(); g.arc(60 + i * 22, 190 - i * 9, 40 - i * 3, Math.PI, 0); g.fill(); } g.fillStyle = "#1d3557"; g.beginPath(); g.moveTo(0, 230); for (let x = 0; x <= 240; x += 10) g.lineTo(x, 220 + Math.sin(x / 18) * 14); g.lineTo(240, 300); g.lineTo(0, 300); g.fill(); }
  if (kind === "stars") { g.fillStyle = "#f6d365"; for (let i = 0; i < 11; i++) { g.beginPath(); g.arc(20 + (i * 53) % 220, 30 + (i * 37) % 140, 6 + (i % 3) * 4, 0, 7); g.fill(); } g.fillStyle = "#0b1d2e"; g.beginPath(); g.moveTo(40, 300); g.lineTo(62, 90); g.lineTo(84, 300); g.fill(); }
  if (kind === "lily") { for (let i = 0; i < 14; i++) { g.fillStyle = i % 2 ? "#d8a7c7" : "#9ccf9a"; g.beginPath(); g.ellipse((i * 61) % 240, 60 + (i * 43) % 220, 24, 8, 0, 0, 7); g.fill(); } }
  return c.toDataURL("image/jpeg", .8);
}
const SAMPLES = [
  { id: "s1", sample: true, title: "神奈川沖浪裏", artist: "葛飾北斎", artistReading: "かつしか ほくさい", year: "1831年頃", medium: "木版画", movement: "浮世絵", museum: "東京国立博物館", visited: "2026-04-12", lat: 35.7188, lng: 139.7765,
    description: "『冨嶽三十六景』の一図。大波の向こうに小さく富士山を置いた大胆な構図で、ヨーロッパの印象派にも影響を与えた。", colors: ["#c9d6df", "#52616b"], kind: "wave" },
  { id: "s2", sample: true, title: "星月夜", artist: "フィンセント・ファン・ゴッホ", artistReading: "Vincent van Gogh", year: "1889年", medium: "油彩、カンヴァス", movement: "ポスト印象派", museum: "ニューヨーク近代美術館", visited: "2025-09-03", lat: 40.7614, lng: -73.9776,
    description: "サン＝レミの療養院の窓から見た夜景をもとに描かれた。うねる筆致の空と糸杉が画面を支配する。", colors: ["#1d3a6e", "#0b1d2e"], kind: "stars" },
  { id: "s3", sample: true, title: "睡蓮", artist: "クロード・モネ", artistReading: "Claude Monet", year: "1916年", medium: "油彩、カンヴァス", movement: "印象派", museum: "国立西洋美術館", visited: "2026-04-12", lat: 35.7155, lng: 139.7757,
    description: "ジヴェルニーの庭の池を描いた連作の一点。水面に映る空と睡蓮が、境界のない画面をつくる。", colors: ["#6d9a8a", "#2f5a62"], kind: "lily" },
];
SAMPLES.forEach(s => { s.thumbUrl = s.imageUrl = swatch(s.colors, s.kind); s.createdAt = Date.parse(s.visited); });

/* ================= state ================= */
let works = [];
const urlCache = new Map(); // blob -> object URL
function urlFor(blob) {
  if (!blob) return "";
  if (typeof blob === "string") return blob;
  let u = urlCache.get(blob);
  if (!u) { u = URL.createObjectURL(blob); urlCache.set(blob, u); }
  return u;
}
const thumbOf = w => w.thumbUrl || urlFor(w.thumb || w.image);
const imageOf = w => w.imageUrl || urlFor(w.image || w.thumb);
const visible = () => works.length ? works : SAMPLES;
const findWork = id => visible().find(x => x.id === id);

async function reload() {
  try { works = await store.all(); await P.loadLocal(); }
  catch (e) { works = []; toast("データを読み込めませんでした：" + e.message); }
  render();
}
// Changes that arrived from the other device.
let remoteT = null;
store.onChange((name, local) => { if (!local) { clearTimeout(remoteT); remoteT = setTimeout(reload, 300); } });

/* ================= scan ================= */
const shots = { art: null, label: null }; // {img, file}
let geo = null; // {lat, lng, source, place}

async function onShot(kind, file) {
  if (!file) return;
  let img;
  try { img = await loadImg(file); }
  catch { status("この画像は読み込めませんでした。JPEGかPNGの写真を選んでください。", true); return; }
  shots[kind] = { img, file };
  const el = kind === "art" ? $("#shotArt") : $("#shotLabel");
  el.classList.add("has");
  el.querySelector("img")?.remove(); el.querySelector(".clear")?.remove();
  const pv = document.createElement("img"); pv.alt = ""; pv.src = img.src; el.prepend(pv);
  const x = document.createElement("button"); x.className = "clear"; x.type = "button"; x.setAttribute("aria-label", "写真を外す"); x.textContent = "×";
  x.onclick = ev => { ev.stopPropagation(); clearShot(kind); };
  el.append(x);
  updateIdentify();
  if (kind === "art" || !geo) locate(file);
}
function clearShot(kind) {
  shots[kind] = null;
  const el = kind === "art" ? $("#shotArt") : $("#shotLabel");
  el.classList.remove("has"); el.querySelector("img")?.remove(); el.querySelector(".clear")?.remove(); el.querySelector("input").value = "";
  updateIdentify();
}
$("#inArt").onchange = e => onShot("art", e.target.files[0]);
$("#inLabel").onchange = e => onShot("label", e.target.files[0]);

// Where was it taken? Photo GPS first, then this device's location.
async function locate(file) {
  let found = null;
  try {
    if (window.exifr) {
      const meta = await exifr.parse(file, { gps: true, pick: ["DateTimeOriginal", "latitude", "longitude"] }).catch(() => null);
      if (meta?.DateTimeOriginal instanceof Date) {
        const d = meta.DateTimeOriginal; $("#inDate").value = new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
      }
      if (meta?.latitude && meta?.longitude) found = { lat: meta.latitude, lng: meta.longitude, source: "photo" };
    }
  } catch {}
  if (!found && settingsGet("geo", "1") === "1" && navigator.geolocation && isFresh(file)) {
    found = await new Promise(res => navigator.geolocation.getCurrentPosition(
      p => res({ lat: p.coords.latitude, lng: p.coords.longitude, source: "device" }),
      () => res(null), { enableHighAccuracy: true, timeout: 8000, maximumAge: 120000 }));
  }
  if (!found) { if (!geo) $("#geoNote").textContent = ""; return; }
  geo = found;
  $("#geoNote").textContent = found.source === "photo" ? "写真の位置情報を記録します" : "現在地を記録します";
  const near = nearestMuseum(found);
  const place = near ? near.name : await reverseGeocode(found.lat, found.lng);
  if (near) geo.museumId = near.id;
  if (place) {
    geo.place = place;
    if (!$("#inMuseum").value.trim()) $("#inMuseum").value = place;
    $("#geoNote").textContent += `（${place} 付近）`;
  }
}
// A museum from the list within 400 m of the photo.
function nearestMuseum(pt) {
  let best = null, bd = 400;
  for (const m of P.museums([])) if (Number.isFinite(m.lat)) { const d = dist(pt, m); if (d < bd) { bd = d; best = m; } }
  return best;
}
// Photos taken just now (camera) get the current location; old library photos don't.
function isFresh(file) { return !file.lastModified || Date.now() - file.lastModified < 30 * 60 * 1000; }

function updateIdentify() {
  const hasKey = !!ai.settings.apiKey;
  $("#keyNotice").hidden = hasKey;
  $("#btnIdentify").disabled = !(shots.art || shots.label) || !hasKey;
}
function status(msg, err, spin) {
  const s = $("#scanStatus"); s.hidden = !msg; s.classList.toggle("err", !!err);
  s.innerHTML = msg ? (spin ? '<span class="spinner"></span>' : "") + esc(msg) : "";
}

// If the phone paused the app (switched to another app) and the request broke, try again once
// the app is shown again, instead of showing an error.
async function keepTrying(fn) {
  for (let n = 0; ; n++) {
    let hidden = document.hidden;
    const mark = () => { if (document.hidden) hidden = true; };
    document.addEventListener("visibilitychange", mark);
    try { return await fn(); }
    catch (e) {
      const broken = ["network", "timeout", "aborted"].includes(e.code) || (e.code === "json" && n === 0) || (e.code === "server" && n === 0);
      if (!broken || n >= 2) throw e;
      if (hidden || document.hidden) await new Promise(r => { const f = () => { if (!document.hidden) { document.removeEventListener("visibilitychange", f); r(); } }; document.addEventListener("visibilitychange", f); f(); });
      else if (e.code === "network") throw e;
      status("もう一度調べています…", false, true);
    } finally { document.removeEventListener("visibilitychange", mark); }
  }
}

async function runIdentify(precise) {
  const btn = $("#btnIdentify"); btn.disabled = true;
  $("#result").hidden = true;
  status(precise ? "高精度モード（Claude Opus）で調べ直しています…（20〜60秒ほど）" : "作品を調べています…（10〜40秒ほど）", false, true);
  const before = ai.usage().usd;
  try {
    const art = shots.art ? await toBlob(shots.art.img, 1568) : null;
    const label = shots.label ? await toBlob(shots.label.img, 1568, .88) : null;
    const museum = $("#inMuseum").value.trim();
    const args = { art, label, museum, place: geo?.place };
    const res = await keepTrying(() => precise ? ai.identifyPrecise(args) : ai.identify(args));
    const cost = res.provider === "claude" ? ai.usage().usd - before : 0;
    const r = normalize(res.data, museum);
    let v = null;
    if (r.title && r.artist) {
      status("Wikipediaで内容を確かめています…", false, true);
      v = await verify(r);
    }
    status("");
    showResult(merge(r, v), cost, res, res.data?._note);
  } catch (e) {
    status(e.message || "識別できませんでした。手入力で保存できます。", true);
  } finally { updateIdentify(); }
}
$("#btnIdentify").onclick = () => runIdentify(false);
$("#btnManual").onclick = () => showResult({ ...normalize({}, $("#inMuseum").value.trim()), src: {}, manual: true });
$("#btnGoSettings").onclick = () => openSettings();

function normalize(d, museum) {
  const s = k => (typeof d[k] === "string" ? d[k] : "").trim();
  const arr = k => Array.isArray(d[k]) ? d[k].map(String).filter(Boolean) : [];
  return {
    title: s("title"), originalTitle: s("originalTitle"), artist: s("artist"), artistReading: s("artistReading"),
    year: s("year"), medium: s("medium"), dimensions: s("dimensions"), movement: s("movement"),
    museum: museum || s("museum"), description: s("description"), artistNote: s("artistNote"),
    lookFor: arr("lookFor"), labelText: s("labelText"), confidence: s("confidence"),
    alternatives: arr("alternatives").slice(0, 3), tags: arr("tags").slice(0, 8),
    basis: d.basis && typeof d.basis === "object" ? d.basis : {},
    photoKind: s("photoKind"),
  };
}
const CONF = { high: ["high", "確度 高"], medium: ["mid", "確度 中"], low: ["low", "確度 低：内容を確認してください"] };
const confHtml = c => { const k = CONF[c]; return k ? `<span class="conf ${k[0]}"><i></i>${k[1]}</span>` : ""; };

const SRC = { label: ["label", "ラベル"], wiki: ["wiki", "Wikipedia確認済"], ai: ["ai", "AIの推測"], user: ["user", "手入力"] };
const srcBadge = k => { const v = SRC[k]; return v ? `<span class="src ${v[0]}">${v[1]}</span>` : ""; };
function verifyBanner(w) {
  if (w.manual) return "";
  if (w.verified) {
    const link = w.wiki ? `<a href="${esc(w.wiki.url)}" target="_blank" rel="noopener">Wikipedia${w.wiki.lang === "en" ? "（英語）" : ""}「${esc(w.wiki.title)}」</a>` : `<a href="${esc(w.wikidataUrl)}" target="_blank" rel="noopener">Wikidata</a>`;
    return `<div class="verify ok small">この作品は ${link} で確認できました。「AIの推測」の印がある項目だけ注意してください。</div>`;
  }
  return `<div class="verify warn small">Wikipediaでは確認できませんでした。「AIの推測」の印がある項目は間違っている可能性があります。ラベルの写真も撮ると正確になります。</div>`;
}
const FIELDS = [["title", "作品名"], ["artist", "作家"], ["year", "制作年"], ["medium", "技法・素材"], ["movement", "流派・様式"],
  ["dimensions", "寸法"], ["museum", "美術館・展覧会"], ["originalTitle", "原題"], ["artistReading", "作家（原語・読み）"]];
function formHtml(w, p) {
  const src = w.src || {};
  return `<div class="grid2">${FIELDS.map(([k, l]) => `<div class="field"><label for="${p}-${k}">${l}${srcBadge(src[k])}</label><input id="${p}-${k}" value="${esc(w[k])}"></div>`).join("")}</div>
  <div class="field"><label for="${p}-description">解説</label><textarea id="${p}-description">${esc(w.description)}</textarea></div>
  <div class="field"><label for="${p}-tags">タグ（読点で区切る）</label><input id="${p}-tags" value="${esc((w.tags || []).join("、"))}"></div>
  <div class="field"><label for="${p}-labelText">ラベルの文字</label><textarea id="${p}-labelText" style="min-height:70px">${esc(w.labelText)}</textarea></div>
  <div class="field"><label for="${p}-note">メモ</label><textarea id="${p}-note" style="min-height:60px" placeholder="気づいたこと、感じたこと">${esc(w.note)}</textarea></div>`;
}
function readForm(p, base) {
  const w = { ...base, src: { ...(base.src || {}) } };
  [...FIELDS.map(f => f[0]), "description", "labelText", "note"].forEach(k => {
    const el = document.getElementById(p + "-" + k); if (!el) return;
    const v = el.value.trim();
    if (v !== (base[k] || "") && ["title", "artist", "year", "medium", "dimensions", "museum"].includes(k)) w.src[k] = v ? "user" : "";
    w[k] = v;
  });
  const t = document.getElementById(p + "-tags"); if (t) w.tags = t.value.split(/[、,，\s]+/).map(s => s.trim()).filter(Boolean);
  return w;
}

function showResult(r, cost, used, note) {
  const box = $("#result"); box.hidden = false;
  const canEscalate = used && ai.canEscalate(used.provider, used.model);
  const unsure = r.confidence && r.confidence !== "high";
  box.innerHTML = `<div class="box">
    <div class="row" style="justify-content:space-between"><h3>${r.title ? esc(r.title) : "作品情報"}</h3>${confHtml(r.confidence)}</div>
    ${r.alternatives.length ? `<div class="small muted">他の候補：${r.alternatives.map(esc).join(" / ")}</div>` : ""}
    ${used ? `<div class="small muted mono">${used.provider === "claude" ? `今回のAI利用料 約${yen(cost)}` : "今回のAI利用料 0円（Gemini無料枠）"}</div>` : ""}
    ${note ? `<div class="small muted">${esc(note)}</div>` : ""}
    ${verifyBanner(r)}
    ${r.wiki?.extract ? `<details class="small"><summary>Wikipediaの説明を読む</summary><div class="prose" style="margin-top:6px">${esc(r.wiki.extract)}</div></details>` : ""}
    ${canEscalate ? `<div class="${unsure ? "status" : ""} row" style="justify-content:space-between">
      <span class="small${unsure ? "" : " muted"}">${unsure ? "AIの自信が低めです。高精度モード（Claude Opus）で調べ直せます。" : "結果が違うときは、高精度モード（Claude Opus）で調べ直せます。"}<br><span class="muted">有料：1回 約10円</span></span>
      <button class="btn ${unsure ? "primary" : "ghost"} small" id="btnPrecise">高精度で再識別</button></div>` : ""}
    ${formHtml(r, "new")}
    <div class="row"><button class="btn primary" id="btnSave">コレクションに保存</button><button class="btn ghost" id="btnDiscard">やり直す</button></div>
  </div>`;
  $("#btnSave").onclick = async () => {
    const w = readForm("new", r);
    if (!w.title && !w.artist) { toast("作品名か作家を入れてください"); return; }
    $("#btnSave").disabled = true;
    try {
      w.id = "w" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      if (shots.art) { w.image = await toBlob(shots.art.img, 1600, .84); w.thumb = await toBlob(shots.art.img, 520, .76); }
      if (shots.label) { w.labelImage = await toBlob(shots.label.img, 1400, .8); if (!w.thumb) w.thumb = await toBlob(shots.label.img, 520, .76); }
      w.visited = $("#inDate").value || today();
      w.createdAt = Date.now();
      w.byName = sync.myName();
      if (geo) { w.lat = geo.lat; w.lng = geo.lng; w.place = geo.place || ""; }
      w.museumId = P.museumIdFor(w) || "";
      delete w.alternatives; delete w.manual;
      await store.put(w);
      store.persist();
      toast("保存しました");
      resetScan(); await reload(); go("collection"); openDetail(w.id);
    } catch (e) {
      toast("保存できませんでした：" + (e?.message || "")); $("#btnSave").disabled = false;
    }
  };
  $("#btnDiscard").onclick = resetScan;
  if ($("#btnPrecise")) $("#btnPrecise").onclick = () => runIdentify(true);
  box.scrollIntoView({ behavior: "smooth", block: "start" });
}
function resetScan() {
  clearShot("art"); clearShot("label"); geo = null; $("#geoNote").textContent = "";
  $("#result").hidden = true; $("#result").innerHTML = ""; status("");
}

/* ================= collection ================= */
let group = "artist", filterVal = "";
function groupValues(list) {
  if (group === "fav") return [];
  return [...new Set(list.map(w => w[group]).filter(Boolean))];
}
function cardHtml(w) {
  return `<button class="work" data-id="${esc(w.id)}">
    <div class="frame">${thumbOf(w) ? `<img src="${thumbOf(w)}" alt="${esc(w.title)}" loading="lazy">` : ""}${w.sample ? `<span class="badge">サンプル</span>` : w.needsReview ? `<span class="badge review">要確認</span>` : ""}${w.fav ? `<span class="fav-mark" aria-label="お気に入り">♥</span>` : ""}</div>
    <div class="label"><div class="artist">${esc(w.artist || "作家不明")}</div><div class="title">${esc(w.title || "無題")}${w.year ? `、${esc(w.year)}` : ""}</div><div class="meta">${esc(w.museum || "")}</div></div>
  </button>`;
}
const yearNum = y => { const m = String(y || "").match(/\d{3,4}/); return m ? +m[0] : 99999; };
function render() {
  const list = visible();
  $("#count").textContent = works.length ? works.length + " 点" : "";
  $("#sampleNote").hidden = works.length > 0;
  document.querySelectorAll("#groupChips .chip").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.g === group)));
  const vals = groupValues(list);
  if (filterVal && !vals.includes(filterVal)) filterVal = "";
  $("#chips").innerHTML = vals.length > 1 ? [`<button class="chip" data-v="" aria-pressed="${!filterVal}">すべて</button>`,
    ...vals.map(v => `<button class="chip" data-v="${esc(v)}" aria-pressed="${v === filterVal}">${esc(v)}</button>`)].join("") : "";
  const q = $("#q").value.trim().toLowerCase();
  let shown = list.filter(w => (group === "fav" ? w.fav : (!filterVal || w[group] === filterVal)) &&
    (!q || [w.title, w.originalTitle, w.artist, w.artistReading, w.museum, w.movement, w.labelText, w.note, (w.tags || []).join(" ")].join(" ").toLowerCase().includes(q)));
  const sort = $("#sort").value;
  shown = [...shown].sort(sort === "old" ? (a, b) => (a.createdAt || 0) - (b.createdAt || 0)
    : sort === "artist" ? (a, b) => (a.artist || "").localeCompare(b.artist || "", "ja")
    : sort === "year" ? (a, b) => yearNum(a.year) - yearNum(b.year)
    : (a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  $("#wall").innerHTML = shown.length ? shown.map(cardHtml).join("") :
    `<div class="empty" style="grid-column:1/-1"><strong>見つかりませんでした</strong><span class="muted small">${group === "fav" ? "作品の詳細画面で ♡ を押すと、お気に入りに入ります。" : "別の言葉で検索するか、絞り込みを「すべて」に戻してください。"}</span></div>`;
  $("#museumList").innerHTML = [...new Set(works.map(w => w.museum).filter(Boolean))].map(m => `<option value="${esc(m)}">`).join("");
  if (!$("#v-museums").hidden) museumsTab.render();
  if (!$("#v-calendar").hidden) calendarTab.render();
  if (!$("#v-events").hidden) eventsTab.render();
}
$("#q").oninput = render;
$("#sort").onchange = render;
$("#groupChips").onclick = e => { const b = e.target.closest(".chip"); if (!b) return; group = b.dataset.g; filterVal = ""; render(); };
$("#chips").onclick = e => { const b = e.target.closest(".chip"); if (!b) return; filterVal = b.dataset.v; render(); };
$("#wall").onclick = e => { const b = e.target.closest(".work"); if (b) openDetail(b.dataset.id); };

/* ================= detail ================= */
let askAbort = null;
onSheetClose(() => askAbort?.abort());

function openDetail(id) {
  const w = findWork(id); if (!w) return;
  const sr = w.src || {};
  const meta = [["制作年", w.year, sr.year], ["技法", w.medium, sr.medium], ["寸法", w.dimensions, sr.dimensions], ["様式", w.movement], ["展示場所", w.museum, sr.museum],
    ["所蔵", w.collection && w.collection !== w.museum ? w.collection : "", "wiki"],
    ["訪問日", (w.visited || "").replace(/-/g, ".")], ["原題", w.originalTitle]].filter(x => x[1]);
  openSheet(`<div class="bar"><button class="btn ghost" id="dClose">← 戻る</button>
      <div class="row">${w.sample ? "" : `<button class="btn ghost small" id="dFav" aria-pressed="${!!w.fav}">${w.fav ? "♥ お気に入り" : "♡ お気に入り"}</button><button class="btn ghost small" id="dShare">共有</button><button class="btn ghost small" id="dEdit">編集</button>`}</div></div>
    <div class="hero">
      <div class="frame">${imageOf(w) ? `<img src="${imageOf(w)}" alt="${esc(w.title)}">` : ""}</div>
      <div class="plaque">
        ${w.sample ? `<span class="small muted">サンプル</span>` : ""}
        <div class="artist">${esc(w.artist || "作家不明")}${w.artistReading ? ` <span class="small muted">${esc(w.artistReading)}</span>` : ""}${srcBadge(sr.artist)}</div>
        <div class="title">${esc(w.title || "無題")}${srcBadge(sr.title)}</div>
        ${confHtml(w.confidence)}
        <dl>${meta.map(([k, v, so]) => `<dt>${k}</dt><dd>${esc(v)}${srcBadge(so)}</dd>`).join("")}</dl>
        ${w.sample ? "" : verifyBanner(w)}
        ${w.needsReview ? `<div class="verify warn small row" style="justify-content:space-between"><span>まとめて登録した作品です。AIの自信が低めなので、内容を確かめてください。</span><button class="btn small" id="dReviewed">確認しました</button></div>` : ""}
        ${w.byName && sync.enabled() ? `<div class="small muted">登録：${esc(w.byName)}</div>` : ""}
        ${(w.tags || []).length ? `<div class="chips" style="flex-wrap:wrap">${w.tags.map(t => `<span class="chip">${esc(t)}</span>`).join("")}</div>` : ""}
      </div>
    </div>
    ${w.wiki?.extract ? `<div class="box"><h3>Wikipediaより</h3><div class="prose">${esc(w.wiki.extract)}</div><a class="small" href="${esc(w.wiki.url)}" target="_blank" rel="noopener">Wikipediaで続きを読む</a></div>` : ""}
    ${w.description ? `<div class="box"><h3>${w.sample ? "解説" : "AIによる解説"}</h3><div class="prose">${esc(w.description)}</div>${w.artistNote ? `<div class="prose muted small">${esc(w.artistNote)}</div>` : ""}</div>` : ""}
    ${(w.lookFor || []).length ? `<div class="box"><h3>実物で見てほしいところ</h3><ul style="margin:0;padding-left:1.2em">${w.lookFor.map(t => `<li>${esc(t)}</li>`).join("")}</ul></div>` : ""}
    ${w.note ? `<div class="box"><h3>メモ</h3><div class="prose">${esc(w.note)}</div></div>` : ""}
    ${w.labelText || w.labelImage ? `<div class="box"><h3>ラベル</h3>${w.labelImage ? `<img class="label-photo" src="${urlFor(w.labelImage)}" alt="ラベルの写真">` : ""}${w.labelText ? `<pre>${esc(w.labelText)}</pre>` : ""}</div>` : ""}
    <div class="box"><h3>この作品についてAIに聞く</h3>
      <div class="qa" id="qa"></div>
      <div class="row"><input class="search" id="askQ" placeholder="例：この作品の技法の特徴は？" enterkeyhint="send"><button class="btn primary" id="askBtn">聞く</button></div>
      <div class="chips" id="askChips">${["もっと詳しく", "描かれた時代背景は？", "同じ作家の代表作は？", "鑑賞のポイントは？", "子ども向けに説明して"].map(t => `<button class="chip">${t}</button>`).join("")}</div>
    </div>
    ${w.sample ? "" : `<div class="row" id="delRow"><button class="btn danger ghost" id="dDel">コレクションから削除</button></div>`}`);
  $("#dClose").onclick = () => closeSheet();
  if (!w.sample) {
    $("#dEdit").onclick = () => editDetail(w);
    $("#dFav").onclick = async () => { w.fav = !w.fav; await store.put(stripUrls(w)); await reload(); openDetail(w.id); };
    $("#dShare").onclick = () => share(w);
    if ($("#dReviewed")) $("#dReviewed").onclick = async () => { const n = stripUrls(w); delete n.needsReview; await store.put(n); await reload(); openDetail(w.id); };
    $("#dDel").onclick = () => {
      $("#delRow").innerHTML = `<span class="small">本当に削除しますか？元に戻せません。</span><button class="btn danger" id="dDelYes">削除する</button><button class="btn ghost" id="dDelNo">やめる</button>`;
      $("#dDelYes").onclick = async () => { try { await store.del(w.id); closeSheet(); await reload(); toast("削除しました"); } catch { toast("削除できませんでした"); } };
      $("#dDelNo").onclick = () => openDetail(w.id);
    };
  }
  // Q&A
  const hist = w.qa ? [...w.qa] : [];
  const qa = $("#qa");
  const addItem = (q, a) => { const d = document.createElement("div"); d.innerHTML = `<div class="q">${esc(q)}</div><div class="a">${esc(a)}</div>`; qa.append(d); return d.querySelector(".a"); };
  hist.forEach(h => addItem(h.q, h.a));
  const askQ = async q => {
    if (!q) return;
    if (!ai.settings.apiKey) { toast("設定でAPIキーを入れてください"); return; }
    const a = addItem(q, ""); a.innerHTML = '<span class="spinner"></span><span class="muted">考えています…</span>';
    $("#askBtn").disabled = true;
    askAbort = new AbortController();
    try {
      const text = await ai.ask(w, hist, q, { signal: askAbort.signal, onText: t => { a.textContent = t; } });
      a.textContent = text;
      hist.push({ q, a: text });
      if (!w.sample) { w.qa = hist.slice(-20); await store.put(stripUrls(w)); }
    } catch (e) { a.textContent = e.message; a.classList.add("muted"); }
    finally { const b = $("#askBtn"); if (b) b.disabled = false; }
  };
  $("#askBtn").onclick = () => { const v = $("#askQ").value.trim(); $("#askQ").value = ""; askQ(v); };
  $("#askQ").onkeydown = e => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); $("#askBtn").click(); } };
  $("#askChips").onclick = e => { const b = e.target.closest(".chip"); if (b) askQ(b.textContent); };
}
const stripUrls = w => { const c = { ...w }; delete c.thumbUrl; delete c.imageUrl; return c; };

async function share(w) {
  const text = `${w.artist}「${w.title}」${w.year ? `（${w.year}）` : ""}${w.museum ? `\n${w.museum}にて` : ""}${w.description ? `\n\n${w.description}` : ""}`;
  try {
    const files = w.image ? [new File([w.image], "artwork.jpg", { type: "image/jpeg" })] : [];
    if (navigator.canShare && files.length && navigator.canShare({ files })) await navigator.share({ title: w.title, text, files });
    else if (navigator.share) await navigator.share({ title: w.title, text });
    else { await navigator.clipboard.writeText(text); toast("作品の説明をコピーしました"); }
  } catch (e) { if (e?.name !== "AbortError") toast("共有できませんでした"); }
}

function editDetail(w) {
  openSheet(`<div class="bar"><button class="btn ghost" id="eCancel">キャンセル</button><button class="btn primary" id="eSave">保存</button></div>
    <h2>作品情報を編集</h2>
    <div class="field"><label for="ed-visited">訪問日</label><input id="ed-visited" type="date" value="${esc(w.visited)}"></div>
    ${formHtml(w, "ed")}`);
  $("#eCancel").onclick = () => openDetail(w.id);
  $("#eSave").onclick = async () => {
    const n = readForm("ed", stripUrls(w)); n.visited = $("#ed-visited").value || w.visited;
    try { await store.put(n); await reload(); toast("保存しました"); openDetail(n.id); } catch { toast("保存できませんでした"); }
  };
}

/* ================= discover ================= */
function picksHtml(d) {
  return `<div class="taste">${esc(d.taste)}</div>` + (d.picks || []).map(p => `<div class="rec">
    <div><strong>${esc(p.artist)}</strong>「${esc(p.title)}」<span class="muted small">${esc(p.year)}</span></div>
    <div class="small">${esc(p.where)}</div><div class="why">${esc(p.why)}</div></div>`).join("");
}
function lsJson(k) { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; } }
function lsPut(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
async function runPicks(btn, out, fn, cacheKey) {
  if (!ai.settings.apiKey) { openSettings(); return; }
  btn.disabled = true;
  out.innerHTML = '<div class="status small"><span class="spinner"></span>考えています…（10〜30秒ほど）</div>';
  try { const d = await fn(); out.innerHTML = picksHtml(d); if (cacheKey) lsPut(cacheKey, d); }
  catch (e) { out.innerHTML = `<div class="status err small">${esc(e.message)}</div>`; }
  finally { btn.disabled = false; }
}
$("#btnDiscover").onclick = () => runPicks($("#btnDiscover"), $("#discoverOut"), () => ai.recommend(visible()), "artscan.lastPicks");
$("#btnPlan").onclick = () => { const v = $("#planName").value.trim(); if (!v) { toast("美術館か展覧会の名前を入れてください"); return; } runPicks($("#btnPlan"), $("#planOut"), () => ai.preview(v)); };
$("#planName").onkeydown = e => { if (e.key === "Enter" && !e.isComposing) $("#btnPlan").click(); };
{ const last = lsJson("artscan.lastPicks"); if (last) $("#discoverOut").innerHTML = picksHtml(last); }

/* ================= settings ================= */
function settingsGet(k, d) { try { return localStorage.getItem("artscan." + k) ?? d; } catch { return d; } }
function settingsSet(k, v) { try { localStorage.setItem("artscan." + k, v); } catch {} }

function keyBox(p) {
  const P = ai.PROVIDERS[p], key = ai.settings.keyFor(p);
  const intro = p === "gemini"
    ? `無料のキーを <a href="${P.keyUrl}" target="_blank" rel="noopener">Google AI Studio</a> で作れます（Googleアカウントでログインし「Create API key」）。無料枠では、送った写真と文章がGoogleのAI改善に使われることがあります。`
    : `任意です。入れると、Claudeを選んだり、識別結果の画面から高精度モード（Claude Opus、1回約10円）を使えます。キーは <a href="${P.keyUrl}" target="_blank" rel="noopener">Anthropic Console</a> で作れます。使いすぎを防ぐため、Consoleの「Limits」で月の上限額を設定しておくと安心です。`;
  return `<div class="box">
      <h3>${p === "gemini" ? "Gemini APIキー（無料）" : "Claude APIキー（任意・有料）"}</h3>
      <div class="field"><label for="sKey-${p}">APIキー（${P.keyHint}）</label>
        <input id="sKey-${p}" type="password" autocomplete="off" spellcheck="false" value="${esc(key)}"></div>
      <div class="row"><button class="btn primary" data-act="save" data-p="${p}">保存して確認</button><button class="btn ghost" data-act="show" data-p="${p}">表示</button>${key ? `<button class="btn ghost danger" data-act="del" data-p="${p}">削除</button>` : ""}</div>
      <div class="small muted" id="sKeyMsg-${p}"></div>
      <div class="help small muted">${intro}</div>
    </div>`;
}

function openSettings(opts = {}) {
  const u = ai.usage();
  const s = ai.settings;
  const prov = s.provider;
  const models = ai.PROVIDERS[prov].impl.MODELS;
  openSheet(`<div class="bar"><button class="btn ghost" id="sClose">← 戻る</button></div>
    <h2>設定</h2>
    <div class="box">
      <h3>使うAI</h3>
      <div class="field"><label for="sProvider">識別・質問・おすすめに使うAI</label>
        <select id="sProvider">${Object.entries(ai.PROVIDERS).map(([id, P]) => `<option value="${id}" ${id === prov ? "selected" : ""}>${P.label}</option>`).join("")}</select></div>
      <div class="field"><label for="sModel">モデル</label>
        <select id="sModel">${Object.entries(models).map(([id, m]) => `<option value="${id}" ${id === s.modelFor(prov) ? "selected" : ""}>${m.name}</option>`).join("")}</select>
        <span class="help">${prov === "gemini"
          ? "Geminiは無料枠で使えます（1日の回数に上限あり）。上限に達したときは自動で軽量モデルに切り替えます。"
          : "1回のスキャンの目安：Haiku 約0.3円、Sonnet 約4〜5円、Opus 約8〜10円。"}</span></div>
      ${prov === "claude" ? `<label class="check"><input type="checkbox" id="sWeb" ${s.webSearch ? "checked" : ""}><span>Web検索で作品名を確かめる<br><span class="small muted">マイナーな作品の精度が上がります。1回のスキャンにつき5〜10円ほど増え、時間も少し長くなります。</span></span></label>` : ""}
      <label class="check"><input type="checkbox" id="sGeo" ${settingsGet("geo", "1") === "1" ? "checked" : ""}><span>撮影した場所を記録する<br><span class="small muted">マップに表示するためです。写真に位置情報があればそれを使い、なければその場で撮った時だけ現在地を使います。</span></span></label>
    </div>
    <div class="box" id="shareBox"></div>
    ${keyBox("gemini")}
    ${keyBox("claude")}
    <div class="box">
      <h3>今月のAI利用</h3>
      <div class="cost"><div><span class="small muted">有料分（Claude）</span><b>${yen(u.usd)}</b></div><div><span class="small muted">無料（Gemini）</span><b>${u.freeCalls}回</b></div><div><span class="small muted">スキャン</span><b>${u.scans}回</b></div></div>
      <div class="small muted">この端末での利用分です。Claudeの金額は1ドル${ai.USD_JPY}円で計算した目安で、正確な金額はAnthropic Consoleで確認できます。</div>
    </div>
    <div class="box">
      <h3>バックアップ</h3>
      <div class="small muted">作品はこの端末の中に保存されています。機種変更やブラウザのデータ削除に備えて、ときどき書き出してください。</div>
      <div class="row"><button class="btn" id="sExport">ファイルに書き出す</button>
        <label class="btn" for="sImport">ファイルから読み込む</label><input id="sImport" type="file" accept="application/json,.json" hidden></div>
      <div class="small muted" id="sBackupMsg"></div>
    </div>
    <div class="box">
      <h3>このアプリについて</h3>
      <div class="small muted">ArtScan（ArtScan AI LLC）の機能を参考に作った個人用アプリです。名前は museum（美術館）と muse（ひらめきの女神）から。APIキーはこの端末のブラウザの中だけに保存され、AIへの問い合わせ以外には送られません。地図データ © OpenStreetMap contributors。</div>
    </div>`);
  $("#sClose").onclick = () => closeSheet();
  renderShareBox(opts.join);
  $("#sheetIn").querySelectorAll("button[data-act]").forEach(b => b.onclick = async () => {
    const p = b.dataset.p, input = $("#sKey-" + p), msg = $("#sKeyMsg-" + p);
    if (b.dataset.act === "show") { input.type = input.type === "password" ? "text" : "password"; return; }
    if (b.dataset.act === "del") { ai.settings.setKey(p, ""); updateIdentify(); openSettings(); toast("APIキーを削除しました"); return; }
    const k = input.value.trim();
    if (!k) { msg.textContent = "キーを入力してください。"; return; }
    msg.innerHTML = '<span class="spinner"></span>確認しています…';
    try { await ai.testKey(p, k); ai.settings.setKey(p, k); msg.textContent = "保存しました。このキーで使えます。"; updateIdentify(); }
    catch (e) { msg.textContent = e.message + (e.code === "network" ? "" : "（キーは保存していません）"); }
  });
  $("#sProvider").onchange = e => { ai.settings.provider = e.target.value; updateIdentify(); openSettings(); toast("使うAIを変更しました"); };
  $("#sModel").onchange = e => { ai.settings.setModel(prov, e.target.value); toast("モデルを変更しました"); };
  if ($("#sWeb")) $("#sWeb").onchange = e => { ai.settings.webSearch = e.target.checked; };
  $("#sGeo").onchange = e => { settingsSet("geo", e.target.checked ? "1" : "0"); };
  $("#sExport").onclick = async () => {
    try {
      const json = await store.exportJson();
      const blob = new Blob([json], { type: "application/json" });
      const name = `artmuse-backup-${today()}.json`;
      const file = new File([blob], name, { type: "application/json" });
      if (navigator.canShare?.({ files: [file] }) && /iPhone|iPad|Android/i.test(navigator.userAgent)) await navigator.share({ files: [file], title: name });
      else { const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); }
      $("#sBackupMsg").textContent = `${works.length}点を書き出しました。`;
    } catch (e) { if (e?.name !== "AbortError") $("#sBackupMsg").textContent = "書き出せませんでした：" + e.message; }
  };
  $("#sImport").onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try { const n = await store.importJson(await f.text()); await reload(); $("#sBackupMsg").textContent = `${n}点を読み込みました。`; }
    catch (err) { $("#sBackupMsg").textContent = "読み込めませんでした：" + err.message; }
  };
}
$("#btnSettings").onclick = () => openSettings();

/* ================= sharing ================= */
const SETUP_URL = "https://github.com/dontforget3oct11z-Git/artapp#家族と共有する設定";
function renderShareBox(joinCode) {
  const box = $("#shareBox"); if (!box) return;
  const st = sync.state;
  if (!sync.enabled()) {
    box.innerHTML = `<h3>家族と共有</h3>
      <div class="small muted">別のスマホ（ご家族など）と、作品・美術館の記録・展示の予定を共有できます。無料のFirebase（Google）を使います。</div>
      <div class="seg" role="tablist"><button data-sh="join" aria-pressed="${joinCode ? "true" : "false"}">招待コードで参加</button><button data-sh="new" aria-pressed="false">最初の1台として始める</button></div>
      <div id="shPane"></div>`;
    const pane = mode => {
      box.querySelectorAll("[data-sh]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.sh === mode)));
      $("#shPane").innerHTML = mode === "join" ? `
        <div class="field"><label for="shCode">招待コード（または招待リンク）</label><textarea id="shCode" style="min-height:70px" placeholder="ARTMUSE- で始まる文字列">${esc(joinCode || "")}</textarea></div>
        <div class="field"><label for="shName">あなたの名前（相手に表示）</label><input id="shName" placeholder="例：ゆき"></div>
        <div class="row"><button class="btn primary" id="shJoin">参加する</button></div>
        <div class="small muted" id="shMsg">もう1台のスマホの「設定 → 家族と共有」に出ている招待コードを貼ってください。</div>` : `
        <details class="small"><summary>Firebaseの準備（最初に1回、約10分）</summary><ol class="steps">
          <li><a href="https://console.firebase.google.com/" target="_blank" rel="noopener">Firebaseコンソール</a>でプロジェクトを作る（Googleアナリティクスはオフで可）</li>
          <li>「セキュリティ」→「Authentication」→「始める」→「ログイン方法」で「匿名」を有効にする</li>
          <li>「Database と Storage」→「Firestore」→「データベースを作成」（場所は asia-northeast1 東京、本番環境モード）</li>
          <li>Firestoreの「ルール」に、<a href="${SETUP_URL}" target="_blank" rel="noopener">説明ページ</a>のルールを貼って「公開」</li>
          <li>「設定」→「全般」→「マイアプリ」→ ウェブ（&lt;/&gt;）を登録し、表示された firebaseConfig をコピー</li>
        </ol></details>
        <div class="field"><label for="shCfg">firebaseConfig を貼り付け</label><textarea id="shCfg" style="min-height:90px" placeholder="const firebaseConfig = { apiKey: ..., projectId: ... };"></textarea></div>
        <div class="field"><label for="shName">あなたの名前（相手に表示）</label><input id="shName" placeholder="例：たけし"></div>
        <div class="row"><button class="btn primary" id="shNew">共有を始める</button></div>
        <div class="small muted" id="shMsg">この端末の作品もすべて共有されます。</div>`;
      const run = async (fn) => {
        const msg = $("#shMsg"); msg.innerHTML = '<span class="spinner"></span>つないでいます…';
        try { await fn(); toast("共有を始めました"); renderShareBox(); }
        catch (e) { msg.textContent = e.message; }
      };
      if ($("#shJoin")) $("#shJoin").onclick = () => {
        const inv = sync.parseInvite($("#shCode").value);
        if (!inv) { $("#shMsg").textContent = "招待コードを読み取れませんでした。ARTMUSE- から最後までコピーしてください。"; return; }
        run(() => sync.join(inv, $("#shName").value.trim()));
      };
      if ($("#shNew")) $("#shNew").onclick = () => {
        const cfg = sync.parseFirebaseConfig($("#shCfg").value);
        if (!cfg) { $("#shMsg").textContent = "firebaseConfig を読み取れませんでした。apiKey と projectId を含めてコピーしてください。"; return; }
        run(() => sync.create(cfg, $("#shName").value.trim()));
      };
    };
    box.querySelectorAll("[data-sh]").forEach(b => b.onclick = () => pane(b.dataset.sh));
    pane(joinCode ? "join" : "join");
    return;
  }
  const names = Object.values(st.names || {}).filter(Boolean);
  const when = st.last ? new Date(st.last).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" }) : "";
  box.innerHTML = `<h3>家族と共有</h3>
    <div class="sync-line ${st.phase}">${st.phase === "syncing" ? '<span class="spinner"></span>同期しています…' : st.phase === "error" ? esc(st.error) : when ? `共有中・${when}に同期しました` : "共有中"}</div>
    ${names.length ? `<div class="small">メンバー：${names.map(esc).join("、")}</div>` : ""}
    <div class="field"><label for="shMyName">あなたの名前</label><div class="row"><input id="shMyName" class="search" value="${esc(sync.myName())}"><button class="btn small" id="shRename">変更</button></div></div>
    <div class="field"><label>招待コード（相手のスマホの「招待コードで参加」に貼る）</label><div class="code mono small" id="shInvite">${esc(sync.inviteCode())}</div></div>
    <div class="row"><button class="btn primary" id="shSend">招待を送る</button><button class="btn" id="shCopy">コードをコピー</button><button class="btn ghost" id="shNow">今すぐ同期</button></div>
    <div class="small muted">招待コードを知っている人は誰でも参加できます。家族以外には送らないでください。</div>
    <div class="row"><button class="btn ghost danger small" id="shLeave">この端末の共有をやめる</button></div>`;
  $("#shRename").onclick = async () => { await sync.rename($("#shMyName").value.trim()); toast("名前を変えました"); };
  $("#shCopy").onclick = async () => { try { await navigator.clipboard.writeText(sync.inviteCode()); toast("コピーしました"); } catch { const r = document.createRange(); r.selectNodeContents($("#shInvite")); getSelection().removeAllRanges(); getSelection().addRange(r); } };
  $("#shSend").onclick = async () => {
    const text = `ArtMuseで作品の記録を共有しましょう。\n1. ${new URL("./", location.href).href} を開いてホーム画面に追加\n2. 設定 → 家族と共有 →「招待コードで参加」に次のコードを貼る\n\n${sync.inviteCode()}`;
    try { if (navigator.share) await navigator.share({ text }); else { await navigator.clipboard.writeText(text); toast("招待文をコピーしました"); } } catch {}
  };
  $("#shNow").onclick = () => sync.syncNow();
  $("#shLeave").onclick = () => {
    if (!confirm("この端末の共有をやめますか？この端末の作品は残ります。もう一度参加するには招待コードが必要です。")) return;
    sync.leave(); renderShareBox(); toast("共有をやめました");
  };
}
sync.onState(() => { renderShareBox(); renderSyncDot(); });
function renderSyncDot() {
  const d = $("#syncDot"); if (!d) return;
  const st = sync.state;
  d.hidden = !sync.enabled();
  d.className = "sync-dot " + st.phase;
  d.title = st.phase === "error" ? st.error : st.phase === "syncing" ? "同期中" : "共有中";
}

/* ================= tabs & misc ================= */
const TABS = ["collection", "museums", "scan", "events", "calendar", "discover"];
function go(tab) {
  TABS.forEach(t => { $("#v-" + t).hidden = t !== tab; });
  document.querySelectorAll("nav.tabs button").forEach(b => { if (b.dataset.tab === tab) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current"); });
  window.scrollTo(0, 0);
  if (tab === "museums") museumsTab.render();
  if (tab === "calendar") calendarTab.render();
  if (tab === "events") eventsTab.render();
  if (tab === "scan") updateIdentify();
  try { history.replaceState(history.state, "", "#" + tab); } catch {}
}
document.querySelectorAll("nav.tabs button").forEach(b => b.onclick = () => go(b.dataset.tab));

/* ================= start ================= */
Object.assign(app, {
  works: () => works, thumbOf, openDetail, go, reload,
  openMuseum: id => museumsTab.openMuseum(id),
  refreshMuseums: () => { if (!$("#v-museums").hidden) museumsTab.render(); },
  showExhibitionsFor: id => calendarTab.showExhibitionsFor(id),
  refreshExhibitions: () => { if (!$("#v-calendar").hidden) calendarTab.render(); if (!$("#v-events").hidden) eventsTab.render(); },
  normalize, nearestMuseum, verify, merge, updateIdentify,
});
museumsTab.init();
calendarTab.init();
eventsTab.init();
bulk.init();

$("#inDate").value = today();
const h = location.hash.slice(1);
if (h.startsWith("join=")) { history.replaceState(null, "", location.pathname); openSettings({ join: decodeURIComponent(h.slice(5)) }); }
else if (TABS.includes(h)) go(h);
updateIdentify();
P.loadCatalog().then(() => render());
reload();
renderSyncDot();
sync.start();

if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
