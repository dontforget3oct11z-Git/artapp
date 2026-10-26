// Small helpers shared by every screen.
export const $ = s => document.querySelector(s);
export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const ymd = d => new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
export const today = () => ymd(new Date());
export const addDays = (s, n) => { const d = new Date(s + "T12:00:00"); d.setDate(d.getDate() + n); return ymd(d); };
export const daysBetween = (a, b) => Math.round((Date.parse(b + "T12:00:00") - Date.parse(a + "T12:00:00")) / 864e5);
export const WEEK = ["日", "月", "火", "水", "木", "金", "土"];
export const jpDate = (s, withWeek = true) => {
  if (!s) return "";
  const d = new Date(s + "T12:00:00");
  return `${d.getMonth() + 1}/${d.getDate()}${withWeek ? `（${WEEK[d.getDay()]}）` : ""}`;
};
export const uid = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

let tt;
export function toast(m) { const t = $("#toast"); t.textContent = m; t.hidden = false; clearTimeout(tt); tt = setTimeout(() => t.hidden = true, 2600); }

// Full-screen sheet for details, settings and forms. The phone's back gesture closes it.
const closers = new Set();
export const onSheetClose = f => closers.add(f);
export function openSheet(html) {
  const sh = $("#sheet"); $("#sheetIn").onclick = null; $("#sheetIn").innerHTML = html;
  if (sh.hidden) { sh.hidden = false; document.body.style.overflow = "hidden"; history.pushState({ sheet: 1 }, ""); }
  sh.scrollTop = 0;
}
export function closeSheet(fromPop) {
  if ($("#sheet").hidden) return;
  closers.forEach(f => { try { f(); } catch {} });
  $("#sheet").hidden = true; document.body.style.overflow = "";
  if (!fromPop && history.state?.sheet) history.back();
}
window.addEventListener("popstate", () => closeSheet(true));
document.addEventListener("keydown", e => { if (e.key === "Escape") closeSheet(); });

// Screens register what other screens may call (open a work, switch tab, reload...).
export const app = {};

// Same-origin JSON with a timeout; null when offline and not cached.
export async function getJson(url) {
  try { const r = await fetch(url, { cache: "no-cache" }); return r.ok ? await r.json() : null; } catch { return null; }
}

// Images
export function loadImg(file) {
  return new Promise((res, rej) => {
    const u = URL.createObjectURL(file); const i = new Image();
    i.onload = () => res(i); i.onerror = () => rej(new Error("decode")); i.src = u;
  });
}
export function toBlob(img, max, q = .82) {
  const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement("canvas"); c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  return new Promise(r => c.toBlob(r, "image/jpeg", q));
}

// Where and when a photo was taken (from the photo's own data).
export async function photoMeta(file) {
  const out = {};
  try {
    if (!window.exifr) return out;
    const m = await exifr.parse(file, { gps: true, pick: ["DateTimeOriginal", "CreateDate", "latitude", "longitude"] }).catch(() => null);
    const d = m?.DateTimeOriginal instanceof Date ? m.DateTimeOriginal : m?.CreateDate instanceof Date ? m.CreateDate : null;
    if (d) { out.date = ymd(d); out.time = d.getTime(); }
    if (m?.latitude && m?.longitude) { out.lat = m.latitude; out.lng = m.longitude; }
  } catch {}
  return out;
}

export async function reverseGeocode(lat, lng) {
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18&accept-language=ja`);
    if (!r.ok) return "";
    const j = await r.json();
    const a = j.address || {};
    const isVenue = ["museum", "gallery", "arts_centre", "attraction"].includes(j.type) || ["tourism", "amenity"].includes(j.category);
    if (j.name && isVenue) return j.name;
    return j.name || a.museum || a.tourism || a.amenity || "";
  } catch { return ""; }
}

// Distance in metres.
export function dist(a, b) {
  const R = 6371e3, r = x => x * Math.PI / 180;
  const dLat = r(b.lat - a.lat), dLng = r(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
