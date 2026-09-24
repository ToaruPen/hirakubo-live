// Offline audio metrics for HK.soundTest buffers, and boot() that loads harness.js (see README).
window.M = {
  stats(buf, a = 0, b = buf.duration) {
    const sr = buf.sampleRate,
      i0 = Math.floor(a * sr),
      i1 = Math.min(Math.floor(b * sr), buf.length);
    let pk = 0,
      s = 0,
      n = 0;

    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);

      for (let i = i0; i < i1; i++) {
        const v = d[i];

        if (Math.abs(v) > pk) pk = Math.abs(v);
        s += v * v;
        n++;
      }
    }

    const db = (x) => +(20 * Math.log10(x + 1e-12)).toFixed(1);

    return { peakDb: db(pk), rmsDb: db(Math.sqrt(s / n)) };
  },
  env(buf, w = 1) {
    const out = [];

    for (let a = 0; a + w <= buf.duration + 1e-9; a += w) out.push(M.stats(buf, a, a + w).rmsDb);

    return out;
  },
  nan(buf) {
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);

      for (let i = 0; i < d.length; i++) if (!Number.isFinite(d[i])) return true;
    }

    return false;
  },
  goertzel(buf, f, a, b) {
    const sr = buf.sampleRate,
      d = buf.getChannelData(0),
      e = buf.getChannelData(1),
      i0 = Math.floor(a * sr),
      i1 = Math.floor(b * sr);
    const k = 2 * Math.cos((2 * Math.PI * f) / sr);
    let s1 = 0,
      s2 = 0;

    for (let i = i0; i < i1; i++) {
      const x = ((d[i] + e[i]) / 2) * (0.5 - 0.5 * Math.cos((2 * Math.PI * (i - i0)) / (i1 - i0)));
      const s0 = x + k * s1 - s2;
      s2 = s1;
      s1 = s0;
    }

    return s1 * s1 + s2 * s2 - k * s1 * s2;
  },
  peakFreq(buf, lo, hi, step, a, b) {
    let best = lo,
      bp = -1;

    for (let f = lo; f <= hi; f += step) {
      const p = M.goertzel(buf, f, a, b);

      if (p > bp) {
        bp = p;
        best = f;
      }
    }

    return best;
  },
  // first time the smoothed |x| passes frac of its maximum
  onset(buf, frac = 0.05, from = 0) {
    const sr = buf.sampleRate,
      d = buf.getChannelData(0),
      e = buf.getChannelData(1),
      w = Math.round(0.005 * sr);
    let mx = 0;
    const env = [];

    for (let i = 0; i + w <= d.length; i += w) {
      let s = 0;

      for (let j = i; j < i + w; j++) s += Math.abs(d[j]) + Math.abs(e[j]);
      env.push(s / (2 * w));
      mx = Math.max(mx, s / (2 * w));
    }

    for (let k = Math.floor((from * sr) / w); k < env.length; k++)
      if (env[k] > frac * mx) return +((k * w) / sr).toFixed(3);

    return null;
  },
  // rms of each channel, for the pan
  lr(buf, a, b) {
    const sr = buf.sampleRate;

    return [0, 1].map((c) => {
      const d = buf.getChannelData(c);
      let s = 0;

      for (let i = Math.floor(a * sr); i < Math.floor(b * sr); i++) s += d[i] * d[i];

      return +(10 * Math.log10(s / ((b - a) * sr) + 1e-24)).toFixed(1);
    });
  },
  kinds: (log) => log.reduce((a, e) => ((a[e.kind] = (a[e.kind] || 0) + 1), a), {}),
};

window.boot = async () => {
  await new Promise((r) => {
    const w = () => (window.HK && HK.renderLive ? r() : setTimeout(w, 100));
    w();
  });

  for (const f of ["/tools/harness/harness.js"])
    await new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = f + "?v=" + Date.now();
      s.onload = res;
      s.onerror = rej;
      document.head.appendChild(s);
    });
  window.hh = (px) => {
    let h = 2166136261;

    for (let i = 0; i < px.length; i++) {
      h ^= px[i];
      h = Math.imul(h, 16777619);
    }

    return (h >>> 0).toString(16);
  };
};
