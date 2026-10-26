// Collects current and upcoming exhibitions from museums' official websites
// and writes data/exhibitions.json. Runs every day on GitHub Actions (.github/workflows/exhibitions.yml).
//
// Which museums: every museum with a website, from data/museums.json (hand-made, checked every day)
// and data/museums-wikidata.json (about 1,400 sites, checked in turns so the free Gemini quota lasts:
// museums that had exhibitions every 3 days, others every 10 days, failing sites every 30 days).
//
// Steps for each museum:
//   1. Respect robots.txt. Download the exhibition page (or the top page, and follow its
//      "展覧会 / Exhibitions" link) and turn the HTML into plain text, keeping link URLs.
//   2. Skip pages with no dates on them (nothing to read, saves the AI quota).
//   3. Ask Gemini (free tier) to list the exhibitions written on the page as JSON.
//   4. Keep only exhibitions whose title and dates are really written on the page.
//      This drops anything the AI made up.
// Progress is kept in data/exhibitions-state.json.
// Without GEMINI_API_KEY it only checks that the pages can be downloaded.
//
// Usage: GEMINI_API_KEY=... node scripts/fetch-exhibitions.mjs [museumId ...]
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";

const ROOT = new URL("../", import.meta.url);
const KEY = process.env.GEMINI_API_KEY || "";
const MODELS = ["gemini-3.8-flash", "gemini-3.5-flash-lite"];
const ONLY = process.argv.slice(2);
const UA = "Mozilla/5.0 (compatible; ArtMuseBot/1.0; personal exhibition calendar; +https://github.com/dontforget3oct11z-Git/artapp)";
// Sites that refuse this bot (HTTP 403) are left alone; their exhibitions can be added by hand in the app.
const DEBUG = process.env.DEBUG_DUMP === "1";
const MAX_AI = Number(process.env.MAX_AI || 220);         // Gemini calls per run
const MAX_MUSEUMS = Number(process.env.MAX_MUSEUMS || 400); // sites visited per run
const MAX_MINUTES = Number(process.env.MAX_MINUTES || 50);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const jstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const TODAY = jstToday();

// ---------- download ----------
async function download(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 25000);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "ja,en;q=0.5" }, redirect: "follow", signal: ctl.signal });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const buf = new Uint8Array(await res.arrayBuffer());
    let cs = (res.headers.get("content-type") || "").match(/charset=([\w-]+)/i)?.[1];
    if (!cs) cs = new TextDecoder("latin1").decode(buf.slice(0, 4000)).match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1];
    let html;
    try { html = new TextDecoder((cs || "utf-8").toLowerCase().replace(/^(x-)?sjis$/, "shift_jis")).decode(buf); }
    catch { html = new TextDecoder("utf-8").decode(buf); }
    return { html, finalUrl: res.url || url };
  } finally { clearTimeout(t); }
}

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };
const decode = s => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) =>
  e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : +e.slice(1)) : (ENT[e.toLowerCase()] ?? m));

function htmlToText(html, base) {
  let h = html.replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|iframe|template)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(header|footer)[\s\S]*?<\/\1>/gi, m => m.length < 8000 ? " " : m); // drop small site headers/footers
  h = h.replace(/<a\b[^>]*href=["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (m, href, inner) => {
    let abs = ""; try { abs = new URL(decode(href), base).href; } catch {}
    const txt = inner.replace(/<img[^>]*alt=["']([^"']*)["'][^>]*>/gi, " $1 ").replace(/<[^>]+>/g, " ");
    return ` ${txt} ${abs && /^https?:/.test(abs) ? `［リンク ${abs} ］` : ""} `;
  });
  h = h.replace(/<img[^>]*alt=["']([^"']+)["'][^>]*>/gi, " $1 ")
    .replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr|\/dt|\/dd|\/section|\/article)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return decode(h).replace(/[ \t　]+/g, " ").replace(/\s*\n\s*/g, "\n").replace(/\n{2,}/g, "\n").trim();
}

// For the "is this title really on the page?" check.
const norm = s => String(s || "").normalize("NFKC").toLowerCase().replace(/[\s「」『』【】（）()［］\[\]〈〉《》"'“”‘’・･:：,，.。、!！?？~〜～―—–\-_/|]/g, "");

// ---------- Gemini ----------
const SCHEMA = {
  type: "OBJECT",
  properties: {
    exhibitions: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          title: { type: "STRING" },
          start: { type: "STRING" },
          end: { type: "STRING" },
          url: { type: "STRING" },
          kind: { type: "STRING", enum: ["special", "collection", "other"] },
          summary: { type: "STRING" },
          venue: { type: "STRING" },
        },
        required: ["title", "start", "end", "url", "kind", "summary", "venue"],
        propertyOrdering: ["title", "start", "end", "url", "kind", "summary", "venue"],
      },
    },
  },
  required: ["exhibitions"],
};

function prompt(m, text) {
  return `今日は${TODAY}です。次は「${m.name}」（${[m.country && m.country !== "日本" ? m.country : "", m.pref, m.city].filter(Boolean).join(" ")}）の公式サイトの展覧会ページから取り出した文章です。［リンク URL ］はリンク先です。

このページに書かれている展覧会のうち、会期の終わりが今日以降のもの（開催中と開催予定）をすべて挙げてください。

決まり：
- ページに書かれていることだけを使う。ページにない展覧会や日付を作らない。
- title：ページに書かれている展覧会名をそのまま（副題は含めてよい）。
- start / end：会期を YYYY-MM-DD で。年が省略されていれば前後の文脈から判断する。終わりが書かれていない常設展などは end を空文字にする。
- url：その展覧会の詳しいページのリンク（［リンク URL ］の中のURL）。なければ空文字。
- kind：特別展・企画展は special、コレクション展・常設展・所蔵品展は collection、それ以外は other。
- summary：ページに書かれている内容から、どんな展覧会か1文で。書かれていなければ空文字。
- venue：会場（館内の展示室名、または別の会場名）が書かれていればそれ。なければ空文字。
- 展覧会でないもの（講演会、イベント、ワークショップ、ショップ、レストランの案内など）は含めない。
- 1つもなければ空の配列にする。

--- ページの文章 ---
${text}`;
}

async function askGemini(m, text) {
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt(m, text) }] }],
    generationConfig: { responseMimeType: "application/json", responseSchema: SCHEMA, temperature: 0 },
  };
  let lastErr;
  for (const model of MODELS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": KEY }, body: JSON.stringify(body),
      });
      if (res.ok) {
        const j = await res.json();
        const t = (j.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || "").join("");
        try { return { list: JSON.parse(t).exhibitions || [], model }; } catch { lastErr = new Error("bad JSON from " + model); break; }
      }
      const msg = (await res.text()).slice(0, 300);
      lastErr = new Error(`Gemini ${model} HTTP ${res.status}: ${msg}`);
      if (res.status === 429) { await sleep(attempt ? 1000 : 30000); continue; } // per-minute limit: wait once, then try the next model
      if (res.status >= 500) { await sleep(5000); continue; }
      break;
    }
  }
  throw lastErr;
}

// ---------- checks ----------
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + "T00:00:00Z"));
function check(m, e, pageText, pageUrl) {
  const title = String(e.title || "").trim();
  if (!title || title.length > 160) return "no title";
  const nt = norm(title);
  if (nt.length < 2) return "short title";
  const np = norm(pageText);
  // The full title, or its main part before a subtitle separator, must be on the page.
  const main = norm(title.split(/[―—–\-－:：|｜]|\s{2,}/)[0]);
  if (!np.includes(nt) && !(main.length >= 4 && np.includes(main))) return "title not on page";
  const start = isDate(e.start) ? e.start : "";
  const end = isDate(e.end) ? e.end : "";
  if (!start && !end) return "no dates";
  if (start && end && start > end) return "start after end";
  if (end && end < TODAY) return "already ended";
  if (start && start > addDays(TODAY, 550)) return "too far ahead";
  // The month and day of each date should be written on the page in some form.
  const pt = pageText.normalize("NFKC");
  for (const d of [start, end].filter(Boolean)) {
    if (!dateOnPage(pt, d)) return "date not on page: " + d;
  }
  let url = "";
  try { if (e.url) { const u = new URL(e.url, pageUrl); if (/^https?:$/.test(u.protocol)) url = u.href; } } catch {}
  if (url && !pageText.includes(url)) url = ""; // only links that were on the page
  return {
    id: m.id + "-" + createHash("sha1").update(nt).digest("hex").slice(0, 10),
    museumId: m.id, title, start, end,
    url: url || pageUrl, kind: ["special", "collection", "other"].includes(e.kind) ? e.kind : "other",
    summary: String(e.summary || "").trim().slice(0, 300), venue: String(e.venue || "").trim().slice(0, 80),
    source: pageUrl,
  };
}
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTHS_FR = ["janv", "f[ée]v", "mars", "avr", "mai", "juin", "juil", "ao[uû]t", "sept", "oct", "nov", "d[ée]c"];
const MONTHS_DE = ["jan", "feb", "m[äa]r", "apr", "mai", "jun", "jul", "aug", "sep", "okt", "nov", "dez"];
const MONTHS_IT = ["genn", "febb", "marz", "apr", "magg", "giugn", "lugl", "agost", "sett", "ott", "nov", "dic"];
const MONTHS_ES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
// Is this date written on the page? 10月7日, 10/7, 10.7, 2026-10-07, Oct 7, 7 October, 7.10., 7 ottobre …
function dateOnPage(pt, d) {
  const [y, mo, da] = d.split("-").map(Number);
  const low = pt.toLowerCase();
  const tests = [
    `(^|\\D)0?${mo}\\s*[月/.．／-]\\s*0?${da}(\\D|$)`,
    `(^|\\D)0?${da}\\s*[./]\\s*0?${mo}(\\D|$)`,
  ];
  for (const names of [MONTHS, MONTHS_FR, MONTHS_DE, MONTHS_IT, MONTHS_ES]) {
    const n = names[mo - 1];
    tests.push(`${n}[a-zéûäè]*\\.?\\s*0?${da}(\\D|$)`, `(^|\\D)0?${da}(st|nd|rd|th|er|\\.)?\\s*(de\\s+)?${n}`);
  }
  return tests.some(t => new RegExp(t, "i").test(low)) || low.includes(`${y}${String(mo).padStart(2, "0")}${String(da).padStart(2, "0")}`);
}
const hasDates = t => /\d{1,2}\s*[月/.]\s*\d{1,2}|20\d\d|(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}/i.test(t);

// ---------- robots.txt ----------
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

// On a top page, the link to the exhibitions list.
function findExhibitionLink(html, base) {
  const links = [];
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let href; try { href = new URL(decode(m[1]), base); } catch { continue; }
    if (href.origin !== new URL(base).origin) continue;
    const txt = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const score = /展覧会|企画展|展示案内|展示情報|特別展|exhibitions?\b|what'?s on|ausstellung|expositions?|mostre|exposiciones/i.test(txt) ? 2
      : /exhibit|tenrankai|exhibition|tenji|ausstellung|exposition|mostre/i.test(href.pathname) ? 1 : 0;
    if (score && !/past|archive|過去|終了|kako/i.test(txt + href.pathname)) links.push({ url: href.href, score, len: txt.length });
  }
  links.sort((a, b) => b.score - a.score || a.len - b.len);
  return links[0]?.url || "";
}

function addDays(d, n) { const t = new Date(d + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); }

// ---------- main ----------
const started = Date.now();
const curated = JSON.parse(await readFile(new URL("data/museums.json", ROOT), "utf8")).museums.map(m => ({ ...m, curated: true }));
let wd = [];
try { wd = JSON.parse(await readFile(new URL("data/museums-wikidata.json", ROOT), "utf8")).museums.filter(m => m.url); } catch {}
let prev = { exhibitions: [] };
try { prev = JSON.parse(await readFile(new URL("data/exhibitions.json", ROOT), "utf8")); } catch {}
let state = {};
try { state = JSON.parse(await readFile(new URL("data/exhibitions-state.json", ROOT), "utf8")); } catch {}

// What to visit this run: chosen ids, else the hand-made list + the Wikidata sites that are due.
const daysSince = d => d ? (Date.parse(TODAY) - Date.parse(d)) / 864e5 : 9999;
const due = m => { const st = state[m.id] || {}; const every = st.fails >= 2 ? 30 : st.found ? 3 : 10; return daysSince(st.checked) >= every; };
let queue = ONLY.length ? [...curated, ...wd].filter(m => ONLY.includes(m.id))
  : [...curated, ...wd.filter(due).sort((a, b) => daysSince((state[b.id] || {}).checked) - daysSince((state[a.id] || {}).checked) || (b.rank || 0) - (a.rank || 0))];
queue = queue.slice(0, MAX_MUSEUMS);
console.log(`Visiting ${queue.length} museums (${curated.length} hand-made, ${wd.length} from Wikidata, ${wd.filter(due).length} due).`);

const done = new Set(), results = [], errors = [], report = [];
let aiCalls = 0, quotaOut = false;
for (const m of queue) {
  if (Date.now() - started > MAX_MINUTES * 60e3) { report.push("… time limit reached, the rest next time"); break; }
  if (quotaOut) break;
  const st = (state[m.id] ||= {});
  const old = (prev.exhibitions || []).filter(e => e.museumId === m.id && (!e.end || e.end >= TODAY));
  // Pages to read: the known exhibition page, else the top page and its exhibitions link.
  let text = "", pageUrl = "", fails = [];
  const tried = new Set();
  const read = async u => {
    if (!u || tried.has(u) || text.length >= 1500) return null;
    tried.add(u);
    try {
      if (!(await allowed(u))) { fails.push(`${u}: robots.txt`); return null; }
      const page = await download(u);
      const t = htmlToText(page.html, page.finalUrl);
      if (DEBUG) console.log(`\n===== ${m.id} ${page.finalUrl} html=${page.html.length} text=${t.length}\n${page.html.replace(/\s+/g, " ").slice(0, 1200)}\n----- text\n${t.slice(0, 600)}`);
      text += (text ? "\n\n--- 別のページ ---\n" : "") + t;
      pageUrl ||= page.finalUrl;
      return page;
    } catch (e) { fails.push(`${u}: ${e.message}`); return null; }
  };
  const first = await read(m.exUrl || st.exUrl);
  if (!first || text.length < 1500) {
    const top = await read(m.url);
    if (top && !m.exUrl) {
      const link = findExhibitionLink(top.html, top.finalUrl);
      if (link) { text = ""; pageUrl = ""; const p = await read(link); if (p) st.exUrl = link; else await read(m.url); }
    }
  }
  st.checked = TODAY;
  done.add(m.id);
  if (!text) {
    st.fails = (st.fails || 0) + 1;
    if (m.curated) errors.push({ museumId: m.id, error: "download: " + fails.join(" / ") });
    report.push(`✗ ${m.id} ${m.name}: ${fails.join(" / ")}`);
    results.push(...old);
    continue;
  }
  st.fails = 0;
  text = text.slice(0, 40000);
  if (!KEY) { report.push(`✓ ${m.id} ${pageUrl} (${text.length} chars)${fails.length ? " [" + fails.join(" / ") + "]" : ""}`); continue; }
  if (!hasDates(text)) { st.found = 0; report.push(`· ${m.id} ${m.name}: no dates on the page`); continue; }
  if (aiCalls >= MAX_AI) { done.delete(m.id); delete st.checked; results.push(...old); continue; }
  try {
    aiCalls++;
    const { list, model } = await askGemini(m, text);
    const kept = [], dropped = [];
    for (const e of list) { const r = check(m, e, text, pageUrl); (typeof r === "string" ? dropped : kept).push(typeof r === "string" ? `${e.title} (${r})` : r); }
    const seen = new Set();
    const uniq = kept.filter(e => !seen.has(e.id) && seen.add(e.id));
    st.found = uniq.length;
    results.push(...uniq);
    report.push(`✓ ${m.id} ${m.name} [${model}] kept ${uniq.length}, dropped ${dropped.length}${dropped.length ? ": " + dropped.join(" / ") : ""}`);
  } catch (e) {
    if (/HTTP 429/.test(e.message)) { quotaOut = true; delete st.checked; done.delete(m.id); report.push("… Gemini free quota used up for today, the rest next time"); results.push(...old); break; }
    if (m.curated) errors.push({ museumId: m.id, error: "ai: " + e.message.slice(0, 200) });
    report.push(`✗ ${m.id} AI failed: ${e.message.slice(0, 200)}`);
    results.push(...old);
  }
  await sleep(4500); // stay under the free per-minute limit
}

console.log(report.join("\n"));
if (!KEY) { console.log("\nGEMINI_API_KEY is not set: only checked the pages, nothing written."); process.exit(0); }

// Museums not visited this run keep what they had.
const others = (prev.exhibitions || []).filter(e => !done.has(e.museumId) && (!e.end || e.end >= TODAY));
const all = [...others, ...results].sort((a, b) => (a.end || "9999").localeCompare(b.end || "9999"));
const out = { updatedAt: new Date().toISOString(), today: TODAY, exhibitions: all, errors };
await writeFile(new URL("data/exhibitions-state.json", ROOT), JSON.stringify(state) + "\n");
await writeFile(new URL("data/exhibitions.json", ROOT), JSON.stringify(out) + "\n");
console.log(`\nWrote ${all.length} exhibitions from ${new Set(all.map(e => e.museumId)).size} museums. AI calls: ${aiCalls}.`);
