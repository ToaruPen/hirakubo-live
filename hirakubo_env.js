// The world around the scene as pure functions of UTC time: sun and moon at the cape,
// single-scattering sky light, and a simulated weather that follows Ishigaki's seasons.
// hirakubo_live_build.py inlines this file into the wallpaper; the tests load it in Node.
const HKEnv = (() => {
  "use strict";
  const D2R = Math.PI / 180,
    R2D = 180 / Math.PI;
  // 平久保埼灯台 24°36′32″N 124°18′54″E. The camera stands on the hill south of it looking
  // due north: +x east (right), +z north (away), eye 60 m above the sea
  const SITE = {
    lat: 24 + 36 / 60 + 32 / 3600,
    lon: 124 + 18 / 60 + 54 / 3600,
    heading: 0,
    eyeH: 60,
  };
  const JST = 9 * 3600e3;
  const norm360 = (x) => ((x % 360) + 360) % 360;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const smooth01 = (x) => {
    x = clamp(x, 0, 1);
    return x * x * (3 - 2 * x);
  };
  const lerp = (a, b, t) => a + (b - a) * t;
  const julian = (ms) => ms / 86400000 + 2440587.5;

  // ------------------------------------------------------------------ sun and moon
  function sunEcliptic(J) {
    // NOAA / Meeus low precision, apparent, of date
    const T = (J - 2451545) / 36525;
    const L0 = norm360(280.46646 + T * (36000.76983 + 0.0003032 * T));
    const M = (357.52911 + T * (35999.05029 - 0.0001537 * T)) * D2R;
    const C =
      Math.sin(M) * (1.914602 - T * (0.004817 + 0.000014 * T)) +
      Math.sin(2 * M) * (0.019993 - 0.000101 * T) +
      Math.sin(3 * M) * 0.000289;
    const om = (125.04 - 1934.136 * T) * D2R;
    const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
    return {
      lam: norm360(L0 + C - 0.00569 - 0.00478 * Math.sin(om)),
      beta: 0,
      eps: eps0 + 0.00256 * Math.cos(om),
    };
  }
  function moonEcliptic(J) {
    // P. Schlyter's elements with the main perturbations (~0.1°)
    const d = J - 2451543.5;
    const N = (125.1228 - 0.0529538083 * d) * D2R,
      inc = 5.1454 * D2R,
      w = (318.0634 + 0.1643573223 * d) * D2R;
    const a = 60.2666,
      e = 0.0549,
      M = norm360(115.3654 + 13.0649929509 * d) * D2R;
    let E = M + e * Math.sin(M) * (1 + e * Math.cos(M));
    for (let k = 0; k < 5; k++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    const xv = a * (Math.cos(E) - e),
      yv = a * Math.sqrt(1 - e * e) * Math.sin(E);
    const v = Math.atan2(yv, xv);
    let r = Math.hypot(xv, yv);
    const xh = r * (Math.cos(N) * Math.cos(v + w) - Math.sin(N) * Math.sin(v + w) * Math.cos(inc));
    const yh = r * (Math.sin(N) * Math.cos(v + w) + Math.cos(N) * Math.sin(v + w) * Math.cos(inc));
    const zh = r * Math.sin(v + w) * Math.sin(inc);
    let lam = Math.atan2(yh, xh) * R2D,
      beta = Math.atan2(zh, Math.hypot(xh, yh)) * R2D;
    const Ms = norm360(356.047 + 0.9856002585 * d) * D2R,
      Ls = Ms * R2D + 282.9404 + 4.70935e-5 * d;
    const Lm = N * R2D + w * R2D + M * R2D;
    const Dm = (Lm - Ls) * D2R,
      F = (Lm - N * R2D) * D2R;
    lam +=
      -1.274 * Math.sin(M - 2 * Dm) +
      0.658 * Math.sin(2 * Dm) -
      0.186 * Math.sin(Ms) -
      0.059 * Math.sin(2 * M - 2 * Dm) -
      0.057 * Math.sin(M - 2 * Dm + Ms) +
      0.053 * Math.sin(M + 2 * Dm) +
      0.046 * Math.sin(2 * Dm - Ms) +
      0.041 * Math.sin(M - Ms) -
      0.035 * Math.sin(Dm) -
      0.031 * Math.sin(M + Ms) -
      0.015 * Math.sin(2 * F - 2 * Dm) +
      0.011 * Math.sin(M - 4 * Dm);
    beta +=
      -0.173 * Math.sin(F - 2 * Dm) -
      0.055 * Math.sin(M - F - 2 * Dm) -
      0.046 * Math.sin(M + F - 2 * Dm) +
      0.033 * Math.sin(F + 2 * Dm) +
      0.017 * Math.sin(2 * M + F);
    r += -0.58 * Math.cos(M - 2 * Dm) - 0.46 * Math.cos(2 * Dm);
    return { lam: norm360(lam), beta, r };
  }
  function equatorial(lam, beta, eps) {
    const l = lam * D2R,
      b = beta * D2R,
      e = eps * D2R;
    const ra = Math.atan2(Math.sin(l) * Math.cos(e) - Math.tan(b) * Math.sin(e), Math.cos(l));
    const dec = Math.asin(Math.sin(b) * Math.cos(e) + Math.cos(b) * Math.sin(e) * Math.sin(l));
    return { ra: norm360(ra * R2D), dec: dec * R2D };
  }
  function gmst(J) {
    const T = (J - 2451545) / 36525;
    return norm360(
      280.46061837 + 360.98564736629 * (J - 2451545) + T * T * (0.000387933 - T / 38710000),
    );
  }
  function horizontal(ra, dec, lst, lat) {
    // true altitude and azimuth (from north, eastward)
    const H = (lst - ra) * D2R,
      p = lat * D2R,
      d = dec * D2R;
    const alt = Math.asin(Math.sin(p) * Math.sin(d) + Math.cos(p) * Math.cos(d) * Math.cos(H));
    const az = Math.atan2(
      -Math.cos(d) * Math.sin(H),
      Math.sin(d) * Math.cos(p) - Math.cos(d) * Math.sin(p) * Math.cos(H),
    );
    return { alt: alt * R2D, az: norm360(az * R2D) };
  }
  function refraction(alt) {
    // Sæmundsson, for a true altitude (degrees)
    const h = Math.max(alt, -1.5);
    return 1.02 / Math.tan((h + 10.3 / (h + 5.11)) * D2R) / 60;
  }
  function bodies(ms, site = SITE) {
    const J = julian(ms),
      lst = norm360(gmst(J) + site.lon);
    const se = sunEcliptic(J),
      me = moonEcliptic(J);
    const sq = equatorial(se.lam, 0, se.eps),
      mq = equatorial(me.lam, me.beta, se.eps);
    const sun = horizontal(sq.ra, sq.dec, lst, site.lat),
      moon = horizontal(mq.ra, mq.dec, lst, site.lat);
    moon.alt -= Math.asin(1 / me.r) * R2D * Math.cos(moon.alt * D2R); // topocentric parallax (~1°)
    sun.app = sun.alt + refraction(sun.alt);
    moon.app = moon.alt + refraction(moon.alt);
    const elong = Math.acos(Math.cos(me.beta * D2R) * Math.cos((me.lam - se.lam) * D2R)) * R2D;
    const phaseAngle = 180 - elong;
    moon.illum = (1 + Math.cos(phaseAngle * D2R)) / 2;
    moon.waxing = norm360(me.lam - se.lam) < 180;
    moon.age = norm360(me.lam - se.lam) / 360; // 0 new, 0.5 full
    // moonlight relative to sunlight, from the Moon's magnitude at this phase angle (Allen)
    const V = -12.73 + 0.026 * phaseAngle + 4e-9 * phaseAngle ** 4;
    moon.rel = 10 ** (-0.4 * (V + 26.74));
    return { sun, moon, lst, lamSun: se.lam, lamMoon: me.lam };
  }
  // time at which the sun's upper limb crosses the horizon, searched within one local day
  function riseSet(dayStartMs, site = SITE) {
    const f = (ms) => {
      const s = bodies(ms, site).sun;
      return s.alt + refraction(s.alt) + 0.2667;
    };
    const out = { rise: null, set: null, transit: null, transitAlt: -90 };
    let prev = f(dayStartMs);
    for (let m = 5; m <= 1440; m += 5) {
      const t = dayStartMs + m * 60e3,
        cur = f(t);
      if (prev < 0 !== cur < 0) {
        let a = t - 300e3,
          b = t;
        for (let k = 0; k < 40; k++) {
          const c = (a + b) / 2;
          if (f(a) < 0 === f(c) < 0) a = c;
          else b = c;
        }
        out[prev < 0 ? "rise" : "set"] = (a + b) / 2;
      }
      const alt = bodies(t, site).sun.alt;
      if (alt > out.transitAlt) {
        out.transitAlt = alt;
        out.transit = t;
      }
      prev = cur;
    }
    return out;
  }

  // ------------------------------------------------------------------ sky light
  // Single scattering in a spherical atmosphere: Rayleigh, Mie (haze) and ozone at 680/550/440 nm
  // (coefficients as in Bruneton's reference implementation). Radiance and irradiance come out per
  // unit solar irradiance, so the same code serves the moon.
  const ATM = {
    Re: 6360e3,
    Ra: 6420e3,
    HR: 8000,
    HM: 1200,
    bR: [5.802e-6, 13.558e-6, 33.1e-6],
    bMs: 3.996e-6,
    bMe: 4.44e-6,
    bO: [0.65e-6, 1.881e-6, 0.085e-6],
    g: 0.8,
  };
  const ozone = (h) => Math.max(0, 1 - Math.abs(h - 25000) / 15000);
  function depthTo(r0, mu, n) {
    // optical depths to the top of the atmosphere, or null if the ground is in the way
    const q = r0 * r0 * (mu * mu - 1);
    if (mu < 0 && q + ATM.Re * ATM.Re >= 0) return null;
    const L = -r0 * mu + Math.sqrt(q + ATM.Ra * ATM.Ra);
    let tR = 0,
      tM = 0,
      tO = 0;
    for (let k = 0; k < n; k++) {
      // samples crowd the dense start of the path
      const u = (k + 0.5) / n,
        s = L * u * u,
        ds = (2 * L * u) / n;
      const h = Math.sqrt(r0 * r0 + s * s + 2 * r0 * s * mu) - ATM.Re;
      tR += Math.exp(-h / ATM.HR) * ds;
      tM += Math.exp(-h / ATM.HM) * ds;
      tO += ozone(h) * ds;
    }
    return [tR, tM, tO];
  }
  function transmit(dep, hz, out) {
    for (let c = 0; c < 3; c++)
      out[c] = dep
        ? Math.exp(-(ATM.bR[c] * dep[0] + ATM.bMe * hz * dep[1] + ATM.bO[c] * dep[2]))
        : 0;
    return out;
  }
  function skyRadiance(view, sun, hz, out) {
    // view, sun: unit vectors (east, north, up)
    const r0 = ATM.Re + SITE.eyeH,
      mu = Math.max(view[2], 0.002);
    const L = -r0 * mu + Math.sqrt(r0 * r0 * (mu * mu - 1) + ATM.Ra * ATM.Ra);
    const ct = view[0] * sun[0] + view[1] * sun[1] + view[2] * sun[2],
      g = ATM.g;
    const pR = (3 / (16 * Math.PI)) * (1 + ct * ct);
    const pM =
      ((3 / (8 * Math.PI)) * ((1 - g * g) * (1 + ct * ct))) /
      ((2 + g * g) * Math.pow(1 + g * g - 2 * g * ct, 1.5));
    out[0] = out[1] = out[2] = 0;
    let tR = 0,
      tM = 0,
      tO = 0;
    const n = 16,
      T = [0, 0, 0];
    for (let k = 0; k < n; k++) {
      const u = (k + 0.5) / n,
        s = L * u * u,
        ds = (2 * L * u) / n;
      const r = Math.sqrt(r0 * r0 + s * s + 2 * r0 * s * mu),
        h = r - ATM.Re;
      const dR = Math.exp(-h / ATM.HR) * ds,
        dM = Math.exp(-h / ATM.HM) * ds,
        dO = ozone(h) * ds;
      const muS = (r0 * sun[2] + s * ct) / r;
      const sd = depthTo(r, muS, 8);
      if (sd) {
        for (let c = 0; c < 3; c++) {
          T[c] = Math.exp(
            -(
              ATM.bR[c] * (tR + dR / 2 + sd[0]) +
              ATM.bMe * hz * (tM + dM / 2 + sd[1]) +
              ATM.bO[c] * (tO + dO / 2 + sd[2])
            ),
          );
          out[c] += T[c] * (ATM.bR[c] * dR * pR + ATM.bMs * hz * dM * pM);
        }
      }
      tR += dR;
      tM += dM;
      tO += dO;
    }
    return out;
  }
  function dirENU(azDeg, altDeg) {
    const a = azDeg * D2R,
      e = altDeg * D2R;
    return [Math.sin(a) * Math.cos(e), Math.cos(a) * Math.cos(e), Math.sin(e)];
  }
  const HEMI = (() => {
    // quadrature for irradiance on a level surface
    const q = [];
    for (const [t0, t1] of [
      [0, 30],
      [30, 60],
      [60, 88],
    ]) {
      const w = (2 * Math.PI * (Math.cos(t0 * D2R) - Math.cos(t1 * D2R))) / 8,
        tz = (t0 + t1) / 2;
      for (let k = 0; k < 8; k++)
        q.push({ d: dirENU(k * 45 + 22.5, 90 - tz), w: w * Math.cos(tz * D2R) });
    }
    return q;
  })();
  const MEAN_DIRS = (() => {
    // for the mean radiance: bands at 1.5°, 6°, 20°, 45°, 75° (solid-angle weights)
    const q = [];
    for (const [a0, a1] of [
      [0, 3],
      [3, 10],
      [10, 30],
      [30, 60],
      [60, 90],
    ]) {
      const w = (Math.sin(a1 * D2R) - Math.sin(a0 * D2R)) / 12,
        am = (a0 + a1) / 2;
      for (let k = 0; k < 12; k++) q.push({ d: dirENU(k * 30 + 15, am), w });
    }
    return q;
  })();
  function skyMean(sun, hz, out) {
    const L = [0, 0, 0];
    out[0] = out[1] = out[2] = 0;
    for (const { d, w } of MEAN_DIRS) {
      skyRadiance(d, sun, hz, L);
      for (let c = 0; c < 3; c++) out[c] += L[c] * w;
    }
    return out;
  }
  function skyIrradiance(sun, hz, out) {
    const L = [0, 0, 0];
    out[0] = out[1] = out[2] = 0;
    for (const { d, w } of HEMI) {
      skyRadiance(d, sun, hz, L);
      for (let c = 0; c < 3; c++) out[c] += L[c] * w;
    }
    return out;
  }
  function sunAt(heightM, sun, hz, out) {
    // sunlight reaching a point at this height (unit TOA irradiance)
    const r0 = ATM.Re + heightM;
    return transmit(depthTo(r0, sun[2], 12), hz, out);
  }

  // ------------------------------------------------------------------ colour
  const lin = (c) => {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const enc = (v) => {
    v = clamp(v, 0, 1);
    return Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055));
  };
  const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  function tone(c) {
    // soft shoulder above 0.9 (linear) that keeps the hue
    const m = Math.max(c[0], c[1], c[2]);
    if (m <= 0.9) return c;
    const k = (0.9 + 0.1 * (1 - Math.exp(-(m - 0.9) / 0.1))) / m;
    return [c[0] * k, c[1] * k, c[2] * k];
  }
  const encRGB = (c, out, o) => {
    c = tone(c);
    for (let i = 0; i < 3; i++) out[o + i] = enc(c[i]);
  };

  // ------------------------------------------------------------------ weather
  // Seven regimes; a 3-hour slot holds one, drawn by a Markov chain (persistence) from a monthly
  // climatology of Ishigaki: cloudy NE monsoon in winter, the rainy season in May–June, sunny
  // southerlies with afternoon showers in summer, gales in the typhoon months. The table is a
  // simplification chosen for this scene, not statistics.
  const REGIMES = ["clear", "fair", "partly", "overcast", "showers", "rain", "storm"];
  const RP = {
    // sc: the share of the layer cloud that is low stratocumulus (the rest is altocumulus or
    // altostratus above, or nimbostratus when it rains)
    //        cumulus deck  deckDark cirrus windK rain  haze  convect swell sc
    clear: [0.04, 0.0, 0.0, 0.15, 0.75, 0.0, 0.12, 0.1, 0.8, 0.0],
    fair: [0.25, 0.0, 0.0, 0.35, 1.0, 0.0, 0.25, 0.35, 1.0, 0.0],
    partly: [0.42, 0.45, 0.2, 0.45, 1.1, 0.0, 0.35, 0.45, 1.0, 0.3],
    overcast: [0.1, 0.94, 0.45, 0.1, 1.2, 0.03, 0.5, 0.15, 1.1, 0.85],
    showers: [0.55, 0.3, 0.3, 0.3, 1.25, -1, 0.45, 1.0, 1.2, 0.0],
    rain: [0.05, 1.0, 0.75, 0.0, 1.45, 0.6, 0.75, 0.3, 1.3, 0.0],
    storm: [0.06, 1.0, 0.92, 0.0, 2.4, 1.0, 0.9, 0.7, 2.2, 0.0],
  };
  const KEYS = ["cu", "deck", "dark", "ci", "windK", "rain", "haze", "conv", "swell", "sc"];
  const CLIMATE = [
    // regime weights, wind from (deg), mean wind (m/s), swell base
    [[5, 10, 20, 35, 10, 17, 3], 20, 7.0, 1.3],
    [[5, 12, 22, 30, 10, 18, 3], 25, 6.8, 1.25],
    [[7, 18, 25, 22, 12, 13, 3], 40, 6.2, 1.1],
    [[8, 22, 25, 18, 12, 12, 3], 70, 5.6, 1.0],
    [[5, 15, 20, 20, 15, 22, 3], 120, 5.2, 0.9],
    [[6, 16, 18, 18, 17, 22, 3], 180, 5.6, 0.85],
    [[12, 35, 22, 6, 15, 4, 6], 190, 5.4, 0.8],
    [[10, 32, 22, 7, 17, 5, 7], 160, 5.4, 0.9],
    [[10, 28, 22, 10, 15, 7, 8], 80, 6.0, 1.0],
    [[7, 20, 25, 20, 12, 10, 6], 40, 7.2, 1.15],
    [[6, 15, 24, 28, 10, 14, 3], 30, 7.4, 1.25],
    [[5, 12, 22, 33, 10, 16, 2], 20, 7.4, 1.3],
  ];
  function hash(a, b, s) {
    let h =
      (Math.imul(a | 0, 0x8da6b343) ^
        Math.imul(b | 0, 0xd8163841) ^
        Math.imul(s | 0, 0xcb1ab31f)) >>>
      0;
    h ^= h >>> 16;
    h = Math.imul(h, 0x7feb352d) >>> 0;
    h ^= h >>> 15;
    h = Math.imul(h, 0x846ca68b) >>> 0;
    h ^= h >>> 16;
    return (h >>> 8) / 16777216;
  }
  function noise(x, s) {
    // smooth value noise in [0, 1] over a float64 axis
    const i = Math.floor(x);
    let f = x - i;
    f = f * f * (3 - 2 * f);
    const lo = i % 16777216,
      hi = Math.floor(i / 16777216);
    return lerp(
      hash(lo, hi, s),
      hash((lo + 1) % 16777216, hi + (lo + 1 === 16777216 ? 1 : 0), s),
      f,
    );
  }
  const SLOT = 3 * 3600e3;
  function monthOf(ms) {
    return new Date(ms + JST).getUTCMonth();
  }
  function localHour(ms) {
    return ((ms + JST) / 3600e3) % 24;
  }
  function draw(weights, u) {
    const tot = weights.reduce((a, b) => a + b, 0);
    let acc = 0;
    for (let k = 0; k < weights.length; k++) {
      acc += weights[k] / tot;
      if (u < acc) return k;
    }
    return weights.length - 1;
  }
  function slotWeights(n) {
    const ms = n * SLOT + SLOT / 2,
      m = monthOf(ms),
      w = CLIMATE[m][0].slice(),
      h = localHour(ms);
    if (m >= 4 && m <= 9 && h >= 11 && h < 19) w[4] *= 2.5; // afternoon convection over the island
    if (m < 4 || m > 9) w[6] *= 0.4; // gales outside typhoon season are rarer
    return w;
  }
  const regimeCache = new Map();
  function regimeOfSlot(n) {
    if (regimeCache.has(n)) return regimeCache.get(n);
    const anchor = Math.floor(n / 24) * 24 - 24; // chains restart every 3 days from 3 days back
    let r = draw(slotWeights(anchor), hash(anchor, 11, 501));
    for (let k = anchor + 1; k <= n; k++) {
      const u = hash(k, 17, 502);
      if (u > 0.55) r = draw(slotWeights(k), hash(k, 23, 503));
      else if (u > 0.45 && r === 6) r = 5; // gales tend to ease into rain
    }
    if (regimeCache.size > 256) regimeCache.clear();
    regimeCache.set(n, r);
    return r;
  }
  // raw weather at an instant; `force` pins the regime (preview)
  function weatherRaw(ms, force) {
    const n = Math.floor(ms / SLOT),
      frac = ms / SLOT - n;
    const r0 = force != null ? force : regimeOfSlot(n),
      r1 = force != null ? force : regimeOfSlot(n + 1);
    const w = smooth01((frac - 0.65) / 0.35); // the last hour of a slot turns into the next
    const P = {},
      a = RP[REGIMES[r0]],
      b = RP[REGIMES[r1]];
    KEYS.forEach((k, i) => {
      P[k] = lerp(a[i] < 0 ? 0.5 : a[i], b[i] < 0 ? 0.5 : b[i], w);
    });
    const showery = lerp(a[5] < 0 ? 1 : 0, b[5] < 0 ? 1 : 0, w);
    P.regime = REGIMES[w < 0.5 ? r0 : r1];
    const m = monthOf(ms),
      cl = CLIMATE[m],
      h = localHour(ms),
      warm = m >= 4 && m <= 9;
    const minutes = ms / 60e3;
    // convective showers come and go in cells of ~15 min
    const cell = Math.max(0, noise(minutes / 14, 601) * 1.6 - 0.75) * 1.8;
    P.rain = clamp(P.rain * (1 - showery) + showery * cell, 0, 1);
    // a shower is a towering cloud passing overhead: while it rains the sky closes in and darkens
    const over = showery * clamp(cell * 1.5, 0, 1);
    P.deck = lerp(P.deck, Math.max(P.deck, 0.97), over);
    P.dark = lerp(P.dark, Math.max(P.dark, 0.55), over);
    P.conv *= warm ? 0.7 + 0.6 * smooth01(1 - Math.abs(h - 14.5) / 5) : 0.8;
    P.cu = clamp(
      P.cu *
        (0.8 + 0.4 * noise(minutes / 50, 602)) *
        (warm ? 0.85 + 0.3 * smooth01(1 - Math.abs(h - 14) / 6) : 1),
      0,
      1,
    );
    P.deck = clamp(P.deck + 0.12 * (noise(minutes / 70, 603) - 0.5), 0, 1);
    P.ci = clamp(P.ci * (0.6 + 0.8 * noise(minutes / 120, 604)), 0, 1);
    P.windSpeed = cl[2] * P.windK * (0.8 + 0.4 * noise(minutes / 90, 605));
    P.windFrom = norm360(
      cl[1] +
        50 * (noise(minutes / 240, 606) - 0.5) +
        (P.regime === "rain" || P.regime === "storm" ? 20 : 0),
    );
    P.swellBase = cl[3];
    P.month = m;
    return P;
  }
  // sea state lags the wind: an exponential memory of about an hour for the wind sea, six for the swell
  function weather(ms, force) {
    const P = weatherRaw(ms, force);
    let ws = 0,
      wsw = 0,
      sw = 0,
      sww = 0;
    for (let k = 0; k < 12; k++) {
      const q = k === 0 ? P : weatherRaw(ms - k * 15 * 60e3, force),
        wk = Math.exp(-k / 4);
      ws += wk * q.windSpeed;
      wsw += wk;
    }
    for (let k = 0; k < 12; k++) {
      const q = k === 0 ? P : weatherRaw(ms - k * 3600e3, force),
        wk = Math.exp(-k / 6);
      sw += wk * q.swell * q.swellBase * clamp(q.windSpeed / 7, 0.6, 2.5);
      sww += wk;
    }
    P.seaWind = ws / wsw;
    P.swellK = sw / sww;
    const a = (P.windFrom + 180) * D2R; // wind blows toward the opposite direction
    P.windVec = [Math.sin(a) * P.windSpeed, Math.cos(a) * P.windSpeed];
    // visibility: haze, plus the extinction of the rain itself (Carbonneau: 1.076·R^0.67 dB/km, R in
    // mm/h). The rain rate is a chosen scale: 25·rain² mm/h, so steady rain (0.6) is about 9 mm/h
    // and the core of a shower about 25 mm/h
    P.rainRate = 25 * P.rain * P.rain;
    P.visibility =
      3.912 / (3.912 / lerp(60e3, 4e3, P.haze ** 1.3) + (1.076 * P.rainRate ** 0.67) / 4.343 / 1e3);
    P.lightning = P.regime === "storm" ? 1 : P.rain > 0.6 && P.conv > 0.7 ? 0.4 : 0;
    return P;
  }
  // the still's own conditions: a south-westerly of 8 m/s and fair-weather cumulus
  const REF_WEATHER = (() => {
    const P = {};
    KEYS.forEach((k, i) => {
      P[k] = RP.fair[i];
    });
    Object.assign(P, {
      regime: "fair",
      windSpeed: 8,
      windFrom: 225,
      seaWind: 8,
      swellK: 1,
      swellBase: 1,
      month: 8,
      windVec: [8 * Math.SQRT1_2, 8 * Math.SQRT1_2],
      visibility: 60e3,
      lightning: 0,
      rain: 0,
    });
    return P;
  })();

  // ------------------------------------------------------------------ lighting for one instant
  // Everything is expressed relative to the still's light: afternoon sun from the south-west,
  // 42° up (the direction its clouds and tower are shaded from), clear air. Colours are the
  // designed palette multiplied, in linear light, by (light now / light in the still), then an
  // eye adaptation r^(−p), where r meters the whole frame (about 40 % sky, 60 % ground) against
  // the still. p = 0.86 is a chosen value: nights come out dark but readable. Very dim scenes shift
  // toward rod vision (bluer, less saturated), judged per surface from its absolute luminance: a
  // bright twilight glow keeps its colour while the dim sky around it does not. Single scattering leaves the sky away from a low sun
  // too dark, so a share of the sky's own mean radiance is added evenly for the higher orders.
  // Once the sun is down, single scattering in this model collapses (and turns red at the zenith,
  // which the real twilight sky is not: ozone makes it blue), so a twilight term takes over: a blue
  // sky whose brightness falls tenfold per 2.7° of solar depression (chosen to match the usual
  // decline of zenith luminance), a little brighter toward the sun and the horizon, until it
  // meets the night sky around −16°.
  const REF_SUN = { az: 225, alt: Math.asin(0.7 / Math.hypot(0.55, 0.7, 0.55)) * R2D };
  const ADAPT_P = 0.86;
  const MS_FILL = 0.25; // multiple-scattering share, of the mean sky radiance
  const NIGHT_SKY = 3.3e-8; // airglow + starlight, relative to the still's sky near 10°
  const TWI = { z0: 1e-3, decade: 2.7, col: [0.567, 1.04, 1.89] }; // zenith at sunset (model units), lum(col) = 1
  const FLOOR = [0.028, 0.0315, 0.0385]; // wallpaper legibility floor for lit surfaces (bluish)
  const CD = { sky10: 6000, land: 3000, cloud: 9000 }; // rough luminances in the still, cd/m²
  // share of rod vision: none above 3 cd/m², most of it below 0.003 cd/m² (the mesopic range)
  const rodShare = (Lcd) => 0.7 * clamp(Math.log10(3 / Math.max(Lcd, 1e-9)) / 3, 0, 1);
  function nodeDirs(W, H, HY, F) {
    // sky palette nodes: 5 columns × 10 levels of the still's ramp
    const nodes = [];
    for (let a = 0; a < 5; a++) {
      const x = (a * (W - 1)) / 4;
      for (let l = 0; l < 10; l++) {
        const v = (y) => {
          const t = clamp(y / HY, 0, 1);
          return Math.pow(t, 1.3) * 8.4 + 0.5 * (1 - x / W) * t;
        };
        let y;
        if (v(HY) <= l + 0.5) y = HY;
        else {
          let lo = 0,
            hi = HY;
          for (let k = 0; k < 30; k++) {
            const m = (lo + hi) / 2;
            if (v(m) < l + 0.5) lo = m;
            else hi = m;
          }
          y = (lo + hi) / 2;
        }
        nodes.push(
          dirENU(
            SITE.heading + Math.atan((x + 0.5 - W / 2) / F) * R2D,
            Math.max(Math.atan((HY - y + 0.5) / F) * R2D, 0.15),
          ),
        );
      }
    }
    return nodes;
  }
  function makeLighting(geo) {
    // geo: { W, H, HY, F, pal }
    const nodes = nodeDirs(geo.W, geo.H, geo.HY, geo.F);
    const refSun = dirENU(REF_SUN.az, REF_SUN.alt),
      hzRef = 1;
    const Eref = (() => {
      const s = sunAt(SITE.eyeH, refSun, hzRef, [0, 0, 0]),
        k = skyIrradiance(refSun, hzRef, [0, 0, 0]);
      return { dir: s.map((v) => v * refSun[2]), sky: k };
    })();
    const fillRef = skyMean(refSun, hzRef, [0, 0, 0]).map((v) => MS_FILL * v);
    const EtotRef = Eref.dir.map((v, c) => v + Eref.sky[c] + Math.PI * fillRef[c]);
    const skyRef = (d) => skyRadiance(d, refSun, hzRef, [0, 0, 0]).map((v, c) => v + fillRef[c]);
    const Lref = nodes.map(skyRef);
    const horizRef = skyRef(dirENU(0, 3));
    const L10ref = lum(skyRef(dirENU(0, 10)));
    const sunCloudRef = sunAt(1500, refSun, hzRef, [0, 0, 0]);
    const palLin = (k) => geo.pal[k].map((c) => c.map(lin));
    const SKY = palLin("sky"),
      WHITE = palLin("white");

    return function lighting(b, wx) {
      const hz = 0.4 + 2.4 * wx.haze;
      const sunD = dirENU(b.sun.az, b.sun.app),
        moonD = dirENU(b.moon.az, b.moon.app);
      const moonK = b.moon.app > -1 ? b.moon.rel * smooth01((b.moon.app + 1) / 3) : 0;
      // light on the ground: sun (through the cloud deck), sky, moon
      const sunG = sunAt(SITE.eyeH, sunD, hz, [0, 0, 0]),
        skyE = skyIrradiance(sunD, hz, [0, 0, 0]);
      const moonG = moonK > 0 ? sunAt(SITE.eyeH, moonD, hz, [0, 0, 0]) : [0, 0, 0];
      const moonSkyE = moonK > 0 ? skyIrradiance(moonD, hz, [0, 0, 0]) : [0, 0, 0];
      const mS = skyMean(sunD, hz, [0, 0, 0]),
        mM = moonK > 0 ? skyMean(moonD, hz, [0, 0, 0]) : [0, 0, 0];
      const fill = [0, 1, 2].map((c) => MS_FILL * (mS[c] + moonK * mM[c]));
      const twi =
        b.sun.app < 1
          ? TWI.z0 * Math.pow(10, Math.min(b.sun.app, 0) / TWI.decade) * smooth01(1 - b.sun.app)
          : 0;
      const sh = Math.hypot(sunD[0], sunD[1]) || 1;
      const M = [0, 0, 0];
      const skyAt = (d, out) => {
        skyRadiance(d, sunD, hz, out);
        if (moonK > 0) {
          skyRadiance(d, moonD, hz, M);
          for (let c = 0; c < 3; c++) out[c] += moonK * M[c];
        }
        const glow = NIGHT_SKY * L10ref * (1 + 1.5 * (1 - d[2]));
        const tw =
          twi * (1 + 0.6 * Math.max(0, (d[0] * sunD[0] + d[1] * sunD[1]) / sh) + 0.4 * (1 - d[2]));
        for (let c = 0; c < 3; c++) out[c] += glow * [0.95, 1, 1.05][c] + fill[c] + tw * TWI.col[c];
        return out;
      };
      // a cloud deck of optical depth tau (chosen: thin altocumulus ≈ 1, nimbostratus ≈ 25) hides the
      // sun and passes 1/(1 + 0.15 tau) of the light above it as diffuse light (a two-stream estimate)
      const deck = wx.deck,
        tau = 1 + 30 * wx.dark * wx.dark,
        Tdk = 1 / (1 + 0.15 * tau);
      const tCu = 1 - 0.25 * wx.cu; // cumulus shadows over the view, on average
      const E = [0, 0, 0],
        Eclr = [0, 0, 0],
        deckL = [0, 0, 0];
      const glowE = NIGHT_SKY * L10ref * Math.PI * 1.6;
      for (let c = 0; c < 3; c++) {
        const dir = sunG[c] * Math.max(sunD[2], 0) + moonK * moonG[c] * Math.max(moonD[2], 0);
        const sky = skyE[c] + moonK * moonSkyE[c] + Math.PI * (fill[c] + 1.3 * twi * TWI.col[c]);
        Eclr[c] = dir * tCu + sky + glowE;
        E[c] = (1 - deck) * (dir * tCu + sky) + deck * Tdk * (dir + sky) + glowE;
        deckL[c] = (Tdk * (dir + sky) + glowE) / Math.PI; // the deck's underside, seen from below
      }
      // exposure meters the frame (about 40 % sky, 60 % ground). The eye adapts to the time of day
      // (clear-sky light) with p, and only partly (0.45) to the gloom a deck adds on top of it.
      const Lclr = nodes.map((d) => skyAt(d, [0, 0, 0]));
      const meter = (Ls, Eg) => {
        let rs = 0;
        Ls.forEach((v, i) => {
          rs += lum(v) / lum(Lref[i]);
        });
        return Math.max((0.4 * rs) / Ls.length + (0.6 * lum(Eg)) / lum(EtotRef), 1e-12);
      };
      const rClr = meter(Lclr, Eclr);
      const r = meter(
        Lclr.map((v) => v.map((x, c) => x * (1 - deck) + deck * deckL[c])),
        E,
      );
      const X = Math.pow(rClr, -ADAPT_P) * Math.pow(r / rClr, -0.45);
      const rg = lum(E) / lum(EtotRef);
      const grade = (g, raw) => {
        // linear gain → displayed gain; raw = unadapted luminance ratio
        const Y = lum(g),
          k = rodShare(raw);
        return g.map((v, c) => lerp(v, Y * [0.62, 0.8, 1.15][c], k));
      };
      const purk = rodShare(rg * CD.land);
      const landG = grade(
        E.map((v, c) => Math.max((v / EtotRef[c]) * X, FLOOR[c])),
        rg * CD.land,
      );
      // sea: its colour mixes reflected sky near the horizon with light from below
      const H3c = skyAt(dirENU(0, 3), [0, 0, 0]),
        H3 = H3c.map((v, c) => v * (1 - deck) + deck * deckL[c]);
      const hg = grade(
        H3.map((v, c) => (v / horizRef[c]) * X),
        (lum(H3) / L10ref) * CD.sky10,
      );
      const hgClr = grade(
        H3c.map((v, c) => (v / horizRef[c]) * X),
        (lum(H3c) / L10ref) * CD.sky10,
      );
      const reflG = hg.map((v, c) => Math.max(v, FLOOR[c]));
      // sky palette (5 columns × 10 levels): the clear sky, seen wherever the deck leaves gaps
      const skyPal = new Uint8Array(150);
      Lclr.forEach((v, i) => {
        const g = grade(
            v.map((x, c) => (x / Lref[i][c]) * X),
            (lum(v) / L10ref) * CD.sky10,
          ),
          lv = i % 10;
        encRGB(
          [0, 1, 2].map((c) => SKY[lv][c] * g[c]),
          skyPal,
          i * 3,
        );
      });
      // clouds: sunlit sides take the sunlight at cloud height, shaded sides the sky light
      const sunC = sunAt(1500, sunD, hz, [0, 0, 0]),
        moonC = moonK > 0 ? sunAt(1500, moonD, hz, [0, 0, 0]) : [0, 0, 0];
      // under a deck the cumulus lose the sun: their tops take the diffuse light, their bases less
      const shadeDeck = 1 - deck;
      const litR = [0, 1, 2].map(
        (c) =>
          ((sunC[c] + moonK * moonC[c]) * shadeDeck + 0.3 * E[c]) /
            (sunCloudRef[c] + 0.3 * EtotRef[c]) +
          (0.8 * deck * E[c]) / EtotRef[c],
      );
      const litG = grade(
        litR.map((v) => v * X),
        lum(litR) * CD.cloud,
      );
      const ambG = grade(
        [0, 1, 2].map((c) => (E[c] / EtotRef[c]) * X * (1 - 0.35 * deck)),
        rg * CD.cloud * 0.3,
      );
      const cFloor = FLOOR.map((v) => v * (1 - 0.3 * deck));
      const deckR = deckL.map((v, c) => (v * Math.PI) / EtotRef[c]);
      const deckG = grade(
        deckR.map((v) => v * X),
        lum(deckR) * CD.cloud,
      );
      const cloudPal = new Uint8Array(21),
        deckPal = new Uint8Array(21),
        bankPal = new Uint8Array(21);
      const fogBank = 1 - Math.exp(-40e3 / wx.visibility);
      // the horizon: clear sky, or the underside of the deck where there is one
      const haze = [0, 1, 2].map((c) =>
        lerp(SKY[9][c] * hgClr[c], WHITE[3][c] * Math.max(deckG[c], FLOOR[c] * 0.8), deck),
      );
      for (let i = 0; i < 7; i++) {
        const t = i / 6,
          cl = [0, 0, 0],
          dk = [0, 0, 0],
          bk = [0, 0, 0];
        for (let c = 0; c < 3; c++) {
          const g = lerp(Math.max(ambG[c], cFloor[c]), Math.max(litG[c], cFloor[c]), t);
          cl[c] = WHITE[i][c] * g;
          dk[c] = WHITE[i][c] * Math.max(deckG[c] * lerp(1.25, 0.9, t), FLOOR[c] * 0.8); // darker palette entries, thicker cloud
          bk[c] = lerp(cl[c], haze[c], fogBank);
        }
        encRGB(cl, cloudPal, i * 3);
        encRGB(dk, deckPal, i * 3);
        encRGB(bk, bankPal, i * 3);
      }
      const hazeCol = new Uint8Array(3);
      encRGB(haze, hazeCol, 0);
      // cloud shading direction: the brightest of sun, moon and sky, in screen terms (x right, y down, z toward the viewer)
      const ws = Math.max(lum(sunC) * shadeDeck * smooth01((b.sun.app + 3) / 4), 0);
      const wm = moonK * lum(moonC) * shadeDeck * smooth01(b.moon.app / 3);
      const wa = 0.08 * lum(E);
      const lx = ws * sunD[0] + wm * moonD[0],
        ly = ws * sunD[2] + wm * moonD[2] + wa,
        lz = -(ws * sunD[1] + wm * moonD[1]);
      const ln = Math.hypot(lx, ly, lz) || 1;
      return {
        r,
        rg,
        X,
        purk,
        landG,
        reflG,
        skyPal,
        cloudPal,
        deckPal,
        bankPal,
        hazeCol,
        light: [lx / ln, -ly / ln, lz / ln],
        skyLum10: (lum(skyAt(dirENU(0, 10), [0, 0, 0])) / L10ref) * 6000, // cd/m², roughly
        sun: b.sun,
        moon: b.moon,
      };
    };
  }
  // naked-eye limiting magnitude for a sky of this luminance (cd/m²)
  function limitingMag(Lcd) {
    const bmag = 12.58 - 2.5 * Math.log10(Math.max(Lcd, 1e-6));
    return 7.93 - 5 * Math.log10(10 ** (4.316 - bmag / 5) + 1);
  }

  return {
    SITE,
    JST,
    REGIMES,
    bodies,
    riseSet,
    gmst,
    julian,
    weather,
    weatherRaw,
    REF_WEATHER,
    REF_SUN,
    makeLighting,
    limitingMag,
    lin,
    enc,
    dirENU,
    skyRadiance,
  };
})();
if (typeof module !== "undefined") module.exports = HKEnv;
