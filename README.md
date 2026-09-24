# 平久保崎ライブ壁紙

石垣島の最北端、平久保崎灯台を南の丘から見たピクセルアート（640×360）と、それを実時間で動かす WebGL2 の壁紙です。

![平久保崎灯台のピクセルアート](hirakubo_1920x1080.png)

公開ページ: https://hirakubo.toarupen.org/

スマホでは、画面からはみ出した部分を指でドラッグして見回せます。

## 動くもの

- 太陽と月の位置は、現在の日本時間から現地の座標で計算します。国立天文台の暦と照らし合わせたテストがあります。空の色は大気の単一散乱モデルで決まります。
- 天気は石垣島の季節に沿ったシミュレーションです（快晴から荒天まで 7 段階）。風向きが変わると、草のうねりと海の風浪も向きを変えます。
- 沖から来るうねり、リーフで砕ける波、白波、雲の流れと生成・消滅が描かれます。
- 音（波・風・雨・雷・フクロウ）は、画面を一度タップすると鳴ります。
- ブラウザでは、右下のパネルで時刻・天気・光・音を切り替えられます。
- Wallpaper Engine の Web 壁紙としても動きます。`hirakubo_live/index.html` を読み込んでください。

## ファイル

| ファイル                      | 役割                                                          |
| ----------------------------- | ------------------------------------------------------------- |
| `hirakubo_pixel.py`           | 静止画を描き、640×360・1920×1080・3840×2160 の PNG に書き出す |
| `hirakubo_loop.py`            | 静止画を物理モデルで動かす 1440 フレームの継ぎ目のないループ  |
| `hirakubo_live_build.py`      | 上の 2 つから必要なデータを取り出し、ページを組み立てる       |
| `hirakubo_live.template.html` | ページの HTML と CSS                                          |
| `hirakubo_live.js`            | 描画・物理・音のエンジン                                      |
| `hirakubo_env.js`             | 太陽・月・空の光・天気（UTC 時刻の純粋関数）                  |
| `wrangler.jsonc`              | Cloudflare への公開設定（静的アセットのみ）                   |
| `tests/`                      | 暦とタイムゾーンのテスト、ブラウザでのスモークテスト          |
| `tools/harness/`              | 描画と音を検証するためのページ内ハーネス                      |
| `tools/oxlint/anti-slop/`     | 取り込んだ anti-slop lint プラグイン（MIT）                   |

ビルド結果（`hirakubo_live/`、`hirakubo_live.html`）とループ動画（mp4）はリポジトリに含めていません。

## 必要なもの

- macOS: ビルドが石碑の文字を「ヒラギノ明朝 ProN」で描くためです。
- Node.js 24 以上と pnpm 10（版は `package.json` の `packageManager` で固定）
- [uv](https://docs.astral.sh/uv/): Python 3.13 と、固定した版の numpy・Pillow を入れます。

## ビルド

```bash
pnpm install
```

```bash
uv sync
```

```bash
pnpm build
```

`hirakubo_live/index.html` ができます。1 ファイルで完結しているので、ブラウザで直接開けます。

静止画を描き直すには `uv run python hirakubo_pixel.py` を実行します。ループ動画は `uv run python hirakubo_loop.py --render <出力先>` で書き出します（ffmpeg が必要です）。

## 検査

| コマンド     | 内容                                                             |
| ------------ | ---------------------------------------------------------------- |
| `pnpm lint`  | oxlint（anti-slop プラグイン込み）、oxfmt、ruff                  |
| `pnpm test`  | 太陽・月の暦（国立天文台）とタイムゾーンのテスト                 |
| `pnpm e2e`   | ビルドしたページを Playwright で開くスモークテスト               |
| `pnpm check` | lint とテスト。コミット前に通します                              |
| `pnpm fmt`   | JavaScript などを oxfmt で整形（Python は `uv run ruff format`） |

`pnpm e2e` の前に `pnpm build` と `pnpm exec playwright install chromium --only-shell` を一度実行してください。e2e では次の 3 点を確かめます。

- ページがエラーなく動き出すこと
- ループ表示が `hirakubo_loop.py` の出力と一致していること（許容差あり）
- スマホで指によるドラッグが効くこと

lint には [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop) の oxlint プラグインを使っています。汎用ルールはすべてエラー扱いです。ルールが当てはまらない箇所だけ、その行に理由を書いて無効化します。取り込んだ版と経緯は `tools/oxlint/anti-slop/UPSTREAM.md` にあります。

### 描画の検証用ハーネス

見た目を変えない変更の前後で、ピクセルのハッシュを比べるための道具です。GPU ごとに値が変わるので、同じマシンで比べます。

リポジトリの直下でサーバを立てます。

```bash
uv run python -m http.server 8000
```

`http://localhost:8000/hirakubo_live/index.html#test` を開き、開発者ツールのコンソールで読み込みます。

```js
await new Promise((r) => {
  const s = document.createElement("script");
  s.src = "/tools/harness/sound_harness.js";
  s.addEventListener("load", r);
  document.head.append(s);
});
await boot();
hh(HK.renderLoop(360)); // ループの 360 フレーム目のハッシュ
hh(T.envFrame([2026, 9, 5], 21, 3, 60).px); // 2026-09-05 21 時、天気 3（曇り）、60 秒後
M.stats((await HK.soundTest({ dur: 8 })).buf); // 8 秒の音のピークと RMS
```

## CI/CD

`.github/workflows/ci.yml` が、プルリクエストと main への push で動きます。

| ジョブ | 実行環境 | 内容                                          |
| ------ | -------- | --------------------------------------------- |
| lint   | ubuntu   | oxlint・oxfmt・ruff、暦とタイムゾーンのテスト |
| build  | macos-26 | 下の 5 項目                                   |
| deploy | ubuntu   | 承認後に公開し、公開ページを確認（下記）      |

build ジョブが確かめること:

- PNG を描き直しても、コミット済みのものと一致すること
- ループの 0 フレーム目が静止画と一致すること
- ページがビルドできること
- e2e が通ること
- ページを成果物として保存し、そのハッシュを記録すること

deploy ジョブが動くのは main への push 時だけです。production 環境で承認されると、build ジョブが検査したページをそのまま `wrangler deploy` します。そのあと、公開 URL のページのハッシュが成果物と一致するかを確かめます。

### デプロイを有効にする

deploy ジョブは、リポジトリ変数 `CLOUDFLARE_ACCOUNT_ID` が空のあいだは動きません。

1. Cloudflare のダッシュボードで API トークンを作ります。テンプレート「Edit Cloudflare Workers」を使い、ゾーンに toarupen.org を含めます。カスタムドメインの更新に Workers Routes の権限が要るためです。
2. GitHub の Settings → Environments → production の Environment secrets に、`CLOUDFLARE_API_TOKEN` として登録します。
3. Settings → Secrets and variables → Actions → Variables に、`CLOUDFLARE_ACCOUNT_ID`（Cloudflare のアカウント ID）を登録します。

これ以降、main に push するたびに deploy ジョブが承認待ちになります。Actions の実行画面の「Review deployments」で承認すると公開されます。

## ライセンス

まだ設定していません（著作権は作者に帰属します）。ただし `tools/oxlint/anti-slop/` は MIT ライセンスです（Copyright 2026 Dillon Mulroy）。
