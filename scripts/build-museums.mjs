// Builds data/museums-wikidata.json: art museums in Japan and major art museums worldwide,
// from Wikidata (free, CC0). Runs on GitHub Actions (.github/workflows/museums.yml).
// The hand-made list in data/museums.json (with exhibition pages) stays as is; museums already
// in it are left out here.
import { readFile, writeFile } from "node:fs/promises";

const ROOT = new URL("../", import.meta.url);
const UA = "ArtMuseBot/1.0 (personal museum map; https://github.com/dontforget3oct11z-Git/artapp)";
const WORLD_MIN_SITELINKS = Number(process.env.WORLD_MIN_SITELINKS || 18);

async function sparql(q) {
  for (let i = 0; i < 3; i++) {
    const res = await fetch("https://query.wikidata.org/sparql", {
      method: "POST",
      headers: { "User-Agent": UA, "Accept": "application/sparql-results+json", "Content-Type": "application/x-www-form-urlencoded" },
      body: "query=" + encodeURIComponent(q),
    });
    if (res.ok) return (await res.json()).results.bindings;
    console.log(`SPARQL HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    await new Promise(r => setTimeout(r, 20000));
  }
  throw new Error("SPARQL failed");
}

const point = s => { const m = /Point\(([-\d.]+) ([-\d.]+)\)/.exec(s || ""); return m ? { lng: +(+m[1]).toFixed(5), lat: +(+m[2]).toFixed(5) } : null; };
const v = (b, k) => b[k]?.value || "";
const qid = u => u.split("/").pop();

// Art museums (and subclasses) in Japan, with the prefecture.
const JAPAN = `
SELECT ?m ?mLabel ?en ?coord ?prefLabel ?cityLabel ?site ?sl WHERE {
  {
    ?m wdt:P31/wdt:P279* wd:Q207694 ; wdt:P17 wd:Q17 ; wdt:P625 ?coord .
  } UNION {
    # many Japanese art museums are only tagged as "museum": also take items named 〜美術館
    ?m wdt:P17 wd:Q17 ; wdt:P625 ?coord ; rdfs:label ?ja .
    FILTER(LANG(?ja) = "ja" && CONTAINS(?ja, "美術館"))
    ?m wdt:P31 ?t . FILTER(?t NOT IN (wd:Q4167410, wd:Q13406463))
  }
  FILTER NOT EXISTS { ?m wdt:P576 [] }
  FILTER NOT EXISTS { ?m wdt:P3999 [] }
  OPTIONAL { ?m wdt:P131* ?pref . ?pref wdt:P31 wd:Q50337 . }
  OPTIONAL { ?m wdt:P131 ?city . }
  OPTIONAL { ?m wdt:P856 ?site . }
  OPTIONAL { ?m rdfs:label ?en FILTER(LANG(?en) = "en") }
  ?m wikibase:sitelinks ?sl .
  SERVICE wikibase:label { bd:serviceParam wikibase:language "ja,en". }
}`;

// Well-known art museums elsewhere (many Wikipedia language versions = well known).
const WORLD = `
SELECT ?m ?mLabel ?en ?coord ?countryLabel ?cc ?cityLabel ?site ?sl WHERE {
  ?m wdt:P31/wdt:P279* wd:Q207694 ; wdt:P625 ?coord ; wikibase:sitelinks ?sl .
  FILTER(?sl >= ${WORLD_MIN_SITELINKS})
  FILTER NOT EXISTS { ?m wdt:P17 wd:Q17 }
  FILTER NOT EXISTS { ?m wdt:P576 [] }
  OPTIONAL { ?m wdt:P17 ?country . OPTIONAL { ?country wdt:P297 ?cc . } }
  OPTIONAL { ?m wdt:P131 ?city . }
  OPTIONAL { ?m wdt:P856 ?site . }
  OPTIONAL { ?m rdfs:label ?en FILTER(LANG(?en) = "en") }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "ja,en". }
}`;

function collect(rows, extra) {
  const byId = new Map();
  for (const b of rows) {
    const id = qid(v(b, "m"));
    const p = point(v(b, "coord"));
    if (!p) continue;
    const name = v(b, "mLabel");
    if (!name || /^Q\d+$/.test(name)) continue;
    const cur = byId.get(id);
    if (cur) { if (!cur.url && v(b, "site")) cur.url = v(b, "site"); if (!cur.pref && v(b, "prefLabel")) cur.pref = v(b, "prefLabel"); continue; }
    byId.set(id, {
      id: "wd-" + id, qid: id, name, en: v(b, "en") !== name ? v(b, "en") : "",
      ...extra(b), city: /^Q\d+$/.test(v(b, "cityLabel")) ? "" : v(b, "cityLabel"),
      lat: p.lat, lng: p.lng, url: v(b, "site"), rank: +v(b, "sl") || 0,
    });
  }
  return [...byId.values()];
}

const norm = s => String(s || "").normalize("NFKC").toLowerCase().replace(/[\s・･「」『』()（）\-_.,]/g, "");
function distM(a, b) {
  const R = 6371e3, r = x => x * Math.PI / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const { museums: curated } = JSON.parse(await readFile(new URL("data/museums.json", ROOT), "utf8"));
const jp = collect(await sparql(JAPAN), b => ({ country: "日本", cc: "JP", pref: v(b, "prefLabel") }));
console.log("Japan rows:", jp.length);
const world = collect(await sparql(WORLD), b => ({ country: /^Q\d+$/.test(v(b, "countryLabel")) ? "" : v(b, "countryLabel"), cc: v(b, "cc"), pref: "" }));
console.log("World rows:", world.length);

// Leave out museums already in the hand-made list (same name, or within 200 m with a similar name).
const dup = m => curated.some(c => norm(c.name) === norm(m.name) || [c.name, ...(c.aliases || [])].some(n => norm(m.name).includes(norm(n)) && distM(c, m) < 2000) || distM(c, m) < 120);
const all = [...jp, ...world].filter(m => !dup(m));
all.sort((a, b) => (a.cc === "JP" ? 0 : 1) - (b.cc === "JP" ? 0 : 1) || b.rank - a.rank);
const out = { source: "Wikidata (CC0)", updatedAt: new Date().toISOString().slice(0, 10), museums: all };
await writeFile(new URL("data/museums-wikidata.json", ROOT), JSON.stringify(out) + "\n");
console.log(`Wrote ${all.length} museums (Japan ${all.filter(m => m.cc === "JP").length}, world ${all.filter(m => m.cc !== "JP").length}).`);
console.log("Japan without prefecture:", all.filter(m => m.cc === "JP" && !m.pref).length);
console.log("Sample:", JSON.stringify(all.slice(0, 3)), JSON.stringify(all.filter(m => m.cc !== "JP").slice(0, 5).map(m => m.name + "/" + m.country)));
