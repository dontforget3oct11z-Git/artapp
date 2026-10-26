// Chooses which AI to use (free Gemini or paid Claude) and keeps the settings.
import * as gemini from "./gemini.js";
import * as claude from "./claude.js";
import { lsGet, lsSet, usage, USD_JPY, AiError } from "./common.js";

export { usage, USD_JPY, AiError };

export const PROVIDERS = {
  gemini: { label: "Gemini（無料）", impl: gemini, keyUrl: "https://aistudio.google.com/apikey", keyHint: "AIza… で始まる文字列" },
  claude: { label: "Claude（有料・従量課金）", impl: claude, keyUrl: "https://console.anthropic.com/settings/keys", keyHint: "sk-ant-… で始まる文字列" },
};

// Keys saved before Gemini support belonged to Claude.
{ const old = lsGet("artscan.apiKey"); if (old && !lsGet("artscan.key.claude")) { lsSet("artscan.key.claude", old); lsSet("artscan.apiKey", null); } }

export const settings = {
  get provider() { const p = lsGet("artscan.provider"); return PROVIDERS[p] ? p : "gemini"; },
  set provider(v) { lsSet("artscan.provider", v); },
  keyFor(p) { return lsGet("artscan.key." + p) || ""; },
  setKey(p, v) { lsSet("artscan.key." + p, v || null); },
  modelFor(p) { const m = lsGet("artscan.model." + p); return PROVIDERS[p].impl.MODELS[m] ? m : PROVIDERS[p].impl.DEFAULT_MODEL; },
  setModel(p, v) { lsSet("artscan.model." + p, v); },
  get webSearch() { return lsGet("artscan.webSearch") === "1"; },
  set webSearch(v) { lsSet("artscan.webSearch", v ? "1" : "0"); },
  get apiKey() { return this.keyFor(this.provider); },
};

function current() {
  const p = settings.provider;
  const key = settings.keyFor(p);
  if (!key) throw new AiError("no_key", "APIキーが設定されていません。右上の設定から入力してください。");
  return { p, impl: PROVIDERS[p].impl, key, model: settings.modelFor(p) };
}

export const isFree = () => settings.provider === "gemini";

export async function identify({ art, label, museum, place, unknown }) {
  const c = current();
  const data = await c.impl.identify({ key: c.key, model: c.model, webSearch: c.p === "claude" && settings.webSearch, art, label, museum, place, unknown });
  return { data, provider: c.p, model: c.model };
}

// "High accuracy" re-check: Claude Opus. Needs a Claude key; costs about 10 yen.
export const canEscalate = (provider, model) => !!settings.keyFor("claude") && !(provider === "claude" && model === claude.PRECISE_MODEL);
export async function identifyPrecise({ art, label, museum, place }) {
  const key = settings.keyFor("claude");
  if (!key) throw new AiError("no_key", "高精度モードにはClaudeのAPIキーが必要です。");
  const data = await claude.identify({ key, model: claude.PRECISE_MODEL, webSearch: settings.webSearch, art, label, museum, place });
  return { data, provider: "claude", model: claude.PRECISE_MODEL };
}

export function ask(work, history, question, opts) { const c = current(); return c.impl.ask({ key: c.key, model: c.model }, work, history, question, opts); }
export function recommend(works) { const c = current(); return c.impl.recommend({ key: c.key, model: c.model }, works); }
export function preview(place) { const c = current(); return c.impl.preview({ key: c.key, model: c.model }, place); }
export function extractEvent(args) { const c = current(); return c.impl.extractEvent({ key: c.key, model: c.model }, args); }
export function testKey(provider, key) { return PROVIDERS[provider].impl.testKey(key); }
