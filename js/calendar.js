// "カレンダー" tab: a month calendar with planned visits, tickets, visit days and exhibition periods,
// filtered with checkboxes (which exhibitions, kind, area). Also the exhibition card, its actions
// and sheets, which the "展示" tab (js/events.js) uses too.
import * as P from "./places.js";
import * as ai from "./ai.js";
import * as F from "./exfilter.js";
import { $, esc, toast, openSheet, closeSheet, app, today, addDays, daysBetween, jpDate, WEEK, loadImg, toBlob } from "./ui.js";

let month = today().slice(0, 7);
let day = "";            // selected day
let museumOnly = "";
const expanded = new Set();

export const KIND = { special: "特別展", collection: "コレクション展", other: "展示" };
const DEFAULTS = { show: ["want", "plan", "ticket", "museums"], kind: ["special", "collection", "other"], area: [] };
let fst = null;

function museumMap() { return new Map(P.museums(app.works()).map(m => [m.id, m])); }

function filtered() {
  const all = P.allExhibitions();
  if (museumOnly) return all.filter(e => e.museumId === museumOnly);
  return F.apply(all, fst, museumMap());
}
// Museum tickets (not tied to one exhibition), within the chosen areas.
function museumTickets() {
  if (!fst.show.has("ticket") && !fst.show.has("all")) return [];
  return P.museumTickets().filter(t => !fst.area.size || fst.area.has(P.areaOf(t.museum)));
}

export function render() {
  const t = today();
  const list = filtered();
  const works = app.works();
  const [y, mo] = month.split("-").map(Number);
  $("#calMonth").textContent = `${y}年${mo}月`;
  $("#calFilterBox").hidden = !!museumOnly;
  $("#calMuseum").hidden = !museumOnly;
  if (museumOnly) $("#calMuseum").innerHTML = `<span>${esc(P.museumById(museumOnly)?.name || "")}の展示</span><button class="btn small ghost" id="calMuseumClear">絞り込みに戻る</button>`;

  // ---- month grid ----
  const first = new Date(y, mo - 1, 1), startPad = first.getDay(), days = new Date(y, mo, 0).getDate();
  const ids = new Set(list.map(e => e.id));
  const plans = P.plans().filter(x => ids.has(x.e.id));
  const mt = museumTickets().filter(x => x.day);
  const visitDays = new Map();
  for (const w of works) if (w.visited) { const d = w.visited.slice(0, 10); visitDays.set(d, (visitDays.get(d) || 0) + 1); }
  for (const m of P.museums(works)) for (const d of m.visits) if (!visitDays.has(d)) visitDays.set(d, 0);
  const wanted = list.filter(e => (e.mark.want || e.mark.ticket) && !e.mark.went);
  let cells = WEEK.map((w, i) => `<div class="dow${i === 0 ? " sun" : i === 6 ? " sat" : ""}">${w}</div>`).join("");
  for (let i = 0; i < startPad; i++) cells += `<div></div>`;
  for (let d = 1; d <= days; d++) {
    const ds = `${month}-${String(d).padStart(2, "0")}`;
    const ev = [...plans.filter(x => x.day === ds).map(x => ({ t: x.e.venueName || x.e.title, ticket: !!x.e.mark.ticket })),
      ...mt.filter(x => x.day === ds).map(x => ({ t: x.museum.name, ticket: true }))];
    const v = visitDays.has(ds);
    const ending = wanted.filter(e => e.end === ds);
    const starting = wanted.filter(e => e.start === ds);
    const dow = (startPad + d - 1) % 7;
    cells += `<button class="day${ds === t ? " today" : ""}${ds === day ? " sel" : ""}${dow === 0 ? " sun" : dow === 6 ? " sat" : ""}" data-day="${ds}" aria-label="${mo}月${d}日${ev.length ? `、予定${ev.length}件` : ""}${v ? "、訪問の記録あり" : ""}${ending.length ? `、行きたい展示の最終日` : ""}">
      <span class="n">${d}</span>
      ${ev.slice(0, 2).map(x => `<span class="ev plan${x.ticket ? " ticket" : ""}">${x.ticket ? "🎫" : ""}${esc(x.t)}</span>`).join("")}${ev.length > 2 ? `<span class="ev plan">+${ev.length - 2}</span>` : ""}
      <span class="marks">${v ? `<i class="m went" title="訪問"></i>` : ""}${ending.length ? `<i class="m end" title="最終日"></i>` : ""}${starting.length ? `<i class="m start" title="初日"></i>` : ""}</span>
    </button>`;
  }
  $("#calGrid").innerHTML = cells;

  // ---- below the grid ----
  if (day) { renderDay(day, list, works); return; }
  const open = list.filter(e => P.isOpen(e, t)).sort((a, b) => (a.end || "9999").localeCompare(b.end || "9999"));
  const soon = open.filter(e => F.endingSoon(e, t));
  const now = open.filter(e => !soon.includes(e));
  const next = list.filter(e => e.start && e.start > t && e.start <= addDays(t, 120)).sort((a, b) => a.start.localeCompare(b.start));
  const tickets = museumTickets();
  const html = (tickets.length ? `<h3>美術館のチケット<span class="small muted"> ${tickets.length}件</span></h3>${tickets.map(ticketCard).join("")}` : "") +
    section("まもなく終了", soon) + section("開催中", now) + section("これから", next);
  $("#calList").innerHTML = html || emptyHtml();
  $("#calInfo").innerHTML = infoHtml();
}

export function section(title, arr, note = "") {
  if (!arr.length) return "";
  const cap = expanded.has(title) ? arr.length : 40;
  return `<h3>${title}<span class="small muted"> ${arr.length}件</span></h3>${note}${arr.slice(0, cap).map(card).join("")}` +
    (arr.length > cap ? `<button class="btn ghost" data-more="${esc(title)}">残り${arr.length - cap}件を表示</button>` : "");
}
export const expand = title => expanded.add(title);

function ticketCard(t) {
  return `<div class="excard ticketed"><div class="top"><span class="kind">🎫 チケット購入済み</span>${t.day ? `<span class="left">${esc(jpDate(t.day))}</span>` : ""}</div>
    <div class="ttl">${esc(t.museum.name)}</div>${t.note ? `<div class="small">${esc(t.note)}</div>` : ""}
    <div class="row acts"><button class="btn small ghost" data-mopen="${esc(t.id)}">美術館を見る</button></div></div>`;
}

function emptyHtml() {
  if (museumOnly) return `<div class="empty">この美術館で、いま登録されている展示はありません。</div>`;
  return `<div class="empty"><strong>この条件の展示はありません</strong><span class="small muted">「絞り込み」でチェックを増やすか、「展示」タブで気になる展示に ☆ や 🎫 を付けてください。</span></div>`;
}
export function infoHtml() {
  const up = P.feedUpdated ? new Date(P.feedUpdated) : null;
  return `展示情報は、各美術館の公式サイトから毎日自動で集めています${up ? `（最終更新 ${up.getMonth() + 1}/${up.getDate()} ${String(up.getHours()).padStart(2, "0")}:${String(up.getMinutes()).padStart(2, "0")}）` : "（まだ集めていません）"}。会期は変わることがあるので、出かける前に公式ページで確認してください。`;
}

const STATUS = { open: ["開催中", "open"], upcoming: ["開催前", "upcoming"], ended: ["終了", "ended"] };
function remain(e) {
  const t = today();
  if (e.end && e.end < t) return `${jpDate(e.end, false)}に終了`;
  if (e.start && e.start > t) { const n = daysBetween(t, e.start); return n <= 1 ? "明日から" : n <= 30 ? `あと${n}日で開幕` : `${jpDate(e.start, false)}から`; }
  if (!e.end) return "";
  const n = daysBetween(t, e.end);
  return n === 0 ? "今日まで" : n === 1 ? "明日まで" : `あと${n}日`;
}
export function card(e) {
  const k = e.mark;
  const st = F.statusOf(e), soon = F.endingSoon(e);
  const urgent = soon && daysBetween(today(), e.end) <= 7;
  const badge = soon ? ["まもなく終了", "soon"] : STATUS[st];
  return `<div class="excard${k.want ? " want" : ""}${k.went ? " went" : ""}${k.ticket ? " ticketed" : ""}${st === "ended" ? " ended" : ""}" data-ex="${esc(e.id)}">
    <div class="exhead"><div class="exthumb${e.image ? "" : " none"}" data-act="more" aria-hidden="true">${e.image ? `<img src="${esc(e.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.parentNode.classList.add('none');this.remove()">` : ""}<span>${esc((e.venueName || e.title || "展").replace(/^(東京都|京都|大阪|国立|県立|市立|公益財団法人)/, "").slice(0, 2))}</span></div><div class="exmain">
    <div class="top"><span class="stbadge ${badge[1]}">${badge[0]}</span><span class="kind">${KIND[e.kind] || "展示"}</span>${k.ticket ? `<span class="tk">🎫 購入済み</span>` : ""}${k.went ? `<span class="tk went">✓ 行った</span>` : ""}<span class="left${urgent ? " urgent" : ""}">${remain(e)}</span></div>
    <div class="ttl">${esc(e.title)}</div>
    <div class="small muted">${esc(e.venueName || "")}${e.museum?.pref ? ` ・ ${esc(e.museum.pref)}` : e.museum?.country && e.area === "海外" ? ` ・ ${esc(e.museum.country)}` : ""}${e.venue ? ` ・ ${esc(e.venue)}` : ""}</div>
    <div class="small mono">${e.start ? esc(jpDate(e.start)) : ""}〜${e.end ? esc(jpDate(e.end)) : ""}</div>
    ${e.summary ? `<div class="small exsum">${esc(e.summary)}</div>` : ""}
    </div></div>
    ${k.plan || k.ticketNote ? `<div class="small plan-line">${k.plan ? `行く日：${esc(jpDate(k.plan))}` : ""}${k.plan && k.ticketNote ? " ・ " : ""}${k.ticketNote ? esc(k.ticketNote) : ""}</div>` : ""}
    <div class="row acts">
      <button class="btn small${k.want ? " on" : ""}" data-act="want" aria-pressed="${!!k.want}">${k.want ? "★ 行きたい" : "☆ 行きたい"}</button>
      <button class="btn small${k.ticket ? " on" : ""}" data-act="ticket" aria-pressed="${!!k.ticket}">🎫 ${k.ticket ? "購入済み" : "チケット"}</button>
      ${st !== "ended" ? `<button class="btn small ghost" data-act="plan">${k.plan ? "予定を変える" : "行く日"}</button>` : ""}
      <button class="btn small ghost" data-act="more" aria-label="詳しく・その他">…</button>
    </div>
  </div>`;
}

function renderDay(ds, list, works) {
  const plans = P.plans().filter(x => x.day === ds && list.some(e => e.id === x.e.id));
  const mt = museumTickets().filter(x => x.day === ds);
  const ws = works.filter(w => (w.visited || "").slice(0, 10) === ds);
  const open = list.filter(e => P.isOpen(e, ds)).sort((a, b) => (a.end || "9999").localeCompare(b.end || "9999"));
  $("#calList").innerHTML = `<div class="row" style="justify-content:space-between"><h3>${esc(jpDate(ds))}</h3><button class="btn small ghost" id="calDayClose">日付の選択をやめる</button></div>
    ${plans.length || mt.length ? `<h3 class="sub">予定</h3>${mt.map(ticketCard).join("")}${plans.map(x => card(x.e)).join("")}` : ""}
    ${ws.length ? `<h3 class="sub">この日に撮った作品</h3><div class="strip">${ws.map(w => `<button data-id="${esc(w.id)}" aria-label="${esc(w.title)}"><div class="frame">${app.thumbOf(w) ? `<img src="${app.thumbOf(w)}" alt="">` : ""}</div></button>`).join("")}</div>` : ""}
    <h3 class="sub">この日に開いている展示<span class="small muted"> ${open.length}件</span></h3>
    ${open.map(card).join("") || `<div class="small muted">この条件の展示はありません。</div>`}`;
  $("#calInfo").innerHTML = infoHtml();
}

const refresh = () => { app.refreshExhibitions?.(); app.refreshMuseums?.(); };

// Clicks inside a list of exhibition cards (used by both tabs). Returns true when handled.
export async function handleCardClick(e) {
  const more = e.target.closest("[data-more]"); if (more) { expanded.add(more.dataset.more); refresh(); return true; }
  const w = e.target.closest("[data-id]"); if (w) { app.openDetail(w.dataset.id); return true; }
  const mo = e.target.closest("[data-mopen]"); if (mo) { app.openMuseum(mo.dataset.mopen); return true; }
  const b = e.target.closest("[data-act]"); if (!b) return false;
  const id = b.closest("[data-ex]").dataset.ex;
  const ex = P.allExhibitions().find(x => x.id === id); if (!ex) return true;
  const act = b.dataset.act;
  if (act === "want") { await P.setMark(id, { want: !ex.mark.want }); toast(ex.mark.want ? "「行きたい」を外しました" : "「行きたい」に入れました"); }
  if (act === "ticket") { openTicket(ex); return true; }
  if (act === "plan") { openPlan(ex); return true; }
  if (act === "more") { openExhibition(ex); return true; }
  refresh();
  return true;
}
async function onListClick(e) {
  if (e.target.closest("#calDayClose")) { day = ""; render(); return; }
  await handleCardClick(e);
}

async function toggleWent(ex) {
  const went = !ex.mark.went;
  await P.setMark(ex.id, { went });
  if (went && ex.museumId) await P.addVisit(ex.museumId, ex.mark.plan && ex.mark.plan <= today() ? ex.mark.plan : today());
  toast(went ? "「行った」にしました" : "「行った」を外しました");
  refresh();
}

// A ticket already bought for this exhibition: the day (if dated) and a note.
function openTicket(ex) {
  const k = ex.mark, t = today();
  const min = ex.start && ex.start > t ? ex.start : "";
  openSheet(`<div class="bar"><button class="btn ghost" id="tkClose">← 戻る</button></div>
    <h2>🎫 チケット購入済み</h2>
    <div class="box"><b>${esc(ex.title)}</b><div class="small muted">${esc(ex.venueName)} ・ ${esc(jpDate(ex.start))}〜${esc(jpDate(ex.end))}</div>
      <label class="check"><input type="checkbox" id="tkNoDay" ${k.plan ? "" : "checked"}><span>行く日はまだ決めていない</span></label>
      <div class="field" id="tkDayBox" ${k.plan ? "" : "hidden"}><label for="tkDay">行く日（日時指定のチケットなら、その日）</label><input type="date" id="tkDay" ${min ? `min="${min}"` : ""} ${ex.end ? `max="${ex.end}"` : ""} value="${esc(k.plan || "")}"></div>
      <div class="field"><label for="tkNote">メモ（時間・枚数・購入先・引換番号など）</label><input id="tkNote" value="${esc(k.ticketNote || "")}" placeholder="例：14:00入場・2枚・ローチケ"></div>
      <div class="small muted">カレンダーに🎫で表示され、共有している相手にも出ます。</div>
      <div class="row"><button class="btn primary" id="tkSave">保存</button>${k.ticket ? `<button class="btn ghost danger" id="tkDel">チケットの記録を消す</button>` : ""}</div></div>`);
  $("#tkClose").onclick = () => closeSheet();
  $("#tkNoDay").onchange = ev => { $("#tkDayBox").hidden = ev.target.checked; if (!ev.target.checked) $("#tkDay").focus(); };
  $("#tkSave").onclick = async () => {
    const d = $("#tkNoDay").checked ? "" : $("#tkDay").value;
    await P.setMark(ex.id, { ticket: true, ticketNote: $("#tkNote").value.trim(), want: true, plan: d });
    closeSheet(); if (d) month = d.slice(0, 7); refresh(); toast("チケット購入済みにしました");
  };
  if ($("#tkDel")) $("#tkDel").onclick = async () => { await P.setMark(ex.id, { ticket: false, ticketNote: "" }); closeSheet(); refresh(); toast("チケットの記録を消しました"); };
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
    await P.setMark(ex.id, { plan: d, want: true }); closeSheet(); month = d.slice(0, 7); refresh(); toast(`${jpDate(d)}に予定を入れました`);
  };
  if ($("#plDel")) $("#plDel").onclick = async () => { await P.setMark(ex.id, { plan: "" }); closeSheet(); refresh(); };
  $("#plIcs").onclick = () => downloadIcs(ex, $("#plDay").value);
}

function downloadIcs(ex, d) {
  const blob = new Blob([P.icsFor(ex, d)], { type: "text/calendar" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "artmuse.ics"; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

function openExhibition(ex) {
  const k = ex.mark;
  openSheet(`<div class="bar"><button class="btn ghost" id="exClose">← 戻る</button></div>
    <h2>${esc(ex.title)}</h2>
    <div class="small muted">${esc(ex.venueName)}${ex.venue ? ` ・ ${esc(ex.venue)}` : ""} ・ ${esc(jpDate(ex.start))}〜${esc(jpDate(ex.end))}</div>
    ${ex.summary ? `<div class="prose">${esc(ex.summary)}</div>` : ""}
    <div class="row">
      <button class="btn${k.went ? " on" : ""}" id="exWent">${k.went ? "✓ 行った" : "行ったにする"}</button>
      <button class="btn${k.ticket ? " on" : ""}" id="exTicket">🎫 ${k.ticket ? "チケットの記録" : "チケット購入済みにする"}</button>
    </div>
    <div class="row">
      ${ex.url ? `<a class="btn" href="${esc(ex.url)}" target="_blank" rel="noopener">公式ページを開く</a>` : ""}
      <button class="btn" id="exIcs">会期をスマホのカレンダーに入れる</button>
      ${ex.museumId ? `<button class="btn ghost" id="exMuseum">美術館の記録を見る</button>` : ""}
    </div>
    <div class="small muted">${ex.mine ? "自分で追加した展示です。" : `この情報は ${ex.source ? `<a href="${esc(ex.source)}" target="_blank" rel="noopener">公式サイトの展覧会ページ</a>` : "公式サイト"} から自動で集めました。会期や休館日は公式ページで確認してください。`}</div>
    ${ex.mine ? `<div class="row"><button class="btn ghost" id="exEdit">編集</button><button class="btn ghost danger" id="exDel">削除</button></div>` : ""}`);
  $("#exClose").onclick = () => closeSheet();
  $("#exWent").onclick = async () => { await toggleWent(ex); closeSheet(); };
  $("#exTicket").onclick = () => openTicket(ex);
  $("#exIcs").onclick = () => downloadIcs(ex);
  if ($("#exMuseum")) $("#exMuseum").onclick = () => app.openMuseum(ex.museumId);
  if ($("#exEdit")) $("#exEdit").onclick = () => openAddEvent(ex);
  if ($("#exDel")) $("#exDel").onclick = async () => { if (!confirm("この展示を削除しますか？")) return; await P.deleteEvent(ex.id); closeSheet(); refresh(); };
}

// Add an exhibition yourself: from a flyer photo / pasted text (AI reads it), or by hand.
// draft: what the AI read from a web page or flyer, shown for checking before saving.
export function openAddEvent(pre, draft) {
  const all = P.museums(app.works()).sort((a, b) => a.name.localeCompare(b.name, "ja"));
  const e = pre || {};
  openSheet(`<div class="bar"><button class="btn ghost" id="aeClose">キャンセル</button><button class="btn primary" id="aeSave">保存</button></div>
    <h2>${pre ? "展示を編集" : "展示を追加"}</h2>
    ${pre ? "" : `<div class="box"><h3>チラシや案内から読み取る</h3>
      <p class="small muted" style="margin:0">チラシ・ポスター・チケットの写真か、公式サイトの文章を貼ると、AIが展覧会名と会期を読み取って下に入れます。${ai.isFree() ? "（Gemini無料枠）" : ""}</p>
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
      ${pre ? "" : `<label class="check"><input type="checkbox" id="aeTicket"><span>🎫 チケットを購入済み</span></label>
      <div class="grid2" id="aeTkBox" hidden><div class="field"><label for="aeTkDay">行く日（決まっていなければ空のまま）</label><input type="date" id="aeTkDay"></div>
      <div class="field"><label for="aeTkNote">チケットのメモ</label><input id="aeTkNote" placeholder="時間・枚数など"></div></div>`}
    </div>`);
  $("#aeClose").onclick = () => closeSheet();
  if ($("#aeTicket")) $("#aeTicket").onchange = ev => { $("#aeTkBox").hidden = !ev.target.checked; };
  const fill = async (getArgs) => {
    if (!ai.settings.apiKey) { toast("設定でAPIキーを入れてください"); return; }
    $("#aeMsg").innerHTML = '<span class="spinner"></span>読み取っています…';
    try {
      const r = await ai.extractEvent({ ...(await getArgs()), todayStr: today() });
      if (!r.found) { $("#aeMsg").textContent = "展覧会の情報を読み取れませんでした。手で入れてください。"; return; }
      setFrom(r);
      $("#aeMsg").textContent = "読み取りました。内容を確かめてから保存してください。";
    } catch (err) { $("#aeMsg").textContent = err.message; }
  };
  function setFrom(r) {
    const set = (id, v) => { if (v) $(id).value = v; };
    set("#aeTitle", r.title); set("#aeUrl", r.url); set("#aeSum", r.summary);
    if (/^\d{4}-\d{2}-\d{2}$/.test(r.start)) $("#aeStart").value = r.start;
    if (/^\d{4}-\d{2}-\d{2}$/.test(r.end)) $("#aeEnd").value = r.end;
    const sq = x => String(x || "").normalize("NFKC").toLowerCase().replace(/[\s,.]/g, "");
    const v = sq(r.venue);
    // Japanese or English name: exact first, then the longest list name inside the venue, then the shortest name containing it
    const pairs = all.flatMap(m => [m.name, m.en].filter(Boolean).map(n => [m, sq(n)])).filter(([, n]) => n.length >= 3);
    const pick = (arr, longest) => arr.sort((a, b) => longest ? b[1].length - a[1].length : a[1].length - b[1].length)[0]?.[0];
    const hit = v && ((pairs.find(([, n]) => n === v) || [])[0] || pick(pairs.filter(([, n]) => v.includes(n)), true) || pick(pairs.filter(([, n]) => n.includes(v)), false));
    if (hit) $("#aeMuseum").value = hit.id; else if (r.venue) { $("#aeMuseum").value = ""; $("#aeVenue").value = r.venue; }
  }
  if (draft) {
    setFrom(draft);
    $("#aeMsg").textContent = "ネットから読み取りました。会期や会場が合っているか確かめてから保存してください。";
    $("#aeMsg").closest(".box").scrollIntoView?.({ block: "end" });
  }
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
    if (!pre) {
      const tk = $("#aeTicket")?.checked, d = $("#aeTkDay")?.value;
      await P.setMark(r.id, { want: true, ...(tk ? { ticket: true, ticketNote: $("#aeTkNote").value.trim() } : {}), ...(tk && d ? { plan: d } : {}) });
    }
    closeSheet(); if (start) month = (start > today() ? start : today()).slice(0, 7); refresh(); toast("展示を保存しました");
  };
}

export function showExhibitionsFor(id) { museumOnly = id; day = ""; render(); }

export function init() {
  fst = F.load("cal", DEFAULTS);
  $("#calFilterBox").innerHTML = F.html("calF", fst);
  F.bind($("#calF"), "cal", fst, DEFAULTS, () => render());
  $("#calPrev").onclick = () => { const [y, m] = month.split("-").map(Number); const d = new Date(y, m - 2, 1); month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; render(); };
  $("#calNext").onclick = () => { const [y, m] = month.split("-").map(Number); const d = new Date(y, m, 1); month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; render(); };
  $("#calToday").onclick = () => { month = today().slice(0, 7); day = ""; render(); };
  $("#calGrid").onclick = e => { const b = e.target.closest("[data-day]"); if (!b) return; day = day === b.dataset.day ? "" : b.dataset.day; render(); if (day) $("#calList").scrollIntoView({ behavior: "smooth", block: "start" }); };
  $("#calMuseum").onclick = e => { if (e.target.closest("#calMuseumClear")) { museumOnly = ""; render(); } };
  $("#calList").onclick = onListClick;
  $("#calAdd").onclick = () => openAddEvent();
}
