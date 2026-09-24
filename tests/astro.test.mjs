// HKEnv's sun and moon against the ephemerides of 国立天文台 暦計算室 (NAOJ).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInThisContext } from "node:vm";

// hirakubo_env.js is a classic script (the build inlines it into the page); run it as one
const source = readFileSync(new URL("../hirakubo_env.js", import.meta.url), "utf8");

const E = runInThisContext(`${source}\nHKEnv`, { filename: "hirakubo_env.js" });

const jst = (y, m, d, h = 0, mi = 0) => Date.UTC(y, m - 1, d, h - 9, mi);

const minutes = (a, b) => (a - b) / 60e3;

const near = (got, want, tol, what) => {
  assert.ok(Math.abs(got - want) <= tol, `${what}: got ${got.toFixed(3)}, want ${want} ± ${tol}`);
};

const at = (day, hms) => {
  const [h, m, s = 0] = hms.split(":").map(Number);

  return jst(...day, h, m) + s * 1e3;
};

// site, day, sunrise and its azimuth, transit and its apparent altitude, sunset and its azimuth
const SUN = [
  [
    "Ishigaki 2026-09-23",
    { lat: 24.3407, lon: 124.1556, eyeH: 0 },
    [2026, 9, 23],
    "6:32",
    89.6,
    "12:35:52",
    65.6,
    "18:39",
    270.2,
  ],
  [
    "Kagoshima 2026-06-21",
    { lat: 31.6, lon: 130.55, eyeH: 0 },
    [2026, 6, 21],
    "5:13",
    61.6,
    "12:20",
    81.8,
    "19:26",
    298.4,
  ],
  [
    "Kagoshima 2026-12-22",
    { lat: 31.6, lon: 130.55, eyeH: 0 },
    [2026, 12, 22],
    "7:13",
    117.2,
    "12:16",
    35,
    "17:19",
    242.8,
  ],
];

for (const [name, site, day, rise, riseAz, transit, transitAlt, set, setAz] of SUN) {
  test(`sun: ${name}`, () => {
    const r = E.riseSet(jst(...day), site);
    // NAOJ rounds rise and set to the minute
    near(minutes(r.rise, at(day, rise)), 0, 1, "sunrise (min)");
    near(minutes(r.set, at(day, set)), 0, 1, "sunset (min)");
    near(E.bodies(r.rise, site).sun.az, riseAz, 0.2, "sunrise azimuth (°)");
    near(E.bodies(r.set, site).sun.az, setAz, 0.2, "sunset azimuth (°)");
    // NAOJ's transit altitude includes refraction, as `app` does
    near(E.bodies(at(day, transit), site).sun.app, transitAlt, 0.1, "altitude at transit (°)");
  });
}

// the moon's elongation reaches 0 (朔), 90 (上弦), 180 (望) or 270 (下弦) at NAOJ's times
const PHASES = [
  ["新月 2026-06-15 11:54", jst(2026, 6, 15, 11, 54), 0],
  ["満月 2026-09-27 01:49", jst(2026, 9, 27, 1, 49), 180],
  ["新月 2026-09-11 12:27", jst(2026, 9, 11, 12, 27), 0],
  ["満月 2026-12-24 10:28", jst(2026, 12, 24, 10, 28), 180],
  ["上弦 2026-09-19 05:44", jst(2026, 9, 19, 5, 44), 90],
  ["下弦 2026-01-11 00:48", jst(2026, 1, 11, 0, 48), 270],
];

// how far the elongation is past `target` at `ms`, in -180..180°
const pastPhase = (ms, target) => {
  const b = E.bodies(ms);

  return ((((b.lamMoon - b.lamSun - target) % 360) + 540) % 360) - 180;
};

for (const [name, when, target] of PHASES) {
  test(`moon: ${name}`, () => {
    let a = when - 12 * 3600e3;
    let c = when + 12 * 3600e3;

    for (let k = 0; k < 50; k++) {
      const m = (a + c) / 2;

      if (pastPhase(a, target) < 0 === pastPhase(m, target) < 0) a = m;
      else c = m;
    }

    // the moon moves 0.5° an hour
    near(minutes((a + c) / 2, when) / 60, 0, 1, "phase time (h)");
  });
}
