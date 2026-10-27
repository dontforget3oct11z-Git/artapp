// Museums and exhibitions: the built-in list (data/*.json, refreshed daily by GitHub Actions)
// plus what you add or mark yourselves (kept in the shared stores "museums", "marks", "events").
import * as store from "./store.js";
import { getJson, dist, today } from "./ui.js";

let catalog = [];          // data/museums.json (with exhibition pages) + data/museums-wikidata.json (Japan + world)
let feed = [];             // data/exhibitions.json
export let feedUpdated = null;
export let feedErrors = [];
let museumRecs = new Map(), marks = new Map(), events = [];

export async function loadCatalog() {
  const [m, w, e] = await Promise.all([getJson("data/museums.json"), getJson("data/museums-wikidata.json"), getJson("data/exhibitions.json")]);
  if (m?.museums) catalog = [...m.museums.map(x => ({ ...x, cc: "JP", country: "日本", rank: 1000 })), ...(w?.museums || [])];
  baseCache = null;
  if (e) { feed = e.exhibitions || []; feedUpdated = e.updatedAt || null; feedErrors = e.errors || []; }
}
export async function loadLocal() {
  const [a, b, c] = await Promise.all([store.list("museums"), store.list("marks"), store.list("events")]);
  museumRecs = new Map(a.map(r => [r.id, r]));
  baseCache = null;
  marks = new Map(b.map(r => [r.id, r]));
  events = c;
}
export const load = () => Promise.all([loadCatalog(), loadLocal()]);

// ---------- museums ----------
const norm = s => String(s || "").normalize("NFKC").toLowerCase().replace(/[\s・･「」『』()（）\-_]/g, "");
export const PREFS = ["北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県", "茨城県", "栃木県", "群馬県", "埼玉県", "千葉県", "東京都", "神奈川県",
  "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県", "岐阜県", "静岡県", "愛知県", "三重県", "滋賀県", "京都府", "大阪府", "兵庫県", "奈良県", "和歌山県",
  "鳥取県", "島根県", "岡山県", "広島県", "山口県", "徳島県", "香川県", "愛媛県", "高知県", "福岡県", "佐賀県", "長崎県", "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県"];

let baseCache = null;
function baseList() {
  if (baseCache) return baseCache;
  const list = catalog.map(m => ({ ...m, custom: false }));
  for (const r of museumRecs.values()) if (r.custom?.name) list.push({ id: r.id, cc: r.custom.cc || "JP", country: r.custom.country || "日本", ...r.custom, aliases: [], custom: true });
  for (const m of list) m._n = [m.name, m.en, ...(m.aliases || [])].filter(Boolean).map(norm);
  return (baseCache = list);
}
export const isJapan = m => !m.cc || m.cc === "JP";

// Areas between country and city: Japanese regions, and everything abroad as one.
export const AREAS = ["北海道", "東北", "関東", "中部", "関西", "中国", "四国", "九州・沖縄", "海外"];
const AREA_OF = {};
[["北海道", "北海道"], ["東北", "青森県 岩手県 宮城県 秋田県 山形県 福島県"], ["関東", "茨城県 栃木県 群馬県 埼玉県 千葉県 東京都 神奈川県"],
 ["中部", "新潟県 富山県 石川県 福井県 山梨県 長野県 岐阜県 静岡県 愛知県"], ["関西", "三重県 滋賀県 京都府 大阪府 兵庫県 奈良県 和歌山県"],
 ["中国", "鳥取県 島根県 岡山県 広島県 山口県"], ["四国", "徳島県 香川県 愛媛県 高知県"], ["九州・沖縄", "福岡県 佐賀県 長崎県 熊本県 大分県 宮崎県 鹿児島県 沖縄県"]]
  .forEach(([a, ps]) => ps.split(" ").forEach(p => { AREA_OF[p] = a; }));
export function areaOf(m) {
  if (!m) return "";
  if (!isJapan(m)) return "海外";
  return AREA_OF[m.pref] || "";
}

// Which museum a work belongs to: chosen id, then name, then place (within 400 m).
export function museumIdFor(w, list = baseList()) {
  if (w.museumId && list.some(m => m.id === w.museumId)) return w.museumId;
  const n = norm(w.museum);
  if (n.length >= 2) {
    for (const m of list) if (m._n.includes(n)) return m.id; // exact name first
    for (const m of list) if (m._n.some(x => x && ((x.length >= 4 && n.includes(x)) || (n.length >= 4 && x.includes(n))))) return m.id;
  }
  if (Number.isFinite(w.lat) && Number.isFinite(w.lng)) {
    let best = null, bd = 400;
    for (const m of list) if (Number.isFinite(m.lat)) { const d = dist(w, m); if (d < bd) { bd = d; best = m.id; } }
    if (best) return best;
  }
  return null;
}

// Every museum with its state: went (status or photos), want, the works and visit days.
export function museums(works) {
  const list = baseList();
  const byId = new Map(list.map(m => [m.id, { ...m, works: [], visits: new Set() }]));
  for (const w of works) {
    const id = museumIdFor(w, list);
    if (!id) continue;
    const m = byId.get(id); m.works.push(w); if (w.visited) m.visits.add(w.visited.slice(0, 10));
  }
  const t = today();
  const openCount = new Map();
  for (const e of allExhibitions()) if (e.museumId && isOpen(e, t)) openCount.set(e.museumId, (openCount.get(e.museumId) || 0) + 1);
  for (const m of byId.values()) {
    const r = museumRecs.get(m.id) || {};
    (r.visits || []).forEach(d => m.visits.add(d));
    m.visits = [...m.visits].sort().reverse();
    m.went = r.status === "went" || m.works.length > 0 || m.visits.length > 0;
    m.want = r.status === "want";
    m.note = r.note || "";
    m.status = m.went ? "went" : m.want ? "want" : "";
    m.current = openCount.get(m.id) || 0;
    m.ticket = r.ticket || null;
  }
  return [...byId.values()];
}
export function museumById(id) { return baseList().find(m => m.id === id) || null; }
export const allMuseums = () => baseList();
export const museumRec = id => museumRecs.get(id) || null;

export async function setMuseumStatus(id, status) {
  const r = museumRecs.get(id) || { id };
  const n = { ...r, status };
  // marking "went" without photos also records today as a visit day
  if (status === "went" && !(r.visits || []).length) n.visits = [today()];
  if (status !== "went") n.visits = [];
  museumRecs.set(id, await store.save("museums", n));
}
export async function addVisit(id, day) {
  const r = museumRecs.get(id) || { id };
  const visits = [...new Set([...(r.visits || []), day])].sort();
  museumRecs.set(id, await store.save("museums", { ...r, status: "went", visits }));
}
// A ticket bought for a museum (not for one exhibition): {day, note}, or null to remove.
export async function setMuseumTicket(id, ticket) {
  const r = museumRecs.get(id) || { id };
  const n = { ...r, ticket: ticket || null };
  if (ticket && !r.status) n.status = "want";
  museumRecs.set(id, await store.save("museums", n));
}
export function museumTickets() {
  return [...museumRecs.values()].filter(r => r.ticket && !r.deleted).map(r => ({ id: r.id, ...r.ticket, museum: museumById(r.id) })).filter(t => t.museum);
}
export async function addCustomMuseum(m) {
  const id = "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const rec = { id, status: m.status || "", custom: { name: m.name, pref: m.pref || "", city: m.city || "", lat: m.lat, lng: m.lng, url: m.url || "", cc: m.cc || "JP", country: m.country || "日本" }, visits: m.status === "went" ? [today()] : [] };
  museumRecs.set(id, await store.save("museums", rec));
  baseCache = null;
  return id;
}
export async function removeCustomMuseum(id) { museumRecs.delete(id); baseCache = null; await store.remove("museums", id); }

// ---------- exhibitions ----------
export const isOpen = (e, day) => (!e.start || e.start <= day) && (!e.end || e.end >= day);
export function exhibitionsAt(museumId) { return allExhibitions().filter(e => e.museumId === museumId); }

export function allExhibitions() {
  const byId = new Map(baseList().map(m => [m.id, m]));
  const mus = id => byId.get(id) || null;
  const out = [];
  for (const e of feed) out.push({ ...e, mine: false, museum: mus(e.museumId) });
  for (const e of events) out.push({ ...e, mine: true, museum: e.museumId ? mus(e.museumId) : null });
  return out.map(e => ({ ...e, mark: marks.get(e.id) || {}, venueName: e.museum?.name || e.venueName || "", area: areaOf(e.museum) }));
}

export async function setMark(id, patch) {
  const r = { ...(marks.get(id) || { id }), ...patch };
  marks.set(id, await store.save("marks", r));
}
export async function saveEvent(e) {
  const r = await store.save("events", { ...e, id: e.id || "u" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5) });
  const i = events.findIndex(x => x.id === r.id);
  if (i >= 0) events[i] = r; else events.push(r);
  return r;
}
export async function deleteEvent(id) { events = events.filter(e => e.id !== id); await store.remove("events", id); }

// Planned visits (for the calendar) from the marks.
export function plans() {
  const all = allExhibitions();
  return all.filter(e => e.mark.plan).map(e => ({ day: e.mark.plan, e }));
}

// Calendar file so a plan or an exhibition can go into the phone's own calendar app.
export function icsFor(e, day) {
  const d = s => s.replace(/-/g, "");
  const next = s => { const t = new Date(s + "T12:00:00"); t.setDate(t.getDate() + 1); return t.toISOString().slice(0, 10).replace(/-/g, ""); };
  const start = day || e.start || today(), end = day || e.end || start;
  const txt = s => String(s || "").replace(/\\/g, "\\\\").replace(/[,;]/g, m => "\\" + m).replace(/\n/g, "\\n");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//ArtMuse//JA", "CALSCALE:GREGORIAN", "BEGIN:VEVENT",
    `UID:${e.id}-${day || "period"}@artmuse`, `DTSTAMP:${stamp}`,
    `DTSTART;VALUE=DATE:${d(start)}`, `DTEND;VALUE=DATE:${next(end)}`,
    `SUMMARY:${txt((day ? "鑑賞：" : "") + e.title)}`, `LOCATION:${txt(e.venueName)}`,
    `DESCRIPTION:${txt([e.start || e.end ? `会期 ${e.start || ""}〜${e.end || ""}` : "", e.url].filter(Boolean).join("\n"))}`,
    e.url ? `URL:${e.url}` : "", "END:VEVENT", "END:VCALENDAR"].filter(Boolean).join("\r\n");
}
