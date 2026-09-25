# hirakubo-live

Pixel art of the Hirakubo-zaki lighthouse (Ishigaki Island) and a real-time WebGL2 wallpaper
built from it. The same page runs in browsers (https://hirakubo.toarupen.org/, Cloudflare) and
in Wallpaper Engine. User-facing text is Japanese; code, comments and commits are English.

## Layout

- `hirakubo_pixel.py` draws the 640×360 still and exports the three committed PNGs.
- `hirakubo_loop.py` animates the still as a seamless 1440-frame loop with simple physics.
- `hirakubo_live_build.py` exports everything the page needs from those two (layers, wave
  components, blades, clouds) and fills `hirakubo_live.template.html` in one pass:
  `/*__HK_DATA__*/` (JSON), `/*__HK_ENV__*/` (`hirakubo_env.js`), `/*__HK_LIVE__*/`
  (`hirakubo_live.js`). Output: `hirakubo_live/index.html` (full document, deployed) and
  `hirakubo_live.html` (fragment). Both are build products and are not committed.
- `hirakubo_env.js` holds pure functions of UTC time: sun, moon, sky light and weather.
- `hirakubo_live.js` is the engine. `#test` in the URL exposes the test hooks on `window.HK`;
  `#debug` shows the HUD.

## Invariants

- The build is deterministic. A change that should not alter the picture must leave these
  byte-identical: the three PNGs (`uv run python hirakubo_pixel.py` then `git diff`), the page
  (`pnpm build`, compare SHA-256), and `uv run python hirakubo_loop.py --gate` must report 0.
- The page's loop mode is a port of `hirakubo_loop.py`. `pnpm e2e` bounds its pixel difference
  from the Python frames at 0, 360 and 1100; float32 on the GPU keeps it from being zero.
- For changes to the live scenes, compare pixel hashes before and after on the same machine
  with `tools/harness/` (below). Hashes differ between GPUs, so they are not in CI.
- `glyph_mask` renders with `/System/Library/Fonts/ヒラギノ明朝 ProN.ttc`, so building needs
  macOS. CI builds on `macos-26`.
- numpy and Pillow are pinned exactly: the data is float64 and the glyphs come from Pillow's
  FreeType. Bump them only with the checks above.
- The page runs in Wallpaper Engine's embedded Chromium, whose version is not published. Do not
  raise the JavaScript baseline casually (for example `toSorted()` needs Chrome 110).

## Lint policy (anti-slop)

`oxlint.config.ts` enables oxlint's correctness, suspicious and perf categories and every generic
rule of the vendored `anti-slop` plugin (`tools/oxlint/anti-slop/`, MIT, from
dmmulroy/anti-slop; provenance in its `UPSTREAM.md`). All are errors. Fix the code, or disable a
rule on the line with `// oxlint-disable-next-line <rule> -- <why it does not apply here>`;
unused disables fail the lint. Never turn a rule off in the config.

- Both JavaScript files are classic scripts sharing one global scope, so their code lives in an
  IIFE (outside it: `HKEnv`, `window.HK` and Wallpaper Engine's settings listener). Write
  helpers at the top of the IIFE as function declarations, not arrow constants.
- `oxfmt` formats everything but Python and the HTML template (100 columns);
  `anti-slop/require-readable-spacing` then wants blank lines between statement groups, which
  `oxlint --fix` adds.
- Python: ruff (see `pyproject.toml` for the rule set and why SIM300 is off), `ruff format`.

## Commands

- `pnpm install` and `uv sync` — tools and the Python environment
- `pnpm build` — verify the layer split, then write both pages
- `pnpm lint` — oxlint, oxfmt --check, ruff check, ruff format --check
- `pnpm fmt` — oxfmt write; `uv run ruff format` — Python
- `pnpm test` — node:test (NAOJ ephemerides, time zone independence)
- `pnpm e2e` — Playwright on SwiftShader against the built page (`pnpm build` first; browser via
  `pnpm exec playwright install chromium --only-shell`)
- `pnpm check` — lint + test; must pass before every commit
- `pnpm deploy` — build + `wrangler deploy` with the owner's Cloudflare login; only when the owner
  asks

## Pixel-hash harness

Serve the repository root (`uv run python -m http.server 8000`), open
`http://localhost:8000/hirakubo_live/index.html#test`, load `/tools/harness/sound_harness.js`
from the console and `await boot()`. Then `hh(HK.renderLoop(360))`,
`hh(T.envFrame([2026, 9, 5], 21, 3, 60).px)` (date, JST hour, regime index, seconds) and
`M.stats((await HK.soundTest({ dur: 8 })).buf)` give values to compare before and after a change.
Load the page afresh for each comparison: state carries over between scenes.

## Deploy

`.github/workflows/ci.yml` deploys on a push to `main`, or a manual run with `deploy` checked,
only while the repository variable `CLOUDFLARE_ACCOUNT_ID` is set. The job waits for the owner's
approval in the `production` environment (branch `main` only), which holds the secret
`CLOUDFLARE_API_TOKEN` (template "Edit Cloudflare Workers" including the toarupen.org zone: the
custom domain needs Workers Routes). It deploys the page the build job tested, then checks that
the site serves that page's SHA-256. Agents never handle the token.
