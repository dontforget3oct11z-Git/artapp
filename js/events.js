// "展示" tab: every limited-time exhibition in one list, grouped by 開催中 / まもなく終了 / 開催前 / 終了,
// with checkbox filters (status, kind, area, marks) and a search box.
import * as P from "./places.js";
import * as F from "./exfilter.js";
import { section, handleCardClick, infoHtml, openAddEvent, expand } from "./calendar.js";
import { $, esc, app, today, addDays, toast } from "./ui.js";
import * as ai from "./ai.js";

const DEFAULTS = { status: ["open", "upcoming"], kind: ["special", "collection", "other"], area: [], show: ["all"] };
let fst = null, q = "", mode = "app";
const norm = s => String(s || "").normalize("NFKC").toLowerCase();

export function render() {
  if (!fst) return;
  const t = today();
  const ms = new Map(P.museums(app.works()).map(m => [m.id, m]));
  // limited-time = has a period (permanent displays without dates are left out)
  let list = P.allExhibitions().filter(e => e.start || e.end);
  const base = F.apply(list, { ...fst, status: new Set(["open", "upcoming", "ended"]) }, ms);
  list = F.apply(list, fst, ms);
  if (q) { const n = norm(q); list = list.filter(e => norm(`${e.title} ${e.venueName} ${e.summary} ${e.museum?.pref || ""} ${e.museum?.city || ""}`).includes(n)); }

  const open = list.filter(e => F.statusOf(e, t) === "open").sort((a, b) => (a.end || "9999").localeCompare(b.end || "9999"));
  const soon = open.filter(e => F.endingSoon(e, t));
  const now = open.filter(e => !soon.includes(e));
  const upcoming = list.filter(e => F.statusOf(e, t) === "upcoming").sort((a, b) => a.start.localeCompare(b.start));
  const ended = list.filter(e => F.statusOf(e, t) === "ended").sort((a, b) => b.end.localeCompare(a.end)).filter(e => e.end >= addDays(t, -180));

  // counts before the status filter
  const c = { open: 0, soon: 0, upcoming: 0, ended: 0 };
  for (const e of base) { const s = F.statusOf(e, t); c[s]++; if (F.endingSoon(e, t)) c.soon++; }
  $("#evCounts").innerHTML = `<div class="evc open"><b>${c.open}</b><span>開催中</span></div><div class="evc soon"><b>${c.soon}</b><span>まもなく終了</span></div>
    <div class="evc upcoming"><b>${c.upcoming}</b><span>開催前</span></div><div class="evc ended"><b>${c.ended}</b><span>終了</span></div>`;

  const html = section("まもなく終了（2週間以内）", soon) + section("開催中", now) + section("開催前", upcoming) + section("終了した展示", ended);
  // not in the app? look it up outside and bring it in
  const web = mode === "web";
  document.querySelectorAll("#evMode button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.m === mode)));
  $("#evAppPart").hidden = web;
  $("#evSearch").placeholder = web ? "ネットで探す展覧会名（例：モネ展 東京）" : "展覧会名・美術館・地名で探す";
  $("#evWeb").hidden = !q && !web;
  $("#evWebSearch").hidden = web && !q;
  if (web) {
    $("#evWeb").style.order = "";
    $("#evWebTitle").textContent = q ? `「${q}」をネットで探す` : "ネットで展示を探して登録";
    $("#evWebHelp").textContent = q ? "「ネットで探す」で公式ページを開き、URLをコピーして下に貼ると、AIが展覧会名と会期を読み取ります。内容を確かめてから保存できます。" : "上の欄に展覧会名を入れて検索してください。公式ページのURLや文章がわかっていれば、下に直接貼っても読み取れます。";
    if (q) $("#evWebSearch").href = "https://www.google.com/search?q=" + encodeURIComponent(`${q} 展覧会 会期`);
  } else if (q) {
    $("#evWebHelp").textContent = "ネットで公式ページを探して、そのURLか文章を貼ると、AIが展覧会名と会期を読み取ります。内容を確かめてから保存できます。";
    $("#evWeb").style.order = list.length ? "10" : ""; // below the results when there are some
    $("#evWebTitle").textContent = list.length ? `「${q}」が見つからないときは` : `「${q}」はアプリの一覧にありません`;
    $("#evWebSearch").href = "https://www.google.com/search?q=" + encodeURIComponent(`${q} 展覧会 会期`);
  }
  $("#evList").innerHTML = html || `<div class="empty"><strong>この条件の展示はありません</strong><span class="small muted">「絞り込み」のチェックやエリアを変えてみてください。</span></div>`;
  $("#evInfo").innerHTML = infoHtml();
}

export function init() {
  fst = F.load("ev", DEFAULTS);
  $("#evFilterBox").innerHTML = F.html("evF", fst);
  F.bind($("#evF"), "ev", fst, DEFAULTS, () => render());
  let qt; $("#evSearch").oninput = e => { clearTimeout(qt); qt = setTimeout(() => { q = e.target.value.trim(); render(); }, 200); };
  // in "ネットで探す", Enter goes straight to the web search
  $("#evSearch").onkeydown = e => { if (e.key === "Enter" && mode === "web" && e.target.value.trim()) { q = e.target.value.trim(); render(); window.open($("#evWebSearch").href, "_blank", "noopener"); } };
  $("#evMode").onclick = e => { const b = e.target.closest("[data-m]"); if (!b || b.dataset.m === mode) return; mode = b.dataset.m; render(); $("#evSearch").focus(); };
  $("#evList").onclick = e => handleCardClick(e);
  $("#evAdd").onclick = () => openAddEvent();
  $("#evWebPaste").onclick = async () => {
    try { const t = (await navigator.clipboard.readText()).trim(); if (t) { $("#evWebIn").value = t; readWeb(); } else toast("コピーした内容がありません"); }
    catch { toast("貼り付けできませんでした。入力欄を長押しして貼り付けてください"); $("#evWebIn").focus(); }
  };
  $("#evWebRead").onclick = () => readWeb();
  $("#evWebIn").onkeydown = e => { if (e.key === "Enter") readWeb(); };
}

let reading = false;
async function readWeb() {
  const v = $("#evWebIn").value.trim(), msg = $("#evWebMsg");
  if (!v) { toast("公式ページのURLか文章を入れてください"); $("#evWebIn").focus(); return; }
  if (reading) return; reading = true;
  const url = (v.match(/https?:\/\/[^\s<>"'）)]+/) || [])[0];
  const onlyUrl = url && v.replace(url, "").trim().length < 20;
  msg.innerHTML = `<span class="spinner"></span>${onlyUrl ? "ページを開いて読み取っています…（10〜30秒）" : "読み取っています…"}`;
  try {
    const r = onlyUrl ? await ai.extractEventFromUrl({ url, hint: q, todayStr: today() })
                      : await ai.extractEvent({ text: v, todayStr: today() });
    if (!r || !r.found || !r.title) { msg.textContent = onlyUrl ? "このページから展覧会の情報を読み取れませんでした。ページの文章をコピーして貼ると読み取れることがあります。" : "展覧会の情報を読み取れませんでした。"; return; }
    if (url && !r.url) r.url = url;
    msg.textContent = "";
    $("#evWebIn").value = "";
    openAddEvent(null, r);
  } catch (e) { msg.textContent = e.message; }
  finally { reading = false; }
}
export { expand };
