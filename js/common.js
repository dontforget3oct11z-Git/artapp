// Shared pieces for every AI provider: settings storage, usage counter, errors, prompts and schemas.

export const USD_JPY = 150; // rough rate for the cost display

export const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
export const lsSet = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} };

export class AiError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// ---- usage (per calendar month, this device only) ----
function monthKey() { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"); }
export function usage() {
  let u; try { u = JSON.parse(lsGet("artscan.usage") || "{}"); } catch { u = {}; }
  if (u.month !== monthKey()) u = { month: monthKey(), usd: 0, calls: 0, scans: 0, freeCalls: 0 };
  u.freeCalls ||= 0;
  return u;
}
export function addUsage({ usd = 0, kind = "", free = false }) {
  const u = usage();
  u.usd += usd; u.calls += 1; if (kind === "scan") u.scans += 1; if (free) u.freeCalls += 1;
  lsSet("artscan.usage", JSON.stringify(u));
}

// Pull the last JSON object out of a free-text answer.
export function extractJson(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const src = fence ? fence[1] : text;
  const start = src.indexOf("{");
  const end = src.lastIndexOf("}");
  if (start < 0 || end <= start) throw new AiError("json", "AIの答えを読み取れませんでした。もう一度試してください。");
  try { return JSON.parse(src.slice(start, end + 1)); }
  catch { throw new AiError("json", "AIの答えを読み取れませんでした。もう一度試してください。"); }
}
export function parseJson(text) {
  try { return JSON.parse(text); } catch { return extractJson(text); }
}

export async function toBase64(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

// ---------------- identify ----------------
export const WORK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["photoKind", "title", "originalTitle", "artist", "artistReading", "year", "medium", "dimensions", "movement", "museum",
    "description", "artistNote", "lookFor", "labelText", "confidence", "alternatives", "tags", "basis"],
  properties: {
    photoKind: { type: "string", enum: ["artwork", "label"] },
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
    basis: {
      type: "object", additionalProperties: false,
      required: ["title", "artist", "year", "medium", "dimensions", "museum"],
      properties: Object.fromEntries(["title", "artist", "year", "medium", "dimensions", "museum"]
        .map(k => [k, { type: "string", enum: ["label", "knowledge", "none"] }])),
    },
  },
};

// Fields whose source we track and show to the user.
export const SOURCED_FIELDS = ["title", "artist", "year", "medium", "dimensions", "museum"];

export const SYSTEM_IDENTIFY = `あなたは経験豊富な美術館の学芸員です。来館者が撮った写真から作品を特定し、日本語で作品カードを作ります。
いちばん大切なのは、事実でないことを書かないことです。確かでない項目は空文字にしてください。空欄は問題ありません。

情報の優先順位：
1. ラベル（キャプション）の写真に書かれた文字。書かれている項目は必ずラベルの内容を使う。
2. 撮影場所として伝えられた美術館・展覧会の名前。
3. 写真の絵柄から作品を確実に特定できた場合だけ、あなたの知識。

各項目の書き方：
- photoKind: 1枚目の写真が作品そのもの（絵画・彫刻・工芸・写真作品など）なら artwork、作品の解説ラベル（キャプション）の文字が主なら label。
- title: 日本語の定訳があれば日本語の作品名。原題は originalTitle に（同じなら空文字）。
- artist: 作家名の日本語表記。artistReading: 原語表記（例：Claude Monet）。日本人作家なら読み仮名。
- year / medium / dimensions / movement: ラベルにあればそれを使う。ラベルになければ、作品を確実に特定できた場合だけ記入し、それ以外は空文字。
- museum: ラベルの館名か、伝えられた撮影場所。なければ、確実な場合だけ所蔵館。
- description: 作品を特定できた場合は、実物の前で読んで楽しい見どころを3〜5文。特定できない場合は、写真に見えていること（主題・色・構図・技法の特徴）だけを書き、作品名や来歴を作らない。
- artistNote: 作家が確実にわかる場合だけ1〜2文。それ以外は空文字。
- lookFor: 写真に実際に見えている細部のうち、実物で注目してほしいものを2〜3個、各1文。
- labelText: ラベル写真があれば、その文字を原文のまま改行も保って書き起こす。読めない文字は〔?〕とする。なければ空文字。
- confidence: 特定の確からしさ。ラベルで確認できたら high。ラベルがなく、絵柄が有名作と明らかに一致するなら medium。それ以外は low。
- alternatives: confidence が high でない時の他の候補「作品名 / 作家」を最大3件。high なら空配列。
- tags: 写真に見えている主題・モチーフ・色などの短いタグを3〜6個。
- basis: title, artist, year, medium, dimensions, museum のそれぞれについて、ラベルや伝えられた撮影場所から取ったら label、絵柄から作品を特定してあなたの知識で書いたら knowledge、空文字なら none。

作品を特定できない場合（現代作家の作品、個人蔵、写真が不鮮明など）は、title と artist を空文字にして confidence を low にし、候補があれば alternatives に入れてください。`;

export function identifyText({ hasArt, hasLabel, museum, place, unknown }) {
  const what = unknown ? "作品（絵画・彫刻など）の写真か、作品の横の解説ラベル（キャプション）の写真のどちらかです。作品だけの写真なら、絵柄から作品カードを作ってください（作品名がわからなければ空文字で構いません）。ラベルの写真なら、文字を labelText に書き起こし、ラベルの内容から作品カードを作ってください。"
    : hasArt && hasLabel ? "1枚目は作品、2枚目はその作品の解説ラベル（キャプション）の写真です。"
    : hasArt ? "作品の写真です。" : "作品の解説ラベル（キャプション）の写真です。";
  let ctx = "";
  if (museum) ctx += `撮影した場所：${museum}\n`;
  else if (place) ctx += `撮影した場所の近く：${place}\n`;
  return `${what}\n${ctx}この作品の作品カードを作ってください。`;
}

// ---------------- ask ----------------
export function askSystem(work) {
  const ctx = [
    `作品：${work.title}${work.originalTitle ? `（${work.originalTitle}）` : ""}`,
    `作家：${work.artist}${work.artistReading ? `（${work.artistReading}）` : ""}`,
    work.year && `制作年：${work.year}`, work.medium && `技法：${work.medium}`,
    work.movement && `様式：${work.movement}`, work.museum && `所蔵・展示：${work.museum}`,
    work.description && `解説：${work.description}`,
    work.labelText && `ラベルの文字：\n${work.labelText}`,
    work.note && `鑑賞者のメモ：${work.note}`,
  ].filter(Boolean).join("\n");
  return `あなたは親切で知識豊富な美術館のガイドです。次の作品を前にした来館者の質問に、日本語で答えてください。普段は3〜6文で簡潔に。確かでないことは推測だと明示してください。Markdownの見出しや表は使わず、普通の文章で答えてください。\n\n${ctx}`;
}

// ---------------- discover ----------------
export const PICKS_SCHEMA = {
  type: "object", additionalProperties: false, required: ["taste", "picks"],
  properties: {
    taste: { type: "string" },
    picks: { type: "array", items: {
      type: "object", additionalProperties: false, required: ["title", "artist", "year", "where", "why"],
      properties: { title: { type: "string" }, artist: { type: "string" }, year: { type: "string" }, where: { type: "string" }, why: { type: "string" } },
    } },
  },
};

export function recommendPrompt(works) {
  const list = works.slice(0, 60).map(w => `- ${w.artist}「${w.title}」${w.year ? `（${w.year}）` : ""}${w.movement ? ` ${w.movement}` : ""}${w.fav ? " ♥" : ""}`).join("\n");
  return `ある人が美術館で撮影して保存した作品の一覧です（♥はお気に入り）。\n${list}\n\nこの人の好みを日本語で2文で分析し（taste）、一覧にない実在の作品を6点すすめてください（picks）。日本国内の美術館で見られる作品を3点以上含め、where には所蔵館と都市を書いてください。why はこの人の好みと結びつけた1文にしてください。`;
}
export function previewPrompt(place) {
  return `これから「${place}」に行きます。そこで見逃せない作品を最大6点、日本語で教えてください。taste には、その美術館・展覧会の特徴と回り方のコツを2文で。picks の where には館内の展示場所や時期の注意（常設か、展示替えがあるか等）を、わかる範囲で書いてください。確かでないことは「〜の可能性があります」と書いてください。`;
}

// ---------------- exhibition from a flyer / poster / pasted text ----------------
export const EVENT_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["title", "venue", "start", "end", "url", "summary", "found"],
  properties: {
    title: { type: "string" }, venue: { type: "string" }, start: { type: "string" }, end: { type: "string" },
    url: { type: "string" }, summary: { type: "string" }, found: { type: "boolean" },
  },
};
// The official page of an exhibition, read by the AI from its URL.
export function eventUrlPrompt({ url, hint, todayStr }) {
  return `今日は${todayStr}です。次のWebページを開いて、載っている展覧会の情報を取り出してください。
${url}
${hint ? `探している展覧会：「${hint}」（ページに複数の展覧会があれば、これに当たるものを選ぶ）\n` : ""}ページに書かれていないことは作らず、空文字にしてください。
次の形のJSONだけを返してください（前後に説明を書かない）：
{"title":"","venue":"","start":"","end":"","url":"","summary":"","found":true}
- title：展覧会名（ページに書かれているとおり）
- venue：会場の美術館名
- start / end：会期を YYYY-MM-DD で。年が書かれていなければ、今日から見て自然な年にする。
- url：その展覧会のページのURL（わからなければ上のURL）
- summary：どんな展覧会か1〜2文（ページの内容から）
- found：ページを開けて展覧会の情報が読み取れたら true。開けない・展覧会の情報がなければ false`;
}
export function eventPrompt({ hasImage, text, todayStr }) {
  return `今日は${todayStr}です。${hasImage ? "写真は展覧会のチラシ・ポスター・看板などです。" : ""}${text ? `次の文章は展覧会の案内です。\n---\n${text.slice(0, 12000)}\n---\n` : ""}
書かれている展覧会の情報を取り出してください。書かれていないことは作らず、空文字にしてください。
- title：展覧会名（書かれているとおり）
- venue：会場の美術館名
- start / end：会期を YYYY-MM-DD で。年が書かれていなければ、今日から見て自然な年にする。
- url：書かれているWebサイトのURL（なければ空文字）
- summary：どんな展覧会か1〜2文（書かれている内容から）
- found：展覧会の情報が読み取れたら true、読み取れなければ false`;
}
