# 平久保崎ライブ壁紙

石垣島・平久保崎灯台のピクセルアートを実時間で動かす WebGL2 壁紙です。太陽・月・天気・波は、現在の日本時間に合わせて変わります。

![平久保崎灯台のピクセルアート](hirakubo_1920x1080.png)

https://hirakubo.toarupen.org/

画面をタップすると音が鳴ります。ビルドした `hirakubo_live/index.html` は、Wallpaper Engine の Web 壁紙としても使えます。

## ビルド

macOS（文字の描画にヒラギノ明朝 ProN を使います）、Node.js 24 以上、pnpm 10、[uv](https://docs.astral.sh/uv/) が必要です。

```bash
pnpm install
uv sync
pnpm build
```

`hirakubo_live/index.html` が出力されます。テストは `pnpm check` と `pnpm e2e` です。

## ライセンス

[MIT](LICENSE)。`tools/oxlint/anti-slop/` は [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop)（MIT）です。
