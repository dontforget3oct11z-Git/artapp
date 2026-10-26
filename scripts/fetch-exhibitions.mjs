// Collects current and upcoming exhibitions from each museum's official exhibition page
// and writes data/exhibitions.json. Runs every day on GitHub Actions (.github/workflows/exhibitions.yml).
//
// Steps for each museum in data/museums.json:
//   1. Download its exhibition page (exUrl) and turn the HTML into plain text, keeping link URLs.
//   2. Ask Gemini (free tier) to list the exhibitions written on that page as JSON.
//   3. Keep only exhibitions whose title really appears in the page text and whose dates make sense.
//      This drops anything the AI made up.
// Without GEMINI_API_KEY it only checks that each page can be downloaded.
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
  return `今日は${TODAY}です。次は「${m.name}」（${m.pref}${m.city}）の公式サイトの展覧会ページから取り出した文章です。［リンク URL ］はリンク先です。

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
  for (const d of [start, end].filter(Boolean)) {
    const [, mo, da] = d.split("-").map(Number);
    const re = new RegExp(`(^|\\D)0?${mo}\\s*[月/.．／]\\s*0?${da}(\\D|$)`);
    if (!re.test(pageText.normalize("NFKC"))) return "date not on page: " + d;
  }
  let url = "";
  try { if (e.url) { const u = new URL(e.url, pageUrl); if (/^https?:$/.test(u.protocol)) url = u.href; } } catch {}
  if (url && !pageText.includes(url)) url = ""; // only links that were on the page
  return {
    id: m.id + "-" + createHash("sha1").update(nt).digest("hex").slice(0, 10),
    museumId: m.id, title, start, end,
    url: url || m.exUrl, kind: ["special", "collection", "other"].includes(e.kind) ? e.kind : "other",
    summary: String(e.summary || "").trim().slice(0, 300), venue: String(e.venue || "").trim().slice(0, 80),
    source: pageUrl,
  };
}
function addDays(d, n) { const t = new Date(d + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); }

// ---------- main ----------
const { museums } = JSON.parse(await readFile(new URL("data/museums.json", ROOT), "utf8"));
let prev = { exhibitions: [] };
try { prev = JSON.parse(await readFile(new URL("data/exhibitions.json", ROOT), "utf8")); } catch {}

const results = [], errors = [], report = [];
for (const m of museums) {
  if (ONLY.length && !ONLY.includes(m.id)) continue;
  const old = (prev.exhibitions || []).filter(e => e.museumId === m.id && (!e.end || e.end >= TODAY));
  // The exhibition page first; the top page too when that fails or has little text.
  let text = "", pageUrl = "", fails = [];
  for (const u of [...new Set([m.exUrl, m.url].filter(Boolean))]) {
    if (text.length >= 1500) break;
    try {
      const page = await download(u);
      const t = htmlToText(page.html, page.finalUrl);
      if (DEBUG) { await mkdir(new URL("debug/", ROOT), { recursive: true }); await writeFile(new URL(`debug/${m.id}-${u === m.exUrl ? "ex" : "top"}.html`, ROOT), page.html); await writeFile(new URL(`debug/${m.id}-${u === m.exUrl ? "ex" : "top"}.txt`, ROOT), t); }
      text += (text ? "\n\n--- 別のページ ---\n" : "") + t;
      pageUrl ||= page.finalUrl;
    } catch (e) { fails.push(`${u}: ${e.message}`); }
  }
  if (!text) {
    errors.push({ museumId: m.id, error: "download: " + fails.join(" / ") });
    report.push(`✗ ${m.id} download failed: ${fails.join(" / ")}`);
    results.push(...old); // keep what we had
    continue;
  }
  text = text.slice(0, 40000);
  const page = { finalUrl: pageUrl };
  if (!KEY) { report.push(`✓ ${m.id} ${page.finalUrl} (${text.length} chars)${fails.length ? " [failed: " + fails.join(" / ") + "]" : ""}`); continue; }
  try {
    const { list, model } = await askGemini(m, text);
    const kept = [], dropped = [];
    for (const e of list) { const r = check(m, e, text, page.finalUrl); (typeof r === "string" ? dropped : kept).push(typeof r === "string" ? `${e.title} (${r})` : r); }
    const seen = new Set();
    const uniq = kept.filter(e => !seen.has(e.id) && seen.add(e.id));
    results.push(...uniq);
    report.push(`✓ ${m.id} [${model}] kept ${uniq.length}, dropped ${dropped.length}${dropped.length ? ": " + dropped.join(" / ") : ""}`);
    if (!list.length && text.length < 1500) errors.push({ museumId: m.id, error: "page text is very short (maybe built by JavaScript)" });
  } catch (e) {
    errors.push({ museumId: m.id, error: "ai: " + e.message.slice(0, 200) });
    report.push(`✗ ${m.id} AI failed: ${e.message.slice(0, 200)}`);
    results.push(...old);
  }
  await sleep(4500); // stay under the free per-minute limit
}

console.log(report.join("\n"));
if (!KEY) { console.log("\nGEMINI_API_KEY is not set: only checked the pages, nothing written."); process.exit(0); }

// Keep museums that were not part of this run (when run for a few ids only).
const others = ONLY.length ? (prev.exhibitions || []).filter(e => !ONLY.includes(e.museumId)) : [];
const all = [...others, ...results].sort((a, b) => (a.end || "9999").localeCompare(b.end || "9999"));
const out = { updatedAt: new Date().toISOString(), today: TODAY, exhibitions: all, errors };
const same = JSON.stringify({ ...prev, updatedAt: 0, today: 0 }) === JSON.stringify({ ...out, updatedAt: 0, today: 0 });
if (same) { console.log("\nNo changes."); process.exit(0); }
await writeFile(new URL("data/exhibitions.json", ROOT), JSON.stringify(out, null, 1) + "\n");
console.log(`\nWrote ${all.length} exhibitions (${errors.length} museums with errors).`);
