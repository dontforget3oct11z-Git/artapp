// Developer check: reads a few real exhibition pages with the app's own URL reader
// (Actions → "AI読み取りテスト" with mode "url"). Needs the GEMINI_API_KEY secret.
import * as gemini from "../js/gemini.js";

const key = process.env.GEMINI_API_KEY;
if (!key) { console.log("GEMINI_API_KEY がありません"); process.exit(1); }
const PAGES = [
  ["https://www.kyuhaku.jp/exhibition/exhibition_t08.html", "滋味延年"],
  ["https://mmat.jp/en/exhibition/archive/2026/20261010-483.html", ""],
  ["https://singaporeartmuseum.sg/Art-Events/Exhibitions/Maria-Taniguchi-Afterimage", "Maria Taniguchi"],
];
const models = (process.env.MODELS || "gemini-3.5-flash-lite").split(/\s+/).filter(Boolean);
let ok = 0, n = 0;
for (const model of models) for (const [url, hint] of PAGES) {
  n++; const t = Date.now();
  try {
    const r = await gemini.extractEventFromUrl({ key, model }, { url, hint, todayStr: "2026-10-27" });
    console.log(`${model} ${url}\n  ${((Date.now() - t) / 1000).toFixed(1)}s`, JSON.stringify(r));
    if (r.found && r.title) ok++;
  } catch (e) { console.log(`${model} ${url}\n  ERROR ${e.code}: ${e.message}`); }
}
console.log(`読み取れた: ${ok}/${n}`);
