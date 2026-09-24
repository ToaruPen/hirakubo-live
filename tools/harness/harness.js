// Test harness for the live wallpaper page (loaded into the page with the #test hash).
const W = 640,
  H = 360,
  HY = 146;

const D = JSON.parse(document.getElementById("hk-data").textContent);

const bin = atob(D.arr.col_static.b64),
  u8 = new Uint8Array(bin.length);

for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);

const CS = new Float64Array(u8.buffer);

const T = (window.T = {});

T.cls = (x, y) => {
  if (y <= HY) return "sky";

  if (y >= CS[W + x]) return "land";

  if (y < CS[x]) return "deep";
  const s = y - CS[x];

  return s >= 1.4 && s < 6 ? "trail" : "lagoon";
};

T.ref = async (path) => {
  const b = await (await fetch(path)).blob();
  const bm = await createImageBitmap(b, { colorSpaceConversion: "none", premultiplyAlpha: "none" });

  const c = new OffscreenCanvas(W, H),
    g = c.getContext("2d");

  g.drawImage(bm, 0, 0);

  return g.getImageData(0, 0, W, H).data;
};

T.compare = (got, ref, rows) => {
  const bad = new Uint8Array(W * H),
    per = {},
    tot = {};

  for (let y = rows[0]; y < rows[1]; y++)
    for (let x = 0; x < W; x++) {
      const k = T.cls(x, y);
      tot[k] = (tot[k] || 0) + 1;
      const i = (y * W + x) * 4;

      if (got[i] !== ref[i] || got[i + 1] !== ref[i + 1] || got[i + 2] !== ref[i + 2]) {
        bad[y * W + x] = 1;
        per[k] = (per[k] || 0) + 1;
      }
    }

  let iso = 0,
    n = 0;

  for (let y = rows[0]; y < rows[1]; y++)
    for (let x = 0; x < W; x++)
      if (bad[y * W + x]) {
        n++;

        const nb =
          (x > 0 && bad[y * W + x - 1]) ||
          (x < W - 1 && bad[y * W + x + 1]) ||
          (y > 0 && bad[(y - 1) * W + x]) ||
          (y < H - 1 && bad[(y + 1) * W + x]);

        if (!nb) iso++;
      }

  return { mismatched: n, isolated: iso, per, tot };
};

// crop of a scene buffer, magnified to fill the pane for a screenshot
T.crop = (px, x0, y0, w, h, label) => {
  let c = document.getElementById("dbg2");

  if (!c) {
    c = document.createElement("canvas");
    c.id = "dbg2";
    c.style.cssText =
      "position:fixed;left:0;top:0;image-rendering:pixelated;z-index:10;background:#000";
    document.body.appendChild(c);
  }

  c.width = w;
  c.height = h;
  const z = Math.max(1, Math.floor(Math.min(innerWidth / w, innerHeight / h)));
  c.style.width = w * z + "px";
  c.style.height = h * z + "px";
  const g = c.getContext("2d");
  g.putImageData(new ImageData(new Uint8ClampedArray(px), W, H), -x0, -y0);

  if (label) {
    g.fillStyle = "rgba(0,0,0,.6)";
    g.fillRect(0, 0, w, 9);
    g.fillStyle = "#fff";
    g.font = "8px monospace";
    g.fillText(label, 2, 7);
  }
};

T.t = 0;

T.go = (t1, step = 0.25) => {
  const r = HK.advanceLive(T.t, t1, step);
  T.t = t1;
  T.last = HK.renderLive(t1);

  return r;
};

// per-region share of pixels that change between consecutive live frames, and one-frame blips
T.motion = (t0, frames = 240) => {
  const regions = ["sky", "deep", "lagoon", "trail", "land"];
  const cls = new Uint8Array(W * H);

  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) cls[y * W + x] = regions.indexOf(T.cls(x, y));

  const ch = regions.map(() => 0),
    bl = regions.map(() => 0),
    tot = regions.map(() => 0);

  for (let i = 0; i < W * H; i++) tot[cls[i]]++;

  let a = HK.renderLive(t0),
    b = HK.renderLive(t0 + 1 / 60);

  for (let f = 2; f <= frames; f++) {
    const c = HK.renderLive(t0 + f / 60);

    for (let i = 0; i < W * H; i++) {
      const j = i * 4;
      const ab = a[j] !== b[j] || a[j + 1] !== b[j + 1] || a[j + 2] !== b[j + 2];
      const ac = a[j] !== c[j] || a[j + 1] !== c[j + 1] || a[j + 2] !== c[j + 2];

      if (ab) {
        ch[cls[i]]++;

        if (!ac) bl[cls[i]]++;
      }
    }

    a = b;
    b = c;
  }

  const out = {};
  regions.forEach((r, k) => {
    out[r] = {
      changedPerFrame: +(ch[k] / tot[k] / (frames - 1)).toFixed(4),
      blipShare: +(bl[k] / Math.max(ch[k], 1)).toFixed(3),
    };
  });

  return out;
};

// env-mode frames: a scene at local hour h (JST) on a day, in a forced weather (null = simulated)
T.envFrame = (day, h, wthr, t = 30) => {
  const ms = Date.UTC(day[0], day[1] - 1, day[2], -9) + h * 3600e3;
  const info = HK.setEnv({ ref: false, time: ms, weather: wthr, t: 0 });
  HK.advanceLive(0, t, 0.25);

  return { px: HK.renderLive(t), info };
};

// several frames side by side at half size, labelled
T.grid = (items, cols = 3) => {
  let c = document.getElementById("dbg2");

  if (!c) {
    c = document.createElement("canvas");
    c.id = "dbg2";
    c.style.cssText =
      "position:fixed;left:0;top:0;z-index:10;background:#000;image-rendering:pixelated";
    document.body.appendChild(c);
  }

  const w = 320,
    h = 180,
    rows = Math.ceil(items.length / cols);

  c.width = cols * w;
  c.height = rows * h;
  const z = Math.min(innerWidth / c.width, innerHeight / c.height);
  c.style.width = c.width * z + "px";
  c.style.height = c.height * z + "px";

  const g = c.getContext("2d"),
    tmp = new OffscreenCanvas(W, H),
    tg = tmp.getContext("2d");

  items.forEach((it, k) => {
    tg.putImageData(new ImageData(new Uint8ClampedArray(it.px), W, H), 0, 0);
    g.imageSmoothingEnabled = false;
    g.drawImage(tmp, (k % cols) * w, Math.floor(k / cols) * h, w, h);
    g.fillStyle = "rgba(0,0,0,.6)";
    g.fillRect((k % cols) * w, Math.floor(k / cols) * h, w, 11);
    g.fillStyle = "#fff";
    g.font = "9px monospace";
    g.fillText(it.label || "", (k % cols) * w + 3, Math.floor(k / cols) * h + 8);
  });
};
