// Checks what the AI said against Wikidata / Wikipedia (free, no key needed).
// The AI only proposes "which work this is"; dates, owner and size come from Wikidata when found.

const WD = "https://www.wikidata.org/w/api.php";
const UNITS = { Q174728: "cm", Q11573: "m", Q174789: "mm", Q218593: "in" };

async function getJson(url, signal) {
  const r = await fetch(url, { signal, headers: { "Api-User-Agent": "ArtScan-PWA/1.0 (personal use)" } });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}
const wd = (params, signal) => getJson(WD + "?" + new URLSearchParams({ format: "json", origin: "*", ...params }), signal);

// Full-text search on Wikidata, with a structured filter such as haswbstatement:P31=Q5.
async function search(text, filter, signal, limit = 5) {
  const j = await wd({ action: "query", list: "search", srsearch: `${text} ${filter}`.trim(), srlimit: String(limit), srnamespace: "0" }, signal);
  return (j?.query?.search || []).map(x => x.title).filter(t => /^Q\d+$/.test(t));
}

async function entities(ids, props, signal) {
  if (!ids.length) return {};
  const j = await wd({ action: "wbgetentities", ids: ids.slice(0, 50).join("|"), props, languages: "ja|en" }, signal);
  return j?.entities || {};
}

const label = e => e?.labels?.ja?.value || e?.labels?.en?.value || "";
const claimValues = (e, p) => (e?.claims?.[p] || []).filter(c => c?.mainsnak?.snaktype === "value" && c.rank !== "deprecated").map(c => c.mainsnak.datavalue?.value);
const itemIds = (e, p) => claimValues(e, p).map(v => v?.id).filter(Boolean);

function yearOf(e) {
  const v = claimValues(e, "P571")[0];
  const m = String(v?.time || "").match(/^([+-])(\d+)-/);
  if (!m) return "";
  const y = parseInt(m[2], 10);
  if (m[1] === "-") return `紀元前${y}年`;
  if ((v.precision ?? 9) <= 7) return `${Math.floor((y - 1) / 100) + 1}世紀`; // century precision
  if (v.precision === 8) return `${y}年代`;                                     // decade precision
  return `${y}年`;
}
function sizeOf(e) {
  const toCm = v => {
    const n = parseFloat(v?.amount);
    const f = { cm: 1, mm: 0.1, m: 100, in: 2.54 }[UNITS[String(v?.unit || "").split("/").pop()]];
    return Number.isFinite(n) && f ? Math.round(n * f * 10) / 10 : null;
  };
  const h = toCm(claimValues(e, "P2048")[0]), w = toCm(claimValues(e, "P2049")[0]);
  return h && w ? `${h} × ${w} cm` : "";
}

async function wikiSummary(lang, title, signal) {
  try {
    const j = await getJson(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, "_"))}`, signal);
    if (j?.type === "disambiguation") return null;
    return { lang, title: j.title || title, extract: j.extract || "", url: j?.content_urls?.mobile?.page || j?.content_urls?.desktop?.page || `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title)}` };
  } catch { return null; }
}

const norm = s => String(s || "").toLowerCase().normalize("NFKC").replace(/[\s・･.\-‐－,，、「」『』（）()"'’]/g, "");

/**
 * Look the work up. Returns null when nothing trustworthy is found.
 * { qid, title, titleEn, artist, year, collection, dimensions, materials, wiki: {lang,title,extract,url}|null, wikidataUrl }
 */
export async function verify({ title, originalTitle, artist, artistReading }, { timeoutMs = 9000 } = {}) {
  const names = [artistReading, artist].filter(Boolean);
  const titles = [title, originalTitle].filter(Boolean);
  if (!names.length || !titles.length) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const signal = ctl.signal;
  try {
    // 1) the artist: a human (P31=Q5) matching the name
    let artists = [];
    for (const n of names) {
      artists = await search(n, "haswbstatement:P31=Q5", signal, 3);
      if (artists.length) break;
    }
    if (!artists.length) return null;

    // 2) a work whose creator (P170) is that artist and whose title matches
    let workId = null, byArtist = null;
    outer: for (const a of artists.slice(0, 2)) {
      for (const t of titles) {
        const hits = await search(t, `haswbstatement:P170=${a}`, signal, 3);
        if (hits.length) { workId = hits[0]; byArtist = a; break outer; }
      }
    }
    if (!workId) return null;

    // 3) details
    const ents = await entities([workId], "labels|claims|sitelinks", signal);
    const e = ents[workId];
    if (!e || !itemIds(e, "P170").includes(byArtist)) return null;

    // Make sure the title really matches one of the work's labels (search can be fuzzy).
    const labels = [e.labels?.ja?.value, e.labels?.en?.value].filter(Boolean).map(norm);
    const wanted = titles.map(norm);
    const titleOk = labels.some(l => wanted.some(w => l && w && (l.includes(w) || w.includes(l))));
    if (!titleOk) return null;

    const refIds = [...itemIds(e, "P195"), ...itemIds(e, "P186"), byArtist];
    const refs = await entities([...new Set(refIds)], "labels", signal);
    const collection = itemIds(e, "P195").map(id => label(refs[id])).filter(Boolean)[0] || "";
    const materials = itemIds(e, "P186").map(id => label(refs[id])).filter(Boolean).slice(0, 3).join("、");

    const sl = e.sitelinks || {};
    const wiki = (sl.jawiki && await wikiSummary("ja", sl.jawiki.title, signal)) || (sl.enwiki && await wikiSummary("en", sl.enwiki.title, signal)) || null;

    return {
      qid: workId,
      title: e.labels?.ja?.value || "",
      titleEn: e.labels?.en?.value || "",
      artist: label(refs[byArtist]),
      year: yearOf(e),
      collection,
      dimensions: sizeOf(e),
      materials,
      wiki,
      wikidataUrl: `https://www.wikidata.org/wiki/${workId}`,
    };
  } catch {
    return null; // offline, blocked or timed out: just leave it unverified
  } finally { clearTimeout(timer); }
}

/**
 * Merge AI result with what Wikidata says. Each field gets a source:
 * "label" (read from the wall label / given location), "wiki" (confirmed), "ai" (AI's guess, unconfirmed).
 */
export function merge(r, v) {
  const basis = r.basis || {};
  const src = {};
  const out = { ...r };
  const fromLabel = k => basis[k] === "label" && out[k];
  for (const k of ["title", "artist", "year", "medium", "dimensions", "museum"]) {
    if (fromLabel(k)) src[k] = "label";
    else if (out[k]) src[k] = "ai";
  }
  if (v) {
    if (!fromLabel("title")) { if (v.title) out.title = v.title; src.title = "wiki"; if (!out.originalTitle && v.titleEn && v.titleEn !== out.title) out.originalTitle = v.titleEn; }
    if (!fromLabel("artist")) src.artist = "wiki";
    if (!fromLabel("year")) { if (v.year) { out.year = v.year; src.year = "wiki"; } }
    if (!fromLabel("dimensions")) { if (v.dimensions) { out.dimensions = v.dimensions; src.dimensions = "wiki"; } }
    if (!fromLabel("medium") && !out.medium && v.materials) { out.medium = v.materials; src.medium = "wiki"; }
    if (!out.museum && v.collection) { out.museum = v.collection; src.museum = "wiki"; }
    if (out.museum && v.collection && src.museum === "ai" && norm(out.museum) === norm(v.collection)) src.museum = "wiki";
    out.collection = v.collection || "";
    out.wiki = v.wiki ? { ...v.wiki } : null;
    out.wikidataUrl = v.wikidataUrl;
    out.verified = true;
    const labelBacked = src.title === "label" || src.artist === "label";
    out.confidence = labelBacked ? "high" : (out.confidence === "low" ? "medium" : out.confidence || "medium");
  } else {
    out.verified = false;
    const labelBacked = src.title === "label" && src.artist === "label";
    if (!labelBacked && out.confidence === "high") out.confidence = "medium";
  }
  out.src = src;
  delete out.basis;
  return out;
}
