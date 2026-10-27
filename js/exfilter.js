// Checkbox filters for exhibitions, shared by the calendar and the exhibitions tab.
// State is a set of checked keys per group, kept in localStorage per screen.
import { esc, today, daysBetween } from "./ui.js";
import { AREAS, isOpen } from "./places.js";

export const GROUPS = {
  show: { label: "表示する展示", opts: [["want", "☆ 行きたい"], ["plan", "行く日を決めた"], ["ticket", "🎫 チケット購入済み"], ["went", "✓ 行った"],
    ["museums", "行った・行きたい美術館の展示"], ["all", "すべての展示"]] },
  status: { label: "開催状況", opts: [["open", "開催中"], ["upcoming", "開催前"], ["ended", "終了"]] },
  kind: { label: "種類", opts: [["special", "特別展"], ["collection", "コレクション展"], ["other", "その他"]] },
  area: { label: "エリア（選ばなければすべて）", opts: AREAS.map(a => [a, a]) },
};

export function load(key, defaults) {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem("artscan.f." + key) || "null"); } catch {}
  const st = {};
  for (const g of Object.keys(defaults)) st[g] = new Set(saved?.[g] ?? defaults[g]);
  return st;
}
export function save(key, st) {
  try { localStorage.setItem("artscan.f." + key, JSON.stringify(Object.fromEntries(Object.entries(st).map(([g, s]) => [g, [...s]])))); } catch {}
}

export function statusOf(e, t = today()) {
  if (e.end && e.end < t) return "ended";
  if (e.start && e.start > t) return "upcoming";
  return "open";
}
export const endingSoon = (e, t = today()) => !!e.end && isOpen(e, t) && daysBetween(t, e.end) <= 14;
const KIND_KEY = k => (k === "special" || k === "collection" ? k : "other");

// museumsById: Map of P.museums() (to know went/want museums)
export function apply(list, st, museumsById) {
  const t = today();
  return list.filter(e => {
    if (st.area && st.area.size && !st.area.has(e.area)) return false;
    if (st.kind && !st.kind.has(KIND_KEY(e.kind))) return false;
    if (st.status && !st.status.has(statusOf(e, t))) return false;
    if (st.show) {
      const s = st.show, k = e.mark || {};
      if (s.has("all")) return true;
      const m = e.museumId ? museumsById?.get(e.museumId) : null;
      return (s.has("want") && (k.want || e.mine)) || (s.has("plan") && !!k.plan) || (s.has("ticket") && !!k.ticket) ||
        (s.has("went") && !!k.went) || (s.has("museums") && !!m && (m.went || m.want));
    }
    return true;
  });
}

// A short text of what is chosen, for the closed filter bar.
export function summary(st) {
  const parts = [];
  for (const [g, def] of Object.entries(GROUPS)) {
    const s = st[g]; if (!s) continue;
    if (g === "area") { if (s.size) parts.push([...s].join("・")); continue; }
    if (s.size === def.opts.length) continue;
    if (g === "show" && s.has("all")) continue;
    parts.push(s.size ? def.opts.filter(o => s.has(o[0])).map(o => o[1].replace(/^[☆✓] |^🎫 /u, "")).join("・") : `${def.label}：なし`);
  }
  return parts.join(" ／ ") || "すべて";
}

export function html(id, st) {
  return `<details class="exf" id="${id}"><summary><span class="exf-k">絞り込み</span><span class="exf-s">${esc(summary(st))}</span></summary>
    <div class="exf-body">${Object.entries(st).map(([g, s]) => `<fieldset><legend>${esc(GROUPS[g].label)}</legend><div class="exf-opts">
      ${GROUPS[g].opts.map(([k, l]) => `<label class="check"><input type="checkbox" data-g="${g}" value="${esc(k)}" ${s.has(k) ? "checked" : ""}><span>${esc(l)}</span></label>`).join("")}
      </div></fieldset>`).join("")}
      <div class="row"><button class="btn small ghost" type="button" data-exf-reset>元に戻す</button></div></div></details>`;
}

// Wire the checkboxes. onChange is called after every change.
export function bind(root, key, st, defaults, onChange) {
  root.onchange = e => {
    const c = e.target.closest("input[data-g]"); if (!c) return;
    const s = st[c.dataset.g];
    c.checked ? s.add(c.value) : s.delete(c.value);
    save(key, st);
    root.querySelector(".exf-s").textContent = summary(st);
    onChange();
  };
  root.onclick = e => {
    if (!e.target.closest("[data-exf-reset]")) return;
    for (const g of Object.keys(st)) st[g] = new Set(defaults[g]);
    save(key, st);
    root.querySelectorAll("input[data-g]").forEach(c => { c.checked = st[c.dataset.g].has(c.value); });
    root.querySelector(".exf-s").textContent = summary(st);
    onChange();
  };
}
