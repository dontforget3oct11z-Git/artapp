// Finds a picture for each exhibition (the page's own share image, or the picture next to the
// exhibition's title on a list page) and writes it into data/exhibitions.json as `image`.
// Runs after fetch-exhibitions.mjs. No AI. Respects robots.txt, one page at a time per site.
// Found pictures are remembered in data/exhibition-images.json so each page is read only once.
import { readFile, writeFile } from "node:fs/promises";

const ROOT = new URL("../", import.meta.url);
const UA = "Mozilla/5.0 (compatible; ArtMuseBot/1.0; personal exhibition calendar; +https://github.com/dontforget3oct11z-Git/artapp)";
const MAX_PAGES = Number(process.env.MAX_IMAGE_PAGES || 400);
const MAX_MS = Number(process.env.MAX_IMAGE_MINUTES || 15) * 60e3;
const RETRY_DAYS = 14; // look again for exhibitions where nothing was found
const sleep = ms => new Promise(r => setTimeout(r, ms));
const started = Date.now();

async function download(url) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "ja,en;q=0.5" }, redirect: "follow", signal: ctl.signal });
    if (!res.ok) throw new Error("HTTP " + res.status);
    if (!/html/i.test(res.headers.get("content-type") || "html")) throw new Error("not html");
    const buf = new Uint8Array(await res.arrayBuffer());
    let cs = (res.headers.get("content-type") || "").match(/charset=([\w-]+)/i)?.[1];
    if (!cs) cs = new TextDecoder("latin1").decode(buf.slice(0, 4000)).match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1];
    try { return { html: new TextDecoder((cs || "utf-8").toLowerCase().replace(/^(x-)?sjis$/, "shift_jis")).decode(buf), finalUrl: res.url || url }; }
    catch { return { html: new TextDecoder("utf-8").decode(buf), finalUrl: res.url || url }; }
  } finally { clearTimeout(t); }
}

const robotsCache = new Map();
async function allowed(url) {
  const u = new URL(url);
  if (!robotsCache.has(u.origin)) {
    let rules = [];
    try {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 10000);
      const r = await fetch(u.origin + "/robots.txt", { headers: { "User-Agent": UA }, signal: ctl.signal });
      clearTimeout(t);
      if (r.ok) rules = parseRobots(await r.text());
    } catch {}
    robotsCache.set(u.origin, rules);
  }
  const path = u.pathname + u.search;
  let best = null;
  for (const r of robotsCache.get(u.origin)) if (r.path && path.startsWith(r.path) && (!best || r.path.length > best.path.length)) best = r;
  return !best || best.allow;
}
function parseRobots(txt) {
  const groups = []; let cur = null, lastWasAgent = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim(); if (!line) continue;
    const [k, ...rest] = line.split(":"); const key = k.trim().toLowerCase(), val = rest.join(":").trim();
    if (key === "user-agent") { if (!lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); } cur.agents.push(val.toLowerCase()); lastWasAgent = true; continue; }
    lastWasAgent = false;
    if (cur && (key === "allow" || key === "disallow")) cur.rules.push({ allow: key === "allow", path: val.replace(/\*.*$/, "") });
  }
  const mine = groups.find(g => g.agents.some(a => a && "artmusebot".includes(a.replace(/\/.*/, "")) && a !== "*"));
  return (mine || groups.find(g => g.agents.includes("*")))?.rules || [];
}

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };
const decode = s => String(s || "").replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) =>
  e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : +e.slice(1)) : (ENT[e.toLowerCase()] ?? m));
const BAD = /logo|icon|favicon|sprite|blank|spacer|loading|banner_?sns|share|ogp?_?default|default_?og|noimage|no_image|dummy|placeholder|\.svg(\?|$)|\.gif(\?|$)/i;
const abs = (src, base) => { try { const u = new URL(decode(src).trim(), base); return /^https?:$/.test(u.protocol) ? u.href : ""; } catch { return ""; } };

function metaImage(html, base) {
  for (const re of [/<meta[^>]+(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image(?::src)?)["'][^>]*>/gi, /<link[^>]+rel=["']image_src["'][^>]*>/gi]) {
    for (const m of html.matchAll(re)) {
      const v = (m[0].match(/(?:content|href)=["']([^"']+)["']/i) || [])[1];
      const u = v && abs(v, base);
      if (u && !BAD.test(u)) return u;
    }
  }
  return "";
}
// On a list page: the picture closest to where the exhibition's title is written.
const squash = s => decode(String(s || "").replace(/<[^>]+>/g, "")).normalize("NFKC").replace(/[\s　「」『』〈〉《》【】()（）:：・\-—–~〜]/g, "").toLowerCase();
function imageNearTitle(html, base, title) {
  const key = squash(title).slice(0, 12);
  if (key.length < 4) return "";
  // walk the page once, keeping the text position of each <img>
  let text = ""; const imgs = [];
  const re = /<img\b[^>]*>|<[^>]+>|[^<]+/gi; let m;
  const body = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, "");
  while ((m = re.exec(body))) {
    const t = m[0];
    if (/^<img\b/i.test(t)) {
      const src = (t.match(/\b(?:data-src|data-original|data-lazy-src|src)=["']([^"']+)["']/i) || [])[1]
        || ((t.match(/\bsrcset=["']([^"']+)["']/i) || [])[1] || "").split(",")[0].trim().split(/\s+/)[0];
      const u = src && abs(src, base);
      const w = +((t.match(/\bwidth=["']?(\d+)/i) || [])[1] || 0);
      if (u && !BAD.test(u) && !(w && w < 80)) imgs.push({ at: text.length, u });
    } else if (t[0] !== "<") text += squash(t);
  }
  const at = text.indexOf(key);
  if (at < 0 || !imgs.length) return "";
  let best = null;
  for (const i of imgs) { const d = Math.abs(i.at - at); if (d < 400 && (!best || d < best.d)) best = { d, u: i.u }; }
  return best?.u || "";
}

// ---------- run ----------
const exPath = new URL("data/exhibitions.json", ROOT), cachePath = new URL("data/exhibition-images.json", ROOT);
const data = JSON.parse(await readFile(exPath, "utf8"));
let cache = {}; try { cache = JSON.parse(await readFile(cachePath, "utf8")); } catch {}
const today = new Date().toISOString().slice(0, 10);
const daysAgo = d => (Date.parse(today) - Date.parse(d || "2000-01-01")) / 864e5;

const list = data.exhibitions || [];
const todo = list.filter(e => e.url && /^https?:/.test(e.url) && !/\.(jpe?g|png|webp|pdf)(\?|$)/i.test(e.url) &&
  !(cache[e.id] && (cache[e.id].img || daysAgo(cache[e.id].at) < RETRY_DAYS)));
console.log(`exhibitions ${list.length}, need a picture ${todo.length}`);

// group by site, one page at a time per site, a few sites at once
const bySite = new Map();
for (const e of todo) { const h = new URL(e.url).host; if (!bySite.has(h)) bySite.set(h, []); bySite.get(h).push(e); }
const pages = new Map(); // url -> Promise<{html, finalUrl} | null>
let pageCount = 0, found = 0;
async function site(items) {
  for (const e of items) {
    if (Date.now() - started > MAX_MS || pageCount >= MAX_PAGES) return;
    let p = pages.get(e.url);
    if (!p) {
      pageCount++;
      p = (async () => { try { if (!(await allowed(e.url))) return null; const r = await download(e.url); await sleep(1500); return r; } catch { return null; } })();
      pages.set(e.url, p);
    }
    const page = await p;
    let img = "";
    if (page) {
      const listPage = e.url === e.source || list.filter(x => x.url === e.url).length > 1;
      img = listPage ? imageNearTitle(page.html, page.finalUrl, e.title) : (metaImage(page.html, page.finalUrl) || imageNearTitle(page.html, page.finalUrl, e.title));
    }
    cache[e.id] = { img, at: today };
    if (img) found++;
  }
}
const sites = [...bySite.values()];
await Promise.all(Array.from({ length: 4 }, async () => { while (sites.length) await site(sites.shift()); }));

// a picture shared by several exhibitions of a museum is its general picture, not the exhibition's
const uses = new Map();
for (const e of list) { const img = cache[e.id]?.img; if (img) uses.set(img, (uses.get(img) || 0) + 1); }
let set = 0;
for (const e of list) {
  const img = cache[e.id]?.img;
  if (img && uses.get(img) < 3) { e.image = img; set++; } else delete e.image;
}
// forget exhibitions that are gone
const ids = new Set(list.map(e => e.id));
for (const k of Object.keys(cache)) if (!ids.has(k)) delete cache[k];

await writeFile(exPath, JSON.stringify(data) + "\n");
await writeFile(cachePath, JSON.stringify(cache, null, 0).replace(/},"/g, '},\n"') + "\n");
console.log(`pages read ${pageCount}, new pictures ${found}, exhibitions with a picture ${set}/${list.length}`);
