// Developer check: runs the app's own Gemini identify on a few public-domain artwork photos
// and prints what comes back (Actions → "AI読み取りテスト"). Needs the GEMINI_API_KEY secret.
import * as gemini from "../js/gemini.js";

const key = process.env.GEMINI_API_KEY;
if (!key) { console.log("GEMINI_API_KEY がありません"); process.exit(1); }
const UA = "ArtMuseBot/1.0 (test; https://github.com/dontforget3oct11z-Git/artapp)";
const IMAGES = [
  ["painting", "https://upload.wikimedia.org/wikipedia/commons/thumb/e/ea/Van_Gogh_-_Starry_Night_-_Google_Art_Project.jpg/1280px-Van_Gogh_-_Starry_Night_-_Google_Art_Project.jpg"],
  ["sculpture", "wiki:The_Thinker"],
  ["sculpture2", "wiki:Venus_de_Milo"],
  ["japanese", "https://upload.wikimedia.org/wikipedia/commons/thumb/a/a5/Tsunami_by_hokusai_19th_century.jpg/1280px-Tsunami_by_hokusai_19th_century.jpg"],
];

// log every raw answer, so a failure shows what the AI actually sent
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const res = await realFetch(url, opts);
  if (String(url).includes("generativelanguage")) {
    const txt = await res.clone().text();
    let j = null; try { j = JSON.parse(txt); } catch {}
    const c = j?.candidates?.[0];
    console.log(`  HTTP ${res.status} model=${String(url).split("/models/")[1]?.split(":")[0]} finish=${c?.finishReason} usage=${JSON.stringify(j?.usageMetadata || {})}`);
    const text = (c?.content?.parts || []).filter(p => !p.thought).map(p => p.text || "").join("");
    console.log("  text:", (text || txt).slice(0, 700).replace(/\n/g, " "));
  }
  return res;
};

const models = (process.env.MODELS || "gemini-3.8-flash gemini-3.5-flash-lite").split(/\s+/).filter(Boolean);
for (let [name, url] of IMAGES) {
  console.log("download", name);
  if (url.startsWith("wiki:")) url = (await (await realFetch("https://en.wikipedia.org/api/rest_v1/page/summary/" + url.slice(5), { headers: { "User-Agent": UA } })).json()).thumbnail?.source?.replace(/\/\d+px-/, "/960px-") || ""; const r = await realFetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(30000) }).catch(e => ({ ok: false, status: e.name }));
  if (!r.ok) { console.log(name, "download HTTP", r.status); continue; }
  const blob = new Blob([await r.arrayBuffer()], { type: "image/jpeg" });
  for (const model of models) for (const unknown of [false, true]) {
    console.log(`\n=== ${name} / ${model} / unknown=${unknown} (${(blob.size / 1024) | 0}KB)`);
    const t = Date.now();
    try {
      const out = await gemini.identify({ key, model, art: blob, unknown, museum: "" });
      console.log(`  OK ${(Date.now() - t) / 1000}s: ${out.title} / ${out.artist} / ${out.confidence} tags=${JSON.stringify(out.tags)}`);
    } catch (e) { console.log(`  ERROR ${(Date.now() - t) / 1000}s: code=${e.code} ${e.message}`); }
    await new Promise(r => setTimeout(r, 7000));
  }
}
