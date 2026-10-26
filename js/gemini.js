// Gemini API (free tier) — called directly from the browser with the user's own free API key.
// Uses the generateContent REST endpoint.
import { AiError, addUsage, parseJson, toBase64, WORK_SCHEMA, PICKS_SCHEMA, SYSTEM_IDENTIFY,
  identifyText, askSystem, recommendPrompt, previewPrompt, EVENT_SCHEMA, eventPrompt } from "./common.js";

const BASE = "https://generativelanguage.googleapis.com/v1beta";

export const MODELS = {
  "gemini-3.8-flash":      { name: "Gemini 3.8 Flash（無料・高精度）" },
  "gemini-3.5-flash-lite": { name: "Gemini 3.5 Flash-Lite（無料・軽量）" },
};
export const DEFAULT_MODEL = "gemini-3.8-flash";
// When the free daily quota of the main model runs out, try the lighter one.
const BACKUP_MODEL = "gemini-3.5-flash-lite";

// Paintings often include nudes or violent scenes; only block clearly harmful output.
const SAFETY = ["HARM_CATEGORY_HARASSMENT", "HARM_CATEGORY_HATE_SPEECH", "HARM_CATEGORY_SEXUALLY_EXPLICIT", "HARM_CATEGORY_DANGEROUS_CONTENT"]
  .map(category => ({ category, threshold: "BLOCK_ONLY_HIGH" }));

// JSON Schema -> Gemini's OpenAPI-style schema (uppercase types, no additionalProperties).
function toGeminiSchema(s) {
  const out = { type: s.type.toUpperCase() };
  if (s.enum) out.enum = s.enum;
  if (s.items) out.items = toGeminiSchema(s.items);
  if (s.properties) {
    out.properties = {};
    for (const [k, v] of Object.entries(s.properties)) out.properties[k] = toGeminiSchema(v);
    out.propertyOrdering = Object.keys(s.properties);
  }
  if (s.required) out.required = s.required;
  return out;
}

function quotaReset() {
  // Free-tier daily quota resets at midnight Pacific time (16:00 or 17:00 in Japan).
  return "日本時間の夕方（16〜17時ごろ）";
}

async function errorFrom(res) {
  let j = null; try { j = await res.json(); } catch {}
  const msg = String(j?.error?.message || "");
  const st = String(j?.error?.status || "");
  const s = res.status;
  if (s === 400 && /API key|API_KEY/i.test(msg + st)) return new AiError("auth", "Gemini APIキーが正しくありません。設定でキーを確認してください。");
  if (s === 400 && /location|region|country/i.test(msg)) return new AiError("region", "この地域ではGemini APIの無料枠を使えません。");
  if (s === 403) return new AiError("forbidden", "このGemini APIキーでは利用できません。Google AI Studioでキーを確認してください。");
  if (s === 404) return new AiError("model", "このモデルは今使えません。設定で別のGeminiモデルを選んでください。");
  if (s === 429) return new AiError("rate", `Geminiの無料枠の上限に達しました。少し待つか、${quotaReset()}のリセット後に試してください。`);
  if (s >= 500) return new AiError("server", "AIのサーバーが混み合っています。少し待ってから試してください。");
  return new AiError("unknown", "AIとの通信でエラーが起きました（" + (msg || s) + "）。");
}

function checkBlocked(data) {
  const block = data?.promptFeedback?.blockReason;
  const fin = data?.candidates?.[0]?.finishReason;
  if (block || ["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "IMAGE_SAFETY"].includes(fin))
    throw new AiError("refusal", "AIがこの画像の処理を断りました。別の写真で試すか、手入力で保存してください。");
}
const textOf = data => (data?.candidates?.[0]?.content?.parts || []).filter(p => typeof p.text === "string" && !p.thought).map(p => p.text).join("");

async function call(key, model, body, { kind, signal } = {}) {
  let res;
  try {
    res = await fetch(`${BASE}/models/${model}:generateContent`, {
      method: "POST", signal,
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(body),
    });
  } catch (e) {
    if (e?.name === "AbortError") throw new AiError("aborted", "中止しました。");
    throw new AiError("network", "インターネットにつながっていないようです。電波の良い場所で試してください。");
  }
  if (!res.ok) throw await errorFrom(res);
  const data = await res.json();
  addUsage({ kind, free: true });
  checkBlocked(data);
  return data;
}

// Try the chosen model; if its free quota is used up, fall back to the lighter one once.
async function callWithBackup(key, model, body, opts) {
  try { return { data: await call(key, model, body, opts), model }; }
  catch (e) {
    if (e.code === "rate" && model !== BACKUP_MODEL) return { data: await call(key, BACKUP_MODEL, body, opts), model: BACKUP_MODEL };
    throw e;
  }
}

const imagePart = async blob => ({ inlineData: { mimeType: blob.type || "image/jpeg", data: await toBase64(blob) } });

export async function identify({ key, model, art, label, museum, place, unknown }) {
  const parts = [];
  if (art) parts.push(await imagePart(art));
  if (label) parts.push(await imagePart(label));
  parts.push({ text: identifyText({ hasArt: !!art, hasLabel: !!label, museum, place, unknown }) });
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_IDENTIFY }] },
    contents: [{ role: "user", parts }],
    safetySettings: SAFETY,
    generationConfig: { responseMimeType: "application/json", responseSchema: toGeminiSchema(WORK_SCHEMA) },
  };
  const { data, model: used } = await callWithBackup(key, model, body, { kind: "scan" });
  const out = parseJson(textOf(data));
  if (used !== model) out._note = "無料枠の都合で、軽量モデルで識別しました。";
  return out;
}

// Streams the answer as it is written.
export async function ask({ key, model }, work, history, question, { onText, signal } = {}) {
  const contents = [];
  for (const h of history) contents.push({ role: "user", parts: [{ text: h.q }] }, { role: "model", parts: [{ text: h.a }] });
  contents.push({ role: "user", parts: [{ text: question }] });
  const body = { systemInstruction: { parts: [{ text: askSystem(work) }] }, contents, safetySettings: SAFETY };
  let res;
  try {
    res = await fetch(`${BASE}/models/${model}:streamGenerateContent?alt=sse`, {
      method: "POST", signal,
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(body),
    });
  } catch (e) {
    if (e?.name === "AbortError") throw new AiError("aborted", "中止しました。");
    throw new AiError("network", "インターネットにつながっていないようです。電波の良い場所で試してください。");
  }
  if (!res.ok) throw await errorFrom(res);
  addUsage({ kind: "ask", free: true });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", acc = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0 || (i = buf.indexOf("\r\n\r\n")) >= 0) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + (buf[i] === "\r" ? 4 : 2));
      for (const line of chunk.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        let d; try { d = JSON.parse(line.slice(5).trim()); } catch { continue; }
        checkBlocked(d);
        const t = textOf(d);
        if (t) { acc += t; onText?.(acc); }
      }
    }
  }
  if (!acc) throw new AiError("empty", "AIから答えが返ってきませんでした。もう一度聞いてください。");
  return acc;
}

async function picks(key, model, prompt) {
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    safetySettings: SAFETY,
    generationConfig: { responseMimeType: "application/json", responseSchema: toGeminiSchema(PICKS_SCHEMA) },
  };
  const { data } = await callWithBackup(key, model, body, { kind: "discover" });
  return parseJson(textOf(data));
}
export const recommend = ({ key, model }, works) => picks(key, model, recommendPrompt(works));
export const preview = ({ key, model }, place) => picks(key, model, previewPrompt(place));

export async function extractEvent({ key, model }, { image, text, todayStr }) {
  const parts = [];
  if (image) parts.push(await imagePart(image));
  parts.push({ text: eventPrompt({ hasImage: !!image, text, todayStr }) });
  const body = { contents: [{ role: "user", parts }], safetySettings: SAFETY,
    generationConfig: { responseMimeType: "application/json", responseSchema: toGeminiSchema(EVENT_SCHEMA) } };
  const { data } = await callWithBackup(key, model, body, { kind: "event" });
  return parseJson(textOf(data));
}

// Free check: reading a model's info costs nothing and uses no quota for generation.
export async function testKey(key) {
  let res;
  try { res = await fetch(`${BASE}/models/${DEFAULT_MODEL}`, { headers: { "x-goog-api-key": key } }); }
  catch { throw new AiError("network", "インターネットにつながっていないようです。"); }
  if (!res.ok) throw await errorFrom(res);
  return true;
}
