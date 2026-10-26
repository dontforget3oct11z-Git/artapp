// "展示" tab: a month calendar with planned visits, visit days and exhibition periods,
// and the list of exhibitions on now / ending soon / coming up.
import * as P from "./places.js";
import * as ai from "./ai.js";
import { $, esc, toast, openSheet, closeSheet, app, today, addDays, daysBetween, jpDate, WEEK, loadImg, toBlob } from "./ui.js";

let month = today().slice(0, 7);
let day = "";            // selected day
let filter = "mine";     // mine | want | all
let pref = "";
let museumOnly = "";     // set from a museum's "開催中の展示" button

const KIND = { special: "特別展", collection: "コレクション展", other: "展示" };

function lsGet(k, d) { try { return localStorage.getItem("artscan." + k) ?? d; } catch { return d; } }
function lsSet(k, v) { try { localStorage.setItem("artscan." + k, v); } catch {} }

function filtered() {
  const ms = new Map(P.museums(app.works()).map(m => [m.id, m]));
  return P.allExhibitions().filter(e => {
    const m = e.museumId ? ms.get(e.museumId) : null;
    if (museumOnly) return e.museumId === museumOnly;
    if (pref && (m?.pref || "") !== pref) return false;
    if (filter === "want") return e.mark.want || e.mark.plan || e.mine;
    if (filter === "mine") return e.mine || e.mark.want || e.mark.plan || e.mark.went || (m && (m.went || m.want));
    return true;
  });
}

export function render() {
  const t = today();
  const list = filtered();
  const works = app.works();
  // ---- header and filters ----
  const [y, mo] = month.split("-").map(Number);
  $("#calMonth").textContent = `${y}年${mo}月`;
  $("#calFilter").querySelectorAll(".chip").forEach(b => b.setAttribute("aria-pressed", String(!museumOnly && b.dataset.f === filter)));
  const prefs = [...new Set(P.museums(works).map(m => m.pref).filter(Boolean))].sort((a, b) => P.PREFS.indexOf(a) - P.PREFS.indexOf(b));
  $("#calPref").innerHTML = `<option value="">すべての地域</option>` + prefs.map(p => `<option ${p === pref ? "selected" : ""}>${esc(p)}</option>`).join("");
  $("#calMuseum").hidden = !museumOnly;
  if (museumOnly) $("#calMuseum").innerHTML = `<span>${esc(P.museumById(museumOnly)?.name || "")}の展示</span><button class="btn small ghost" id="calMuseumClear">すべて表示</button>`;

  // ---- month grid ----
  const first = new Date(y, mo - 1, 1), startPad = first.getDay(), days = new Date(y, mo, 0).getDate();
  const plans = P.plans();
  const visitDays = new Map();
  for (const w of works) if (w.visited) { const d = w.visited.slice(0, 10); visitDays.set(d, (visitDays.get(d) || 0) + 1); }
  for (const m of P.museums(works)) for (const d of m.visits) if (!visitDays.has(d)) visitDays.set(d, 0);
  const wanted = list.filter(e => e.mark.want && !e.mark.went);
  let cells = WEEK.map((w, i) => `<div class="dow${i === 0 ? " sun" : i === 6 ? " sat" : ""}">${w}</div>`).join("");
  for (let i = 0; i < startPad; i++) cells += `<div></div>`;
  for (let d = 1; d <= days; d++) {
    const ds = `${month}-${String(d).padStart(2, "0")}`;
    const p = plans.filter(x => x.day === ds);
    const v = visitDays.has(ds);
    const ending = wanted.filter(e => e.end === ds);
    const starting = wanted.filter(e => e.start === ds);
    const dow = (startPad + d - 1) % 7;
    cells += `<button class="day${ds === t ? " today" : ""}${ds === day ? " sel" : ""}${dow === 0 ? " sun" : dow === 6 ? " sat" : ""}" data-day="${ds}" aria-label="${mo}月${d}日${p.length ? `、予定${p.length}件` : ""}${v ? "、訪問の記録あり" : ""}${ending.length ? `、行きたい展示の最終日` : ""}">
      <span class="n">${d}</span>
      ${p.slice(0, 2).map(x => `<span class="ev plan">${esc(x.e.venueName || x.e.title)}</span>`).join("")}${p.length > 2 ? `<span class="ev plan">+${p.length - 2}</span>` : ""}
      <span class="marks">${v ? `<i class="m went" title="訪問"></i>` : ""}${ending.length ? `<i class="m end" title="最終日"></i>` : ""}${starting.length ? `<i class="m start" title="初日"></i>` : ""}</span>
    </button>`;
  }
  $("#calGrid").innerHTML = cells;

  // ---- below the grid ----
  if (day) { renderDay(day, list, works); return; }
  const open = list.filter(e => P.isOpen(e, t)).sort((a, b) => (a.end || "9999").localeCompare(b.end || "9999"));
  const soon = open.filter(e => e.end && daysBetween(t, e.end) <= 14);
  const now = open.filter(e => !soon.includes(e));
  const next = list.filter(e => e.start && e.start > t && e.start <= addDays(t, 120)).sort((a, b) => a.start.localeCompare(b.start));
  const section = (title, arr, note) => arr.length ? `<h3>${title}<span class="small muted"> ${arr.length}件</span></h3>${note || ""}${arr.map(card).join("")}` : "";
  const html = section("まもなく終了", soon) + section("開催中", now) + section("これから", next);
  $("#calList").innerHTML = html || emptyHtml();
  $("#calInfo").innerHTML = infoHtml();
}

function emptyHtml() {
  if (museumOnly) return `<div class="empty">この美術館で、いま登録されている展示はありません。</div>`;
  if (filter === "want") return `<div class="empty"><strong>「行きたい」展示はまだありません</strong><span class="small muted">「すべて」から気になる展示の ☆ を押すと、ここに集まります。</span></div>`;
  if (filter === "mine") return `<div class="empty"><strong>ここには、行った・行きたい美術館の展示が出ます</strong><span class="small muted">「美術館」タブで美術館に印を付けるか、「すべて」を選んでください。</span></div>`;
  return `<div class="empty"><strong>展示情報がまだありません</strong><span class="small muted">展示情報は毎朝、美術館の公式サイトから自動で集めます。「＋ 展示を追加」から自分で登録することもできます。</span></div>`;
}
function infoHtml() {
  const up = P.feedUpdated ? new Date(P.feedUpdated) : null;
  return `展示情報は、主要な美術館の公式サイトから毎朝自動で集めています${up ? `（最終更新 ${up.getMonth() + 1}/${up.getDate()} ${String(up.getHours()).padStart(2, "0")}:${String(up.getMinutes()).padStart(2, "0")}）` : "（まだ集めていません）"}。会期は変わることがあるので、出かける前に公式ページで確認してください。`;
}

function remain(e) {
  const t = today();
  if (e.start && e.start > t) { const n = daysBetween(t, e.start); return n <= 1 ? "明日から" : `${jpDate(e.start, false)}から`; }
  if (!e.end) return "開催中";
  const n = daysBetween(t, e.end);
  return n === 0 ? "今日まで" : n === 1 ? "明日まで" : `あと${n}日`;
}
function card(e) {
  const k = e.mark;
  const urgent = e.end && P.isOpen(e, today()) && daysBetween(today(), e.end) <= 7;
  return `<div class="excard${k.want ? " want" : ""}${k.went ? " went" : ""}" data-ex="${esc(e.id)}">
    <div class="top"><span class="kind">${KIND[e.kind] || "展示"}</span><span class="left${urgent ? " urgent" : ""}">${remain(e)}</span></div>
    <div class="ttl">${esc(e.title)}</div>
    <div class="small muted">${esc(e.venueName || "")}${e.museum?.pref ? ` ・ ${esc(e.museum.pref)}` : ""}${e.venue ? ` ・ ${esc(e.venue)}` : ""}</div>
    <div class="small mono">${e.start ? esc(jpDate(e.start)) : ""}〜${e.end ? esc(jpDate(e.end)) : ""}</div>
    ${e.summary ? `<div class="small">${esc(e.summary)}</div>` : ""}
    ${k.plan ? `<div class="small plan-line">予定日：${esc(jpDate(k.plan))}</div>` : ""}
    <div class="row acts">
      <button class="btn small${k.want ? " on" : ""}" data-act="want" aria-pressed="${!!k.want}">${k.want ? "★ 行きたい" : "☆ 行きたい"}</button>
      <button class="btn small${k.went ? " on" : ""}" data-act="went" aria-pressed="${!!k.went}">${k.went ? "✓ 行った" : "行った"}</button>
      <button class="btn small ghost" data-act="plan">${k.plan ? "予定を変える" : "行く日を決める"}</button>
      <button class="btn small ghost" data-act="more" aria-label="その他">…</button>
    </div>
  </div>`;
}

function renderDay(ds, list, works) {
  const plans = P.plans().filter(x => x.day === ds);
  const ws = works.filter(w => (w.visited || "").slice(0, 10) === ds);
  const open = list.filter(e => P.isOpen(e, ds)).sort((a, b) => (a.end || "9999").localeCompare(b.end || "9999"));
  $("#calList").innerHTML = `<div class="row" style="justify-content:space-between"><h3>${esc(jpDate(ds))}</h3><button class="btn small ghost" id="calDayClose">日付の選択をやめる</button></div>
    ${plans.length ? `<h3 class="sub">予定</h3>${plans.map(x => card(x.e)).join("")}` : ""}
    ${ws.length ? `<h3 class="sub">この日に撮った作品</h3><div class="strip">${ws.map(w => `<button data-id="${esc(w.id)}" aria-label="${esc(w.title)}"><div class="frame">${app.thumbOf(w) ? `<img src="${app.thumbOf(w)}" alt="">` : ""}</div></button>`).join("")}</div>` : ""}
    <h3 class="sub">この日に開いている展示<span class="small muted"> ${open.length}件</span></h3>
    ${open.map(card).join("") || `<div class="small muted">この条件の展示はありません。</div>`}`;
  $("#calInfo").innerHTML = infoHtml();
}

async function onListClick(e) {
  if (e.target.closest("#calDayClose")) { day = ""; render(); return; }
  const w = e.target.closest("[data-id]"); if (w) { app.openDetail(w.dataset.id); return; }
  const b = e.target.closest("[data-act]"); if (!b) return;
  const id = b.closest("[data-ex]").dataset.ex;
  const ex = P.allExhibitions().find(x => x.id === id); if (!ex) return;
  const act = b.dataset.act;
  if (act === "want") { await P.setMark(id, { want: !ex.mark.want }); toast(ex.mark.want ? "「行きたい」を外しました" : "「行きたい」に入れました"); }
  if (act === "went") {
    const went = !ex.mark.went;
    await P.setMark(id, { went });
    if (went && ex.museumId) await P.addVisit(ex.museumId, ex.mark.plan && ex.mark.plan <= today() ? ex.mark.plan : today());
    toast(went ? "「行った」にしました" : "「行った」を外しました");
  }
  if (act === "plan") { openPlan(ex); return; }
  if (act === "more") { openExhibition(ex); return; }
  render(); app.refreshMuseums?.();
}

function openPlan(ex) {
  const t = today();
  const min = ex.start && ex.start > t ? ex.start : t;
  openSheet(`<div class="bar"><button class="btn ghost" id="plClose">← 戻る</button></div>
    <h2>行く日を決める</h2>
    <div class="box"><b>${esc(ex.title)}</b><div class="small muted">${esc(ex.venueName)} ・ ${esc(jpDate(ex.start))}〜${esc(jpDate(ex.end))}</div>
      <div class="field"><label for="plDay">行く日</label><input type="date" id="plDay" min="${min}" ${ex.end ? `max="${ex.end}"` : ""} value="${esc(ex.mark.plan || (day && day >= min ? day : min))}"></div>
      <div class="small muted">共有している相手のカレンダーにも出ます。</div>
      <div class="row"><button class="btn primary" id="plSave">保存</button>${ex.mark.plan ? `<button class="btn ghost danger" id="plDel">予定を消す</button>` : ""}</div>
      <div class="row"><button class="btn small ghost" id="plIcs">スマホのカレンダーにも入れる</button></div></div>`);
  $("#plClose").onclick = () => closeSheet();
  $("#plSave").onclick = async () => {
    const d = $("#plDay").value; if (!d) return;
    await P.setMark(ex.id, { plan: d, want: true }); closeSheet(); month = d.slice(0, 7); render(); toast(`${jpDate(d)}に予定を入れました`);
  };
  if ($("#plDel")) $("#plDel").onclick = async () => { await P.setMark(ex.id, { plan: "" }); closeSheet(); render(); };
  $("#plIcs").onclick = () => downloadIcs(ex, $("#plDay").value);
}

function downloadIcs(ex, d) {
  const blob = new Blob([P.icsFor(ex, d)], { type: "text/calendar" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "artmuse.ics"; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

function openExhibition(ex) {
  openSheet(`<div class="bar"><button class="btn ghost" id="exClose">← 戻る</button></div>
    <h2>${esc(ex.title)}</h2>
    <div class="small muted">${esc(ex.venueName)}${ex.venue ? ` ・ ${esc(ex.venue)}` : ""} ・ ${esc(jpDate(ex.start))}〜${esc(jpDate(ex.end))}</div>
    ${ex.summary ? `<div class="prose">${esc(ex.summary)}</div>` : ""}
    <div class="row">
      ${ex.url ? `<a class="btn" href="${esc(ex.url)}" target="_blank" rel="noopener">公式ページを開く</a>` : ""}
      <button class="btn" id="exIcs">会期をスマホのカレンダーに入れる</button>
      ${ex.museumId ? `<button class="btn ghost" id="exMuseum">美術館の記録を見る</button>` : ""}
    </div>
    <div class="small muted">${ex.mine ? "自分で追加した展示です。" : `この情報は ${ex.source ? `<a href="${esc(ex.source)}" target="_blank" rel="noopener">公式サイトの展覧会ページ</a>` : "公式サイト"} から自動で集めました。会期や休館日は公式ページで確認してください。`}</div>
    ${ex.mine ? `<div class="row"><button class="btn ghost" id="exEdit">編集</button><button class="btn ghost danger" id="exDel">削除</button></div>` : ""}`);
  $("#exClose").onclick = () => closeSheet();
  $("#exIcs").onclick = () => downloadIcs(ex);
  if ($("#exMuseum")) $("#exMuseum").onclick = () => app.openMuseum(ex.museumId);
  if ($("#exEdit")) $("#exEdit").onclick = () => openAddEvent(ex);
  if ($("#exDel")) $("#exDel").onclick = async () => { if (!confirm("この展示を削除しますか？")) return; await P.deleteEvent(ex.id); closeSheet(); render(); };
}

// Add an exhibition yourself: from a flyer photo / pasted text (AI reads it), or by hand.
function openAddEvent(pre) {
  const all = P.museums(app.works()).sort((a, b) => a.name.localeCompare(b.name, "ja"));
  const e = pre || {};
  openSheet(`<div class="bar"><button class="btn ghost" id="aeClose">キャンセル</button><button class="btn primary" id="aeSave">保存</button></div>
    <h2>${pre ? "展示を編集" : "展示を追加"}</h2>
    ${pre ? "" : `<div class="box"><h3>チラシや案内から読み取る</h3>
      <p class="small muted" style="margin:0">チラシ・ポスターの写真か、公式サイトの文章を貼ると、AIが展覧会名と会期を読み取って下に入れます。${ai.isFree() ? "（Gemini無料枠）" : ""}</p>
      <div class="row"><label class="btn" for="aeImg">写真を選ぶ・撮る</label><input id="aeImg" type="file" accept="image/*" hidden></div>
      <div class="field"><label for="aeText">または文章を貼る</label><textarea id="aeText" style="min-height:70px" placeholder="公式サイトの展覧会ページの文章をコピーして貼り付け"></textarea></div>
      <div class="row"><button class="btn small" id="aeRead">文章から読み取る</button></div>
      <div id="aeMsg" class="small muted"></div></div>`}
    <div class="box">
      <div class="field"><label for="aeTitle">展覧会名</label><input id="aeTitle" value="${esc(e.title)}"></div>
      <div class="field"><label for="aeMuseum">美術館</label><select id="aeMuseum"><option value="">（リストにない会場）</option>${all.map(m => `<option value="${esc(m.id)}" ${m.id === e.museumId ? "selected" : ""}>${esc(m.name)}</option>`).join("")}</select></div>
      <div class="field" id="aeVenueBox"><label for="aeVenue">会場名（リストにないとき）</label><input id="aeVenue" value="${esc(e.museumId ? "" : e.venueName)}"></div>
      <div class="grid2"><div class="field"><label for="aeStart">初日</label><input type="date" id="aeStart" value="${esc(e.start)}"></div>
      <div class="field"><label for="aeEnd">最終日</label><input type="date" id="aeEnd" value="${esc(e.end)}"></div></div>
      <div class="field"><label for="aeUrl">公式ページのURL</label><input id="aeUrl" type="url" value="${esc(e.url)}" placeholder="https://"></div>
      <div class="field"><label for="aeSum">メモ</label><textarea id="aeSum" style="min-height:60px">${esc(e.summary)}</textarea></div>
    </div>`);
  $("#aeClose").onclick = () => closeSheet();
  const fill = async (getArgs) => {
    if (!ai.settings.apiKey) { toast("設定でAPIキーを入れてください"); return; }
    $("#aeMsg").innerHTML = '<span class="spinner"></span>読み取っています…';
    try {
      const r = await ai.extractEvent({ ...(await getArgs()), todayStr: today() });
      if (!r.found) { $("#aeMsg").textContent = "展覧会の情報を読み取れませんでした。手で入れてください。"; return; }
      const set = (id, v) => { if (v) $(id).value = v; };
      set("#aeTitle", r.title); set("#aeUrl", r.url); set("#aeSum", r.summary);
      if (/^\d{4}-\d{2}-\d{2}$/.test(r.start)) $("#aeStart").value = r.start;
      if (/^\d{4}-\d{2}-\d{2}$/.test(r.end)) $("#aeEnd").value = r.end;
      const hit = r.venue && all.find(m => m.name.includes(r.venue) || r.venue.includes(m.name));
      if (hit) $("#aeMuseum").value = hit.id; else if (r.venue) { $("#aeMuseum").value = ""; $("#aeVenue").value = r.venue; }
      $("#aeMsg").textContent = "読み取りました。内容を確かめてから保存してください。";
    } catch (err) { $("#aeMsg").textContent = err.message; }
  };
  if ($("#aeImg")) $("#aeImg").onchange = ev => { const f = ev.target.files[0]; if (f) fill(async () => ({ image: await toBlob(await loadImg(f), 1600, .85) })); };
  if ($("#aeRead")) $("#aeRead").onclick = () => { const t = $("#aeText").value.trim(); if (!t) { toast("文章を貼ってください"); return; } fill(async () => ({ text: t })); };
  $("#aeSave").onclick = async () => {
    const title = $("#aeTitle").value.trim();
    if (!title) { toast("展覧会名を入れてください"); return; }
    const start = $("#aeStart").value, end = $("#aeEnd").value;
    if (start && end && start > end) { toast("初日と最終日を確かめてください"); return; }
    const museumId = $("#aeMuseum").value;
    const r = await P.saveEvent({ id: e.mine ? e.id : undefined, title, museumId, venueName: museumId ? "" : $("#aeVenue").value.trim(),
      start, end, url: $("#aeUrl").value.trim(), summary: $("#aeSum").value.trim(), kind: "special", source: "user" });
    if (!pre) await P.setMark(r.id, { want: true });
    closeSheet(); if (start) month = (start > today() ? start : today()).slice(0, 7); render(); toast("展示を保存しました");
  };
}

export function showExhibitionsFor(id) { museumOnly = id; day = ""; render(); }

export function init() {
  filter = lsGet("calFilter", "mine");
  $("#calPrev").onclick = () => { const [y, m] = month.split("-").map(Number); const d = new Date(y, m - 2, 1); month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; render(); };
  $("#calNext").onclick = () => { const [y, m] = month.split("-").map(Number); const d = new Date(y, m, 1); month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; render(); };
  $("#calToday").onclick = () => { month = today().slice(0, 7); day = ""; render(); };
  $("#calGrid").onclick = e => { const b = e.target.closest("[data-day]"); if (!b) return; day = day === b.dataset.day ? "" : b.dataset.day; render(); if (day) $("#calList").scrollIntoView({ behavior: "smooth", block: "start" }); };
  $("#calFilter").onclick = e => { const b = e.target.closest(".chip"); if (!b) return; filter = b.dataset.f; museumOnly = ""; lsSet("calFilter", filter); render(); };
  $("#calPref").onchange = e => { pref = e.target.value; render(); };
  $("#calMuseum").onclick = e => { if (e.target.closest("#calMuseumClear")) { museumOnly = ""; render(); } };
  $("#calList").onclick = onListClick;
  $("#calAdd").onclick = () => openAddEvent();
}
