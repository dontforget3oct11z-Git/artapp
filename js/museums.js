// "美術館" tab: every museum marked 行った / 行きたい / まだ, on a map and as a list by prefecture,
// plus the visit timeline.
import * as P from "./places.js";
import { $, esc, toast, openSheet, closeSheet, app, jpDate, today } from "./ui.js";

let filter = "all", mode = "map", scope = "jp", q = "";
try { scope = localStorage.getItem("artscan.mScope") || "jp"; } catch {}
let map = null, layer = null;
const ST = { went: "行った", want: "行きたい", "": "まだ" };

const color = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888";

export function render() {
  const works = app.works();
  const everything = P.museums(works);
  const all = everything.filter(m => scope === "jp" ? P.isJapan(m) : !P.isJapan(m));
  const went = all.filter(m => m.went).length, want = all.filter(m => m.want).length;
  $("#mTally").innerHTML = `
    <div><b>${went}</b><span>行った</span></div>
    <div><b>${want}</b><span>行きたい</span></div>
    <div><b>${all.length - went - want}</b><span>まだ</span></div>
    <div class="bar" aria-label="行った美術館の割合"><i style="width:${all.length ? Math.round(went / all.length * 100) : 0}%"></i></div>`;
  $("#mScope").querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.s === scope)));
  $("#mFilter").querySelectorAll(".chip").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.f === filter)));
  $("#mSeg").querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.m === mode)));
  const nq = q.normalize("NFKC").toLowerCase();
  const shown = all.filter(m => (filter === "all" || m.status === filter) &&
    (!nq || [m.name, m.en, m.pref, m.city, m.country].join(" ").normalize("NFKC").toLowerCase().includes(nq)));
  $("#mSearchWrap").hidden = mode === "log";
  $("#map").hidden = mode !== "map"; $("#mapNote").hidden = mode !== "map";
  $("#mList").hidden = mode !== "list";
  $("#timelineWrap").hidden = mode !== "log";
  if (mode === "map") renderMap(shown, works, everything);
  if (mode === "list") renderList(shown);
  if (mode === "log") renderTimeline(works);
}

function renderMap(shown, works, all) {
  if (!window.L) { $("#mapNote").textContent = "地図を読み込めませんでした。インターネット接続を確認してください。"; return; }
  if (!map) {
    map = L.map("map", { zoomControl: true, attributionControl: true, preferCanvas: true, worldCopyJump: true }).setView([35.68, 139.76], 5);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    layer = L.layerGroup().addTo(map);
    map.getContainer().addEventListener("click", onMapClick);
  }
  setTimeout(() => map.invalidateSize(), 0);
  layer.clearLayers();
  const accent = color("--accent"), warn = color("--warn"), muted = color("--muted"), paper = color("--paper");
  const pts = [];
  for (const m of shown) {
    if (!Number.isFinite(m.lat) || !Number.isFinite(m.lng)) continue;
    if (m.went || m.want || filter === "" || q) pts.push([m.lat, m.lng]);
    const style = m.went ? { radius: 8 + Math.min(8, m.works.length), color: paper, weight: 2, fillColor: accent, fillOpacity: .95 }
      : m.want ? { radius: 8, color: warn, weight: 3, fillColor: paper, fillOpacity: 1 }
      : { radius: 4.5, color: muted, weight: 1, fillColor: paper, fillOpacity: .9, opacity: .7 };
    L.circleMarker([m.lat, m.lng], style).bindPopup(() => popupHtml(m), { maxWidth: 260 }).addTo(layer);
  }
  // photos taken somewhere that isn't in the museum list
  const known = new Set(all.flatMap(m => m.works.map(w => w.id)));
  const loose = works.filter(w => !known.has(w.id) && Number.isFinite(w.lat) && Number.isFinite(w.lng));
  if ((filter === "all" || filter === "went") && scope === "jp" && !q) {
    const groups = new Map();
    for (const w of loose) { const k = w.museum || `${w.lat.toFixed(3)},${w.lng.toFixed(3)}`; (groups.get(k) || groups.set(k, []).get(k)).push(w); }
    for (const ws of groups.values()) {
      const lat = ws.reduce((s, w) => s + w.lat, 0) / ws.length, lng = ws.reduce((s, w) => s + w.lng, 0) / ws.length;
      pts.push([lat, lng]);
      L.circleMarker([lat, lng], { radius: 7, color: accent, weight: 2, fillColor: accent, fillOpacity: .35, dashArray: "3 3" })
        .bindPopup(`<div class="pop-title">${esc(ws[0].museum || ws[0].place || "撮影地")}</div><div class="small muted">${ws.length}点・美術館リストにない場所</div>
          <div class="pop-strip">${ws.slice(0, 12).map(w => `<button data-id="${esc(w.id)}" aria-label="${esc(w.title)}"><img src="${app.thumbOf(w)}" alt=""></button>`).join("")}</div>
          <button class="btn small" data-addfrom="${esc(ws[0].id)}">美術館として登録</button>`).addTo(layer);
    }
  }
  // Zoom to the museums you marked; otherwise show the whole country or the world.
  if (pts.length === 1) map.setView(pts[0], 13);
  else if (pts.length > 1 && pts.length < 300) map.fitBounds(pts, { padding: [24, 24], maxZoom: 13 });
  else map.setView(scope === "jp" ? [36.5, 137.5] : [30, 10], scope === "jp" ? 5 : 2);
  $("#mapNote").innerHTML = `<span class="key went"></span>行った <span class="key want"></span>行きたい <span class="key none"></span>まだ ・ 印を押すと記録を付けられます`;
}

function statusButtons(m) {
  return `<div class="seg small" role="group" aria-label="${esc(m.name)}の記録">${["went", "want", ""].map(s =>
    `<button data-mst="${s}" data-mid="${esc(m.id)}" aria-pressed="${m.status === s}" ${s !== "went" && m.works.length ? "disabled title=\"作品があるので「行った」になります\"" : ""}>${ST[s]}</button>`).join("")}</div>`;
}
function popupHtml(m) {
  return `<div class="pop-title">${esc(m.name)}</div>
    <div class="small muted">${esc(P.isJapan(m) ? (m.pref || "") + (m.city || "") : [m.country, m.city].filter(Boolean).join(" "))}${m.works.length ? ` ・ 作品${m.works.length}点` : ""}${m.visits[0] ? ` ・ 最後に行った日 ${esc(m.visits[0].replace(/-/g, "."))}` : ""}</div>
    ${statusButtons(m)}
    ${m.works.length ? `<div class="pop-strip">${m.works.slice(0, 8).map(w => `<button data-id="${esc(w.id)}" aria-label="${esc(w.title)}"><img src="${app.thumbOf(w)}" alt=""></button>`).join("")}</div>` : ""}
    <div class="row" style="margin-top:6px">${m.current ? `<button class="btn small" data-exfor="${esc(m.id)}">開催中の展示 ${m.current}件</button>` : ""}<button class="btn small ghost" data-mopen="${esc(m.id)}">詳しく</button></div>`;
}

async function onMapClick(e) {
  const w = e.target.closest("[data-id]"); if (w) { app.openDetail(w.dataset.id); return; }
  if (await handleCommon(e)) { map.closePopup(); }
  const a = e.target.closest("[data-addfrom]");
  if (a) { const wk = app.works().find(x => x.id === a.dataset.addfrom); map.closePopup(); openAdd(wk ? { name: wk.museum || wk.place || "", lat: wk.lat, lng: wk.lng, status: "went" } : {}); }
}

// Buttons that appear on the map, in the list and in the museum sheet.
async function handleCommon(e) {
  const st = e.target.closest("[data-mst]");
  if (st && !st.disabled) { await P.setMuseumStatus(st.dataset.mid, st.dataset.mst); toast(`「${ST[st.dataset.mst]}」にしました`); render(); if (!$("#sheet").hidden && $("#museumSheet")) openMuseum(st.dataset.mid); return true; }
  const ex = e.target.closest("[data-exfor]");
  if (ex) { closeSheet(); app.go("calendar"); app.showExhibitionsFor?.(ex.dataset.exfor); return true; }
  const op = e.target.closest("[data-mopen]");
  if (op) { openMuseum(op.dataset.mopen); return true; }
  return false;
}

function renderList(shown) {
  const byPref = new Map();
  const jp = scope === "jp";
  for (const m of shown) { const k = (jp ? m.pref : m.country) || "その他"; (byPref.get(k) || byPref.set(k, []).get(k)).push(m); }
  const order = [...P.PREFS, "その他"];
  const keys = [...byPref.keys()].sort(jp ? (a, b) => order.indexOf(a) - order.indexOf(b) : (a, b) => (a === "その他") - (b === "その他") || byPref.get(b).length - byPref.get(a).length || a.localeCompare(b, "ja"));
  const openAll = shown.length <= 40 || !!q;
  $("#mList").innerHTML = keys.map(k => {
    const ms = byPref.get(k).sort((a, b) => (b.went - a.went) || (b.want - a.want) || (b.rank || 0) - (a.rank || 0) || a.name.localeCompare(b.name, "ja"));
    const went = ms.filter(m => m.went).length;
    return `<details class="pref" ${openAll || went || ms.some(m => m.want) ? "open" : ""}><summary><h3>${esc(k)}</h3><span class="small muted mono">${went} / ${ms.length}館</span></summary>
      ${ms.map(m => `<div class="mrow">
        <button class="mname" data-mopen="${esc(m.id)}"><span class="dot ${m.status || "none"}"></span><span><b>${esc(m.name)}</b><span class="small muted">${esc(m.city || "")}${m.en && !jp ? ` ・ ${esc(m.en)}` : ""}${m.works.length ? ` ・ 作品${m.works.length}点` : ""}${m.current ? ` ・ 開催中${m.current}件` : ""}</span></span></button>
        ${statusButtons(m)}</div>`).join("")}
    </details>`;
  }).join("") || `<div class="empty">この条件の美術館はありません。</div>`;
}

function renderTimeline(works) {
  const groups = {};
  works.forEach(w => { const k = (w.museum || "美術館未記入") + "|" + (w.visited || "").slice(0, 10); (groups[k] ||= []).push(w); });
  const keys = Object.keys(groups).sort((a, b) => b.split("|")[1].localeCompare(a.split("|")[1]));
  $("#timeline").innerHTML = keys.map(k => {
    const [m, d] = k.split("|"); const ws = groups[k];
    const artists = [...new Set(ws.map(w => w.artist).filter(Boolean))].join("、");
    return `<div class="museum">
      <div class="hd"><h3>${esc(m)}</h3><span class="yr">${esc(d.replace(/-/g, "."))} ・ ${ws.length}点</span></div>
      <div class="strip">${ws.map(w => `<button data-id="${esc(w.id)}" aria-label="${esc(w.title)}"><div class="frame">${app.thumbOf(w) ? `<img src="${app.thumbOf(w)}" alt="">` : ""}</div></button>`).join("")}</div>
      <div class="small muted">${esc(artists)}</div>
    </div>`;
  }).join("") || `<div class="empty">まだ記録がありません。</div>`;
}

export function openMuseum(id) {
  const m = P.museums(app.works()).find(x => x.id === id); if (!m) return;
  const exs = P.exhibitionsAt(id).filter(e => !e.end || e.end >= today()).sort((a, b) => (a.start || "").localeCompare(b.start || ""));
  openSheet(`<div class="bar" id="museumSheet"><button class="btn ghost" id="msClose">← 戻る</button>${m.url ? `<a class="btn ghost small" href="${esc(m.url)}" target="_blank" rel="noopener">公式サイト</a>` : ""}</div>
    <h2>${esc(m.name)}</h2>
    <div class="small muted">${esc(P.isJapan(m) ? (m.pref || "") + (m.city || "") : [m.country, m.city].filter(Boolean).join(" "))}${m.en ? ` ・ ${esc(m.en)}` : ""}</div>
    ${statusButtons(m)}
    <div class="box ticketbox"><h3>🎫 チケット</h3>
      ${m.ticket ? `<div class="small"><b>購入済み</b>${m.ticket.day ? ` ・ 行く日 ${esc(jpDate(m.ticket.day))}` : ""}${m.ticket.note ? ` ・ ${esc(m.ticket.note)}` : ""}</div>` : `<div class="small muted">入館券・年間パスポートなどを買ったら記録できます。展覧会のチケットは「展示」タブの各展示から登録できます。</div>`}
      <div class="grid2"><div class="field"><label for="msTkDay">行く日（任意）</label><input type="date" id="msTkDay" value="${esc(m.ticket?.day || "")}"></div>
      <div class="field"><label for="msTkNote">メモ</label><input id="msTkNote" value="${esc(m.ticket?.note || "")}" placeholder="例：年パス・2026年12月まで"></div></div>
      <div class="row"><button class="btn small" id="msTkSave">${m.ticket ? "チケットの記録を更新" : "チケット購入済みにする"}</button>${m.ticket ? `<button class="btn small ghost danger" id="msTkDel">記録を消す</button>` : ""}</div></div>
    <div class="box"><h3>行った日</h3>
      ${m.visits.length ? `<div class="chips" style="flex-wrap:wrap">${m.visits.map(d => `<span class="chip">${esc(d.replace(/-/g, "."))}</span>`).join("")}</div>` : `<div class="small muted">まだ記録がありません。</div>`}
      <div class="row"><input type="date" id="msDay" value="${today()}" class="select"><button class="btn small" id="msAddDay">行った日を追加</button></div></div>
    ${m.works.length ? `<div class="box"><h3>撮った作品（${m.works.length}点）</h3><div class="strip">${m.works.map(w => `<button data-id="${esc(w.id)}" aria-label="${esc(w.title)}"><div class="frame">${app.thumbOf(w) ? `<img src="${app.thumbOf(w)}" alt="">` : ""}</div></button>`).join("")}</div></div>` : ""}
    <div class="box"><h3>展示</h3>
      ${exs.length ? exs.map(e => `<div class="rec"><div><b>${esc(e.title)}</b></div><div class="small muted">${P.isOpen(e, today()) ? "開催中" : "これから"} ・ ${esc(jpDate(e.start, false))}〜${esc(jpDate(e.end, false))}</div></div>`).join("")
        : `<div class="small muted">${m.custom ? "自分で追加した美術館の展示は、カレンダーの「展示を追加」から登録できます。" : "いま登録されている展示はありません。"}</div>`}
      ${exs.length ? `<div class="row"><button class="btn small" data-exfor="${esc(m.id)}">カレンダーで見る</button></div>` : ""}</div>
    <div class="box"><div class="field"><label for="msNote">メモ</label><textarea id="msNote" style="min-height:60px" placeholder="行きたい理由、混雑、カフェなど">${esc(m.note)}</textarea></div>
      <div class="row"><button class="btn small" id="msSaveNote">メモを保存</button></div></div>
    ${m.custom ? `<div class="row"><button class="btn danger ghost" id="msDel">この美術館を削除</button></div>` : ""}`);
  $("#msClose").onclick = () => closeSheet();
  $("#sheetIn").onclick = async e => {
    const w = e.target.closest("[data-id]"); if (w) { app.openDetail(w.dataset.id); return; }
    await handleCommon(e);
  };
  $("#msAddDay").onclick = async () => { const d = $("#msDay").value; if (!d) return; await P.addVisit(id, d); render(); openMuseum(id); toast("行った日を追加しました"); };
  $("#msTkSave").onclick = async () => {
    await P.setMuseumTicket(id, { day: $("#msTkDay").value, note: $("#msTkNote").value.trim() });
    render(); app.refreshExhibitions?.(); openMuseum(id); toast("チケット購入済みにしました");
  };
  if ($("#msTkDel")) $("#msTkDel").onclick = async () => { await P.setMuseumTicket(id, null); render(); app.refreshExhibitions?.(); openMuseum(id); toast("チケットの記録を消しました"); };
  $("#msSaveNote").onclick = async () => {
    const r = P.museumRec(id) || { id };
    const { save } = await import("./store.js"); await save("museums", { ...r, note: $("#msNote").value.trim() });
    await P.loadLocal(); toast("メモを保存しました");
  };
  if ($("#msDel")) $("#msDel").onclick = async () => { if (!confirm("この美術館を削除しますか？")) return; await P.removeCustomMuseum(id); closeSheet(); render(); };
}

// Add a museum that isn't in the list: search OpenStreetMap by name.
export function openAdd(pre = {}) {
  openSheet(`<div class="bar"><button class="btn ghost" id="maClose">← 戻る</button></div>
    <h2>美術館を追加</h2>
    <p class="small muted" style="margin:0">リストにない美術館・ギャラリーを追加できます。名前で探して、場所を選んでください。</p>
    <div class="row"><input class="search" id="maQ" placeholder="例：ひろしま美術館" value="${esc(pre.name || "")}" enterkeyhint="search"><button class="btn" id="maFind">探す</button></div>
    <div id="maOut" class="rec-list"></div>
    <div class="box"><h3>見つからないとき</h3>
      <div class="grid2"><div class="field"><label for="maName">名前</label><input id="maName" value="${esc(pre.name || "")}"></div>
      <div class="field"><label for="maPref">都道府県</label><select id="maPref"><option value="">（選ぶ）</option>${P.PREFS.map(p => `<option>${p}</option>`).join("")}</select></div></div>
      <div class="row"><button class="btn" id="maManual">この名前で追加</button></div></div>`);
  $("#maClose").onclick = () => closeSheet();
  const status = pre.status || "want";
  const add = async m => { await P.addCustomMuseum({ ...m, status }); closeSheet(); render(); toast(`「${m.name}」を${ST[status]}で追加しました`); };
  const find = async () => {
    const q = $("#maQ").value.trim(); if (!q) return;
    $("#maOut").innerHTML = '<div class="status small"><span class="spinner"></span>探しています…</div>';
    try {
      const near = Number.isFinite(pre.lat) ? `&viewbox=${pre.lng - .05},${pre.lat + .05},${pre.lng + .05},${pre.lat - .05}` : "";
      const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(q)}${scope === "jp" ? "&countrycodes=jp" : ""}&accept-language=ja&addressdetails=1&limit=8${near}`);
      const j = r.ok ? await r.json() : [];
      $("#maOut").innerHTML = j.length ? j.map((x, i) => {
        const a = x.address || {};
        return `<div class="rec row" style="justify-content:space-between"><div><b>${esc(x.name || q)}</b><div class="small muted">${esc([a.country_code !== "jp" ? a.country : "", a.province || a.state, a.city || a.town || a.village, a.suburb].filter(Boolean).join(" "))}</div></div><button class="btn small" data-i="${i}">追加</button></div>`;
      }).join("") : `<div class="status small">見つかりませんでした。下の「この名前で追加」を使ってください。</div>`;
      $("#maOut").onclick = e => {
        const b = e.target.closest("[data-i]"); if (!b) return;
        const x = j[+b.dataset.i], a = x.address || {};
        const cc = (a.country_code || "jp").toUpperCase();
        add({ name: x.name || q, pref: cc === "JP" ? (a.province || a.state || "") : "", city: a.city || a.town || a.village || "", lat: +x.lat, lng: +x.lon, cc, country: cc === "JP" ? "日本" : (a.country || "") });
      };
    } catch { $("#maOut").innerHTML = `<div class="status err small">探せませんでした。インターネット接続を確認してください。</div>`; }
  };
  $("#maFind").onclick = find;
  $("#maQ").onkeydown = e => { if (e.key === "Enter" && !e.isComposing) find(); };
  $("#maManual").onclick = () => {
    const name = $("#maName").value.trim(); if (!name) { toast("名前を入れてください"); return; }
    add({ name, pref: $("#maPref").value, lat: pre.lat, lng: pre.lng });
  };
  if (pre.name) find();
}

export function init() {
  $("#mScope").onclick = e => { const b = e.target.closest("button"); if (!b) return; scope = b.dataset.s; try { localStorage.setItem("artscan.mScope", scope); } catch {} render(); };
  let qt; $("#mSearch").oninput = e => { clearTimeout(qt); qt = setTimeout(() => { q = e.target.value.trim(); render(); }, 200); };
  $("#mFilter").onclick = e => { const b = e.target.closest(".chip"); if (!b) return; filter = b.dataset.f; render(); };
  $("#mSeg").onclick = e => { const b = e.target.closest("button"); if (!b) return; mode = b.dataset.m; render(); };
  $("#mList").onclick = e => handleCommon(e);
  $("#timeline").onclick = e => { const b = e.target.closest("button[data-id]"); if (b) app.openDetail(b.dataset.id); };
  $("#mAdd").onclick = () => openAdd();
}
