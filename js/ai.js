// Calls Claude directly from the browser with the user's own API key.
// The key lives only in this device's localStorage.
// Bundled from @anthropic-ai/sdk@0.133.0 (see vendor/).
import Anthropic from "../vendor/anthropic-sdk.js";

export const MODELS = {
  "claude-opus-5-5":   { name: "Claude Opus 5.5（最高精度）", inUsd: 4,    outUsd: 20,  fallback: true },
  "claude-sonnet-5-5": { name: "Claude Sonnet 5.5（バランス）", inUsd: 2,  outUsd: 10,  fallback: true },
  "claude-haiku-5-5":  { name: "Claude Haiku 5.5（最安・初期設定）",     inUsd: 0.1, outUsd: 0.5, fallback: false },
};
export const DEFAULT_MODEL = "claude-haiku-5-5";
export const PRECISE_MODEL = "claude-opus-5-5"; // used for "re-identify with high accuracy"
const WEB_SEARCH_USD = 10 / 1000; // per search
export const USD_JPY = 150;       // rough rate for the cost display

const LS = {
  key: "artscan.apiKey", model: "artscan.model", web: "artscan.webSearch", usage: "artscan.usage",
};
const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} };

export const settings = {
  get apiKey() { return lsGet(LS.key) || ""; },
  set apiKey(v) { lsSet(LS.key, v || null); client = null; },
  get model() { const m = lsGet(LS.model); return MODELS[m] ? m : DEFAULT_MODEL; },
  set model(v) { lsSet(LS.model, v); },
  get webSearch() { return lsGet(LS.web) === "1"; },
  set webSearch(v) { lsSet(LS.web, v ? "1" : "0"); },
};

// ---- usage / cost tracking (per calendar month) ----
function monthKey() { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"); }
export function usage() {
  let u; try { u = JSON.parse(lsGet(LS.usage) || "{}"); } catch { u = {}; }
  const m = monthKey();
  if (u.month !== m) u = { month: m, usd: 0, calls: 0, scans: 0 };
  return u;
}
function record(msg, model, kind) {
  const p = MODELS[model] || MODELS[DEFAULT_MODEL];
  const us = msg?.usage || {};
  const inTok = (us.input_tokens || 0) + (us.cache_creation_input_tokens || 0) * 1.25 + (us.cache_read_input_tokens || 0) * 0.1;
  const searches = us.server_tool_use?.web_search_requests || 0;
  const usd = inTok / 1e6 * p.inUsd + (us.output_tokens || 0) / 1e6 * p.outUsd + searches * WEB_SEARCH_USD;
  const u = usage();
  u.usd += usd; u.calls += 1; if (kind === "scan") u.scans += 1;
  lsSet(LS.usage, JSON.stringify(u));
  return usd;
}

let client = null;
function getClient() {
  if (!settings.apiKey) throw new AiError("no_key", "APIキーが設定されていません。右上の設定から入力してください。");
  if (!client) client = new Anthropic({ apiKey: settings.apiKey, dangerouslyAllowBrowser: true, maxRetries: 2 });
  return client;
}

export class AiError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function friendly(err) {
  if (err instanceof AiError) return err;
  const s = err?.status;
  const raw = String(err?.error?.error?.message || err?.message || "");
  if (s === 401) return new AiError("auth", "APIキーが正しくありません。設定でキーを確認してください。");
  if (s === 403) return new AiError("forbidden", "このAPIキーでは利用できません（権限不足）。");
  if (s === 429) return new AiError("rate", "AIの利用上限に達しました。少し待ってから試してください。");
  if (s === 400 && /credit|balance/i.test(raw)) return new AiError("credit", "APIのクレジット残高が足りません。Anthropic Consoleで残高を確認してください。");
  if (s === 400 && /spend|limit/i.test(raw)) return new AiError("limit", "設定した利用上限額に達しました。Anthropic Consoleで上限を確認してください。");
  if (s === 529 || s >= 500) return new AiError("server", "AIのサーバーが混み合っています。少し待ってから試してください。");
  if (err instanceof Anthropic.APIConnectionError || err?.name === "APIConnectionError")
    return new AiError("network", "インターネットにつながっていないようです。電波の良い場所で試してください。");
  if (err?.name === "APIUserAbortError" || err?.name === "AbortError") return new AiError("aborted", "中止しました。");
  return new AiError("unknown", "AIとの通信でエラーが起きました（" + (raw || s || "不明") + "）。");
}

function baseParams(model, extra) {
  const p = { model, max_tokens: 16000, ...extra };
  if (MODELS[model]?.fallback) {
    // Re-run on another model server-side if a safety classifier declines.
    p.betas = ["server-side-fallback-2026-07-01"];
    p.fallbacks = "default";
  }
  return p;
}

function textOf(msg) {
  return (msg.content || []).filter(b => b.type === "text").map(b => b.text).join("");
}

// Pull the last JSON object out of a free-text answer.
function extractJson(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const src = fence ? fence[1] : text;
  const start = src.indexOf("{");
  const end = src.lastIndexOf("}");
  if (start < 0 || end <= start) throw new AiError("json", "AIの答えを読み取れませんでした。もう一度試してください。");
  try { return JSON.parse(src.slice(start, end + 1)); }
  catch { throw new AiError("json", "AIの答えを読み取れませんでした。もう一度試してください。"); }
}

async function run(params, { onText, signal, kind } = {}) {
  const c = getClient();
  const model = params.model;
  let messages = params.messages;
  let msg;
  try {
    // Web search can pause a long turn; resume it a couple of times.
    for (let round = 0; round < 3; round++) {
      const stream = c.beta.messages.stream({ ...params, messages }, { signal });
      if (onText) {
        let acc = "";
        stream.on("text", d => { acc += d; onText(acc); });
      }
      msg = await stream.finalMessage();
      record(msg, model, round === 0 ? kind : "");
      if (msg.stop_reason !== "pause_turn") break;
      messages = [...messages, { role: "assistant", content: msg.content }];
    }
  } catch (e) { throw friendly(e); }
  if (msg.stop_reason === "refusal") throw new AiError("refusal", "AIがこの画像の処理を断りました。別の写真で試すか、手入力で保存してください。");
  return msg;
}

async function imageBlock(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return { type: "image", source: { type: "base64", media_type: blob.type || "image/jpeg", data: btoa(bin) } };
}

// ---------------- identify ----------------
const WORK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "originalTitle", "artist", "artistReading", "year", "medium", "dimensions", "movement", "museum",
    "description", "artistNote", "lookFor", "labelText", "confidence", "alternatives", "tags"],
  properties: {
    title: { type: "string" },
    originalTitle: { type: "string" },
    artist: { type: "string" },
    artistReading: { type: "string" },
    year: { type: "string" },
    medium: { type: "string" },
    dimensions: { type: "string" },
    movement: { type: "string" },
    museum: { type: "string" },
    description: { type: "string" },
    artistNote: { type: "string" },
    lookFor: { type: "array", items: { type: "string" } },
    labelText: { type: "string" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    alternatives: { type: "array", items: { type: "string" } },
    tags: { type: "array", items: { type: "string" } },
  },
};

const SYSTEM_IDENTIFY = `あなたは経験豊富な美術館の学芸員です。来館者が撮った写真から作品を特定し、日本語で作品カードを作ります。

各項目の書き方：
- title: 日本語の定訳があれば日本語の作品名。原題は originalTitle に（同じなら空文字）。
- artist: 作家名の日本語表記。artistReading: 原語表記（例：Claude Monet）。日本人作家なら読み仮名。
- year / medium / dimensions / movement: わかる範囲で。不明なら空文字。
- museum: 所蔵館。ラベルや撮影場所の情報を優先。
- description: 実物の前で読んで楽しい見どころを3〜5文。
- artistNote: 作家について1〜2文。
- lookFor: 実物で注目してほしい細部を2〜3個、各1文。
- labelText: ラベル写真があれば、その文字を原文のまま改行も保って書き起こす。なければ空文字。
- confidence: 特定の確からしさ。ラベルで確認できたら high、絵柄だけで有名作と一致すれば high か medium、推測なら low。
- alternatives: confidence が high でない時の他の候補「作品名 / 作家」を最大3件。high なら空配列。
- tags: 主題・モチーフ・色などの短いタグを3〜6個。

写真から確認できない情報を事実のように断定しないでください。特定できない作品（現代作家の作品や個人蔵など）でも、見える情報から推定して埋め、confidence を low にしてください。`;

export async function identify({ art, label, museum, place, model }) {
  model = model || settings.model;
  const content = [];
  if (art) content.push(await imageBlock(art));
  if (label) content.push(await imageBlock(label));
  const what = art && label ? "1枚目は作品、2枚目はその作品の解説ラベル（キャプション）の写真です。"
    : art ? "作品の写真です。" : "作品の解説ラベル（キャプション）の写真です。";
  let ctx = "";
  if (museum) ctx += `撮影した場所：${museum}\n`;
  else if (place) ctx += `撮影した場所の近く：${place}\n`;
  const web = settings.webSearch;
  content.push({ type: "text", text: `${what}\n${ctx}この作品の作品カードを作ってください。` +
    (web ? `\n必要ならWeb検索で作品名・所蔵館を確認してください。最後に、次のキーを持つJSONオブジェクトだけを出力してください：${WORK_SCHEMA.required.join(", ")}` : "") });

  const extra = { system: SYSTEM_IDENTIFY, messages: [{ role: "user", content }], output_config: { effort: "medium" } };
  if (web) extra.tools = [{ type: "web_search_20260209", name: "web_search", max_uses: 3 }];
  else extra.output_config.format = { type: "json_schema", schema: WORK_SCHEMA };

  const msg = await run(baseParams(model, extra), { kind: "scan" });
  const text = textOf(msg);
  if (web) return extractJson(text);
  try { return JSON.parse(text); } catch { return extractJson(text); }
}

// ---------------- ask about a work ----------------
export async function ask(work, history, question, { onText, signal } = {}) {
  const ctx = [
    `作品：${work.title}${work.originalTitle ? `（${work.originalTitle}）` : ""}`,
    `作家：${work.artist}${work.artistReading ? `（${work.artistReading}）` : ""}`,
    work.year && `制作年：${work.year}`, work.medium && `技法：${work.medium}`,
    work.movement && `様式：${work.movement}`, work.museum && `所蔵・展示：${work.museum}`,
    work.description && `解説：${work.description}`,
    work.labelText && `ラベルの文字：\n${work.labelText}`,
    work.note && `鑑賞者のメモ：${work.note}`,
  ].filter(Boolean).join("\n");
  const system = `あなたは親切で知識豊富な美術館のガイドです。次の作品を前にした来館者の質問に、日本語で答えてください。普段は3〜6文で簡潔に。確かでないことは推測だと明示してください。Markdownの見出しや表は使わず、普通の文章で答えてください。\n\n${ctx}`;
  const messages = [];
  for (const h of history) messages.push({ role: "user", content: h.q }, { role: "assistant", content: h.a });
  messages.push({ role: "user", content: question });
  const msg = await run(baseParams(settings.model, { system, messages, output_config: { effort: "low" } }), { onText, signal, kind: "ask" });
  return textOf(msg);
}

// ---------------- discover ----------------
const PICKS_SCHEMA = {
  type: "object", additionalProperties: false, required: ["taste", "picks"],
  properties: {
    taste: { type: "string" },
    picks: { type: "array", items: {
      type: "object", additionalProperties: false, required: ["title", "artist", "year", "where", "why"],
      properties: { title: { type: "string" }, artist: { type: "string" }, year: { type: "string" }, where: { type: "string" }, why: { type: "string" } },
    } },
  },
};

export async function recommend(works) {
  const list = works.slice(0, 60).map(w => `- ${w.artist}「${w.title}」${w.year ? `（${w.year}）` : ""}${w.movement ? ` ${w.movement}` : ""}${w.fav ? " ♥" : ""}`).join("\n");
  const prompt = `ある人が美術館で撮影して保存した作品の一覧です（♥はお気に入り）。\n${list}\n\nこの人の好みを日本語で2文で分析し（taste）、一覧にない実在の作品を6点すすめてください（picks）。日本国内の美術館で見られる作品を3点以上含め、where には所蔵館と都市を書いてください。why はこの人の好みと結びつけた1文にしてください。`;
  const msg = await run(baseParams(settings.model, {
    messages: [{ role: "user", content: prompt }],
    output_config: { effort: "low", format: { type: "json_schema", schema: PICKS_SCHEMA } },
  }), { kind: "discover" });
  return JSON.parse(textOf(msg));
}

export async function preview(place) {
  const prompt = `これから「${place}」に行きます。そこで見逃せない作品を最大6点、日本語で教えてください。taste には、その美術館・展覧会の特徴と回り方のコツを2文で。picks の where には館内の展示場所や時期の注意（常設か、展示替えがあるか等）を、わかる範囲で書いてください。確かでないことは「〜の可能性があります」と書いてください。`;
  const msg = await run(baseParams(settings.model, {
    messages: [{ role: "user", content: prompt }],
    output_config: { effort: "low", format: { type: "json_schema", schema: PICKS_SCHEMA } },
  }), { kind: "discover" });
  return JSON.parse(textOf(msg));
}

// Cheap key check: one tiny request.
export async function testKey(key) {
  const c = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true, maxRetries: 0 });
  try {
    await c.models.retrieve("claude-haiku-5-5");
    return true;
  } catch (e) { throw friendly(e); }
}
