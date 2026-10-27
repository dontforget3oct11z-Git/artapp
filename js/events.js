// "展示" tab: every limited-time exhibition in one list, grouped by 開催中 / まもなく終了 / 開催前 / 終了,
// with checkbox filters (status, kind, area, marks) and a search box.
import * as P from "./places.js";
import * as F from "./exfilter.js";
import { section, handleCardClick, infoHtml, openAddEvent, expand } from "./calendar.js";
import { $, esc, app, today, addDays } from "./ui.js";

const DEFAULTS = { status: ["open", "upcoming"], kind: ["special", "collection", "other"], area: [], show: ["all"] };
let fst = null, q = "";
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
  $("#evList").innerHTML = html || `<div class="empty"><strong>この条件の展示はありません</strong><span class="small muted">「絞り込み」のチェックやエリアを変えてみてください。</span></div>`;
  $("#evInfo").innerHTML = infoHtml();
}

export function init() {
  fst = F.load("ev", DEFAULTS);
  $("#evFilterBox").innerHTML = F.html("evF", fst);
  F.bind($("#evF"), "ev", fst, DEFAULTS, () => render());
  let qt; $("#evSearch").oninput = e => { clearTimeout(qt); qt = setTimeout(() => { q = e.target.value.trim(); render(); }, 200); };
  $("#evList").onclick = e => handleCardClick(e);
  $("#evAdd").onclick = () => openAddEvent();
}
export { expand };
