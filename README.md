# ArtScan

美術館で撮った作品の写真から、AIが作品名・作家・解説を調べてコレクションに残すWebアプリ（PWA）です。
App Storeの「ArtScan: Museum Photos」の機能を参考にしています。

サーバーはありません。AIへの問い合わせは、スマホから直接行います。

- **初期設定は Google の Gemini API の無料枠**です。無料のAPIキーを入れるだけで、0円で使えます。
- Claude APIキーも入れておくと、AIの自信が低いときに「高精度で再識別」（Claude Opus、1回約10円）を使えます。Claudeをメインにすることもできます。

## できること

- **スキャン**：作品の写真（と壁のラベルの写真）から、作品名・作家・制作年・技法・寸法・様式・所蔵館・解説・見どころを作成。ラベルの文字も書き起こして保存
- **コレクション**：作品をカードで表示。検索、作家・美術館・様式での絞り込み、並べ替え、お気に入り
- **作品の詳細**：解説、見どころ、ラベルの写真と文字、メモ、編集、共有、AIへの質問（会話は作品ごとに保存）
- **マップ**：撮影した場所を地図に表示（写真の位置情報か、撮影時の現在地）。美術館ごとの訪問記録
- **発見**：コレクションの傾向から好みを分析しておすすめ作品を提案。行く前の美術館の見どころ予習
- **設定**：使うAI（Gemini無料 / Claude）、APIキー、モデル、今月の利用料の目安、バックアップの書き出しと読み込み
- **オフライン**：アプリ本体はオフラインでも開け、保存した作品も見られます（AI機能と地図は通信が必要です）

## 情報の正確さについて

AIはそれらしい作り話をすることがあります（Gemini・Claudeどちらも）。そのため、このアプリはAIの答えをそのまま使いません。

1. **ラベルを最優先**：壁のラベル（キャプション）を撮ると、作品名・作家・年などはラベルの文字から取ります。
2. **Wikipediaで裏付け**：AIが挙げた作品名と作家で Wikidata / Wikipedia を調べます（無料・キー不要）。見つかれば、制作年・寸法・所蔵館はそこから取り、Wikipediaの説明とリンクも保存します。
3. **わからない項目は空欄**：AIには、確かでない項目は空欄にするよう指示しています。
4. **出典の印**：各項目に「ラベル」「Wikipedia確認済」「AIの推測」「手入力」の印が付きます。「AIの推測」の項目だけ注意して見てください。

## 公開のしかた（GitHub Pages・無料）

1. このリポジトリを **Public（公開）** にします。無料プランのGitHub Pagesは公開リポジトリでのみ使えます。APIキーはリポジトリに含まれないので、公開しても安全です。
2. GitHubのリポジトリで **Settings → Pages** を開きます。
3. 「Build and deployment」の Source を **Deploy from a branch**、Branch を **main** と **/ (root)** にして Save を押します。
4. 1〜2分後に `https://<ユーザー名>.github.io/<リポジトリ名>/` で開けるようになります。

## スマホへの入れ方

- **iPhone**：Safariで上のURLを開き、共有ボタン →「ホーム画面に追加」
- **Android**：Chromeで開き、メニュー →「アプリをインストール」（または「ホーム画面に追加」）

## APIキーの準備

### Gemini（無料・必須）

1. [Google AI Studio](https://aistudio.google.com/apikey) にGoogleアカウントでログインし、「Create API key」でキーを作ります。
2. アプリ右上の歯車（設定）の「Gemini APIキー」に入れて「保存して確認」を押します。

無料枠の注意：
- 1日に使える回数に上限があります（Google AI Studioの「Rate limit」で確認できます）。上限に達すると自動で軽量モデル（Gemini 3.5 Flash-Lite）に切り替えます。上限は日本時間の夕方（16〜17時ごろ）にリセットされます。
- 無料枠では、送った写真と文章がGoogleのAI改善に使われることがあります。

### Claude（任意・有料）

1. [Anthropic Console](https://console.anthropic.com/settings/keys) でAPIキーを作ります。
2. 使いすぎを防ぐため、Consoleの **Settings → Limits** で月の利用上限額を設定しておくと安心です。
3. 設定の「Claude APIキー」に入れます。

| 使い方 | 1枚あたり | 月100枚 |
|---|---|---|
| Gemini（初期設定） | 0円 | 0円 |
| Geminiで識別し、自信が低いときだけClaude Opusで再識別 | 再識別1回 約10円 | 再識別した分だけ |
| Claude Haiku 5.5 をメインに使う | 約0.3円 | 約30円 |
| Claude Sonnet 5.5 をメインに使う | 約4〜5円 | 約400〜500円 |
| Claude Opus 5.5 をメインに使う | 約8〜10円 | 約800〜1,000円 |

Claudeの金額は、作品とラベルの写真を両方送った場合の目安です（1ドル150円）。

キーはその端末のブラウザの中（localStorage）だけに保存されます。AIへの問い合わせ以外には送られません。
ただし、端末を他の人と共用する場合は注意してください。

## データについて

- 作品と写真は、その端末のブラウザの中（IndexedDB）に保存されます。別の端末とは同期されません。
- 機種変更やブラウザのデータ削除に備えて、設定の「ファイルに書き出す」でときどきバックアップしてください。
- 撮影場所の名前を調べるため、位置情報を OpenStreetMap の Nominatim に送ります。設定でオフにできます。

## ファイル構成

```
index.html            画面
css/app.css           見た目
js/app.js             画面の動き
js/ai.js              使うAIの切り替えと設定
js/gemini.js          Gemini APIとのやりとり（無料）
js/claude.js          Claude APIとのやりとり（有料）
js/common.js          AIへの指示文と共通処理
js/verify.js          Wikidata / Wikipediaでの裏付け
js/store.js           端末内への保存（IndexedDB）とバックアップ
sw.js                 オフライン対応
manifest.webmanifest  ホーム画面用の設定
vendor/               同梱ライブラリ（Anthropic SDK 0.133.0、Leaflet 1.9.4、exifr 7.1.3）
```

ビルドは不要です。ファイルをそのまま置けば動きます。
ローカルで試すときは `python3 -m http.server` などで配信して `http://localhost:8000/` を開いてください。

## クレジット

- 地図：© [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors（Leaflet）
- 写真の位置情報の読み取り：exifr
- 元になったアプリ：ArtScan: Museum Photos（ArtScan AI LLC）。このアプリは個人の学習・利用目的で作った非公式の再現版です。
