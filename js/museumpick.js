// A text box for a museum name that suggests museums from the list as you type,
// so the same museum is always written the same way.
// The chosen museum's id is kept in input.dataset.mid (cleared when the text is changed by hand).
import * as P from "./places.js";
import { esc } from "./ui.js";

const norm = s => String(s || "").normalize("NFKC").toLowerCase().replace(/[\s・･「」『』()（）\-_.,]/g, "");

export function search(q, extraNames = [], limit = 8) {
  const n = norm(q);
  if (!n) return [];
  const out = [];
  for (const m of P.allMuseums()) {
    const names = [m.name, m.en, ...(m.aliases || [])].filter(Boolean).map(norm);
    const place = norm(`${m.pref || ""}${m.city || ""}${m.country || ""}`);
    let score = 0;
    if (names.some(x => x === n)) score = 100;
    else if (names.some(x => x.startsWith(n))) score = 60;
    else if (names.some(x => x.includes(n))) score = 40;
    else if (n.length >= 2 && place.includes(n)) score = 10;
    if (score) out.push({ m, score: score + Math.min(20, (m.rank || 0) / 50) + (P.isJapan(m) ? 5 : 0) });
  }
  out.sort((a, b) => b.score - a.score);
  const res = out.slice(0, limit).map(x => ({ id: x.m.id, name: x.m.name, sub: P.isJapan(x.m) ? `${x.m.pref || ""}${x.m.city || ""}` : [x.m.country, x.m.city].filter(Boolean).join(" ") }));
  // names already used in the collection that are not in the list (exhibitions, galleries…)
  for (const name of extraNames) if (res.length < limit && norm(name).includes(n) && !res.some(r => r.name === name)) res.push({ id: "", name, sub: "コレクションで使った名前" });
  return res;
}

let openBox = null;
function close() { openBox?.remove(); openBox = null; }
document.addEventListener("click", e => { if (openBox && !openBox.contains(e.target) && !e.target.matches?.("[data-mpick]")) close(); });

// extraNames: () => string[]   onPick: (museum) => void
export function attach(input, { extraNames = () => [], onPick } = {}) {
  if (!input || input.dataset.mpick) return;
  input.dataset.mpick = "1";
  input.removeAttribute("list");
  input.setAttribute("autocomplete", "off");
  const show = () => {
    close();
    const res = search(input.value, extraNames());
    if (!res.length) return;
    const box = document.createElement("div");
    box.className = "mpick"; box.setAttribute("role", "listbox");
    box.innerHTML = res.map((r, i) => `<button type="button" role="option" data-i="${i}"><b>${esc(r.name)}</b>${r.sub ? `<span>${esc(r.sub)}</span>` : ""}</button>`).join("");
    box.onmousedown = e => e.preventDefault(); // keep focus in the input
    box.onclick = e => {
      const b = e.target.closest("[data-i]"); if (!b) return;
      const r = res[+b.dataset.i];
      input.value = r.name; input.dataset.mid = r.id;
      close(); onPick?.(r);
      input.dispatchEvent(new Event("change", { bubbles: true }));
    };
    input.insertAdjacentElement("afterend", box);
    openBox = box;
  };
  input.addEventListener("input", () => { delete input.dataset.mid; show(); });
  input.addEventListener("focus", () => { if (input.value) show(); });
  input.addEventListener("keydown", e => { if (e.key === "Escape") close(); });
  input.addEventListener("blur", () => setTimeout(() => { if (openBox && !openBox.contains(document.activeElement)) close(); }, 150));
}
