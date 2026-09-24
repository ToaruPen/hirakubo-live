"use strict";
// Wallpaper Engine hands the user's FPS limit to this listener (documented web wallpaper API).
// It must exist before the first frame; outside Wallpaper Engine it is simply never called, so a
// call also marks the page as a wallpaper (the sky controls are for browsers only).
const HK_SETTINGS = { fps: 60, wallpaper: false };
window.wallpaperPropertyListener = {
  applyGeneralProperties(p) {
    if (p.fps) HK_SETTINGS.fps = p.fps;
    HK_SETTINGS.wallpaper = true;
    const ui = document.getElementById("sky-ui");
    if (ui) ui.hidden = true;
  },
};

(function () {
  const HKAPI = (window.HK = {});
  const TAU = 2 * Math.PI;
  const msg = document.getElementById("msg");
  function fail(text) {
    msg.textContent = text;
    msg.hidden = false;
  }

  // ------------------------------------------------------------------ numerics shared with numpy
  function mod2pi(x) {
    const m = x % TAU;
    return m < 0 ? m + TAU : m;
  }
  function rhe(v) {
    // numpy / Python round(): half to even
    return Math.abs(v % 1) === 0.5 ? 2 * Math.round(v / 2) : Math.round(v);
  }
  function clamp(v, a, b) {
    return v < a ? a : v > b ? b : v;
  }
  function smooth01(x) {
    x = clamp(x, 0, 1);
    return x * x * (3 - 2 * x);
  }
  function lerp(a, b, t) {
    return a + (b - a) * t;
  }
  function mulberry32(a) {
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  // integer-hash value noise: the same function runs in the shaders (trail foam) and here (new clouds)
  function hash3(x, y, s) {
    let h = (Math.imul(x, 0x8da6b343) ^ Math.imul(y, 0xd8163841) ^ Math.imul(s, 0xcb1ab31f)) >>> 0;
    h ^= h >>> 16;
    h = Math.imul(h, 0x7feb352d) >>> 0;
    h ^= h >>> 15;
    h = Math.imul(h, 0x846ca68b) >>> 0;
    h ^= h >>> 16;
    return (h >>> 8) / 16777216;
  }
  function vnH(u, v, s) {
    const x0 = Math.floor(u),
      y0 = Math.floor(v);
    let fx = u - x0,
      fy = v - y0;
    fx = fx * fx * (3 - 2 * fx);
    fy = fy * fy * (3 - 2 * fy);
    const a = x0 & 511,
      b = (x0 + 1) & 511,
      c = y0 & 511,
      d = (y0 + 1) & 511;
    return (
      (hash3(a, c, s) * (1 - fx) + hash3(b, c, s) * fx) * (1 - fy) +
      (hash3(a, d, s) * (1 - fx) + hash3(b, d, s) * fx) * fy
    );
  }
  function fbmH(u, v, s, oct) {
    let sum = 0,
      amp = 1,
      norm = 0;
    for (let o = 0; o < oct; o++) {
      sum += amp * vnH(u * 2 ** o, v * 2 ** o, s + 101 * o);
      norm += amp;
      amp *= 0.5;
    }
    return sum / norm;
  }
  function n1(t, s) {
    // smooth 1-D noise in [0, 1]
    const i = Math.floor(t);
    let f = t - i;
    f = f * f * (3 - 2 * f);
    return hash3(i | 0, 7, s) * (1 - f) + hash3((i + 1) | 0, 7, s) * f;
  }

  // ------------------------------------------------------------------ data
  let D;
  try {
    D = JSON.parse(document.getElementById("hk-data").textContent);
  } catch (e) {
    fail("壁紙のデータを読み込めませんでした。ファイルが壊れていないか確認してください。");
    return;
  }
  const C = D.const;
  const W = C.W,
    H = C.H,
    HY = C.HY,
    F = C.F,
    CAM_H = C.CAM_H,
    N = C.N,
    T = C.T,
    FPS = C.FPS;
  const WIND = C.WIND,
    SHEEN = C.SHEEN,
    G = C.G;
  const selfTest = [];
  function dec(a) {
    const bin = atob(a.b64),
      u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const Ty = {
      float64: Float64Array,
      float32: Float32Array,
      int16: Int16Array,
      uint16: Uint16Array,
      int32: Int32Array,
      uint8: Uint8Array,
    }[a.dtype];
    const out = new Ty(u8.buffer);
    let s = 0;
    for (let i = 0; i < out.length; i++) s += out[i];
    if (Math.abs(s - a.sum) > 1e-6 * Math.max(1, Math.abs(a.sum)))
      selfTest.push(`array sum ${a.dtype} ${s} != ${a.sum}`);
    return out;
  }
  const A = {};
  for (const k in D.arr) A[k] = dec(D.arr[k]);
  const CS = A.col_static; // rows of W: surf_y, land_y, brk, brk2, reef, kx_reef, kx_isle, reefX, reefZ, isleX
  const colRow = (r) => CS.subarray(r * W, (r + 1) * W);
  const SURF_Y = colRow(0),
    LAND_Y = colRow(1),
    KX_REEF = colRow(5),
    KX_ISLE = colRow(6);
  const REEF_X = colRow(7),
    REEF_Z = colRow(8),
    ISLE_X = colRow(9);
  const PAL_ORDER = ["sky", "white", "deep", "lagoon", "coral", "grass", "straw", "rock"];
  const palFlat = new Float32Array(57 * 3);
  {
    let o = 0;
    for (const k of PAL_ORDER)
      for (const c of D.pal[k]) {
        palFlat.set(c, o);
        o += 3;
      }
  }

  // ------------------------------------------------------------------ WebGL2
  const canvas = document.getElementById("hk");
  const gl = canvas.getContext("webgl2", {
    antialias: false,
    alpha: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: false,
    powerPreference: "low-power",
  });
  if (!gl) {
    fail("この壁紙の表示には WebGL2 が必要です。WebGL2 に対応したブラウザで開いてください。");
    return;
  }
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

  function texture(w, h, ifmt, fmt, type, data) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, w, h, 0, fmt, type, data || null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  function imageTexture(img) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    return t;
  }
  function target() {
    const t = texture(W, H, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    return { t, fb };
  }

  const VS = `#version 300 es
void main() { vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;
  const PRE = `#version 300 es
precision highp float; precision highp int; precision highp sampler2D;
const int W = ${W}, H = ${H};
const float HY = ${HY}.0, F = ${F.toFixed(1)}, CAM_H = ${CAM_H.toFixed(1)}, EYE = ${C.EYE.toFixed(1)};
const float SHEEN = ${SHEEN}, TAUF = 6.283185307179586;
const int SKYP = 0, WHP = 10, DEEPP = 17, LAGP = 26, CORP = 34, GRP = 39, STRP = 48, ROCKP = 52;
uniform vec3 uPal[57];
uniform sampler2D uMasks;
out vec4 o;
float bay(ivec2 p) {
  int m[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
  return (float(m[(p.y & 3) * 4 + (p.x & 3)]) + 0.5) / 16.0;
}
vec3 pal(int i) { return uPal[i] / 255.0; }
int quantI(float v, int n, bool dith, ivec2 p) {
  float c = clamp(v, 0.0, float(n - 1));
  float idx;
  if (dith) { float b = floor(c); idx = b + ((c - b) > bay(p) ? 1.0 : 0.0); }
  else idx = floor(c + 0.5);
  return clamp(int(idx), 0, n - 1);
}
vec3 quantC(float v, int off, int n, bool dith, ivec2 p) { return pal(off + quantI(v, n, dith, p)); }
vec3 lin(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 srgb(vec3 l) {
  l = clamp(l, 0.0, 1.0);
  return mix(l * 12.92, 1.055 * pow(l, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, l));
}
ivec4 maskAt(ivec2 p) { return ivec4(round(texelFetch(uMasks, p, 0) * 255.0)); }
ivec3 rgb8(vec4 c) { return ivec3(round(c.rgb * 255.0)); }
float fieldV(sampler2D s, ivec2 p) {
  ivec3 b = ivec3(round(texelFetch(s, p, 0).rgb * 255.0));
  return float(b.r * 65536 + b.g * 256 + b.b) / ${C.FIX}.0 - ${C.FIX_OFF.toFixed(1)};
}
float compSum(vec4 c[12], int n, vec2 xz, vec2 foot, bool att) {
  float s = 0.0;
  for (int j = 0; j < 12; j++) {
    if (j >= n) break;
    vec4 q = c[j];
    float a = att ? exp(-0.245 * ((q.x * foot.x) * (q.x * foot.x) + (q.y * foot.y) * (q.y * foot.y))) : 1.0;
    s += q.z * cos(q.x * xz.x + q.y * xz.y + q.w) * a;
  }
  return s;
}
uint hash3(uint x, uint y, uint s) {
  uint h = (x * 0x8da6b343u) ^ (y * 0xd8163841u) ^ (s * 0xcb1ab31fu);
  h ^= h >> 16; h *= 0x7feb352du; h ^= h >> 15; h *= 0x846ca68bu; h ^= h >> 16;
  return h;
}
float latH(int x, int y, int s) { return float(hash3(uint(x & 511), uint(y & 511), uint(s)) >> 8) / 16777216.0; }
float vnH(float u, float v, int s) {
  float fx0 = floor(u), fy0 = floor(v);
  float fx = u - fx0, fy = v - fy0;
  fx = fx * fx * (3.0 - 2.0 * fx); fy = fy * fy * (3.0 - 2.0 * fy);
  int x0 = int(fx0), y0 = int(fy0);
  return (latH(x0, y0, s) * (1.0 - fx) + latH(x0 + 1, y0, s) * fx) * (1.0 - fy)
       + (latH(x0, y0 + 1, s) * (1.0 - fx) + latH(x0 + 1, y0 + 1, s) * fx) * fy;
}
vec2 ground(ivec2 p) {         // hill treated as a ground plane EYE metres below the eye
  float gz = F * EYE / max(float(p.y) - HY, 1.0);
  return vec2((float(p.x) - float(W) / 2.0) * gz / F, gz);
}
vec3 seaXZ(ivec2 p) {          // sea-surface point seen by the pixel, and its footprint scale
  float z = F * CAM_H / max(float(p.y) - HY, 0.5);
  return vec3((float(p.x) - float(W) / 2.0) * z / F, z, 0.0);
}
`;

  // P1: sky, clouds, horizon bank; sea colours before foam; land left black (as the still's
  // pipeline has it when the sea is despeckled)
  const FS_BASE =
    PRE +
    `
uniform sampler2D uColS, uColD, uOver, uFieldA, uFieldB, uCirrus;
uniform vec4 uRough[12], uSwell[12], uChop[12], uChopL[12];
uniform int uNRough, uNSwell, uNChop, uNChopL;
uniform float uCirrusShift, uReflect, uSwellReflect;
// light of the moment (hirakubo_env.js): the sky ramp at five azimuths, cumulus, horizon bank and
// deck shades; in the still's own light these are the designed palettes
uniform vec3 uSkyPal[50], uCloudPal[7], uBankPal[7], uDeckPal[7];
uniform float uCirrusThr, uDeck, uDeckH, uStarK, uMW, uSc, uScH, uScT;
uniform vec2 uDeckOff, uScOff;
uniform vec3 uMWCol;
uniform mat3 uGal;
vec3 skyC(float v, ivec2 p) {  // ramp level from the ordered dither, blended across the azimuth columns
  int lv = quantI(v, 10, true, p);
  float fx = float(p.x) * 4.0 / float(W - 1);
  int a = min(int(fx), 3);
  vec3 ca = uSkyPal[a * 10 + lv], cb = uSkyPal[(a + 1) * 10 + lv];
  if (ca == cb) return ca / 255.0;
  return srgb(mix(lin(ca / 255.0), lin(cb / 255.0), fx - float(a)));
}
vec3 skyAir(float v, ivec2 p) {  // the sky ramp without dither, in linear light: the colour of the air itself
  float fx = float(p.x) * 4.0 / float(W - 1), fl = clamp(v, 0.0, 9.0);
  int a = min(int(fx), 3), l0 = min(int(fl), 8);
  float u = fx - float(a), f = fl - float(l0);
  vec3 c0 = mix(lin(uSkyPal[a * 10 + l0] / 255.0), lin(uSkyPal[(a + 1) * 10 + l0] / 255.0), u);
  vec3 c1 = mix(lin(uSkyPal[a * 10 + l0 + 1] / 255.0), lin(uSkyPal[(a + 1) * 10 + l0 + 1] / 255.0), u);
  return mix(c0, c1, f);
}
vec3 scCell(vec2 p) {           // stratocumulus cells: distances to the nearest two cell centres, and the nearest one's depth
  vec2 i = floor(p), f = p - i;
  float d1 = 9.0, d2 = 9.0, depth = 0.0;
  for (int dy = -1; dy <= 1; dy++) for (int dx = -1; dx <= 1; dx++) {
    ivec2 q = ivec2(i) + ivec2(dx, dy);
    float h1 = latH(q.x, q.y, 521), h2 = latH(q.x, q.y, 522), h3 = latH(q.x, q.y, 523);
    // each centre wanders within its cell, so cells slowly swell, merge and part
    vec2 o = 0.5 + 0.36 * vec2(sin(uScT * (0.6 + 0.4 * h3) + 6.283 * h1), cos(uScT * (0.5 + 0.5 * h1) + 6.283 * h2));
    vec2 r = vec2(float(dx), float(dy)) + o - f;
    float d = dot(r, r);
    if (d < d1) { d2 = d1; d1 = d; depth = h3; } else if (d < d2) d2 = d;
  }
  return vec3(sqrt(d1), sqrt(d2), depth);
}
float milky(ivec2 p) {         // the Milky Way: a band along the galactic equator, brightest toward Sagittarius
  vec3 d = normalize(vec3((float(p.x) + 0.5 - float(W) / 2.0) / F, 1.0, (HY - float(p.y) + 0.5) / F));
  vec3 g = uGal * d;           // x toward the galactic centre, z toward the north galactic pole
  float b = asin(clamp(g.z, -1.0, 1.0)), l = atan(g.y, g.x);
  float core = exp(-l * l / 0.9);
  float band = exp(-b * b / (0.035 * (1.0 + 1.5 * core)));
  float dust = vnH(l * 9.0 + 300.0, b * 30.0 + 300.0, 419);
  float rift = (l > -0.2 && l < 1.1) ? 0.6 * (1.0 - smoothstep(0.0, 0.08, abs(b + 0.02))) : 0.0;
  float am = 1.0 / (d.z + 0.025 * exp(-11.0 * d.z));          // dimmed through the air mass, 0.2 mag each
  return band * (0.45 + 0.9 * core) * (0.7 + 0.6 * dust) * (1.0 - rift) * pow(10.0, -0.08 * am);
}
const vec3 TINT[4] = vec3[4](vec3(1.0), vec3(0.78, 0.88, 1.0), vec3(1.0, 0.94, 0.8), vec3(1.0, 0.8, 0.62));
float latC(int o, int x, int y) {
  int off = o == 0 ? 0 : (o == 1 ? 15 : 43);
  return texelFetch(uCirrus, ivec2(((x % 512) + 512) % 512, off + y), 0).r;
}
float vnC(float u, float v, int o) {
  float fx0 = floor(u), fy0 = floor(v);
  float fx = u - fx0, fy = v - fy0;
  fx = fx * fx * (3.0 - 2.0 * fx); fy = fy * fy * (3.0 - 2.0 * fy);
  int x0 = int(fx0), y0 = int(fy0);
  return (latC(o, x0, y0) * (1.0 - fx) + latC(o, x0 + 1, y0) * fx) * (1.0 - fy)
       + (latC(o, x0, y0 + 1) * (1.0 - fx) + latC(o, x0 + 1, y0 + 1) * fx) * fy;
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec4 mk = maskAt(p);
  int region = mk.r & 3;
  vec4 cs = texelFetch(uColS, ivec2(p.x, 0), 0);
  float x = float(p.x), y = float(p.y);
  vec3 c = vec3(0.0);
  if (p.y <= int(HY)) {
    float t = clamp(y / HY, 0.0, 1.0);
    float v = pow(t, 1.3) * 8.4 + 0.5 * (1.0 - x / float(W)) * t;
    float vs = v;
    if (p.y < 75 && p.y > 6) {
      float u = (x - uCirrusShift) / 80.0, w = y / 6.0;
      float wisp = (vnC(u, w, 0) + 0.5 * vnC(2.0 * u, 2.0 * w, 1) + 0.25 * vnC(4.0 * u, 4.0 * w, 2)) / 1.75;
      if (wisp > uCirrusThr) vs = v + 1.0 + (wisp - uCirrusThr) * 10.0;
    }
    c = skyC(vs, p);
    ivec4 ov = ivec4(round(texelFetch(uOver, p, 0) * 255.0));
    // night: stars (overlay G = brightness, B = colour) and the Milky Way, added in linear light
    if (vs == v && (ov.g > 0 || uMW > 0.0)) {
      vec3 l = lin(c);
      if (uMW > 0.0) l += uMWCol * (uMW * milky(p));
      if (ov.g > 0) l += TINT[ov.b & 3] * (uStarK * float(ov.g) / 255.0);
      c = srgb(l);
    }
    // a cloud deck: a noise field on a plane uDeckH up, drifting with the wind, seen in perspective.
    // Near the horizon its pattern gets finer than the pixels, so it gives way to its mean: the
    // mean shade over the share of sky the deck covers
    bool decked = false;
    float deckCover = 0.0;
    if (uDeck > 0.0) {
      float e = (HY - y + 0.5) / F, dist = uDeckH / e;
      float fade = smoothstep(0.25, 1.0, dist / (F * e) / 650.0), thr = mix(0.85, 0.15, uDeck);
      float cover = smoothstep(-0.15, 0.15, 0.5 + 0.35 * (uDeck - 0.3) - thr);
      deckCover = cover;
      vec3 l = lin(c), near = l;
      bool hit = false;
      if (fade < 1.0) {
        vec2 wp = (vec2((x + 0.5 - float(W) / 2.0) / F * dist, dist) - uDeckOff) / 2600.0;
        float n = (vnH(wp.x, wp.y, 311) + 0.5 * vnH(2.0 * wp.x, 2.0 * wp.y, 312) + 0.25 * vnH(4.0 * wp.x, 4.0 * wp.y, 313)) / 1.75;
        float d = (n - thr) / 0.25;
        hit = d > 0.0 && (d > 0.2 || d * 5.0 > bay(p));
        if (hit) near = lin(uDeckPal[quantI(6.0 - 5.0 * clamp(d, 0.0, 1.0), 7, true, p)] / 255.0);
      }
      if (hit || fade > 0.0) {
        c = srgb(mix(near, mix(l, lin(uDeckPal[3] / 255.0), cover), fade));
        decked = fade < 0.5 ? hit : cover > 0.5;
      }
    }
    // stratocumulus: a low layer uScH up of rounded cells about a kilometre across, drifting with
    // the wind. From below a cell is darkest at its thick core and pale at its thin rim; the seams
    // between cells show what is above. Seen lower, the cells' own depth (a few hundred metres)
    // hides the seams, and near the horizon the layer gives way to its mean, as the deck does
    if (uSc > 0.0) {
      float e = (HY - y + 0.5) / F, dist = uScH / e, mpp = dist / (F * e);
      float fade = smoothstep(0.2, 1.0, mpp / 450.0);
      float thr = mix(0.55, -0.12, smoothstep(0.0, 1.0, uSc)) - 0.25 * smoothstep(0.0, 1.0, mpp / 250.0);
      float cover = clamp(1.05 * uSc, 0.0, 1.0);
      vec3 l = lin(c), near = l;
      bool hit = false;
      if (fade < 1.0) {
        vec2 wp = (vec2((x + 0.5 - float(W) / 2.0) / F * dist, dist) - uScOff) / 1000.0;
        vec3 cc = scCell(wp);
        float rim = cc.y - cc.x + 0.3 * (vnH(3.0 * wp.x, 3.0 * wp.y, 524) - 0.5);   // distance from the seam, frayed
        float tk = (rim - thr) / 0.45;
        hit = tk > 0.0 && (tk > 0.25 || 4.0 * tk > bay(p));
        if (hit) near = lin(uDeckPal[quantI(6.0 - 5.5 * clamp(tk * (0.55 + 0.6 * cc.z), 0.0, 1.0), 7, true, p)] / 255.0);
      }
      if (hit || fade > 0.0) {
        c = srgb(mix(near, mix(l, lin(uDeckPal[3] / 255.0), cover), fade));
        decked = decked || (fade < 0.5 ? hit : cover > 0.5);
        deckCover = max(deckCover, cover);
      }
    }
    // cloud overlay: 1..7 an opaque cumulus shade, 8+ a thin one that only lightens the sky
    int cl = ov.r;
    if (cl >= 8) { if (!decked) c = skyC(vs + float(cl - 8) / 16.0, p); }
    else if (cl > 0) c = uCloudPal[cl - 1] / 255.0;
    // weather (overlay B, never set in the still's light): over a cloud, its fading into the air,
    // whose colour is the smooth sky (under a deck, the deck's mean shade); elsewhere a rain shaft,
    // rain in the cloud's shadow, darkening the sky toward the cloud's shaded side
    if (ov.b >= 4) {
      vec3 air = mix(skyAir(v, p), lin(uDeckPal[3] / 255.0), deckCover);
      c = srgb(mix(lin(c), cl > 0 ? air : lin(uCloudPal[0] / 255.0), float(ov.b - 4) / 251.0));
    }
    vec4 bank = texelFetch(uColD, ivec2(p.x, 1), 0);
    float bottom = HY - 2.0;
    if (bottom - y < bank.x && y <= bottom) {
      float below = bank.x - (bottom - y);
      float bv = below <= 1.0 ? 6.0 - (bank.y < -0.2 ? 1.0 : 0.0) : 4.4;
      if (below > 3.0) bv = 3.6;
      c = uBankPal[quantI(bv, 7, false, p)] / 255.0;
    }
  } else if (region == 1 || region == 2) {
    vec3 sx = seaXZ(p);
    vec2 foot = vec2(sx.y / F, sx.y * sx.y / (F * CAM_H));
    float rough = compSum(uRough, uNRough, sx.xy, foot, true);
    if (region == 1) {
      float r = y - HY;
      float fade = clamp((r - 3.0) / 16.0, 0.0, 1.0);
      float toReef = max(cs.x - y, 0.0);
      float v = 1.25 + 5.6 * exp(-(r - 1.0) / 2.3) + 2.4 * exp(-toReef / 4.5);
      float tex = -0.5 * rough + uSwellReflect * compSum(uSwell, uNSwell, sx.xy, foot, true)
                + uReflect * compSum(uChop, uNChop, sx.xy, foot, true);
      float s = y - cs.x;
      float face = (s >= -3.5 && s < -1.0) ? -1.6 * texelFetch(uColD, ivec2(p.x, 0), 0).w : 0.0;
      c = quantC(v + fade * tex + face, DEEPP, 9, true, p);
    } else {
      float shim = uReflect * compSum(uChopL, uNChopL, sx.xy, foot, true) - 0.25 * rough;
      c = quantC(fieldV(uFieldA, p) + shim, LAGP, 8, false, p);
      if ((mk.g & 2) != 0) c = quantC(fieldV(uFieldB, p) + 0.6 * shim, CORP, 5, false, p);
      if ((mk.g & 4) != 0) c = quantC(7.0 + shim, LAGP, 8, false, p);
    }
  }
  o = vec4(c, 1.0);
}`;

  // P2/P3 and P5/P6: a pixel differing from 3+ agreeing neighbours takes their colour
  const FS_DESPECKLE =
    PRE +
    `
uniform sampler2D uSrc;
uniform int uLand;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 cur = texelFetch(uSrc, p, 0);
  int region = maskAt(p).r & 3;
  bool allow = uLand == 1 ? region == 3 : (region == 1 || region == 2);
  if (!allow) { o = cur; return; }
  ivec3 k = rgb8(cur);
  ivec3 up = rgb8(texelFetch(uSrc, ivec2(p.x, (p.y + H - 1) % H), 0));
  ivec3 dn = rgb8(texelFetch(uSrc, ivec2(p.x, (p.y + 1) % H), 0));
  ivec3 lf = rgb8(texelFetch(uSrc, ivec2((p.x + W - 1) % W, p.y), 0));
  ivec3 rt = rgb8(texelFetch(uSrc, ivec2((p.x + 1) % W, p.y), 0));
  if (up == dn && dn == lf && k != up) k = up;
  if (up == dn && dn == rt && k != up) k = up;
  if (up == lf && lf == rt && k != up) k = up;
  if (dn == lf && lf == rt && k != dn) k = dn;
  o = vec4(vec3(k) / 255.0, 1.0);
}`;

  // P4: whitecaps, surf, wet rock, island, then the grass swaying in the gusts
  const FS_SEA2 =
    PRE +
    `
uniform sampler2D uSrc, uColS, uColD, uOver, uFieldA, uFieldB, uIsle;
uniform vec4 uGust[12];
uniform int uNGust;
uniform float uLap, uBore;
uniform ivec2 uTrailY;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec3 c = texelFetch(uSrc, p, 0).rgb;
  ivec4 mk = maskAt(p);
  int region = mk.r & 3;
  ivec4 ov = ivec4(round(texelFetch(uOver, p, 0) * 255.0));
  float y = float(p.y);
  if (region == 1 || region == 2) {
    if (ov.b == 1) c = pal(WHP + 6); else if (ov.b == 2) c = pal(WHP + 5);
    else if (ov.b == 3) c = pal(WHP + 4); else if (ov.b == 4) c = pal(DEEPP + 7);
    vec4 cs = texelFetch(uColS, ivec2(p.x, 0), 0);
    float reef = texelFetch(uColS, ivec2(p.x, 1), 0).x;
    vec4 cd = texelFetch(uColD, ivec2(p.x, 0), 0);
    float tau = cd.x, amp = cd.y, s = y - cs.x;
    float inten = amp * reef * (0.5 + 0.5 * exp(-tau / 2.5));
    if (s >= -1.0 && s < 0.2 && cs.z > 1.0 - 1.2 * inten) c = pal(WHP + 6);
    if (s >= 0.2 && s < 1.4 && cs.z > 1.1 - 1.0 * inten) c = pal(WHP + 5);
    float sp = clamp(tau / 0.7, 0.0, 1.0);
    if (tau < 0.7 && s >= -1.0 - 3.5 * sp && s < -1.0 && cs.w > 0.5 + 0.45 * sp) c = pal(WHP + 5);
    if (region == 2 && p.y >= uTrailY.x && p.y < uTrailY.y && s >= 1.4 && s < 6.0) {
      vec3 sx = seaXZ(p);
      float zb = sx.y + uBore * tau;
      int seed = 73 + 7 * int(round(cd.z));
      float u = sx.x / 3.0, v = zb / 5.0;
      float trail = (vnH(u, v, seed) + 0.5 * vnH(2.0 * u, 2.0 * v, seed + 101)) / 1.5;
      float ires = amp * reef * exp(-tau / 5.0);
      if (trail > 0.58 + 0.035 * s - 0.15 * (ires - 0.3)) c = pal(LAGP + 7);
    }
    if ((mk.g & 16) != 0) c = pal(ROCKP + 1);
    if ((mk.g & 32) != 0) c = pal(ROCKP + 2);
    if ((mk.g & 64) != 0 && cos(0.9 * float(p.x) / 7.0 - uLap) > -0.3) c = pal(WHP + 5);
    if ((mk.g & 1) != 0) c = texelFetch(uIsle, p, 0).rgb;
  }
  if (ov.a == 1) c = pal(WHP + 6); else if (ov.a == 2) c = pal(WHP + 5);
  if (region == 3) {
    float d = compSum(uGust, uNGust, ground(p), vec2(0.0), false);
    c = quantC(fieldV(uFieldA, p) + SHEEN * d, GRP, 9, false, p);
    if ((mk.g & 8) != 0) c = quantC(fieldV(uFieldB, p) + SHEEN * d, STRP, 4, false, p);
  }
  o = vec4(c, 1.0);
}`;

  // P7: fixed overlays around the blades, contact shadows that follow the moving grass
  const FS_COMPOSE =
    PRE +
    `
uniform sampler2D uSrc, uOver, uFieldA, uC1, uC2, uPost;
uniform vec4 uGust[12];
uniform int uNGust;
vec3 shadow(ivec2 p) {
  float gv = fieldV(uFieldA, p) + SHEEN * compSum(uGust, uNGust, ground(p), vec2(0.0), false);
  return quantC(gv - 2.4, GRP, 9, false, p);
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec3 c = texelFetch(uSrc, p, 0).rgb;
  ivec4 mk = maskAt(p);
  ivec4 ov = ivec4(round(texelFetch(uOver, p, 0) * 255.0));
  int t1 = (mk.r >> 2) & 3, t2 = (mk.r >> 4) & 3;
  if (t1 == 1) c = shadow(p); else if (t1 == 2) c = texelFetch(uC1, p, 0).rgb;
  if (p.y > int(HY) && ov.r > 0) c = pal(GRP + ov.r - 1);
  if (t2 == 1) c = shadow(p); else if (t2 == 2) c = texelFetch(uC2, p, 0).rgb;
  if ((mk.g & 128) != 0) {
    ivec3 k = rgb8(vec4(c, 1.0));
    int best = 0, bd = 1 << 30;
    for (int i = 0; i < 9; i++) {
      ivec3 g = ivec3(uPal[GRP + i]);
      ivec3 dd = abs(k - g);
      int dist = dd.r + dd.g + dd.b;
      if (dist < bd) { bd = dist; best = i; }
    }
    c = pal(GRP + max(best - 2, 0));
  }
  if (((mk.r >> 6) & 1) == 1) c = texelFetch(uPost, p, 0).rgb;
  if (p.y > int(HY) && ov.g > 0) c = pal(GRP + ov.g - 1);     // on sky rows G carries the stars
  o = vec4(c, 1.0);
}`;

  // P8: the light of the moment on everything the sky passes did not already colour: land and
  // structures by the ground illuminance, the sea by a Fresnel mix of that and the reflected
  // horizon sky, haze with distance; then the lighthouse lamp, rain and lightning
  const FS_GRADE =
    PRE +
    `
uniform sampler2D uSrc;
uniform int uRef;
uniform vec3 uLandG, uReflG, uHaze, uLampCol, uRainCol;
uniform float uVis, uSeaDesat, uLamp, uHalo, uHaloR, uRain, uRainT, uRainSlant, uFlash;
uniform float uGlass, uHaloK, uHaloS, uBeamK, uBeamB, uBeamPhi, uBeamI;
uniform vec2 uBeamA;
uniform vec3 uLant;
uniform sampler2D uC1, uC2;
uniform float uWet, uPool;
uniform vec3 uSkyRefl;
// A lighthouse beam: a cone from the lantern (uLant, in metres: x east, y up, z north of the eye)
// turned to azimuth phi, 1 m across at the lens and spreading 1.5° wide and 1.7° tall, Gaussian
// across. Its cross-section s metres out, for a point off the axis by off: the half-widths rh and
// rv, and q, the squared offset in them (beyond 24 the beam counts as nothing)
vec3 beamCS(float s, vec3 off) {
  float rh = 0.026 * (s + 38.0), rv = 0.03 * (s + 33.0);
  float q = off.y * off.y / (rv * rv) + (dot(off, off) - off.y * off.y) / (rh * rh);
  return vec3(rh, rv, q);
}
// the light it scatters toward the eye: its irradiance falls as the cross-section grows; along the
// view ray it is integrated over the chord, and the air scatters it by a Henyey–Greenstein phase
// function (g = 0.7, sea-air haze and drops). Behind whatever the ray, along the unit vector v from
// the eye, meets first (tHit) the beam is hidden
float beamRay(vec3 v, float tHit, float phi) {
  vec3 d = vec3(sin(phi), 0.0, cos(phi)), w0 = -uLant;
  float b = dot(v, d), dd = dot(v, w0), e = dot(d, w0), den = max(1.0 - b * b, 1e-4);
  float t = (b * e - dd) / den, s = (e - b * dd) / den;
  if (s < 0.0) { s = 0.0; t = -dd; }          // nearest the lens itself, where the beam starts
  if (t <= 0.0 || t > tHit) return 0.0;
  vec3 cs = beamCS(s, w0 + t * v - s * d);
  if (cs.z > 24.0) return 0.0;
  float gg = 0.7, hg = (1.0 - gg * gg) / (12.566 * pow(1.0 + gg * gg + 2.0 * gg * b, 1.5));
  return hg * exp(-cs.z) * exp(-uBeamB * (t + s)) / (sqrt(cs.x * cs.y) * max(sqrt(den), 0.05));
}
// the beam's light falling on the sea at P (metres from the eye): the irradiance of the cone there,
// on level water, returned as the light a surface of albedo 1 sends back (÷π)
float beamOn(vec3 P, float phi) {
  vec3 d = vec3(sin(phi), 0.0, cos(phi)), w = P - uLant;
  float s = dot(w, d);
  if (s <= 0.0) return 0.0;
  vec3 cs = beamCS(s, w - s * d);
  if (cs.z > 24.0) return 0.0;
  return exp(-cs.z) * exp(-uBeamB * (s + length(P))) / (cs.x * cs.y) * (-w.y / length(w)) / 3.14159265;
}
float rainLayer(ivec2 p, int k) {
  float fk = float(k), sl = uRainSlant * (0.55 + 0.25 * fk);
  float xs = float(p.x) - sl * float(p.y);
  float cw = 5.0 - 1.5 * fk;
  int col = int(floor(xs / cw));
  float h = latH(col, 17 + k, 520 + k);
  float per = 60.0 + 60.0 * h, spd = (240.0 + 170.0 * fk) * (0.85 + 0.3 * h);
  float yy = float(p.y) - spd * uRainT + 997.0 * h;
  float cyc = floor(yy / per), ph = yy - cyc * per;
  if (abs(xs - (float(col) + 0.5) * cw) > 0.5) return 0.0;
  if (ph >= 2.0 + 2.5 * fk) return 0.0;
  return latH(int(cyc), col, 530 + k) < uRain * (0.35 + 0.2 * fk) ? 0.16 + 0.1 * fk : 0.0;
}
// the Fresnel reflectance of water at incidence cosine ci (Schlick): the sea's reflected sky and
// a wet surface's sheen
float fres(float ci) { return 0.02 + 0.98 * pow(1.0 - ci, 5.0); }
// ITU-R BT.709 relative luminance
float luma(vec3 x) { return dot(x, vec3(0.2126, 0.7152, 0.0722)); }
// Wet ground. Under a water film, light a rough surface scatters back is partly turned back again
// by total internal reflection at the film's top and has another chance to be absorbed (Lekner &
// Dorf 1988), so albedo a becomes (1 − re)(1 − ri)·a/(1 − ri·a) with re ≈ 0.066 and ri ≈ 0.47 for
// water: darker, and most in the darkest colours, so the colour deepens. The still's colour stands
// in for the albedo. The film's surface mirrors the sky (Schlick, at this row's angle on level
// ground; the boulders are taken as level too). Stone, the path and the boulders, is filmed all
// over; grass holds water on about half its blades (chosen), whose lit upper shades take the
// sheen: a blade's film sends its re every way and about half of that sees the sky, so 0.033 of
// the sky. Pools stand in hollows of the path fixed on the ground, the deepest first: none when
// empty, 38 % of it when full (chosen). In rain drops splash, most visibly on stone and near the
// eye (their number is chosen for the look).
vec3 wetGround(ivec2 p, ivec4 mk, vec3 c, vec3 lc, vec3 l) {
  if (((mk.r >> 6) & 1) == 1) return l;                                      // the post
  ivec3 k8 = rgb8(vec4(c, 1.0));
  if ((mk.b & 2) != 0 && k8 == rgb8(texelFetch(uC2, p, 0))) return l;        // tower, hut, apron, fence
  bool path = (mk.b & 1) != 0 && k8 == rgb8(texelFetch(uC1, p, 0));
  bool stone = path || ((mk.b & 4) != 0 && k8 == rgb8(texelFetch(uC2, p, 0)));   // or a boulder
  float y = float(p.y), dep = (y + 0.5 - HY) / F, ci = dep / sqrt(1.0 + dep * dep);
  float R = fres(ci);
  if (uWet > 0.0) {
    vec3 a = max(lc, vec3(1e-4));
    float cover = uWet * (stone ? 1.0 : 0.5);
    l *= mix(vec3(1.0), 0.491 / (1.0 - 0.474 * a), cover);
    if (stone) l += cover * 0.6 * R * uSkyRefl;                                  // a thin film on rough stone
    else l += cover * smoothstep(0.03, 0.12, luma(a)) * 0.033 * uSkyRefl;
  }
  if (path && uPool > 0.0) {
    vec2 g = ground(p);
    float hol = (vnH(g.x * 1.6, g.y * 1.1, 811) + 0.5 * vnH(g.x * 4.0, g.y * 2.7, 812)) / 1.5;
    if (hol > 0.89 - 0.33 * uPool) l = (1.0 - R) * 0.8 * l + R * uSkyRefl;
  }
  if (uRain > 0.0 && p.y > 228) {
    float slot = floor(uRainT * 20.0 + 64.0 * latH(p.x, p.y, 541));
    float h = float(hash3(uint(p.x), uint(p.y), uint(slot) * 7919u + 543u) >> 8) / 16777216.0;
    float pr = uRain * (stone ? 0.02 : 0.006) * smoothstep(228.0, 330.0, y);
    if (h < pr) l = mix(l, uRainCol * 1.1, 0.55);
  }
  return l;
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec3 c = texelFetch(uSrc, p, 0).rgb;
  if (uRef == 1) { o = vec4(c, 1.0); return; }
  ivec4 mk = maskAt(p);
  int region = mk.r & 3;
  bool layer = ((mk.r >> 2) & 15) != 0 || ((mk.r >> 6) & 1) == 1;
  bool sky = p.y <= int(HY) && region == 0 && !layer;
  bool seaPix = (region == 1 || region == 2) && !layer && (mk.g & 1) == 0;
  float y = float(p.y);
  vec3 lc = lin(c), l = lc;
  if (!sky) {
    float z = 0.0;
    if (seaPix) {
      float sg = (y - HY) / F, cs = sg / sqrt(1.0 + sg * sg);
      float R = fres(cs);         // Schlick, at the grazing angle of this row
      l *= mix(uLandG, uReflG, R);
      l = mix(l, vec3(luma(l)), uSeaDesat);
      z = F * CAM_H / max(y - HY, 0.5);
    } else {
      l *= uLandG;
      if ((mk.g & 1) != 0) z = F * CAM_H / max(y - HY, 0.5);   // the island out on the sea
      if (region == 3 && (uWet > 0.0 || uPool > 0.0 || uRain > 0.0)) l = wetGround(p, mk, c, lc, l);
    }
    if (z > 0.0) l = mix(l, lin(uHaze / 255.0), 1.0 - exp(-z / uVis));
  }
  if (uLamp > 0.0) {           // the lantern: on and off in 明3秒暗3秒; with the turning beams, a dim steady glow behind the screen
    vec2 d = (vec2(p) + 0.5 - vec2(213.0, 121.5)) * vec2(1.0, 1.4);
    bool glass = p.x >= 207 && p.x <= 218 && p.y >= 120 && p.y <= 123 && rgb8(vec4(c, 1.0)) == ivec3(uPal[ROCKP]);
    float hr = uHaloR * uHaloS;
    if (glass) l = mix(l, uLampCol, min(uLamp * uGlass * 1.5, 1.0));
    else l += uLampCol * (uLamp * uHalo * uHaloK * exp(-dot(d, d) / (2.0 * hr * hr)));
  }
  if (uBeamK > 0.0) {
    vec3 v = normalize(vec3((float(p.x) + 0.5 - float(W) / 2.0) / F, (HY - y - 0.5) / F, 1.0));
    float tHit = 1e9;
    if (layer) tHit = uLant.z / v.z;                              // the tower, fence and path
    else if (!sky) tHit = F * (region == 3 ? EYE : CAM_H) / max(y + 0.5 - HY, 0.5) / v.z;
    float a0 = uBeamA.x > 0.0 ? uBeamA.x * beamRay(v, tHit, uBeamPhi) : 0.0;
    float a1 = uBeamA.y > 0.0 ? uBeamA.y * beamRay(v, tHit, uBeamPhi + 3.14159265) : 0.0;
    // On the sea: the lamp is not mirrored, as the eye and the lantern stand on the same side of the
    // water at nearly the same height and no wave is steep enough to join them; the glow of the beams
    // in the air is, but only its far parts land on the visible sea, too faint to show (computed and
    // left out). What reaches the sea is the beam's lower edge, far out: it lights the water, the
    // foam most (the still's colour stands in for the albedo)
    float lit = 0.0;
    if (seaPix && v.y < 0.0) {
      vec3 P = v * (CAM_H / -v.y);
      float on = (uBeamA.x > 0.0 ? uBeamA.x * beamOn(P, uBeamPhi) : 0.0)
               + (uBeamA.y > 0.0 ? uBeamA.y * beamOn(P, uBeamPhi + 3.14159265) : 0.0);
      lit = uBeamI * on * luma(lc);
    }
    // On a dark wet night the beam is hundreds of times brighter than the land the eye is adapted
    // to; like the eye (and film) its highlights roll off, to at most 0.35 (chosen) instead of
    // clipping. Then in half-stop steps, dithered between them, like the rest of the picture's light
    float a = uBeamK * (a0 + a1) + lit;
    a = 0.35 * (1.0 - exp(-a / 0.35));
    if (a > 0.004) l += uLampCol * exp2(floor(2.0 * log2(a) + bay(p)) / 2.0);
  }
  if (uRain > 0.0) {
    float a = max(rainLayer(p, 0), max(rainLayer(p, 1), rainLayer(p, 2)));
    l = mix(l, uRainCol, a);
  }
  if (uFlash > 0.0) l += vec3(0.8, 0.85, 1.0) * (uFlash * (sky ? 0.45 : 0.14));
  o = vec4(srgb(l), 1.0);
}`;

  // P8: nearest-neighbour upscale that covers the screen; integer scale when it costs little crop
  const FS_PRESENT = `#version 300 es
precision highp float; precision highp int; precision highp sampler2D;
uniform sampler2D uSrc;
uniform vec2 uCanvas, uOff;
uniform float uScale;
out vec4 o;
void main() {
  vec2 q = vec2(gl_FragCoord.x, uCanvas.y - gl_FragCoord.y);
  ivec2 s = ivec2(floor((q - uOff) / uScale));
  s = clamp(s, ivec2(0), ivec2(${W - 1}, ${H - 1}));
  o = vec4(texelFetch(uSrc, s, 0).rgb, 1.0);
}`;

  function program(fs) {
    const p = gl.createProgram();
    for (const [type, src] of [
      [gl.VERTEX_SHADER, VS],
      [gl.FRAGMENT_SHADER, fs],
    ]) {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      gl.attachShader(p, s);
    }
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const loc = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const name = gl.getActiveUniform(p, i).name.replace(/\[0\]$/, "");
      loc[name] = gl.getUniformLocation(p, name);
    }
    return { p, loc };
  }

  let P;
  try {
    P = {
      base: program(FS_BASE),
      desp: program(FS_DESPECKLE),
      sea2: program(FS_SEA2),
      comp: program(FS_COMPOSE),
      grade: program(FS_GRADE),
      present: program(FS_PRESENT),
    };
  } catch (e) {
    fail("描画の準備に失敗しました（シェーダー）。" + e.message);
    console.error(e);
    return;
  }
  const vao = gl.createVertexArray();
  const RT = [target(), target()];

  // static textures
  const TX = {};
  const colS = new Float32Array(W * 3 * 4);
  for (let x = 0; x < W; x++) {
    colS.set([CS[x], CS[W + x], CS[2 * W + x], CS[3 * W + x]], x * 4);
    colS.set([CS[4 * W + x], 0, 0, 0], (W + x) * 4);
  }
  TX.colS = texture(W, 3, gl.RGBA32F, gl.RGBA, gl.FLOAT, colS);
  const colD = new Float32Array(W * 2 * 4);
  TX.colD = texture(W, 2, gl.RGBA32F, gl.RGBA, gl.FLOAT, colD);
  const over = new Uint8Array(W * H * 4);
  TX.over = texture(W, H, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, over);
  {
    const rows = D.cirrus.map(dec),
      buf = new Float32Array(512 * 96);
    let off = 0;
    for (const r of rows) {
      buf.set(r, off);
      off += r.length;
    }
    TX.cirrus = texture(512, 96, gl.R32F, gl.RED, gl.FLOAT, buf);
  }

  // ------------------------------------------------------------------ wave and gust inputs
  function compSet(mode) {
    const c = D.comps[mode];
    return {
      rough: c.rough,
      swell: c.swell,
      chop: c.chop,
      chopL: c.chopL,
      gust: c.gust,
      flutter: c.flutter,
    };
  }
  // temporal phase of a component: exact modulo the loop in "loop" mode, plain ω·t otherwise
  function tphase(n, mode, i, t) {
    return mode === "loop" ? (TAU * ((n * i) % N)) / N : mod2pi(((TAU * n) / T) * t);
  }
  function packUniform(rows, mode, i, t, out, gain = 1) {
    for (let j = 0; j < rows.length; j++) {
      const r = rows[j]; // kx, kz, A, phase, n, atten, sin
      out[4 * j] = r[0];
      out[4 * j + 1] = r[1];
      out[4 * j + 2] = r[2] * gain;
      out[4 * j + 3] = mod2pi(r[3] - tphase(r[4], mode, i, t) - (r[6] ? Math.PI / 2 : 0));
    }
    return out;
  }
  function pointSum(rows, X, Z, mode, i, t) {
    // same sum as hl.Advected, at one point, in float64
    let s = 0;
    for (const r of rows)
      s += r[2] * Math.cos(r[0] * X + r[1] * Z - tphase(r[4], mode, i, t) + r[3]);
    return s;
  }

  // ------------------------------------------------------------------ surf timing per column
  const SW_N = C.SWELL_N,
    SW_OM = (TAU * SW_N) / T,
    SET_AMP = C.SET_AMP;
  const tauR = new Float64Array(W),
    ampR = new Float64Array(W),
    mR = new Int32Array(W);
  const tauI = new Float64Array(W),
    ampI = new Float64Array(W);
  function loopTiming(kx, i, tau, amp, mm) {
    // hl.Surf.timing
    const ph = D.comps.loop.swell[0][3];
    const cyc = Math.floor((SW_N * i) / N),
      frac = (SW_N * i) % N;
    for (let c = 0; c < W; c++) {
      const u = (2 * Math.PI * frac) / N - kx[c] - ph;
      tau[c] = mod2pi(u) / SW_OM;
      const m = (((cyc + Math.floor(u / TAU)) % 3) + 3) % 3;
      amp[c] = SET_AMP[m];
      if (mm) mm[c] = m;
    }
    return SW_OM;
  }
  const LIVE_SWELL = D.comps.live.swell;
  const SW0 = LIVE_SWELL.reduce((a, r) => (r[7] > a[7] ? r : a));
  const SW0_OM = (TAU * SW0[4]) / T;
  // every crest that reaches a column gets its own number, so the foam it leaves never repeats
  const crest = { n: new Float64Array(W), last: new Float64Array(W), t: NaN };
  function groupTiming(X, Z, t, tau, amp, mm, lo, hi) {
    // η = Re Σ w_j e^{iψ_j} = |B| cos(ψ0 + arg B): crests arrive when ψ0 + arg B ≡ 0,
    // and |B| is the wave-group envelope that makes the sets
    const fresh = mm && !(Math.abs(t - crest.t) < 1); // first frame or a jump in time
    if (mm) crest.t = t;
    for (let c = lo; c < hi; c++) {
      const x = X[c],
        z = typeof Z === "number" ? Z : Z[c];
      let br = 0,
        bi = 0;
      for (const r of LIVE_SWELL) {
        const om = (TAU * r[4]) / T;
        const a = (r[0] - SW0[0]) * x + (r[1] - SW0[1]) * z - mod2pi((om - SW0_OM) * t) + r[3];
        br += r[7] * Math.cos(a);
        bi += r[7] * Math.sin(a);
      }
      const u = mod2pi(SW0_OM * t) - (SW0[0] * x + SW0[1] * z) - Math.atan2(bi, br);
      tau[c] = mod2pi(u) / SW0_OM;
      amp[c] = clamp(0.45 + 0.4 * Math.hypot(br, bi), 0.45, 1.15);
      if (mm) {
        if (fresh) crest.n[c] = ((Math.floor(u / TAU) % 3) + 3) % 3;
        else if (tau[c] < crest.last[c] - (0.5 * TAU) / SW0_OM) crest.n[c]++;
        crest.last[c] = tau[c];
        mm[c] = crest.n[c] % 16777216; // stays exact in the float texture
      }
    }
    return SW0_OM;
  }

  // ------------------------------------------------------------------ whitecaps
  const CAP_C = (G * 3.0) / TAU;
  const DEEP_AT = (row, x) => row > HY && row < LAND_Y[x] && row < SURF_Y[x];
  function drawCaps(ev, count, ageOf) {
    const inten = new Float64Array(count),
      yy = new Float64Array(count),
      xx = new Float64Array(count),
      wp = new Float64Array(count);
    for (let j = 0; j < count; j++) {
      const e = ev(j),
        age = ageOf(j);
      const ride = Math.min(age, 0.8),
        along = CAP_C * ride + 0.15 * age;
      const X = e.x0 + (e.wx === undefined ? WIND[0] : e.wx) * along,
        Z = e.z0 + (e.wz === undefined ? WIND[1] : e.wz) * along;
      const y = HY + (F * CAM_H) / Z,
        x = W / 2 + (X * F) / Z;
      const wpx = (e.size * (1 + 0.4 * Math.min(age, 1.5)) * F) / Z;
      inten[j] =
        Math.min(1, age / 0.12) *
        Math.exp(-Math.max(age - 0.8, 0) / e.life) *
        clamp((wpx - 0.35) / 1.0, 0, 1) ** 1.5 *
        clamp((y - HY - 6) / 14, 0, 1);
      yy[j] = y;
      xx[j] = x;
      wp[j] = wpx;
    }
    const order = Array.from({ length: count }, (_, j) => j).sort((a, b) => inten[a] - inten[b]);
    for (const j of order) {
      const it = inten[j];
      if (it < 0.06) continue;
      const row = rhe(yy[j]);
      if (row >= H) continue;
      const half = Math.max(wp[j], 1.0) / 2;
      const code = it > 0.55 ? 1 : it > 0.3 ? 2 : it > 0.14 ? 3 : 4;
      for (let x = rhe(xx[j] - half), x1 = rhe(xx[j] + half); x <= x1; x++) {
        if (x < 0 || x >= W) continue;
        if (!DEEP_AT(row, x) || !(SURF_Y[x] - row > 1.5)) continue;
        over[(row * W + x) * 4 + 2] = code;
      }
    }
  }
  const loopCaps = {
    n: A.caps_z0.length,
    ev: (j) => ({ z0: A.caps_z0[j], x0: A.caps_x0[j], size: A.caps_size[j], life: A.caps_life[j] }),
  };
  const liveCaps = {
    list: [],
    next: -10,
    rnd: mulberry32(4242),
    rate: 700 / 24, // starts from a sea already breaking
    gauss() {
      const u = 1 - this.rnd(),
        v = this.rnd();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v);
    },
    step(t) {
      // breaking is a Poisson process: 700 events per 24 s over the visible open water at the
      // still's wind; whitecap cover grows as U^3.41 (Monahan & O'Muircheartaigh), so the rate does.
      // After a jump in time, skip what would already have faded (memoryless, so still exact)
      if (this.next < t - 10) this.next = t - 10;
      const rate = this.rate * (env.ref ? 1 : mo.kCaps);
      while (this.next <= t) {
        const r = this.rnd;
        const z0 = Math.sqrt(650 ** 2 + r() * (3500 ** 2 - 650 ** 2));
        const ev = {
          z0,
          x0: ((r() * 2.3 - 1.15) * z0 * (W / 2)) / F,
          size: Math.exp(Math.log(5) + 0.5 * this.gauss()),
          life: 1.2 + 1.8 * r(),
          birth: this.next,
        };
        if (!env.ref) {
          const u = Math.hypot(mo.ux, mo.uz) || 1;
          ev.wx = mo.ux / u;
          ev.wz = mo.uz / u;
        }
        this.list.push(ev);
        this.next += -Math.log(1 - r()) / rate;
      }
      this.list = this.list.filter((e) => t - e.birth < 0.8 + 3 * e.life);
    },
  };

  // ------------------------------------------------------------------ island surf
  const ISL = C.ISLAND,
    ISLE_NOISE = A.isle_noise,
    ISLE_X0 = C.isle_x0;
  function drawIsland() {
    const base = ISL.base + 1;
    const put = (x, y, code) => {
      if (x >= 0 && x < W && y >= 0 && y < H) over[(y * W + x) * 4 + 3] = code;
    };
    for (let x = ISLE_X0; x < ISL.x1 + 5; x++) {
      const n = ISLE_NOISE[x - ISLE_X0];
      const ii = ampI[x] * (0.3 + 0.7 * Math.exp(-tauI[x] / 2.0));
      if (n > 1 - 0.9 * ii) put(x, base, n > 1 - 0.5 * ii ? 1 : 2);
      if (x < ISL.x0 + 6 && tauI[x] < 1.0 && n > 0.4) {
        for (let dy = 1; dy <= Math.trunc(3.5 * (1 - tauI[x]) * ampI[x]); dy++)
          put(x - 2, base - dy, 2);
      }
    }
  }

  // ------------------------------------------------------------------ grass blades
  const TUFT = { rx: A.tuft_rx, ry: A.tuft_ry, gx: A.tuft_gx, gz: A.tuft_gz, gv0: A.tuft_gv0 };
  const BLADE = { b: A.blade_b, lean: A.blade_lean, n: A.blade_n, tuft: A.blade_tuft };
  const FG = { x: A.fg_x, y: A.fg_y, le: A.fg_le, n: A.fg_n, c: A.fg_c, gx: A.fg_gx, gz: A.fg_gz };
  const NT = TUFT.rx.length,
    NB = BLADE.b.length,
    NF = FG.x.length;
  const tuftFirst = new Int32Array(NT + 1).fill(-1);
  for (let b = NB - 1; b >= 0; b--) tuftFirst[BLADE.tuft[b]] = b;
  tuftFirst[NT] = NB;
  for (let t = NT - 1; t >= 0; t--) if (tuftFirst[t] < 0) tuftFirst[t] = tuftFirst[t + 1];
  function plotR(x, y, v) {
    if (x >= 0 && x < W && y >= 0 && y < H) over[(y * W + x) * 4] = v;
  }
  function plotG(x, y, v) {
    if (x >= 0 && x < W && y >= 0 && y < H) over[(y * W + x) * 4 + 1] = v;
  }
  function drawBlades(comps, mode, i, t) {
    // the blades lean with the wind across the view (drag ∝ U²) and gust with U; the gust
    // pattern runs on its own clock so a stronger wind sweeps it faster
    const w = mode === "live" && !env.ref;
    const tg = w ? mo.gustT : t,
      kg = w ? mo.kGust : 1,
      m = w ? mo.bend : 1;
    const lo = m >= 0 ? 0.05 : -2.2,
      hi = m >= 0 ? 2.2 : -0.05;
    for (let tu = 0; tu < NT; tu++) {
      // tuft blades, then the dark root pixel
      const gx = TUFT.gx[tu],
        gz = TUFT.gz[tu];
      const gust = pointSum(comps.gust, gx, gz, mode, i, tg) * kg,
        flut = pointSum(comps.flutter, gx, gz, mode, i, tg) * kg;
      const base = clamp(rhe(TUFT.gv0[tu] + SHEEN * gust), 1, 6);
      const bend = clamp(m + 0.45 * gust + 0.25 * flut, lo, hi);
      const rx = TUFT.rx[tu],
        ry = TUFT.ry[tu];
      for (let b = tuftFirst[tu]; b < tuftFirst[tu + 1]; b++) {
        const n = BLADE.n[b],
          lean = BLADE.lean[b],
          b0 = BLADE.b[b];
        for (let k = 0; k < n; k++) {
          plotR(
            rhe(b0 + (lean * bend * k * k) / n),
            ry - k,
            Math.min(base + 1 + (k === n - 1 ? 1 : 0), 8) + 1,
          );
        }
      }
      // the still's root pixel is two shades under the tuft; live, one shade, so that the roots do
      // not read as black dots on a large screen
      plotR(rx, ry + 1, Math.max(base - (w ? 1 : 2), 0) + 1);
    }
    for (let f = 0; f < NF; f++) {
      // foreground blades at the viewer's feet
      const gust = pointSum(comps.gust, FG.gx[f], FG.gz[f], mode, i, tg) * kg;
      const flut = pointSum(comps.flutter, FG.gx[f], FG.gz[f], mode, i, tg) * kg;
      const bend = clamp(m + 0.5 * gust + 0.3 * flut, lo, hi);
      const n = FG.n[f],
        c = FG.c[f];
      for (let k = 0; k < n; k++) {
        const px = rhe(FG.x[f] + (FG.le[f] * bend * k * k) / n),
          py = FG.y[f] - k;
        plotG(px, py, c + 2 * (k > n - 3 ? 1 : 0) + 1);
        plotG(px + 1, py, Math.max(c - 1, 0) + 1);
      }
    }
  }

  // ------------------------------------------------------------------ clouds
  // Trade cumulus share one base 640 m up and ride an 8 m/s south-westerly. Each is placed in
  // 3-D: it drifts right and away, so it shrinks and sinks toward the horizon, and it forms,
  // matures and dissipates. The four clouds of the still start exactly where the still has them.
  const UX = C.U_CLOUD * WIND[0],
    UZ = C.U_CLOUD * WIND[1],
    CB = C.CLOUD_BASE;
  const LIGHT = (() => {
    const l = [-0.55, -0.7, 0.55],
      n = Math.sqrt(l[0] * l[0] + l[1] * l[1] + l[2] * l[2]);
    return l.map((v) => v / n);
  })();
  class Cloud {
    constructor(o) {
      Object.assign(this, o);
      this.sprite = null;
      this.drawnAt = -1;
      this.dx0 = mo.cloudX;
      this.dz0 = mo.cloudZ;
    }
    pose(t) {
      // in the still's wind the drift is U·(t − tb); otherwise it is the wind integrated since birth
      if (env.ref) {
        const dt = t - this.tb,
          Z = this.Z0 + UZ * dt,
          s = this.Z0 / Z;
        return {
          s,
          Z,
          ax: this.ax0 + (this.ax0 - W / 2) * (s - 1) + (F * UX * dt) / Z,
          base: this.base0 + (HY - this.base0) * (1 - s),
        };
      }
      const dx = mo.cloudX - this.dx0,
        Z = this.Z0 + mo.cloudZ - this.dz0,
        s = this.Z0 / Z;
      return {
        s,
        Z,
        ax: this.ax0 + (this.ax0 - W / 2) * (s - 1) + (F * dx) / Z,
        base: this.base0 + (HY - this.base0) * (1 - s),
      };
    }
    life(t) {
      // a forming cumulus swells from about half size while its water content builds; a
      // dissipating one thins out. `water` scales the optical depth: where it is low the cloud
      // is translucent and only lightens the sky, and the white body grows out from the core.
      // A cumulonimbus instead rises: its tower climbs from the base (rise) at full density
      const u = this.grow ? smooth01((t - this.tb) / this.grow) : 1;
      const v = this.decayAt == null ? 0 : smooth01((t - this.decayAt) / this.decayDur);
      if (this.kind === "cb") return { size: 1 - 0.35 * v, water: 1 - v, rise: 0.15 + 0.85 * u };
      return {
        size: (0.55 + 0.45 * u) * (1 - 0.35 * v),
        water: Math.min(this.grow ? smooth01((t - this.tb) / (0.6 * this.grow)) : 1, 1 - v),
      };
    }
    raster(t) {
      const { s, ax, base } = this.pose(t),
        { size, water } = this.life(t);
      const dx = ax - this.ax0,
        dy = base - this.base0,
        inv = 1 / s - 1;
      // env-mode kinds may flatten their puffs (ky), fray them (rag, baseRag) and shade darker
      const rag = this.rag ?? 1,
        br = this.baseRag ?? 1,
        vb = this.vb ?? 1.5,
        vs = this.vs ?? 5.0;
      let pf = this.puffs.map((q, j) => {
        const [cx, cy, r] = q;
        const g =
          1 +
          0.14 *
            (n1(t / this.evo[j][0] + this.evo[j][1], this.seed + j) -
              n1(this.evo[j][1], this.seed + j));
        return [
          cx + dx + (s - 1) * (cx - this.ax0),
          cy + dy + (s - 1) * (cy - this.base0),
          r * s * g * size,
          q[3] || 1,
        ];
      });
      if (this.kind === "cb") {
        // only the turrets the rising tower has reached
        const lim = this.life(t).rise * this.hTop;
        pf = pf.filter((p, j) => this.base0 - this.puffs[j][1] <= lim);
        if (!pf.length) {
          this.sprite = null;
          this.shaft = null;
          return;
        }
      }
      let x0 = W,
        x1 = 0,
        y0 = H,
        y1 = 0,
        top = Infinity;
      for (const [cx, cy, r, ky] of pf) {
        x0 = Math.min(x0, Math.max(Math.trunc(cx - r - 3), 0));
        x1 = Math.max(x1, Math.min(Math.trunc(cx + r + 4), W));
        y0 = Math.min(y0, Math.max(Math.trunc(cy - r - 3), 0));
        y1 = Math.max(y1, Math.min(Math.trunc(cy + r + 4), H));
        top = Math.min(top, cy - r * ky);
      }
      this.shaft = this.rainK ? this.rasterShaft(t, ax, base, s, size) : null;
      if (x1 <= x0 || y1 <= y0 || y0 > HY) {
        this.sprite = null;
        return;
      }
      const gx0 = Math.max(x0 - 8, 0),
        gy0 = Math.max(y0 - 8, 0);
      const gw = Math.min(x1 + 8, W) - gx0,
        gh = Math.min(y1 + 8, H) - gy0;
      const hgt = new Float64Array(gw * gh);
      const noiseAt = (x, y) => this.noise(x - dx + (x - ax) * inv, y - dy + (y - base) * inv);
      const nzCache = new Float64Array(gw * gh).fill(NaN);
      for (const [cx, cy, r, ky] of pf) {
        if (r <= 0) continue;
        const px0 = Math.max(Math.trunc(cx - r - 3), 0),
          px1 = Math.min(Math.trunc(cx + r + 4), W);
        const py0 = Math.max(Math.trunc(cy - r - 3), 0),
          py1 = Math.min(Math.trunc(cy + r + 4), H);
        for (let y = py0; y < py1; y++)
          for (let x = px0; x < px1; x++) {
            const gi = (y - gy0) * gw + (x - gx0);
            let nz = nzCache[gi];
            if (nz !== nz) nz = nzCache[gi] = noiseAt(x, y);
            const ax_ = (x + 0.5 - cx) / r,
              ay_ = (y + 0.5 - cy) / (r * ky);
            const d2 = ax_ * ax_ + ay_ * ay_ + 0.3 * nz * 2 * rag;
            const h = Math.sqrt(Math.max(1 - d2, 0)) * (r * ky);
            if (h > hgt[gi]) hgt[gi] = h;
          }
      }
      const bl = blur2(hgt, gw, gh);
      const idx = new Uint8Array(gw * gh);
      let hmax = 0;
      if (water < 1) for (let k = 0; k < hgt.length; k++) hmax = Math.max(hmax, hgt[k]);
      const band = 7 * s,
        LT = env.ref || !env.L ? LIGHT : env.L.light;
      for (let y = gy0; y < gy0 + gh && y <= HY; y++)
        for (let x = gx0; x < gx0 + gw; x++) {
          const gi = (y - gy0) * gw + (x - gx0);
          if (!(hgt[gi] > 0)) continue;
          const e = this.edge(x - dx + (x - ax) * inv);
          if (!(y <= base + rhe((e - 0.5) * 2 * br))) continue;
          const depth = water < 1 ? water * (1 + (3 * hgt[gi]) / hmax) : 1; // optical depth, 1 = opaque
          if (depth < 1) {
            idx[gi] = 8 + Math.round(48 * depth);
            continue;
          } // lightens the sky by up to 3 steps
          const lx = x - gx0,
            ly = y - gy0;
          const gxv =
            lx === 0
              ? bl[gi + 1] - bl[gi]
              : lx === gw - 1
                ? bl[gi] - bl[gi - 1]
                : (bl[gi + 1] - bl[gi - 1]) / 2;
          const gyv =
            ly === 0
              ? bl[gi + gw] - bl[gi]
              : ly === gh - 1
                ? bl[gi] - bl[gi - gw]
                : (bl[gi + gw] - bl[gi - gw]) / 2;
          const nl = Math.sqrt(gxv * gxv + gyv * gyv + 1);
          const lit = clamp((-gxv / nl) * LT[0] + (-gyv / nl) * LT[1] + (1 / nl) * LT[2], 0, 1);
          const vert = clamp((base - y) / Math.max(base - top, 1), 0, 1);
          let shade = 0.12 + 0.72 * lit + 0.28 * vert;
          shade -= 0.45 * clamp((y - (base - band)) / band, 0, 1);
          // a deep cloud lets little light through to its lower part: the base darkens over its
          // lowest kilometre or so, the more the thicker the cloud
          if (this.thick) shade -= this.thick * Math.exp((-(base - y) * this.Z0) / (s * F) / 1000);
          const v = clamp(vb + shade * vs, 0, 6);
          idx[gi] = clamp(Math.floor(v + 0.5), 0, 6) + 1;
        }
      this.sprite = { x0: gx0, y0: gy0, w: gw, h: gh, idx };
    }
    rasterShaft(t, ax, base, s, size) {
      // rain falling from the base to the sea: a streaky grey curtain about three quarters as wide
      // as the tower, its foot trailing upwind where the wind near the sea is weaker than aloft
      const hw = 0.38 * this.wb * s * size,
        lean = this.lean,
        lf = this.life(t);
      const k = this.rainK * smooth01((lf.rise - 0.7) / 0.3) * lf.water; // rain once the tower is deep
      if (k <= 0) return null;
      const ya = Math.max(Math.ceil(base + 1.5), 0),
        yb = Math.floor(HY);
      if (yb < ya || hw < 2) return null;
      const reach = lean * (yb - base);
      const sx0 = Math.max(Math.floor(ax - hw + Math.min(reach, 0)) - 2, 0);
      const sx1 = Math.min(Math.ceil(ax + hw + Math.max(reach, 0)) + 2, W);
      if (sx1 <= sx0) return null;
      const sw = sx1 - sx0,
        sh = yb - ya + 1,
        d = new Uint8Array(sw * sh);
      for (let y = ya; y <= yb; y++) {
        const drop = y - base,
          xc = ax + lean * drop,
          onset = smooth01(drop / 4);
        for (let x = sx0; x < sx1; x++) {
          const u = (x + 0.5 - xc) / hw;
          const body =
            1 - u * u + 0.6 * (vnH((x - xc) / 5 + 40, drop / 14 + t / 40, this.seed + 7) - 0.5);
          if (body <= 0) continue;
          const streak = 0.5 + 0.5 * vnH((x - xc) / 1.7 + 80, drop / 45 - t / 25, this.seed + 9);
          const a = k * Math.min(2 * body, 1) * streak * onset;
          if (a > 0.03) d[(y - ya) * sw + (x - sx0)] = Math.round(255 * a);
        }
      }
      return { x0: sx0, y0: ya, w: sw, h: sh, d };
    }
    // aerial perspective beyond the still's own air: the share of the cloud's contrast lost to the
    // haze and rain between it and the eye (Koschmieder, 3.912 / visibility per metre)
    fog(t) {
      const Z = this.pose(t).Z,
        V = env.wx.visibility;
      return 1 - Math.exp(-3.912 * Z * Math.max(1 / V - 1 / V_STILL, 0));
    }
  }
  const V_STILL = 60e3 + (4e3 - 60e3) * 0.25 ** 1.3; // visibility of the still's air, a fair day (haze 0.25)
  function blur2(a, w, h) {
    // hirakubo_pixel.blur(a, 2): box 5 twice per axis, edge padding
    let src = a,
      tmp = new Float64Array(w * h);
    for (let pass = 0; pass < 2; pass++) {
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          let s = 0;
          for (let d = -2; d <= 2; d++) s += src[y * w + clamp(x + d, 0, w - 1)];
          tmp[y * w + x] = s / 5;
        }
      const out = new Float64Array(w * h);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          let s = 0;
          for (let d = -2; d <= 2; d++) s += tmp[clamp(y + d, 0, h - 1) * w + x];
          out[y * w + x] = s / 5;
        }
      src = out;
    }
    return src;
  }
  function gridNoise(cd) {
    // exported jitter noise of a still cloud, sampled bilinearly
    const [gx0, gy0, gw, gh] = cd.grid,
      nz = dec(cd.nz),
      edge = dec(cd.edge);
    return {
      noise(x, y) {
        const u = clamp(x - gx0, 0, gw - 1),
          v = clamp(y - gy0, 0, gh - 1);
        const i = Math.min(Math.floor(u), gw - 2),
          j = Math.min(Math.floor(v), gh - 2);
        const fx = u - i,
          fy = v - j;
        if (fx === 0 && fy === 0) return nz[j * gw + i];
        return (
          (nz[j * gw + i] * (1 - fx) + nz[j * gw + i + 1] * fx) * (1 - fy) +
          (nz[(j + 1) * gw + i] * (1 - fx) + nz[(j + 1) * gw + i + 1] * fx) * fy
        );
      },
      edge(x) {
        const u = clamp(x - gx0, 0, gw - 1),
          i = Math.min(Math.floor(u), gw - 2),
          f = u - i;
        return f === 0 ? edge[i] : edge[i] * (1 - f) + edge[i + 1] * f;
      },
    };
  }
  function halfWidth(p, ax0) {
    return Math.max(...p.map((q) => Math.abs(q[0] - ax0) + q[2]));
  }
  function cumulus(x0, x1, base, height, rnd, tiers, lean) {
    // hirakubo_pixel.cumulus
    const puffs = [],
      U = (a, b) => a + (b - a) * rnd();
    for (let tier = 0; tier < tiers; tier++) {
      const f = tier / Math.max(tiers - 1, 1);
      const a = x0 + (x1 - x0) * (0.18 * f + lean * f),
        b = x1 - (x1 - x0) * (0.38 * f - lean * f);
      const rr = height * (0.34 - 0.1 * f);
      for (let x = a; x <= b;) {
        const tt = (x - a) / Math.max(b - a, 1);
        const r = Math.max(2.5, rr * (0.45 + 0.55 * Math.sin(Math.PI * tt) ** 0.7) * U(0.85, 1.12));
        puffs.push([x, base - r * 0.45 - f * height * 0.55 + U(-1, 1), r]);
        x += r * U(0.55, 0.8);
      }
    }
    return puffs;
  }
  function tower(x0, x1, base, height, rnd, lean) {
    // a cumulonimbus column: tiers of turrets about a fifth of its width, stacked to its top
    const puffs = [],
      w = x1 - x0,
      U = (a, b) => a + (b - a) * rnd();
    const rr = 0.18 * w,
      n = Math.max(2, Math.ceil(height / (0.8 * rr)));
    for (let k = 0; k < n; k++) {
      const f = k / (n - 1),
        cy = base - 0.5 * rr - f * (height - rr);
      if (cy + rr < -HY) break; // far above the frame
      const mid = (x0 + x1) / 2 + lean * f * w + U(-0.08, 0.08) * w,
        half = w * U(0.4, 0.53); // bulging, uneven sides
      const a = mid - half + 0.6 * rr,
        b = mid + half - 0.6 * rr;
      for (let x = a; x <= b;) {
        const r = rr * U(0.75, 1.1);
        puffs.push([x, cy + U(-0.15, 0.15) * rr, r]);
        x += r * U(0.6, 0.85);
      }
    }
    return puffs;
  }
  function shreds(x0, x1, base, height, rnd) {
    // scud: flat, broken pieces in a loose row
    const puffs = [],
      U = (a, b) => a + (b - a) * rnd();
    for (let x = x0; x <= x1;) {
      const r = height * U(0.5, 1.0);
      if (rnd() > 0.2) puffs.push([x, base - 0.35 * r + U(-0.3, 0.3) * height, r, 0.45]);
      x += r * U(0.7, 1.3);
    }
    return puffs;
  }
  const sky = {
    clouds: [],
    rnd: mulberry32(9001),
    nextSpawn: 0,
    seed: 5000,
    evo(n) {
      return Array.from({ length: n }, () => [80 + 160 * this.rnd(), 100 * this.rnd()]);
    },
    init() {
      const r = this.rnd;
      this.clouds = D.clouds.map((cd, k) => {
        const p = cd.puffs,
          xs = p.map((q) => q[0] - q[2]).concat(p.map((q) => q[0] + q[2]));
        const ax0 = (Math.min(...xs) + Math.max(...xs)) / 2,
          base0 = cd.base;
        const Z0 = (F * CB) / (HY - base0);
        return new Cloud({
          kind: "cu",
          puffs: p,
          ax0,
          base0,
          Z0,
          tb: 0,
          half: halfWidth(p, ax0),
          seed: 700 + k,
          evo: this.evo(p.length),
          decayAt: 900 + 1500 * r(),
          decayDur: 360 + 240 * r(),
          ...gridNoise(cd),
        });
      });
      this.nextSpawn = 120 + 240 * r();
    },
    spawn(t, mature, kind = "cu") {
      if (kind === "cb") return this.spawnCb(t, mature);
      if (kind === "fr") return this.spawnFr(t, mature);
      // new cumulus form where the air is: across the view, biased upwind. Convective weather
      // builds them taller (congestus) with a fourth tier of towers
      const r = this.rnd,
        seed = this.seed++;
      const Z0 = Math.exp(Math.log(3000) + r() * Math.log(14000 / 3000));
      const xs = env.ref || mo.ux >= 0 ? -60 + 620 * r() : 700 - 620 * r(),
        base0 = HY - (F * CB) / Z0;
      const wpx = Math.min(((500 + 1000 * r()) * F) / Z0, 200);
      let hpx = wpx * (0.33 + 0.17 * r()),
        tiers = wpx > 60 ? 3 : 2;
      if (!env.ref) {
        const tall = env.wx.conv * r();
        hpx *= 1 + 1.4 * tall;
        if (tall > 0.5 && wpx > 40) tiers = 4;
      }
      const puffs = cumulus(
        xs - wpx / 2,
        xs + wpx / 2,
        base0,
        hpx,
        mulberry32(seed),
        tiers,
        0.12 * r() - 0.06,
      );
      const c = new Cloud({
        kind: "cu",
        puffs,
        ax0: xs,
        base0,
        Z0,
        tb: t,
        seed,
        half: halfWidth(puffs, xs),
        evo: this.evo(puffs.length),
        grow: 300 + 180 * r(),
        decayAt: t + 900 + 1500 * r(),
        decayDur: 360 + 240 * r(),
        noise: (x, y) => fbmH(x / 5, y / 5, seed, 3) - 0.5,
        edge: (x) => vnH(x / 7, 0, seed + 3),
      });
      if (!env.ref) c.thick = clamp(((hpx * Z0) / F - 1500) / 6000, 0, 0.6);
      if (mature) {
        c.grow = 0;
        c.decayAt = t + 150 + 2200 * r();
      }
      this.clouds.push(c);
    },
    spawnCb(t, mature) {
      // a cumulonimbus 12–30 km off: a tower 3–7 km across and 8–12 km tall on the common base, so
      // its top is above the frame; its base is dark and a rain shaft hangs from it
      const r = this.rnd,
        seed = this.seed++;
      const Z0 = 12000 + 18000 * r(),
        base0 = HY - (F * CB) / Z0;
      const xs = mo.ux >= 0 ? -80 + 660 * r() : 720 - 660 * r();
      const wpx = Math.min(((3000 + 4000 * r()) * F) / Z0, 260),
        hpx = ((8000 + 4000 * r()) * F) / Z0;
      const puffs = tower(
        xs - wpx / 2,
        xs + wpx / 2,
        base0,
        hpx,
        mulberry32(seed),
        0.1 * r() - 0.05,
      );
      const c = new Cloud({
        kind: "cb",
        puffs,
        ax0: xs,
        base0,
        Z0,
        tb: t,
        seed,
        half: halfWidth(puffs, xs),
        evo: this.evo(puffs.length),
        grow: 600 + 400 * r(),
        decayAt: t + 1500 + 1500 * r(),
        decayDur: 600 + 300 * r(),
        wb: wpx,
        hTop: hpx,
        thick: 0.6,
        rainK: 0.7 + 0.25 * r(),
        lean: -0.2 * clamp(mo.ux / 8, -1.2, 1.2),
        rag: 0.7,
        noise: (x, y) => fbmH(x / 5, y / 5, seed, 3) - 0.5,
        edge: (x) => vnH(x / 7, 0, seed + 3),
      });
      if (mature) {
        c.grow = 0;
        c.decayAt = t + 300 + 2400 * r();
      }
      this.clouds.push(c);
    },
    spawnFr(t, mature) {
      // scud (fractus): ragged shreds 150–400 m up under a raining deck, dark against it. In rain the
      // air hides anything much beyond a kilometre or two, so only near ones (0.6–2.5 km) are made
      const r = this.rnd,
        seed = this.seed++;
      const hb = 150 + 250 * r(),
        Z0 = Math.max((hb * F) / (HY - 20), 600 + 1900 * r()),
        base0 = HY - (F * hb) / Z0;
      const xs = mo.ux >= 0 ? -100 + 700 * r() : 740 - 700 * r();
      const wpx = Math.min(((400 + 1400 * r()) * F) / Z0, 260),
        hpx = wpx * (0.12 + 0.1 * r());
      const puffs = shreds(xs - wpx / 2, xs + wpx / 2, base0, hpx, mulberry32(seed));
      if (!puffs.length) return;
      const c = new Cloud({
        kind: "fr",
        puffs,
        ax0: xs,
        base0,
        Z0,
        tb: t,
        seed,
        half: halfWidth(puffs, xs),
        evo: this.evo(puffs.length),
        grow: 60 + 90 * r(),
        decayAt: t + 240 + 420 * r(),
        decayDur: 120 + 120 * r(),
        rag: 2.2,
        baseRag: 3,
        vb: 0.4,
        vs: 2.2,
        noise: (x, y) => fbmH(x / 3, y / 3, seed, 3) - 0.5,
        edge: (x) => fbmH(x / 9, 0, seed + 3, 2),
      });
      if (mature) {
        c.grow = 0;
        c.decayAt = t + 60 + 500 * r();
      }
      this.clouds.push(c);
    },
    step(t, live) {
      for (const c of this.clouds) {
        const ps = c.pose(t);
        if (ps.s < 0.35 && (c.decayAt == null || c.decayAt > t)) {
          c.decayAt = t;
          c.decayDur = 360 + 240 * this.rnd();
        }
        // a cloud blown toward the viewer thins out before it grows past the frame
        if (!env.ref && ps.s > 1.8 && (c.decayAt == null || c.decayAt > t)) {
          c.decayAt = t;
          c.decayDur = 120 + 120 * this.rnd();
        }
      }
      const ref = env.ref,
        right = ref || mo.ux >= 0;
      this.clouds = this.clouds.filter((c) => {
        const ps = c.pose(t);
        const gone = c.decayAt != null && t > c.decayAt + c.decayDur;
        if (
          !ref &&
          (ps.Z < (c.kind === "fr" ? 400 : 1200) ||
            ps.base < -40 ||
            (!right && ps.ax + c.half * ps.s < -2))
        )
          return false;
        return !gone && ps.base < HY - 1 && (!right || ps.ax - c.half * ps.s < W + 2);
      });
      if (live && !ref) this.regulate(t);
      else if (live && t >= this.nextSpawn) {
        if (this.clouds.length < 6) this.spawn(t);
        this.nextSpawn = t - 300 * Math.log(1 - this.rnd());
      }
    },
    // the weather sets how many clouds of each kind the sky holds: cumulus (fair ≈ 4–5, showery
    // ≈ 10), cumulonimbus in convective weather (up to 3, in place of cumulus) and scud under a
    // raining deck (up to 8). Each kind follows its target by forming new clouds and letting the
    // oldest dissipate, so a change of weather turns the sky over within minutes
    target() {
      return Math.round(env.wx.cu * 18);
    },
    targets() {
      const wx = env.wx,
        cb = Math.round(3 * clamp((wx.conv - 0.6) / 0.4, 0, 1) * clamp(wx.cu / 0.4, 0, 1));
      return { cu: Math.max(this.target() - cb, 0), cb, fr: Math.round(8 * wx.rain * wx.deck) };
    },
    PERIOD: { cu: 1500, cb: 2400, fr: 300 },
    next: { cu: 0, cb: 0, fr: 0 },
    cull: { cu: 0, cb: 0, fr: 0 },
    nextCull: 0,
    dirty: false,
    regulate(t) {
      const tg = this.targets();
      for (const kind of ["cu", "cb", "fr"]) {
        const n = tg[kind],
          all = this.clouds.filter((c) => c.kind === kind);
        if (t >= this.next[kind]) {
          // the further below its target, the sooner a kind forms again
          const deficit = n - all.length;
          if (deficit > 0) this.spawn(t, false, kind);
          this.next[kind] =
            t +
            (n === 0
              ? 30
              : Math.min(
                  (-this.PERIOD[kind] / n / Math.max(deficit, 1)) * Math.log(1 - this.rnd()),
                  90,
                ));
        }
        if (t >= this.cull[kind]) {
          const alive = all.filter((c) => c.decayAt == null || c.decayAt > t);
          if (alive.length > n + (kind === "cu" && n > 0 ? 1 : 0)) {
            const old = alive.reduce((a, b) => (b.tb < a.tb ? b : a));
            old.decayAt = t;
            old.decayDur = (kind === "fr" ? 60 : 240) + 240 * this.rnd();
            this.cull[kind] = t + (alive.length > n + 3 || n === 0 ? 15 : 45);
          }
        }
      }
    },
    reset(t, keepStill) {
      // the population of a new weather, already grown (after a jump in time)
      const tg = this.targets();
      if (!keepStill || tg.cu < 3) this.clouds = []; // the still's own clouds stay if the weather has cumulus
      else this.clouds = this.clouds.filter((c) => c.kind === "cu");
      for (const kind of ["cb", "cu", "fr"]) {
        let k = this.clouds.filter((c) => c.kind === kind).length;
        for (let guard = 0; k < tg[kind] && guard < 40; guard++) {
          const m = this.clouds.length;
          this.spawn(t, true, kind);
          k += this.clouds.length > m ? 1 : 0;
        }
        this.next[kind] = t + 60;
        this.cull[kind] = t + 60;
      }
      this.nextSpawn = t + 60;
      this.nextCull = t + 60;
      this.dirty = true;
    },
    rasterDue(t, all) {
      // one cloud per frame, round robin, unless a full redraw is asked
      if (this.dirty) {
        all = true;
        this.dirty = false;
      }
      if (all) {
        for (const c of this.clouds) {
          c.raster(t);
          c.drawnAt = t;
        }
        return;
      }
      let pick = null;
      for (const c of this.clouds) if (!pick || c.drawnAt < pick.drawnAt) pick = c;
      if (pick) {
        pick.raster(t);
        pick.drawnAt = t;
      }
    },
    composite(t) {
      const order = this.clouds.slice().sort((a, b) => b.pose(t).Z - a.pose(t).Z);
      // in env mode overlay B carries, over a cloud, how far it has faded into the air (4..255), and
      // elsewhere the density of a rain shaft
      const w = !env.ref;
      for (const c of order) {
        const fog = w ? c.fog(t) : 0;
        if (fog > 0.985) continue;
        const fb = fog < 0.004 ? 0 : 4 + Math.round(251 * fog);
        const sh = w && c.shaft;
        if (sh) {
          for (let y = 0; y < sh.h; y++)
            for (let x = 0; x < sh.w; x++) {
              const a = sh.d[y * sh.w + x];
              if (!a) continue;
              const k = ((sh.y0 + y) * W + sh.x0 + x) * 4,
                code = 4 + Math.round(a * (1 - fog) * 0.984);
              if (code > over[k + 2]) over[k + 2] = code;
            }
        }
        const sp = c.sprite;
        if (!sp) continue;
        for (let y = 0; y < sp.h; y++) {
          const yy = sp.y0 + y;
          if (yy > HY) break;
          for (let x = 0; x < sp.w; x++) {
            const v = sp.idx[y * sp.w + x];
            if (!v) continue;
            const k = (yy * W + sp.x0 + x) * 4,
              cur = over[k];
            if (v < 8 || cur === 0) {
              over[k] = v;
              if (w) over[k + 2] = fb;
            } // a thin cloud never hides an opaque one
            else if (cur >= 8) {
              over[k] = Math.min(cur + v - 8, 255);
              if (w) over[k + 2] = fb;
            }
          }
        }
      }
    },
  };

  // distant cumulus heads on the horizon, 40 km out, drifting at their own tiny angular speed
  const bank = {
    v: (F * C.U_CLOUD * WIND[0]) / C.BANK_DIST,
    rnd: mulberry32(207207),
    bumps: D.bank.map(([x, w, h], k) => ({
      p: x,
      w,
      h,
      tau: 300 + 600 * ((k * 0.61803) % 1),
      o: k * 13.7,
      s: 900 + k,
    })),
    cx: 0,
    nb: 0,
    init() {
      this.cx = Math.min(...this.bumps.map((b) => b.p));
    },
    flow(shift) {
      // any wind: new heads appear upwind, old ones leave downwind
      if (!this.bumps.length)
        this.bumps.push({ p: W / 2 - shift, w: 10, h: 2, tau: 500, o: 0, s: 90000 + this.nb++ });
      let lo = Infinity,
        hi = -Infinity;
      for (const b of this.bumps) {
        lo = Math.min(lo, b.p);
        hi = Math.max(hi, b.p);
      }
      const r = this.rnd,
        add = () => {
          const w = 6 + 14 * r(),
            h = (1.5 + 1.7 * r()) * (w / 10) ** 0.8;
          const d = w * (0.45 + 0.35 * r()) + (r() < 0.28 ? 12 + 38 * r() : 0);
          return { w, h, d };
        };
      if (mo.ux >= 0) {
        if (lo + shift > W + 40) lo = W + 40 - shift;
        while (lo + shift > -30) {
          const n = add();
          lo -= n.d;
          this.bumps.push({
            p: lo,
            w: n.w,
            h: n.h,
            tau: 300 + 600 * r(),
            o: 100 * r(),
            s: 90000 + this.nb++,
          });
        }
      } else {
        if (hi + shift < -40) hi = -40 - shift;
        while (hi + shift < W + 30) {
          const n = add();
          hi += n.d;
          this.bumps.push({
            p: hi,
            w: n.w,
            h: n.h,
            tau: 300 + 600 * r(),
            o: 100 * r(),
            s: 90000 + this.nb++,
          });
        }
      }
      this.bumps = this.bumps.filter(
        (b) => b.p + shift - b.w / 2 < W + 60 && b.p + shift + b.w / 2 > -60,
      );
    },
    step(t, live) {
      const shift = env.ref ? this.v * t : mo.bank;
      if (live && !env.ref) this.flow(shift);
      else if (live) {
        // grow the bank upwind with the still's own spacing rule, mirrored; in steady running a
        // newcomer is born at x < -29, off-screen. The clamp only acts on the first ones at t = 0
        let refill = false;
        if (this.cx + shift > W + 40) {
          this.cx = W + 40 - shift;
          refill = true;
        } // after a jump in time
        while (this.cx + shift > -30) {
          const r = this.rnd,
            w = 6 + 14 * r(),
            h = (1.5 + 1.7 * r()) * (w / 10) ** 0.8;
          let p = this.cx - w * (0.45 + 0.35 * r()) - (r() < 0.28 ? 12 + 38 * r() : 0);
          if (!refill) p = Math.min(p, -shift - 0.5 - w / 2);
          this.cx = p;
          this.bumps.push({ p, w, h, tau: 300 + 600 * r(), o: 100 * r(), s: 90000 + this.nb++ });
        }
        this.bumps = this.bumps.filter((b) => b.p + shift - b.w / 2 < W + 10);
      }
      const top = new Float64Array(W);
      const hk = env.ref ? 1 : clamp(0.4 + 2.4 * env.wx.cu, 0.3, 2.2); // taller heads in convective weather
      for (const b of this.bumps) {
        const cx = b.p + (live ? shift : 0);
        const g = (live ? 1 + 0.3 * (n1(t / b.tau + b.o, b.s) - n1(b.o, b.s)) : 1) * hk;
        const lo = Math.max(Math.ceil(cx - b.w / 2), 0),
          hi = Math.min(Math.floor(cx + b.w / 2), W - 1);
        for (let x = lo; x <= hi; x++) {
          const q = (x - cx) / (b.w / 2);
          top[x] = Math.max(top[x], b.h * g * Math.sqrt(clamp(1 - q * q, 0, 1)));
        }
      }
      const fl = new Float64Array(W);
      for (let x = 0; x < W; x++)
        fl[x] = Math.floor(top[x] * clamp((Math.abs(x - C.LX) - 30) / 10, 0, 1) + 0.35);
      for (let x = 0; x < W; x++) {
        const dh =
          x === 0
            ? fl[1] - fl[0]
            : x === W - 1
              ? fl[W - 1] - fl[W - 2]
              : (fl[x + 1] - fl[x - 1]) / 2;
        colD[(W + x) * 4] = fl[x];
        colD[(W + x) * 4 + 1] = dh;
      }
    },
  };
  const V_CIRRUS = (F * C.U_CIRRUS * WIND[0]) / ((C.CIRRUS_H * F) / (HY - 40));

  // ------------------------------------------------------------------ the world: sun, moon, weather
  // hirakubo_env.js (inlined above) gives the sun and moon at the cape and a simulated weather as
  // functions of UTC, and turns them into palettes and gains. "ref" is the still's own afternoon
  // (designed palettes, no grading, the still's wind); the tests run in it and it is exact.
  const HE = HKEnv; // a global lexical binding of the script above, not a window property
  const D2R = Math.PI / 180;
  const lightingOf = HE.makeLighting({ W, H, HY, F, pal: D.pal });
  const env = {
    ref: true,
    clock: "now",
    speed: 1,
    force: null,
    wind: null,
    wetFix: null,
    light: "beam",
    ms: Date.now(),
    wx: HE.REF_WEATHER,
    b: null,
    L: null,
    litMs: NaN,
    litReal: -Infinity,
    jump: false,
  };
  const LU = {
    sky: new Float32Array(150),
    cloud: new Float32Array(21),
    bank: new Float32Array(21),
    deck: new Float32Array(21),
    landG: new Float32Array([1, 1, 1]),
    reflG: new Float32Array([1, 1, 1]),
    haze: new Float32Array(3),
    vis: 60000,
    desat: 0,
    lampCol: new Float32Array([1, 0.9, 0.72]),
    lampLevel: 0,
    halo: 0,
    haloR: 4,
    rain: 0,
    beamK: 0,
    beamI: 0,
    beamB: 0,
    rainCol: new Float32Array(3),
    slant: 0,
    cirrusThr: 0.63,
    deckAmt: 0,
    deckH: 2000,
    scAmt: 0,
    scH: 900,
    starK: 0,
    mw: 0,
    mlim: -10,
    mwCol: new Float32Array(3),
    gal: new Float32Array(9),
    wet: 0,
    pool: 0,
    skyRefl: new Float32Array(3),
  };
  function refPalettes() {
    for (let a = 0; a < 5; a++)
      for (let l = 0; l < 10; l++) LU.sky.set(D.pal.sky[l], (a * 10 + l) * 3);
    for (let i = 0; i < 7; i++)
      for (const k of ["cloud", "bank", "deck"]) LU[k].set(D.pal.white[i], i * 3);
    LU.cirrusThr = 0.63;
    LU.deckAmt = 0;
    LU.scAmt = 0;
    LU.starK = 0;
    LU.mw = 0;
    LU.lampLevel = 0;
    LU.rain = 0;
    LU.wet = 0;
    LU.pool = 0;
  }
  refPalettes();
  // wind-driven motion, integrated so that the wind may change: cloud drift (m), the deck's drift
  // (m, wrapped to its texture period), bank and cirrus shifts (px), the gust clock (s); and the
  // sea-state gains of the moment. In the still's wind all of them reduce to the old closed forms
  const mo = {
    cloudX: 0,
    cloudZ: 0,
    deckX: 0,
    deckZ: 0,
    scX: 0,
    scZ: 0,
    scT: 0,
    bank: 0,
    cirrus: 0,
    gustT: 0,
    ux: UX,
    uz: UZ,
    kRough: 1,
    kSwell: 1,
    kCaps: 1,
    kGust: 1,
    bend: 1,
    gustTurn: NaN,
    seaTurn: NaN,
  };
  // the gusts on the grass and the cat's paws and wind waves on the sea were made for the still's
  // south-westerly; in another wind their patterns are turned by the difference in bearing (rad,
  // clockwise), so that they travel with the wind (the swell comes from the open sea whatever the wind)
  const WIND_BEAR = Math.atan2(WIND[0], WIND[1]);
  function turnTarget() {
    const wv = env.wx.windVec;
    return Math.hypot(wv[0], wv[1]) > 0.3
      ? Math.atan2(wv[0], wv[1]) - WIND_BEAR
      : Number.isFinite(mo.gustTurn)
        ? mo.gustTurn
        : 0;
  }
  function motionStep(dt, dts) {
    const wx = env.wx,
      wv = wx.windVec,
      U = wx.windSpeed,
      k = C.U_CLOUD / 8;
    mo.ux = wv[0] * k;
    mo.uz = wv[1] * k;
    mo.cloudX += mo.ux * dts;
    mo.cloudZ += mo.uz * dts;
    const P = 512 * 2600;
    mo.deckX = (mo.deckX + 1.3 * mo.ux * dts) % P;
    mo.deckZ = (mo.deckZ + 1.3 * mo.uz * dts) % P;
    mo.scX = (mo.scX + mo.ux * dts) % 512e3;
    mo.scZ = (mo.scZ + mo.uz * dts) % 512e3; // stratocumulus: 512 cells of 1 km
    mo.scT += dts / 400;
    mo.bank += ((F * mo.ux) / C.BANK_DIST) * dts;
    mo.cirrus += ((V_CIRRUS * wv[0]) / (8 * WIND[0])) * dts;
    mo.gustT += (dt * Math.max(U, 0.5)) / 8;
    // sea surface: slope variance after Cox & Munk, σ² = 0.003 + 0.00512 U, sets the short waves;
    // whitecaps follow U^3.41; the swell and the reef surf follow the lagged swell index
    const su = Math.max(wx.seaWind, 0.5);
    mo.kRough = Math.sqrt((0.003 + 0.00512 * su) / (0.003 + 0.00512 * 8));
    mo.kCaps = Math.min((su / 8) ** 3.41, 10);
    mo.kSwell = clamp(wx.swellK, 0.3, 2.5);
    mo.kGust = U / 8;
    mo.bend = clamp((wv[0] * U) / (64 * WIND[0]), -2, 2);
    // a veer turns the gusts over ~20 s of sky time and the sea over ~5 min, each no faster than a
    // set rate in real time (fast-forward), so that no pattern jumps
    const ease = (a, tau, rate) => {
      const d = turnTarget() - a;
      return (
        a +
        clamp(
          Math.atan2(Math.sin(d), Math.cos(d)) * (1 - Math.exp(-dts / tau)),
          -rate * dt,
          rate * dt,
        )
      );
    };
    if (Number.isFinite(mo.gustTurn)) mo.gustTurn = ease(mo.gustTurn, 20, 0.05);
    if (Number.isFinite(mo.seaTurn)) mo.seaTurn = ease(mo.seaTurn, 300, 0.01);
  }
  function eqVec(ra, dec) {
    ra *= D2R;
    dec *= D2R;
    return [Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)];
  }
  const GAL_X = eqVec(266.405, -28.936),
    GAL_Z = eqVec(192.8595, 27.1283); // galactic centre, north galactic pole
  const GAL_Y = [
    GAL_Z[1] * GAL_X[2] - GAL_Z[2] * GAL_X[1],
    GAL_Z[2] * GAL_X[0] - GAL_Z[0] * GAL_X[2],
    GAL_Z[0] * GAL_X[1] - GAL_Z[1] * GAL_X[0],
  ];
  function localFrame(lstDeg) {
    // east, north, up of the cape in equatorial coordinates
    const t = lstDeg * D2R,
      p = HE.SITE.lat * D2R,
      ct = Math.cos(t),
      st = Math.sin(t),
      cp = Math.cos(p),
      sp = Math.sin(p);
    return { E: [-st, ct, 0], N: [-sp * ct, -sp * st, cp], U: [cp * ct, cp * st, sp] };
  }
  function galMatrix(lstDeg, out) {
    // view (E, N, U) → galactic, column-major for uniformMatrix3fv
    const f = localFrame(lstDeg),
      cols = [f.E, f.N, f.U],
      rows = [GAL_X, GAL_Y, GAL_Z];
    for (let c = 0; c < 3; c++)
      for (let r = 0; r < 3; r++)
        out[c * 3 + r] =
          rows[r][0] * cols[c][0] + rows[r][1] * cols[c][1] + rows[r][2] * cols[c][2];
  }
  const linC = (v) => {
    v /= 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  // ------------------------------------------------------------------ wet ground
  // Water on the grass and the stone (w: share of the ~0.5 mm their surfaces hold) and standing in
  // the hollows of the path (p: share of ~3 mm), stepped over the weather of the past day on a fixed
  // 5-minute grid, so the same moment is always as wet. Rain fills them (the path pools above
  // ~1 mm/h); the air dries them at a potential evaporation that rises with the sun on the ground
  // and with the wind, from 0.03 mm/h at night to ~0.6 mm/h under a high sun, and that rain damps
  // (none from 0.5 mm/h), so the faint drizzle of an overcast sky leaves the ground dry; pools also
  // soak away at 0.3 mm/h. The amounts and rates are chosen, not measured. A pinned weather is taken to have
  // held for the whole day.
  const WET = { hold: 0.5, pool: 3, step: 300e3, back: 24 * 3600e3 };
  WET.h = WET.step / 3600e3; // the grid step in hours, used in the rates below
  const wet = { g: NaN, force: undefined, w: 0, p: 0, next: NaN, w1: 0, p1: 0 };
  function wetStep(st, ms, force) {
    // one grid step from ms, in the weather of its middle
    const mid = ms + WET.step / 2,
      wx = HE.weather(mid, force),
      h = WET.h;
    const R = wx.rain > 0.02 ? wx.rainRate : 0,
      alt = HE.bodies(mid).sun.app;
    const E =
      (0.03 + 0.55 * Math.max(Math.sin(alt * D2R), 0) * (1 - 0.75 * wx.deck)) *
      (0.6 + 0.08 * wx.windSpeed) *
      Math.max(0, 1 - R / 0.5);
    st.w += (1 - st.w) * (1 - Math.exp((-R * h) / WET.hold));
    st.w = Math.max(0, st.w - (E * h) / WET.hold);
    st.p = clamp(st.p + ((Math.max(R - 1, 0) - 0.3 - 0.5 * E) * h) / WET.pool, 0, 1);
  }
  function wetness(ms, force) {
    const g = Math.floor(ms / WET.step) * WET.step;
    if (force !== wet.force || !(g >= wet.g) || g - wet.g > WET.back) {
      // a jump: the whole day again
      const st = { w: 0, p: 0 };
      for (let t = g - WET.back; t < g; t += WET.step) wetStep(st, t, force);
      Object.assign(wet, { g, force, w: st.w, p: st.p, next: NaN });
    } else if (g > wet.g) {
      const st = { w: wet.w, p: wet.p };
      for (let t = wet.g; t < g; t += WET.step) wetStep(st, t, force);
      Object.assign(wet, { g, w: st.w, p: st.p });
    }
    if (wet.next !== g) {
      const st = { w: wet.w, p: wet.p };
      wetStep(st, g, force);
      wet.w1 = st.w;
      wet.p1 = st.p;
      wet.next = g;
    }
    const f = (ms - g) / WET.step;
    return { w: lerp(wet.w, wet.w1, f), p: lerp(wet.p, wet.p1, f) };
  }
  function updateEnv(realNow, force) {
    if (env.ref) return;
    if (!force && Math.abs(env.ms - env.litMs) < 5000 && realNow - env.litReal < 1) return;
    env.litMs = env.ms;
    env.litReal = realNow;
    const b = HE.bodies(env.ms),
      wx = HE.weather(env.ms, env.force);
    if (env.wind) {
      // test hook: a fixed wind [m/s, from °] (the ground dries in the simulated one)
      const a = (env.wind[1] + 180) * D2R;
      wx.windSpeed = wx.seaWind = env.wind[0];
      wx.windFrom = env.wind[1];
      wx.windVec = [Math.sin(a) * env.wind[0], Math.cos(a) * env.wind[0]];
    }
    const L = lightingOf(b, wx);
    env.b = b;
    env.wx = wx;
    env.L = L;
    LU.sky.set(L.skyPal);
    LU.cloud.set(L.cloudPal);
    LU.bank.set(L.bankPal);
    LU.deck.set(L.deckPal);
    LU.landG.set(L.landG);
    LU.reflG.set(L.reflG);
    LU.haze.set(L.hazeCol);
    LU.vis = wx.visibility;
    LU.desat = 0.45 * wx.deck;
    LU.cirrusThr = clamp(0.63 + 0.5 * (0.35 - wx.ci), 0.45, 0.95);
    // the layer cloud is split between low stratocumulus and the deck above it; under an overcast
    // (deck near 1) the deck above stays whole, so the seams between cells show cloud, not sky;
    // a raining deck has no gaps
    LU.scAmt = wx.deck * wx.sc < 0.02 ? 0 : wx.deck * wx.sc;
    LU.scH = 900;
    LU.deckAmt =
      wx.deck < 0.02 ? 0 : wx.deck * (1 - 0.6 * wx.sc * (1 - wx.deck)) * (1 + 0.3 * wx.rain);
    LU.deckH = 3200 + (1300 - 3200) * wx.dark;
    LU.mlim = HE.limitingMag(L.skyLum10);
    LU.starK = LU.mlim > 0 ? 1 : 0;
    LU.mw = clamp((LU.mlim - 5.2) / 0.8, 0, 1) * (1 - wx.deck);
    const mid = [0, 1, 2].map((c) => linC(L.skyPal[(20 + 2) * 3 + c]));
    const y = 0.2126 * mid[0] + 0.7152 * mid[1] + 0.0722 * mid[2];
    LU.mwCol.set([6 * y, 5.7 * y, 5.2 * y]); // a chosen strength: the band a dark-adapted eye picks out
    galMatrix(b.lst, LU.gal);
    // the lamp is switched by daylight (on below ~100 lx) and stands out more as the scene darkens
    LU.lampLevel = clamp(Math.log10(1e-3 / Math.max(L.rg, 1e-12)) / 1.5, 0, 1);
    // the beam: I·β·√π·tanW·tanH in cd/m² per unit of beamRay, shown like the sky (6000 cd/m² at 10°
    // in the still is a display level of about 0.4, times the eye's adaptation X)
    // near the sea at night the air is humid and its sea-salt haze swells: three times the haze's
    // scattering (chosen), plus the rain's
    const sig = 3.912 / wx.visibility,
      sigR = (1.076 * (wx.rainRate || 0) ** 0.67) / 4343;
    LU.beamB = 3 * Math.max(sig - sigR, 0) + sigR;
    // Looking at the beam the eye adapts to it in part, so on the darkest wet nights, where the
    // picture is exposed for land hundreds of times dimmer, its gain is held back toward 20 (chosen)
    const bk = (BEAM.cd * LU.beamB * Math.sqrt(Math.PI) * BEAM.tanW * BEAM.tanH * 0.4 * L.X) / 6000;
    LU.beamK = bk / (1 + bk / 20);
    LU.beamI = (BEAM.cd * BEAM.tanW * BEAM.tanH * 0.4 * L.X) / 6000 / (1 + bk / 20); // lux on a surface → display
    LU.halo = 0.12 + 0.7 * wx.haze;
    LU.haloR = 2.5 + 6 * wx.haze + 4 * wx.rain;
    LU.rain = wx.rain > 0.02 ? wx.rain : 0;
    LU.slant = clamp(wx.windVec[0] / 7, -1.2, 1.2);
    LU.rainCol.set([0, 1, 2].map((c) => Math.min(1, 1.2 * linC(L.hazeCol[c]))));
    const wt = env.wetFix || wetness(env.ms, env.force); // test hook: a fixed {w, p}
    LU.wet = wt.w;
    LU.pool = wt.p;
    // what wet ground mirrors: the sky some 15° up toward the sea, or the cloud deck over it
    LU.skyRefl.set(
      [0, 1, 2].map((c) => lerp(linC(L.skyPal[63 + c]), linC(L.deckPal[9 + c]), wx.deck)),
    );
  }
  // effects that run on real time whatever the sky's speed: the lamp's rhythm, rain, lightning
  const fx = {
    lamp: 0,
    rainT: 0,
    flash: 0,
    glass: 1,
    haloK: 1,
    haloS: 1,
    beamK: 0,
    beamI: 0,
    phi: 0,
    a0: 0,
    a1: 0,
  };
  // the lantern, from the picture: the tower stands on the cape's ground plane C.EYE below the eye,
  // its base at row 228 on axis x = 213, the light at row 121.5 (about 79 m off, 3.9 m above the eye)
  const LANT = (() => {
    const z = (F * C.EYE) / (228 - HY);
    return [((213 - W / 2) * z) / F, ((HY - 121.5) * z) / F, z];
  })();
  const TO_EYE = Math.atan2(-LANT[0], -LANT[2]); // the eye's bearing from the lantern, ≈ 168°
  // the turning light (chosen, the real one is 明3秒暗3秒): two opposite beams, a turn in 12 s, 2e6 cd
  // on the axis. A screen in the lantern blanks the landward 120° around the eye's bearing, with soft
  // edges, so the beams sweep the sea and the hill is not flashed
  const BEAM = { period: 12, cd: 2e6, tanW: 0.026, tanH: 0.03, screen: 60 * D2R, edge: 8 * D2R };
  const beamOut = (a) =>
    smooth01(
      (Math.abs(Math.atan2(Math.sin(a - TO_EYE), Math.cos(a - TO_EYE))) - BEAM.screen) / BEAM.edge,
    );
  const bolt = { rnd: mulberry32(8080), next: 0, t0: -99, n: 0 };
  function effects(t) {
    if (env.light === "iso" || env.ref) {
      fx.lamp = env.ref ? 0 : LU.lampLevel * (t % 6 < 3 ? 1 : 0); // 明3秒暗3秒
      fx.glass = 1;
      fx.haloK = 1;
      fx.haloS = 1;
      fx.beamK = 0;
      fx.beamI = 0;
    } else {
      // behind the screen the lantern glows dimly; the beams turn clockwise seen from above
      fx.lamp = LU.lampLevel;
      fx.phi = (TAU * (t % BEAM.period)) / BEAM.period;
      fx.a0 = beamOut(fx.phi);
      fx.a1 = beamOut(fx.phi + Math.PI);
      fx.glass = 0.55;
      fx.haloK = 0.35;
      fx.haloS = 1;
      fx.beamK = LU.beamK * fx.lamp;
      fx.beamI = LU.beamI * fx.lamp;
    }
    fx.rainT = t % 600;
    const rate = env.ref ? 0 : env.wx.lightning / 12;
    if (rate <= 0) bolt.next = t + 5;
    else if (t >= bolt.next) {
      bolt.t0 = t;
      bolt.n = 1 + Math.floor(3 * bolt.rnd());
      bolt.next = t - Math.log(1 - bolt.rnd()) / rate;
    }
    let f = 0;
    for (let k = 0; k < bolt.n; k++) {
      const d = t - bolt.t0 - 0.11 * k;
      if (d >= 0) f += Math.exp(-d / 0.045);
    }
    fx.flash = Math.min(f, 1.5);
  }

  // ------------------------------------------------------------------ stars
  // A procedural sky of 9000 stars to magnitude 6.5, thicker toward the galactic plane, with the
  // real counts per magnitude, N(<m) ≈ 10^(0.5 m + 0.7). The positions are not a catalogue.
  // Each is dimmed by the air mass, shown if brighter than the limiting magnitude of the sky of
  // the moment, and twinkles more near the horizon.
  const STARS = (() => {
    const n = 9000,
      r = mulberry32(31415),
      v = new Float64Array(3 * n),
      mag = new Float32Array(n),
      tint = new Uint8Array(n);
    for (let k = 0; k < n;) {
      const z = 2 * r() - 1,
        ph = TAU * r(),
        q = Math.sqrt(1 - z * z),
        x = q * Math.cos(ph),
        y = q * Math.sin(ph);
      const b = Math.asin(x * GAL_Z[0] + y * GAL_Z[1] + z * GAL_Z[2]);
      if (r() * 2.5 > 1 + 1.5 * Math.exp(-((b / 0.3) ** 2))) continue;
      v[3 * k] = x;
      v[3 * k + 1] = y;
      v[3 * k + 2] = z;
      mag[k] = 6.5 + 2 * Math.log10(1 - r());
      const u = r();
      tint[k] = u < 0.4 ? 0 : u < 0.6 ? 1 : u < 0.85 ? 2 : 3;
      k++;
    }
    return { n, v, mag, tint };
  })();
  function drawStars(t) {
    if (env.ref || !LU.starK || !env.b) return;
    // extinction 0.16 mag per air mass in clean air (a dark site), more in haze
    const f = localFrame(env.b.lst),
      { E, N, U } = f,
      kext = 0.16 + 0.3 * env.wx.haze,
      S = STARS;
    for (let i = 0; i < S.n; i++) {
      const x = S.v[3 * i],
        y = S.v[3 * i + 1],
        z = S.v[3 * i + 2];
      const nn = N[0] * x + N[1] * y + N[2] * z;
      if (nn < 0.8) continue;
      const uu = U[0] * x + U[1] * y + U[2] * z;
      if (uu <= 0) continue;
      const ee = E[0] * x + E[1] * y + E[2] * z;
      const px = Math.floor(W / 2 + (F * ee) / nn),
        py = Math.round(HY + 0.5 - (F * uu) / nn);
      if (px < 0 || px >= W || py < 0 || py > HY - 1) continue;
      const am = 1 / (uu + 0.025 * Math.exp(-11 * uu)); // air mass (Rozenberg)
      const bm = LU.mlim - (S.mag[i] + kext * am);
      if (bm <= 0) continue;
      const tw = 1 + Math.min(0.6, 0.12 * am) * (2 * n1(t * 7 + i * 0.37, 900 + (i & 255)) - 1);
      const code = Math.round(255 * Math.min(1, (0.08 + 0.14 * bm) * tw));
      const k = (py * W + px) * 4;
      if (over[k] || over[k + 2] >= 4) continue; // behind a cloud or a rain shaft
      if (code > over[k + 1]) {
        over[k + 1] = code;
        over[k + 2] = S.tint[i];
      }
    }
  }

  // ------------------------------------------------------------------ one frame
  const U = {
    rough: new Float32Array(48),
    swell: new Float32Array(48),
    chop: new Float32Array(48),
    chopL: new Float32Array(48),
    gust: new Float32Array(48),
  };
  const SETS = { loop: compSet("loop"), live: compSet("live") };
  // the live set turned to the wind of the moment (the first use after a jump sets the turns). Only k
  // turns: the drift ω = k·U and the wind waves' ω(|k|) turn with it, and the waves keep their
  // strength, since the slope seen across the wind is nearly that seen along it (Cox & Munk: the
  // crosswind slope variance is ~3/4 of the upwind one at 8 m/s)
  const TURNED = { ...SETS.live };
  for (const k of ["gust", "flutter", "rough", "chop", "chopL"])
    TURNED[k] = SETS.live[k].map((r) => r.slice());
  function turnRows(k, a) {
    const c = Math.cos(a),
      s = Math.sin(a),
      src = SETS.live[k],
      dst = TURNED[k];
    for (let j = 0; j < src.length; j++) {
      dst[j][0] = src[j][0] * c + src[j][1] * s;
      dst[j][1] = src[j][1] * c - src[j][0] * s;
    }
  }
  function turnWind() {
    if (!Number.isFinite(mo.gustTurn)) mo.gustTurn = turnTarget();
    if (!Number.isFinite(mo.seaTurn)) mo.seaTurn = mo.gustTurn;
    for (const k of ["gust", "flutter"]) turnRows(k, mo.gustTurn);
    for (const k of ["rough", "chop", "chopL"]) turnRows(k, mo.seaTurn);
    return TURNED;
  }
  let cpuMs = 0;
  function simulate(mode, i, t, rasterAll, tc = t) {
    // t runs the sea and the grass in real time; tc runs the sky, which may be fast-forwarded
    const c0 = performance.now();
    const w = mode === "live" && !env.ref;
    const comps = w ? turnWind() : SETS[mode];
    over.fill(0);
    let om;
    if (mode === "loop") {
      om = loopTiming(KX_REEF, i, tauR, ampR, mR);
      loopTiming(KX_ISLE, i, tauI, ampI, null);
      drawCaps(loopCaps.ev, loopCaps.n, (j) => ((((i - A.caps_birth[j]) % N) + N) % N) / FPS);
    } else {
      om = groupTiming(REEF_X, REEF_Z, t, tauR, ampR, mR, 0, W);
      groupTiming(ISLE_X, C.isle_zi, t, tauI, ampI, null, ISLE_X0, ISL.x1 + 5);
      if (w)
        for (let c = 0; c < W; c++) {
          ampR[c] = clamp(ampR[c] * mo.kSwell, 0.2, 1.8);
          ampI[c] = clamp(ampI[c] * mo.kSwell, 0.2, 1.8);
        }
      liveCaps.step(t);
      const L = liveCaps.list;
      drawCaps(
        (j) => L[j],
        L.length,
        (j) => t - L[j].birth,
      );
    }
    const period = TAU / om;
    for (let c = 0; c < W; c++) {
      const f = clamp((tauR[c] - (period - 1.1)) / 1.1, 0, 1) * ampR[c];
      colD.set([tauR[c], ampR[c], mR[c], f], c * 4);
    }
    bank.step(tc, mode === "live");
    drawIsland();
    sky.step(tc, mode === "live");
    sky.rasterDue(tc, rasterAll);
    sky.composite(tc);
    if (w) drawStars(t);
    drawBlades(comps, mode, i, t);
    const gain = {
      rough: w ? mo.kRough : 1,
      swell: w ? mo.kSwell : 1,
      chop: w ? mo.kRough : 1,
      chopL: w ? mo.kRough : 1,
      gust: w ? mo.kGust : 1,
    };
    for (const k of ["rough", "swell", "chop", "chopL", "gust"])
      packUniform(comps[k], mode, i, k === "gust" && w ? mo.gustT : t, U[k], gain[k]);
    effects(t);
    cpuMs = performance.now() - c0;
    return {
      comps,
      lap: mode === "loop" ? tphase(10, "loop", i, t) : mod2pi(((TAU * 10) / T) * t),
      shift: w ? ((mo.cirrus % 40960) + 40960) % 40960 : (V_CIRRUS * tc) % 40960,
    };
  }

  function bindTex(prog, name, unit, tex) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (prog.loc[name]) gl.uniform1i(prog.loc[name], unit);
  }
  function common(prog) {
    gl.useProgram(prog.p);
    if (prog.loc.uPal) gl.uniform3fv(prog.loc.uPal, palFlat);
    bindTex(prog, "uMasks", 0, TX.masks);
  }
  function pass(prog, dst) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst ? dst.fb : null);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  function setComps(prog, name, key, comps) {
    if (prog.loc[name]) gl.uniform4fv(prog.loc[name], U[key]);
    if (prog.loc["uN" + name.slice(1)])
      gl.uniform1i(prog.loc["uN" + name.slice(1)], comps[key].length);
  }
  function renderScene(frame) {
    gl.bindVertexArray(vao);
    gl.viewport(0, 0, W, H);
    gl.bindTexture(gl.TEXTURE_2D, TX.colD);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, 2, gl.RGBA, gl.FLOAT, colD);
    gl.bindTexture(gl.TEXTURE_2D, TX.over);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, over);
    const { comps } = frame;
    let pr = P.base;
    common(pr);
    bindTex(pr, "uColS", 1, TX.colS);
    bindTex(pr, "uColD", 2, TX.colD);
    bindTex(pr, "uOver", 3, TX.over);
    bindTex(pr, "uFieldA", 4, TX.fieldA);
    bindTex(pr, "uFieldB", 5, TX.fieldB);
    bindTex(pr, "uCirrus", 6, TX.cirrus);
    setComps(pr, "uRough", "rough", comps);
    setComps(pr, "uSwell", "swell", comps);
    setComps(pr, "uChop", "chop", comps);
    setComps(pr, "uChopL", "chopL", comps);
    gl.uniform1f(pr.loc.uCirrusShift, frame.shift);
    gl.uniform3fv(pr.loc.uSkyPal, LU.sky);
    gl.uniform3fv(pr.loc.uCloudPal, LU.cloud);
    gl.uniform3fv(pr.loc.uBankPal, LU.bank);
    gl.uniform3fv(pr.loc.uDeckPal, LU.deck);
    gl.uniform1f(pr.loc.uCirrusThr, LU.cirrusThr);
    gl.uniform1f(pr.loc.uDeck, LU.deckAmt);
    gl.uniform1f(pr.loc.uDeckH, LU.deckH);
    gl.uniform2f(pr.loc.uDeckOff, mo.deckX, mo.deckZ);
    gl.uniform1f(pr.loc.uSc, LU.scAmt);
    gl.uniform1f(pr.loc.uScH, LU.scH);
    gl.uniform1f(pr.loc.uScT, mo.scT);
    gl.uniform2f(pr.loc.uScOff, mo.scX, mo.scZ);
    gl.uniform1f(pr.loc.uStarK, LU.starK);
    gl.uniform1f(pr.loc.uMW, LU.mw);
    gl.uniform3fv(pr.loc.uMWCol, LU.mwCol);
    gl.uniformMatrix3fv(pr.loc.uGal, false, LU.gal);
    gl.uniform1f(pr.loc.uReflect, C.REFLECT);
    gl.uniform1f(pr.loc.uSwellReflect, C.SWELL_REFLECT);
    pass(pr, RT[0]);
    const desp = (src, dst, land) => {
      pr = P.desp;
      common(pr);
      bindTex(pr, "uSrc", 1, src.t);
      gl.uniform1i(pr.loc.uLand, land);
      pass(pr, dst);
    };
    desp(RT[0], RT[1], 0);
    desp(RT[1], RT[0], 0);
    pr = P.sea2;
    common(pr);
    bindTex(pr, "uSrc", 1, RT[0].t);
    bindTex(pr, "uColS", 2, TX.colS);
    bindTex(pr, "uColD", 3, TX.colD);
    bindTex(pr, "uOver", 4, TX.over);
    bindTex(pr, "uFieldA", 5, TX.fieldA);
    bindTex(pr, "uFieldB", 6, TX.fieldB);
    bindTex(pr, "uIsle", 7, TX.isle);
    setComps(pr, "uGust", "gust", comps);
    gl.uniform1f(pr.loc.uLap, frame.lap);
    gl.uniform1f(pr.loc.uBore, C.BORE);
    gl.uniform2i(pr.loc.uTrailY, C.trail_y[0], C.trail_y[1]);
    pass(pr, RT[1]);
    desp(RT[1], RT[0], 1);
    desp(RT[0], RT[1], 1);
    pr = P.comp;
    common(pr);
    bindTex(pr, "uSrc", 1, RT[1].t);
    bindTex(pr, "uOver", 2, TX.over);
    bindTex(pr, "uFieldA", 3, TX.fieldA);
    bindTex(pr, "uC1", 4, TX.c1);
    bindTex(pr, "uC2", 5, TX.c2);
    bindTex(pr, "uPost", 6, TX.post);
    setComps(pr, "uGust", "gust", comps);
    pass(pr, RT[0]);
    pr = P.grade;
    common(pr);
    bindTex(pr, "uSrc", 1, RT[0].t);
    gl.uniform1i(pr.loc.uRef, env.ref ? 1 : 0);
    if (!env.ref) {
      gl.uniform3fv(pr.loc.uLandG, LU.landG);
      gl.uniform3fv(pr.loc.uReflG, LU.reflG);
      gl.uniform3fv(pr.loc.uHaze, LU.haze);
      gl.uniform1f(pr.loc.uVis, LU.vis);
      gl.uniform1f(pr.loc.uSeaDesat, LU.desat);
      gl.uniform3fv(pr.loc.uLampCol, LU.lampCol);
      gl.uniform1f(pr.loc.uLamp, fx.lamp);
      gl.uniform1f(pr.loc.uHalo, LU.halo);
      gl.uniform1f(pr.loc.uHaloR, LU.haloR);
      gl.uniform1f(pr.loc.uGlass, fx.glass);
      gl.uniform1f(pr.loc.uHaloK, fx.haloK);
      gl.uniform1f(pr.loc.uHaloS, fx.haloS);
      gl.uniform1f(pr.loc.uBeamK, fx.beamK);
      gl.uniform1f(pr.loc.uBeamB, LU.beamB);
      gl.uniform1f(pr.loc.uBeamPhi, fx.phi);
      gl.uniform1f(pr.loc.uBeamI, fx.beamI);
      gl.uniform2f(pr.loc.uBeamA, fx.a0, fx.a1);
      gl.uniform3f(pr.loc.uLant, LANT[0], LANT[1], LANT[2]);
      gl.uniform1f(pr.loc.uRain, LU.rain);
      gl.uniform3fv(pr.loc.uRainCol, LU.rainCol);
      gl.uniform1f(pr.loc.uRainT, fx.rainT);
      gl.uniform1f(pr.loc.uRainSlant, LU.slant);
      gl.uniform1f(pr.loc.uFlash, fx.flash);
      gl.uniform1f(pr.loc.uWet, LU.wet);
      gl.uniform1f(pr.loc.uPool, LU.pool);
      gl.uniform3fv(pr.loc.uSkyRefl, LU.skyRefl);
      bindTex(pr, "uC1", 2, TX.c1);
      bindTex(pr, "uC2", 3, TX.c2);
    }
    pass(pr, RT[1]);
  }
  let view = { scale: 1, ox: 0, oy: 0, cx: W / 2, cy: H / 2, panX: false, panY: false };
  // the scene point a touch drag has put at the screen's centre (NaN: the framing below)
  const pan = { x: NaN, y: NaN };
  function layout() {
    const dpr = window.devicePixelRatio || 1;
    const cw = Math.max(1, Math.round(canvas.clientWidth * dpr)),
      ch = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }
    let s = Math.max(cw / W, ch / H);
    const si = Math.ceil(s - 1e-6);
    if (si / s <= 1.15) s = si; // crisp integer pixels if the extra crop is small
    // a narrow (portrait) screen shows only a slice of the width: keep the hut and the lighthouse
    // (x 168–236) in it, and as much of the path and the sea to their right as fits
    const vw = cw / s,
      vh = ch / s;
    const cx =
      vw >= W
        ? W / 2
        : clamp(Number.isFinite(pan.x) ? pan.x : Math.min(W / 2, 160 + vw / 2), vw / 2, W - vw / 2);
    const oy =
      vh >= H || !Number.isFinite(pan.y)
        ? (ch - H * s) * 0.55
        : ch / 2 - clamp(pan.y, vh / 2, H - vh / 2) * s;
    view = {
      scale: s,
      ox: cw / 2 - cx * s,
      oy,
      cx,
      cy: (ch / 2 - oy) / s,
      panX: vw < W,
      panY: vh < H,
    };
  }
  // a finger (not a mouse: the wallpaper host) drags the scene over what the screen crops, and a
  // flick carries on and slows; a tap stays a tap
  function setupPan() {
    let drag = null,
      fling = 0;
    const moveTo = (x, y) => {
      // keeps only an axis the screen crops
      const px = pan.x,
        py = pan.y;
      pan.x = x;
      pan.y = y;
      layout();
      pan.x = view.panX ? view.cx : px;
      pan.y = view.panY ? view.cy : py;
      present();
    };
    canvas.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" || drag) return;
      cancelAnimationFrame(fling);
      drag = {
        id: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        cx: view.cx,
        cy: view.cy,
        moved: false,
        vx: 0,
        vy: 0,
        t: e.timeStamp,
      };
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x,
        dy = e.clientY - drag.y;
      if (!drag.moved) {
        if (Math.hypot(dx, dy) < 8) return;
        drag.moved = true;
        try {
          canvas.setPointerCapture(e.pointerId);
        } catch (err) {
          /* already released */
        }
      }
      const k = (window.devicePixelRatio || 1) / view.scale,
        x0 = view.cx,
        y0 = view.cy;
      moveTo(drag.cx - dx * k, drag.cy - dy * k);
      const dt = Math.max(e.timeStamp - drag.t, 1) / 1000,
        a = Math.min(dt / 0.05, 1); // velocity, ~50 ms memory
      drag.vx += a * ((view.cx - x0) / dt - drag.vx);
      drag.vy += a * ((view.cy - y0) / dt - drag.vy);
      drag.t = e.timeStamp;
    });
    const end = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const d = drag;
      drag = null;
      if (!d.moved || e.type === "pointercancel" || e.timeStamp - d.t > 80) return;
      let vx = d.vx,
        vy = d.vy,
        t0 = performance.now();
      const step = () => {
        const now = performance.now(),
          dt = Math.min((now - t0) / 1000, 0.05),
          x0 = view.cx,
          y0 = view.cy;
        t0 = now;
        moveTo(x0 + vx * dt, y0 + vy * dt);
        if (view.cx === x0) vx = 0; // stopped by an edge
        if (view.cy === y0) vy = 0;
        const f = Math.exp(-dt / 0.3);
        vx *= f;
        vy *= f;
        if (Math.hypot(vx, vy) > 5) fling = requestAnimationFrame(step);
      };
      if (Math.hypot(vx, vy) > 30) fling = requestAnimationFrame(step);
    };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
  }
  function present() {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    const pr = P.present;
    gl.useProgram(pr.p);
    bindTex(pr, "uSrc", 0, RT[1].t);
    gl.uniform2f(pr.loc.uCanvas, canvas.width, canvas.height);
    gl.uniform2f(pr.loc.uOff, view.ox, view.oy);
    gl.uniform1f(pr.loc.uScale, view.scale);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  function readScene() {
    const px = new Uint8Array(W * H * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, RT[1].fb);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return px;
  }

  // ------------------------------------------------------------------ start
  async function loadImages() {
    for (const k in D.img) {
      // wait for load, not decode(): decode() never settles while the page is hidden
      const im = new Image();
      await new Promise((res, rej) => {
        im.onload = res;
        im.onerror = () => rej(new Error("image " + k));
        im.src = D.img[k].uri;
      });
      TX[k] = imageTexture(im);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, TX[k], 0);
      const px = new Uint8Array(W * H * 4);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let s = 0;
      for (let i = 0; i < px.length; i += 4) s += px[i] + px[i + 1] + px[i + 2];
      if (s !== D.img[k].sum) selfTest.push(`image ${k}: ${s} != ${D.img[k].sum}`);
      gl.deleteFramebuffer(fb);
    }
  }

  const hud = document.getElementById("hud");
  const debug = location.hash === "#debug",
    testing = location.hash === "#test";
  let simT = 0,
    simTc = 0,
    last = performance.now() / 1000,
    lastDraw = last,
    acc = 0,
    running = true,
    frames = 0,
    fpsT = 0,
    fpsShown = 0;
  // a GPU reset (sleep, driver update) drops every texture; start over once the context is back
  canvas.addEventListener("webglcontextlost", (e) => {
    e.preventDefault();
    running = false;
    soundSync();
  });
  canvas.addEventListener("webglcontextrestored", () => location.reload());

  // ------------------------------------------------------------------ the sky's clock
  // "now" follows the system clock; the sun and the weather are computed for the cape from UTC, so
  // the machine's time zone does not matter. A manual time, or fast-forward, runs from where it is
  // set. A jump of more than 20 minutes (a new setting, or waking from sleep) re-forms the clouds
  // for the weather of the new moment.
  function advanceEnv(dtReal) {
    const prev = env.ms,
      expect = dtReal * env.speed * 1000;
    if (env.clock === "now" && env.speed === 1) env.ms = Date.now();
    else env.ms += expect;
    const jumped = env.jump || Math.abs(env.ms - prev - expect) > 20 * 60e3;
    env.jump = false;
    return jumped;
  }
  function skySpeed() {
    return env.ref ? 1 : Math.min(env.speed, 60);
  }
  function stepWorld(step, now) {
    simT += step;
    if (env.ref) {
      simTc = simT;
      return;
    }
    const sp = skySpeed();
    simTc += step * sp;
    const jumped = advanceEnv(step);
    updateEnv(now, jumped);
    motionStep(step, step * sp);
    if (jumped) {
      sky.reset(simTc, false);
      mo.gustTurn = mo.seaTurn = NaN;
    }
  }

  function tick() {
    if (!running) return;
    requestAnimationFrame(tick);
    const now = performance.now() / 1000;
    const dt = Math.min(now - last, 1);
    last = now;
    if (HK_SETTINGS.fps > 0) {
      // documented Wallpaper Engine limiter
      acc += dt;
      if (acc < 1.0 / HK_SETTINGS.fps) return;
      acc -= 1.0 / HK_SETTINGS.fps;
      if (acc > 1.0 / HK_SETTINGS.fps) acc = 0;
    }
    // real time between drawn frames, capped so a pause does not jump the scene; the cap follows
    // a low FPS limit (up to 0.9 s, below the surf's one-second continuity check)
    const step = Math.min(now - lastDraw, Math.min(0.9, Math.max(0.25, 1.5 / HK_SETTINGS.fps)));
    stepWorld(step, now);
    lastDraw = now;
    renderScene(simulate("live", 0, simT, simT === 0, simTc));
    present();
    if (snd.kit && snd.ctx.state === "running")
      soundStep(snd.kit, snd.ctx.currentTime + SND.look, simT, step);
    frames++;
    if (now - uiT >= 0.25) {
      uiT = now;
      refreshUI();
    }
    if (debug && now - fpsT >= 0.5) {
      fpsShown = frames / (now - fpsT);
      frames = 0;
      fpsT = now;
      hud.textContent =
        `fps ${fpsShown.toFixed(1)}  cpu ${cpuMs.toFixed(2)} ms\n` +
        `t ${simT.toFixed(1)} s  clouds ${sky.clouds.length}  caps ${liveCaps.list.length}  bank ${bank.bumps.length}\n` +
        (env.ref
          ? "ref"
          : `${new Date(env.ms).toISOString().slice(0, 16)}Z ${env.wx.regime} sun ${env.b.sun.app.toFixed(1)}° r ${env.L.r.toExponential(1)} mlim ${LU.mlim.toFixed(1)}`);
    }
  }

  // ------------------------------------------------------------------ controls (browser only)
  // Wallpaper Engine provides wallpaperRegisterAudioListener to its pages; there the wallpaper just
  // follows the system clock and the simulated weather, and this panel stays hidden.
  const $ = (id) => document.getElementById(id);
  const JST = 9 * 3600e3;
  const REGIME_JA = {
    clear: "快晴",
    fair: "晴れ",
    partly: "晴れ時々曇り",
    overcast: "曇り",
    showers: "にわか雨",
    rain: "雨",
    storm: "荒天",
  };
  const DIR16 = [
    "北",
    "北北東",
    "北東",
    "東北東",
    "東",
    "東南東",
    "南東",
    "南南東",
    "南",
    "南南西",
    "南西",
    "西南西",
    "西",
    "西北西",
    "北西",
    "北北西",
  ];
  const WDAY = "日月火水木金土";
  const jst = (ms) => {
    const d = new Date(ms + JST);
    return {
      y: d.getUTCFullYear(),
      mo: d.getUTCMonth() + 1,
      d: d.getUTCDate(),
      wd: d.getUTCDay(),
      h: d.getUTCHours(),
      mi: d.getUTCMinutes(),
    };
  };
  const hhmm = (ms) => {
    const p = jst(ms);
    return `${p.h}:${String(p.mi).padStart(2, "0")}`;
  };
  const dayOf = (ms) => Math.floor((ms + JST) / 86400e3);
  const rsCache = new Map();
  function sunTimes(day) {
    if (!rsCache.has(day)) {
      if (rsCache.size > 8) rsCache.clear();
      rsCache.set(day, HE.riseSet(day * 86400e3 - JST));
    }
    return rsCache.get(day);
  }
  let uiT = 0,
    uiOn = false,
    dragging = false;
  const PREF = "hirakubo-sky-v1";
  function savePrefs() {
    try {
      localStorage.setItem(
        PREF,
        JSON.stringify({
          clock: env.clock,
          ms: env.clock === "manual" ? env.ms : null,
          force: env.force,
          light: env.light,
          sound: snd.want,
          vol: snd.vol,
        }),
      );
    } catch (e) {
      /* storage unavailable */
    }
  }
  function loadPrefs() {
    try {
      const o = JSON.parse(localStorage.getItem(PREF) || "null");
      if (!o) return;
      if (o.clock === "manual" && Number.isFinite(o.ms)) {
        env.clock = "manual";
        env.ms = o.ms;
      }
      if (o.force === null || (Number.isInteger(o.force) && o.force >= 0 && o.force < 7))
        env.force = o.force;
      if (o.light === "beam" || o.light === "iso") env.light = o.light;
      if (typeof o.sound === "boolean") snd.want = o.sound;
      if (Number.isInteger(o.vol) && o.vol >= 0 && o.vol <= 100) snd.vol = o.vol;
    } catch (e) {
      /* storage unavailable */
    }
  }
  function statusLines() {
    const p = jst(env.ms),
      wx = env.wx,
      b = env.b,
      day = dayOf(env.ms),
      rs = sunTimes(day);
    let sun;
    if (rs.rise && env.ms < rs.rise) sun = `日の出 ${hhmm(rs.rise)}`;
    else if (rs.set && env.ms < rs.set) sun = `日の入り ${hhmm(rs.set)}`;
    else {
      const n = sunTimes(day + 1);
      sun = `日の出 ${n.rise ? hhmm(n.rise) : "--"}`;
    }
    const wind = `${DIR16[Math.round(wx.windFrom / 22.5) % 16]}の風 ${Math.round(wx.windSpeed)} m/s`;
    const moon = `月齢 ${(b.moon.age * 29.53).toFixed(1)}`;
    return [
      `平久保崎 ${p.mo}月${p.d}日(${WDAY[p.wd]}) ${hhmm(env.ms)}${env.speed > 1 ? `　×${env.speed}` : ""}`,
      `${REGIME_JA[wx.regime]}${env.force == null ? "" : "（指定）"} ・ ${wind} ・ ${sun} ・ ${moon}`,
    ];
  }
  function setPressed(ids, on) {
    for (const id of ids) $(id).setAttribute("aria-pressed", String(id === on));
  }
  function syncManual() {
    const p = jst(env.ms);
    $("manual-date").value =
      `${p.y}-${String(p.mo).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
    if (!dragging) $("manual-time").value = String(p.h * 60 + p.mi);
    $("manual-out").value = hhmm(env.ms);
  }
  function refreshUI() {
    if (!uiOn || env.ref) return;
    $("sky-clock").textContent = hhmm(env.ms);
    if ($("sky-panel").hidden) return;
    const [a, b] = statusLines();
    $("sky-status").innerHTML = "";
    $("sky-status").append(
      a,
      Object.assign(document.createElement("span"), { className: "sub", textContent: b }),
    );
    if (env.clock === "manual") syncManual();
    soundHint();
  }
  function applyManual() {
    const d = $("manual-date").value.split("-").map(Number),
      m = Number($("manual-time").value);
    if (d.length !== 3 || d.some((v) => !Number.isFinite(v))) return;
    env.ms = Date.UTC(d[0], d[1] - 1, d[2]) - JST + m * 60e3;
    env.jump = true;
    env.litMs = NaN;
    savePrefs();
    refreshUI();
  }
  function setupUI() {
    if (HK_SETTINGS.wallpaper || typeof window.wallpaperRegisterAudioListener === "function")
      return;
    uiOn = true;
    $("sky-ui").hidden = false;
    const panel = $("sky-panel"),
      toggle = $("sky-toggle");
    toggle.addEventListener("click", () => {
      panel.hidden = !panel.hidden;
      toggle.setAttribute("aria-expanded", String(!panel.hidden));
      refreshUI();
    });
    const clockBtns = ["clock-now", "clock-manual"],
      speedBtns = ["speed-1", "speed-60", "speed-600"];
    const showClock = () => {
      setPressed(clockBtns, env.clock === "now" ? "clock-now" : "clock-manual");
      $("manual-box").hidden = env.clock !== "manual";
    };
    $("clock-now").addEventListener("click", () => {
      env.clock = "now";
      env.ms = Date.now();
      env.jump = true;
      env.litMs = NaN;
      showClock();
      savePrefs();
      refreshUI();
    });
    $("clock-manual").addEventListener("click", () => {
      env.clock = "manual";
      showClock();
      syncManual();
      savePrefs();
      refreshUI();
    });
    for (const id of speedBtns)
      $(id).addEventListener("click", () => {
        env.speed = Number(id.slice(6));
        setPressed(speedBtns, id);
        if (env.clock === "now" && env.speed === 1) {
          env.ms = Date.now();
          env.jump = true;
          env.litMs = NaN;
        }
        refreshUI();
      });
    const range = $("manual-time");
    range.addEventListener("pointerdown", () => {
      dragging = true;
    });
    range.addEventListener("pointerup", () => {
      dragging = false;
    });
    range.addEventListener("input", () => {
      $("manual-out").value =
        `${Math.floor(range.value / 60)}:${String(range.value % 60).padStart(2, "0")}`;
      applyManual();
    });
    $("manual-date").addEventListener("change", applyManual);
    const sel = $("sky-weather");
    sel.value = env.force == null ? "auto" : String(env.force);
    sel.addEventListener("change", () => {
      env.force = sel.value === "auto" ? null : Number(sel.value);
      env.jump = true;
      env.litMs = NaN;
      savePrefs();
      refreshUI();
    });
    const lightBtns = ["light-beam", "light-iso"];
    setPressed(lightBtns, "light-" + env.light);
    for (const id of lightBtns)
      $(id).addEventListener("click", () => {
        env.light = id.slice(6);
        setPressed(lightBtns, id);
        savePrefs();
      });
    // sound starts from a click or tap (browsers only let a page play after one); a sound left on in
    // an earlier visit waits for the first click, tap or key anywhere on the page
    const soundBtns = ["sound-off", "sound-on"],
      vol = $("sound-vol");
    const showSound = () => {
      setPressed(soundBtns, snd.want ? "sound-on" : "sound-off");
      $("sound-box").hidden = !snd.want;
      soundHint();
    };
    for (const id of soundBtns)
      $(id).addEventListener("click", () => {
        snd.want = id === "sound-on";
        showSound();
        soundSync();
        savePrefs();
      });
    vol.value = String(snd.vol);
    vol.addEventListener("input", () => {
      snd.vol = Number(vol.value);
      soundSync();
    });
    vol.addEventListener("change", savePrefs);
    // a touch counts as a user's gesture on its release (pointerup, touchend, click), a mouse on its press
    const arm = () => {
      snd.armed = true;
      if (snd.want && !(snd.ctx && snd.ctx.state === "running")) soundSync();
    };
    for (const ev of ["pointerdown", "pointerup", "touchend", "click", "keydown"])
      window.addEventListener(ev, arm, true);
    document.addEventListener("visibilitychange", soundSync);
    showSound();
    showClock();
    refreshUI();
  }

  // ------------------------------------------------------------------ sound (browser only)
  // Nothing is recorded: every sound is synthesised in Web Audio from the simulation of the moment,
  // as heard from the viewer's place on the hill. Each stretch of the reef roars as its crest breaks
  // on screen, heard r/343 s later from 0.7–1.1 km, without the highs the air takes over that
  // distance; the grass rustles on the side where the blades at the viewer's feet bend, and a wire
  // whistles in a gale; the rain hisses and ticks on the stone with its rate; thunder follows each
  // flash after the time its distance takes at 343 m/s. Two animals: the Ryukyu scops owl
  // (リュウキュウコノハズク), whose males call a two-note コホッ at about 800–900 Hz on nights all year
  // round, and the grass cicada Mogannia minuta (イワサキクサゼミ), which buzzes ジー in the grass on
  // spring mornings, from late March through May. The levels, the owl's rhythm and bouts, the
  // cicada's pitch and pulse rate, and the thunder's distances are chosen.
  const SND = { c: 343, zones: 8, look: 0.05 };
  const ZONES = Array.from({ length: SND.zones }, (_, k) => {
    // stretches of the reef, left to right
    const c = Math.round(((k + 0.5) * W) / SND.zones),
      x = REEF_X[c],
      z = REEF_Z[c];
    return { c, r: Math.hypot(x, z, CAM_H), pan: clamp(Math.atan2(x, z) / (40 * D2R), -0.9, 0.9) };
  });
  // the blades at the viewer's feet nearest the left, the middle and the right of the view
  const FG_EAR = [W / 6, W / 2, (5 * W) / 6].map((x) => {
    let b = 0;
    for (let f = 1; f < NF; f++) if (Math.abs(FG.x[f] - x) < Math.abs(FG.x[b] - x)) b = f;
    return b;
  });
  const GUST_RMS = Math.sqrt(SETS.live.gust.reduce((a, r) => a + r[2] * r[2], 0) / 2);
  const OWLS = [
    { f: 850, pan: -0.5, lp: 4200, g: 1 },
    { f: 805, pan: 0.65, lp: 2600, g: 0.45 },
  ]; // a near male and a far one
  const CICADAS = [
    { f: 6300, pr: 88, pan: -0.6 },
    { f: 6900, pr: 97, pan: 0.15 },
    { f: 7400, pr: 104, pan: 0.7 },
  ];
  const snd = { want: false, vol: 70, armed: false, ctx: null, kit: null, stop: 0 };

  function noiseBuffers(ctx) {
    // eight seconds each of white, pink (Kellet's filter) and brown noise at an rms of 0.3, with the
    // loop's seam crossfaded
    const sr = ctx.sampleRate,
      n = Math.round(8 * sr),
      m = Math.round(0.1 * sr),
      rnd = mulberry32(4242);
    const raw = [new Float32Array(n + m), new Float32Array(n + m), new Float32Array(n + m)];
    let b0 = 0,
      b1 = 0,
      b2 = 0,
      b3 = 0,
      b4 = 0,
      b5 = 0,
      b6 = 0,
      br = 0;
    for (let i = 0; i < n + m; i++) {
      const x = 2 * rnd() - 1;
      b0 = 0.99886 * b0 + x * 0.0555179;
      b1 = 0.99332 * b1 + x * 0.0750759;
      b2 = 0.969 * b2 + x * 0.153852;
      b3 = 0.8665 * b3 + x * 0.3104856;
      b4 = 0.55 * b4 + x * 0.5329522;
      b5 = -0.7616 * b5 - x * 0.016898;
      raw[0][i] = x;
      raw[1][i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + x * 0.5362;
      b6 = x * 0.115926;
      br = (br + 0.02 * x) / 1.02;
      raw[2][i] = br;
    }
    return raw.map((r) => {
      const buf = ctx.createBuffer(1, n, sr),
        d = buf.getChannelData(0);
      let s = 0;
      for (let i = 0; i < n; i++) {
        d[i] = i < m ? lerp(r[n + i], r[i], i / m) : r[i];
        s += d[i] * d[i];
      }
      const k = 0.3 / Math.sqrt(s / n);
      for (let i = 0; i < n; i++) d[i] *= k;
      return buf;
    });
  }
  function dropBuffer(ctx) {
    // a drop on stone: a click that rings for a moment near 3 kHz
    const sr = ctx.sampleRate,
      n = Math.round(0.03 * sr),
      buf = ctx.createBuffer(1, n, sr),
      d = buf.getChannelData(0),
      rnd = mulberry32(77);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      d[i] =
        0.8 * Math.sin(TAU * 3000 * t) * Math.exp(-t / 0.004) +
        0.5 * (2 * rnd() - 1) * Math.exp(-t / 0.0008);
    }
    return buf;
  }
  // the whole graph, on any BaseAudioContext (the tests render it offline)
  function soundKit(ctx) {
    const rnd = mulberry32(5150),
      [white, pink, brown] = noiseBuffers(ctx);
    const gain = (v = 0) => {
      const g = ctx.createGain();
      g.gain.value = v;
      return g;
    };
    const filter = (type, f, Q) => {
      const b = ctx.createBiquadFilter();
      b.type = type;
      b.frequency.value = f;
      b.Q.value = Q;
      return b;
    };
    const panner = (p) => {
      const s = ctx.createStereoPanner();
      s.pan.value = p;
      return s;
    };
    const loop = (buf) => {
      const s = ctx.createBufferSource();
      s.buffer = buf;
      s.loop = true;
      s.playbackRate.value = 0.97 + 0.06 * rnd();
      s.start(0, rnd() * buf.duration);
      return s;
    };
    const out = gain(0),
      comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.knee.value = 6;
    comp.ratio.value = 8;
    comp.attack.value = 0.004;
    comp.release.value = 0.3;
    out.connect(comp).connect(ctx.destination);
    const bus = {};
    for (const k of ["surf", "wind", "rain", "thunder", "owl", "cicada"])
      (bus[k] = gain(1)).connect(out);
    const K = {
      ctx,
      rnd,
      gain,
      filter,
      panner,
      white,
      pink,
      brown,
      drop: dropBuffer(ctx),
      out,
      bus,
      log: [],
      t: NaN,
      slow: -Infinity,
      bolt: bolt.t0,
      seen: new Float64Array(SND.zones),
    };
    // the reef: a bed from all of it and from the island's, and each stretch breaking in its turn
    K.bed = gain();
    for (const p of [-0.6, 0.6])
      loop(pink)
        .connect(filter("lowpass", 420, 0.5))
        .connect(panner(p))
        .connect(K.bed);
    loop(brown)
      .connect(filter("lowpass", 110, 0.5))
      .connect(K.bed);
    K.bed.connect(bus.surf);
    K.zone = ZONES.map((Z) => {
      const lp = filter("lowpass", 380, 0.5),
        g = gain();
      loop(pink).connect(lp).connect(g).connect(panner(Z.pan)).connect(bus.surf);
      return { lp, g };
    });
    // the wind: a low buffeting, the grass left, middle and right, and a wire's Aeolian tone
    K.rumble = gain();
    loop(brown)
      .connect(filter("lowpass", 160, 0.5))
      .connect(K.rumble)
      .connect(bus.wind);
    K.rustle = [-0.75, 0, 0.75].map((p) => {
      const g = gain();
      loop(white)
        .connect(filter("bandpass", 3400, 0.45))
        .connect(g)
        .connect(panner(p))
        .connect(bus.wind);
      return g;
    });
    K.whistleF = filter("bandpass", 500, 40);
    K.whistle = gain();
    loop(white).connect(K.whistleF).connect(K.whistle).connect(panner(0.35)).connect(bus.wind);
    // the rain: a hiss and a patter (the drops are made as they fall)
    K.hiss = gain();
    for (const p of [-0.7, 0.7])
      loop(white)
        .connect(filter("highpass", 1200, 0.5))
        .connect(panner(p))
        .connect(K.hiss);
    K.hiss.connect(bus.rain);
    K.patter = gain();
    loop(pink)
      .connect(filter("bandpass", 900, 0.6))
      .connect(K.patter)
      .connect(bus.rain);
    // the owls: a near tone and a far one through the air's lowpass
    K.owlWave = ctx.createPeriodicWave(
      new Float32Array([0, 0, 0, 0]),
      new Float32Array([0, 1, 0.1, 0.03]),
    );
    K.owlIn = OWLS.map((o) => {
      const lp = filter("lowpass", o.lp, 0.7);
      lp.connect(panner(o.pan)).connect(bus.owl);
      return lp;
    });
    K.owl = { next: 5 + 25 * rnd(), left: 0, who: 0 };
    // the cicadas: a band of noise near 6–7 kHz, pulsed about a hundred times a second by a square wave
    K.cic = CICADAS.map((c) => {
      const am = gain(0.5),
        depth = gain(0.5),
        lvl = gain(),
        o = ctx.createOscillator();
      o.type = "square";
      o.frequency.value = c.pr;
      o.connect(depth).connect(am.gain);
      o.start();
      loop(white)
        .connect(filter("bandpass", c.f, 4))
        .connect(am)
        .connect(lvl)
        .connect(panner(c.pan))
        .connect(bus.cicada);
      return { lvl, on: rnd() < 0.5, next: 5 * rnd() };
    });
    return K;
  }
  function note(K, e) {
    K.log.push(e);
    if (K.log.length > 200) K.log.shift();
  }
  function surfBreak(K, z, at, a) {
    const { lp, g } = K.zone[z],
      p = (0.16 * Math.min(a * a, 2.5) * 900) / ZONES[z].r;
    g.gain.setTargetAtTime(p, at, 0.2); // the lip falls along the stretch
    g.gain.setTargetAtTime(0.08 * p, at + 0.8, 1.5); // and the white water hisses out
    lp.frequency.setTargetAtTime(1100, at, 0.15);
    lp.frequency.setTargetAtTime(360, at + 0.5, 1.2);
    note(K, { kind: "surf", at, z, a });
  }
  function thunder(K, at, r, strokes) {
    // the channel is kilometres long, so the farther the flash, the longer the peal, and the more of
    // its highs the air has taken
    const ctx = K.ctx,
      rnd = K.rnd,
      near = r < 2500;
    const D = 3 + (1.6 * r) / 1000 + strokes,
      peak = 1.1 * clamp(1500 / r, 0.12, 1);
    const s = ctx.createBufferSource(),
      g = K.gain();
    s.buffer = K.brown;
    s.loop = true;
    s.connect(K.filter("lowpass", clamp(2000 * (1000 / r) ** 0.8, 110, 1200), 0.6))
      .connect(g)
      .connect(K.bus.thunder);
    let tt = at;
    const bumps = 2 + strokes + Math.floor(3 * rnd());
    for (let k = 0; k < bumps; k++) {
      // the first arrival, then the rest of the channel
      const p = peak * (k === 0 ? 1 : 0.3 + 0.6 * rnd()),
        a = k === 0 && near ? 0.01 : 0.05 + 0.15 * rnd();
      g.gain.setTargetAtTime(p, tt, a);
      g.gain.setTargetAtTime(0.2 * p, tt + 3 * a, 0.3 + 0.5 * rnd());
      tt += 3 * a + (D / bumps) * (0.3 + 0.9 * rnd());
    }
    g.gain.setTargetAtTime(0, tt, D / 6);
    s.start(at, rnd() * 6);
    s.stop(tt + D);
    if (near) {
      // the crack of the first stroke
      const c = ctx.createBufferSource(),
        cg = K.gain();
      c.buffer = K.white;
      c.connect(K.filter("highpass", 700, 0.7))
        .connect(cg)
        .connect(K.bus.thunder);
      cg.gain.setValueAtTime(0, at);
      cg.gain.linearRampToValueAtTime((0.7 * (2500 - r)) / 1300, at + 0.004);
      cg.gain.setTargetAtTime(0, at + 0.004, 0.08);
      c.start(at, rnd() * 6);
      c.stop(at + 1);
    }
    note(K, { kind: "thunder", at, r });
  }
  function owlCall(K, at, who, act) {
    const o = K.ctx.createOscillator(),
      e = K.gain(),
      f = OWLS[who].f,
      g = 0.1 * OWLS[who].g * act;
    o.setPeriodicWave(K.owlWave);
    o.connect(e).connect(K.owlIn[who]);
    o.frequency.setValueAtTime(0.96 * f, at); // コ: short and softer
    e.gain.setValueAtTime(0, at);
    e.gain.linearRampToValueAtTime(0.35 * g, at + 0.015);
    e.gain.linearRampToValueAtTime(0, at + 0.07);
    const b = at + 0.16; // ホッ: up onto the note, then off it
    o.frequency.setValueAtTime(0.93 * f, b);
    o.frequency.linearRampToValueAtTime(f, b + 0.05);
    o.frequency.linearRampToValueAtTime(0.97 * f, b + 0.24);
    e.gain.setValueAtTime(0, b);
    e.gain.linearRampToValueAtTime(g, b + 0.03);
    e.gain.linearRampToValueAtTime(0.8 * g, b + 0.17);
    e.gain.linearRampToValueAtTime(0, b + 0.24);
    o.start(at);
    o.stop(b + 0.3);
    note(K, { kind: "owl", at, who });
  }
  const rainOf = (wx) => (wx.rain > 0.02 ? wx.rainRate : 0); // mm/h, as the wet ground takes it
  function owlAct() {
    // after dusk, out of the rain and a strong wind
    if (!env.b) return 0;
    return (
      smooth01((-2 - env.b.sun.app) / 4) *
      clamp(1 - rainOf(env.wx), 0, 1) *
      clamp((12 - env.wx.windSpeed) / 4, 0, 1)
    );
  }
  function cicadaAct() {
    // mid-March to early June, 7–12 h, dry, sun up, not too windy
    if (!env.b) return 0;
    const p = jst(env.ms),
      doy = (Date.UTC(p.y, p.mo - 1, p.d) - Date.UTC(p.y, 0, 1)) / 86400e3,
      h = p.h + p.mi / 60;
    const season = smooth01((doy - 74) / 16) * smooth01((166 - doy) / 20);
    const morning = smooth01((h - 6.5) / 1.5) * smooth01((12.5 - h) / 2);
    const wx = env.wx;
    return (
      season *
      morning *
      (rainOf(wx) > 0.1 || env.b.sun.app < 0 ? 0 : 1) *
      (1 - 0.5 * wx.deck) *
      clamp((11 - wx.windSpeed) / 4, 0, 1)
    );
  }
  // one step of the scene (sim time t, dt s) heard at context time `when`
  function soundStep(K, when, t, dt) {
    const ctx = K.ctx,
      wx = env.wx,
      U = wx.windSpeed,
      R = rainOf(wx);
    const cont = t - K.t > 0 && t - K.t < 1; // not the first step, nor a jump in time
    K.t = t;
    for (let z = 0; z < SND.zones; z++) {
      const Z = ZONES[z],
        n = crest.n[Z.c];
      if (cont && n === K.seen[z] + 1) surfBreak(K, z, when + Z.r / SND.c, ampR[Z.c]);
      K.seen[z] = n;
    }
    if (bolt.t0 !== K.bolt) {
      K.bolt = bolt.t0;
      if (cont && t - bolt.t0 < 1) {
        const r = 1200 + 7800 * K.rnd() ** 1.3;
        thunder(K, when + (bolt.t0 - t) + r / SND.c, r, bolt.n);
      }
    }
    if (R > 0) {
      // drops on the stone, more as it rains harder
      const m = Math.min(4 + 2 * R, 40) * dt;
      for (let k = Math.floor(m) + (K.rnd() < m % 1 ? 1 : 0); k > 0; k--) {
        const s = ctx.createBufferSource();
        s.buffer = K.drop;
        s.playbackRate.value = 0.55 + 1.1 * K.rnd();
        s.connect(K.gain(0.02 + 0.07 * K.rnd() ** 2))
          .connect(K.panner(1.8 * K.rnd() - 0.9))
          .connect(K.bus.rain);
        s.start(when + K.rnd() * dt);
      }
    }
    if (cont && t - K.slow < 0.1) return; // the levels, ten times a second
    K.slow = t;
    const set = (param, v, tc) => param.setTargetAtTime(v, when, tc);
    set(K.bed.gain, 0.035 + 0.035 * mo.kSwell, 2);
    let gm = 0;
    FG_EAR.forEach((f, k) => {
      const gn = clamp(
        pointSum(TURNED.gust, FG.gx[f], FG.gz[f], "live", 0, mo.gustT) / (2 * GUST_RMS),
        -1,
        1,
      );
      gm += gn / 3;
      set(K.rustle[k].gain, 0.2 * Math.min(((U * (1 + 0.5 * gn)) / 10) ** 2, 2), 0.15);
    });
    set(K.rumble.gain, 0.12 * Math.min(((U * (1 + 0.3 * gm)) / 12) ** 2, 3), 0.3);
    // the tone of a 4 mm wire, f = 0.2 U / d (chosen), only in a gale
    set(K.whistleF.frequency, 50 * U * (1 + 0.2 * gm), 0.3);
    set(K.whistle.gain, 3 * smooth01((U - 9) / 5) * (0.6 + 0.4 * gm), 0.3);
    const rr = Math.sqrt(R / 25);
    set(K.hiss.gain, 0.25 * rr, 1);
    set(K.patter.gain, 0.12 * rr, 1);
    // the owl calls in bouts of 6–23 calls some two seconds apart, then is quiet for a while
    const O = K.owl,
      act = owlAct();
    if (when + 0.15 >= O.next) {
      if (act < 0.05) {
        O.left = 0;
        O.next = when + 20 + 40 * K.rnd();
      } else if (O.left === 0) {
        O.left = 6 + Math.floor(18 * K.rnd());
        O.who = K.rnd() < 0.6 ? 0 : 1;
      } else {
        const at = Math.max(O.next, when);
        owlCall(K, at, O.who, act);
        O.next = at + (--O.left ? 1.9 + 0.7 * K.rnd() : 25 + 120 * K.rnd());
      }
    }
    // each cicada sings for a minute or so, rests, and sings again
    const ca = cicadaAct();
    for (const c of K.cic) {
      if (when >= c.next) {
        c.on = !c.on;
        c.next = when + (c.on ? 20 + 70 * K.rnd() : 4 + 25 * K.rnd());
      }
      set(c.lvl.gain, c.on ? 0.4 * ca : 0, 0.4);
    }
  }
  // on while it is wanted, the scene runs and the page is in view; the context is made at the first
  // click, and suspended (after a short fade) whenever it is not needed
  function soundSync() {
    const go = snd.want && running && !document.hidden;
    // iOS plays a page's Web Audio in an "ambient" session that the silent switch mutes; a
    // "playback" session is not muted (navigator.audioSession: Safari 16.4 on, absent elsewhere)
    const session = (type) => {
      try {
        if (navigator.audioSession) navigator.audioSession.type = type;
      } catch (e) {
        /* unsupported */
      }
    };
    if (go) session("playback");
    if (go && !snd.ctx && snd.armed) {
      try {
        snd.ctx = new AudioContext({ latencyHint: "playback" });
        snd.kit = soundKit(snd.ctx);
        snd.ctx.addEventListener("statechange", soundHint);
      } catch (e) {
        snd.ctx = snd.kit = null;
        snd.want = false;
        soundHint("このブラウザでは音を出せません。");
        return;
      }
    }
    if (snd.ctx) {
      const g = snd.kit.out.gain,
        now = snd.ctx.currentTime;
      clearTimeout(snd.stop);
      if (go) {
        if (snd.ctx.state !== "running") snd.ctx.resume().catch(() => {});
        g.cancelScheduledValues(now);
        g.setTargetAtTime((snd.vol / 100) ** 2, now, 0.4);
      } else {
        g.cancelScheduledValues(now);
        g.setTargetAtTime(0, now, 0.08);
        snd.stop = setTimeout(() => {
          if (snd.ctx.state === "running") snd.ctx.suspend();
          session("auto");
        }, 500);
      }
    }
    soundHint();
  }
  function soundHint(text) {
    const h = $("sound-hint");
    if (typeof text !== "string") {
      text = "";
      if (snd.want && !running)
        text = "動きを止めている間は鳴りません。画面をタップ（クリック）すると動き出します。";
      else if (snd.want && !(snd.ctx && snd.ctx.state === "running"))
        text = "ブラウザの決まりで、画面を一度タップ（クリック）すると鳴り始めます。";
    }
    h.textContent = text;
    h.hidden = !text;
  }

  // ------------------------------------------------------------------ start
  (async () => {
    await loadImages();
    sky.init();
    bank.init();
    // test hooks: exact loop frames for comparison with hirakubo_loop.py, and live frames at any time
    Object.assign(HKAPI, {
      selfTest,
      renderLoop(i) {
        renderScene(simulate("loop", i, i / FPS, true));
        return readScene();
      },
      renderLive(t) {
        renderScene(simulate("live", 0, t, true));
        return readScene();
      },
      advanceLive(t0, t1, step) {
        // run the live systems forward without drawing every step
        for (let t = t0; t <= t1; t += step) {
          if (!env.ref) motionStep(step, step);
          simulate("live", 0, t);
        }
        let cover = 0;
        for (let x = 0; x < W; x++) cover += colD[(W + x) * 4] > 0;
        return {
          clouds: sky.clouds.length,
          caps: liveCaps.list.length,
          bank: bank.bumps.length,
          cover: cover / W,
        };
      },
      cloudInfo: (t) =>
        sky.clouds.map((c) => ({
          kind: c.kind,
          tb: c.tb,
          ...c.pose(t),
          ...c.life(t),
          fog: env.ref ? 0 : c.fog(t),
        })),
      beamInfo: () => ({
        ...fx,
        beamKenv: LU.beamK,
        beamB: LU.beamB,
        X: env.L && env.L.X,
        lampLevel: LU.lampLevel,
        light: env.light,
      }),
      skyState: () => ({
        targets: env.ref ? null : sky.targets(),
        next: { ...sky.next },
        cull: { ...sky.cull },
      }),
      rasterTimes: (t) =>
        sky.clouds.map((c) => {
          const a = performance.now();
          c.raster(t);
          return [
            c.kind,
            +(performance.now() - a).toFixed(2),
            c.sprite ? c.sprite.w * c.sprite.h : 0,
          ];
        }),
      // the sky of any moment and weather: { ref, time (UTC ms), weather (0–6 or null), speed, t, reset }
      setEnv(o = {}) {
        if ("time" in o) {
          env.clock = "manual";
          env.ms = o.time;
        }
        if ("speed" in o) env.speed = o.speed;
        if ("weather" in o) env.force = o.weather;
        if ("wind" in o) env.wind = o.wind;
        if ("wet" in o) env.wetFix = o.wet;
        if ("light" in o) env.light = o.light;
        if ("ref" in o) env.ref = !!o.ref;
        if (env.ref) refPalettes();
        else {
          updateEnv(performance.now() / 1000, true);
          if (o.reset !== false) {
            sky.reset(o.t ?? simT, false);
            mo.gustTurn = mo.seaTurn = NaN;
          }
        }
        return HKAPI.envInfo();
      },
      envInfo: () => ({
        ref: env.ref,
        ms: env.ms,
        regime: env.wx.regime,
        deck: env.wx.deck,
        cu: env.wx.cu,
        rain: env.wx.rain,
        wind: [env.wx.windSpeed, env.wx.windFrom],
        sun: env.b && env.b.sun.app,
        r: env.L && env.L.r,
        mlim: LU.mlim,
        lamp: LU.lampLevel,
        mo: { ...mo },
        target: env.ref ? 6 : sky.target(),
      }),
      wetInfo: () => ({ ...wetness(env.ms, env.force), ms: env.ms, wet: LU.wet, pool: LU.pool }),
      turnInfo: () => ({
        gust: mo.gustTurn,
        sea: mo.seaTurn,
        target: env.ref ? 0 : turnTarget(),
        rows: Object.fromEntries(
          ["gust", "rough", "chop", "chopL"].map((k) => [k, TURNED[k].map((r) => r.slice(0, 5))]),
        ),
      }),
      audioInfo: () => ({
        want: snd.want,
        vol: snd.vol,
        armed: snd.armed,
        state: snd.ctx ? snd.ctx.state : "none",
        time: snd.ctx && snd.ctx.currentTime,
        owl: snd.kit && { ...snd.kit.owl },
        owlAct: owlAct(),
        cicadaAct: cicadaAct(),
        zones: ZONES,
        log: snd.kit ? snd.kit.log.slice(-30) : [],
      }),
      // the sound of the live scene rendered offline: { dur, dt, t0, solo: bus name, vol, owlAt, thunder: [[at, r, strokes]],
      // onStep(t, fx) }
      async soundTest(o = {}) {
        const sr = o.sr || 44100,
          dur = o.dur || 20,
          dt = o.dt || 0.05,
          t0 = o.t0 ?? simT;
        const ctx = new OfflineAudioContext({
          numberOfChannels: 2,
          length: Math.ceil(sr * dur),
          sampleRate: sr,
        });
        const K = soundKit(ctx);
        K.out.gain.value = o.vol ?? 1;
        if (o.solo) for (const k in K.bus) K.bus[k].gain.value = k === o.solo ? 1 : 0;
        if (o.owlAt != null) K.owl.next = o.owlAt;
        for (const [at, r, n] of o.thunder || []) thunder(K, at + r / SND.c, r, n);
        for (let t = t0; t < t0 + dur; t += dt) {
          if (!env.ref) motionStep(dt, dt);
          simulate("live", 0, t);
          soundStep(K, t - t0, t, dt);
          if (o.onStep) o.onStep(t, fx);
        }
        simT = t0 + dur;
        return { buf: await ctx.startRendering(), log: K.log };
      },
      stop() {
        running = false;
      },
      setTime(t) {
        simT = t;
      },
      state: () => ({
        t: simT,
        cpuMs,
        clouds: sky.clouds.length,
        caps: liveCaps.list.length,
        view: { ...view },
      }),
    });
    if (testing) return; // harness drives frames itself
    if (debug) hud.hidden = false;
    loadPrefs();
    env.ref = false;
    updateEnv(performance.now() / 1000, true);
    sky.reset(0, true);
    setupUI();
    layout();
    setupPan();
    window.addEventListener("resize", layout);
    renderScene(simulate("live", 0, 0, true));
    present();
    lastDraw = last = performance.now() / 1000;
    const reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      // show the scene still; a click starts it
      running = false;
      canvas.addEventListener("click", () => {
        if (!running) {
          running = true;
          last = lastDraw = performance.now() / 1000;
          soundSync();
          tick();
        }
      });
      window.addEventListener("resize", () => {
        present();
      });
      return;
    }
    requestAnimationFrame(tick);
  })().catch((e) => {
    fail("描画を開始できませんでした。" + e.message);
    console.error(e);
  });
})();
