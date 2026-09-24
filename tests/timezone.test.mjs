// The scene follows Japan time whatever the viewer's time zone: weather and sky must not change
// with the process's TZ.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ENV_JS = fileURLToPath(new URL("../hirakubo_env.js", import.meta.url));

const PROBE = `
const src = require("node:fs").readFileSync(${JSON.stringify(ENV_JS)}, "utf8");
const E = require("node:vm").runInThisContext(src + "\\nHKEnv");
const out = [];
for (const ms of [Date.UTC(2026, 0, 15, 3), Date.UTC(2026, 6, 1, 9, 30), Date.UTC(2026, 8, 23, 5, 50)]) {
  const w = E.weather(ms), b = E.bodies(ms);
  out.push([w.regime, w.cu, w.windSpeed, w.windFrom, w.rain, b.sun.alt]);
}
process.stdout.write(JSON.stringify(out));
`;

const run = (tz) =>
  execFileSync(process.execPath, ["--input-type=commonjs", "-e", PROBE], {
    env: { ...process.env, TZ: tz },
    encoding: "utf8",
  });

test("weather and sun do not depend on the time zone", () => {
  const tokyo = run("Asia/Tokyo");

  for (const tz of ["UTC", "America/Los_Angeles", "Pacific/Kiritimati"]) {
    assert.equal(run(tz), tokyo, tz);
  }
});
