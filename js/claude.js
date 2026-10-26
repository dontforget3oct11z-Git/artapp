// Claude (paid, pay-as-you-go) — called directly from the browser with the user's own API key.
// Bundled from @anthropic-ai/sdk@0.133.0 (see vendor/).
import Anthropic from "../vendor/anthropic-sdk.js";
import { AiError, addUsage, parseJson, extractJson, toBase64, WORK_SCHEMA, PICKS_SCHEMA, SYSTEM_IDENTIFY,
  identifyText, askSystem, recommendPrompt, previewPrompt } from "./common.js";

export const MODELS = {
  "claude-haiku-5-5":  { name: "Claude Haiku 5.5（1枚 約0.3円）",   inUsd: 0.1, outUsd: 0.5, fallback: false },
  "claude-sonnet-5-5": { name: "Claude Sonnet 5.5（1枚 約4〜5円）", inUsd: 2,   outUsd: 10,  fallback: true },
  "claude-opus-5-5":   { name: "Claude Opus 5.5（1枚 約8〜10円）",  inUsd: 4,   outUsd: 20,  fallback: true },
};
export const DEFAULT_MODEL = "claude-haiku-5-5";
export const PRECISE_MODEL = "claude-opus-5-5";
const WEB_SEARCH_USD = 10 / 1000; // per search

function cost(msg, model) {
  const p = MODELS[model] || MODELS[DEFAULT_MODEL];
  const us = msg?.usage || {};
  const inTok = (us.input_tokens || 0) + (us.cache_creation_input_tokens || 0) * 1.25 + (us.cache_read_input_tokens || 0) * 0.1;
  const searches = us.server_tool_use?.web_search_requests || 0;
  return inTok / 1e6 * p.inUsd + (us.output_tokens || 0) / 1e6 * p.outUsd + searches * WEB_SEARCH_USD;
}

function friendly(err) {
  if (err instanceof AiError) return err;
  const s = err?.status;
  const raw = String(err?.error?.error?.message || err?.message || "");
  if (s === 401) return new AiError("auth", "Claude APIキーが正しくありません。設定でキーを確認してください。");
  if (s === 403) return new AiError("forbidden", "このAPIキーでは利用できません（権限不足）。");
  if (s === 429) return new AiError("rate", "AIの利用上限に達しました。少し待ってから試してください。");
  if (s === 400 && /credit|balance/i.test(raw)) return new AiError("credit", "APIのクレジット残高が足りません。Anthropic Consoleで残高を確認してください。");
  if (s === 400 && /spend|limit/i.test(raw)) return new AiError("limit", "設定した利用上限額に達しました。Anthropic Consoleで上限を確認してください。");
  if (s === 404) return new AiError("model", "このAPIキーではこのモデルを使えません。設定で別のモデルを選んでください。");
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
const textOf = msg => (msg.content || []).filter(b => b.type === "text").map(b => b.text).join("");

async function run(key, params, { onText, signal, kind } = {}) {
  const c = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true, maxRetries: 2 });
  let messages = params.messages;
  let msg;
  try {
    // Web search can pause a long turn; resume it a couple of times.
    for (let round = 0; round < 3; round++) {
      const stream = c.beta.messages.stream({ ...params, messages }, { signal });
      if (onText) { let acc = ""; stream.on("text", d => { acc += d; onText(acc); }); }
      msg = await stream.finalMessage();
      addUsage({ usd: cost(msg, params.model), kind: round === 0 ? kind : "" });
      if (msg.stop_reason !== "pause_turn") break;
      messages = [...messages, { role: "assistant", content: msg.content }];
    }
  } catch (e) { throw friendly(e); }
  if (msg.stop_reason === "refusal") throw new AiError("refusal", "AIがこの画像の処理を断りました。別の写真で試すか、手入力で保存してください。");
  return msg;
}

const imageBlock = async blob => ({ type: "image", source: { type: "base64", media_type: blob.type || "image/jpeg", data: await toBase64(blob) } });

export async function identify({ key, model, webSearch, art, label, museum, place }) {
  const content = [];
  if (art) content.push(await imageBlock(art));
  if (label) content.push(await imageBlock(label));
  content.push({ type: "text", text: identifyText({ hasArt: !!art, hasLabel: !!label, museum, place }) +
    (webSearch ? `\n必要ならWeb検索で作品名・所蔵館を確認してください。最後に、次のキーを持つJSONオブジェクトだけを出力してください：${WORK_SCHEMA.required.join(", ")}` : "") });
  const extra = { system: SYSTEM_IDENTIFY, messages: [{ role: "user", content }], output_config: { effort: "medium" } };
  if (webSearch) extra.tools = [{ type: "web_search_20260209", name: "web_search", max_uses: 3 }];
  else extra.output_config.format = { type: "json_schema", schema: WORK_SCHEMA };
  const msg = await run(key, baseParams(model, extra), { kind: "scan" });
  return webSearch ? extractJson(textOf(msg)) : parseJson(textOf(msg));
}

export async function ask({ key, model }, work, history, question, { onText, signal } = {}) {
  const messages = [];
  for (const h of history) messages.push({ role: "user", content: h.q }, { role: "assistant", content: h.a });
  messages.push({ role: "user", content: question });
  const msg = await run(key, baseParams(model, { system: askSystem(work), messages, output_config: { effort: "low" } }), { onText, signal, kind: "ask" });
  return textOf(msg);
}

async function picks(key, model, prompt) {
  const msg = await run(key, baseParams(model, {
    messages: [{ role: "user", content: prompt }],
    output_config: { effort: "low", format: { type: "json_schema", schema: PICKS_SCHEMA } },
  }), { kind: "discover" });
  return parseJson(textOf(msg));
}
export const recommend = ({ key, model }, works) => picks(key, model, recommendPrompt(works));
export const preview = ({ key, model }, place) => picks(key, model, previewPrompt(place));

// Free check: reading a model's info costs nothing.
export async function testKey(key) {
  const c = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true, maxRetries: 0 });
  try { await c.models.retrieve("claude-haiku-5-5"); return true; }
  catch (e) { throw friendly(e); }
}
