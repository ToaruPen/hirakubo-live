// The built page (pnpm build) in a real browser: it starts, its loop mode still matches
// hirakubo_loop.py, and a finger pans the view on a phone.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { expect, test } from "@playwright/test";

interface View {
  cx: number;
  cy: number;
  scale: number;
}

interface HkApi {
  selfTest: string[];
  state: () => { t: number; view: View };
  renderLoop: (frame: number) => Uint8Array;
}

declare global {
  interface Window {
    HK: HkApi;
  }
}

const ROOT = join(import.meta.dirname, "..", "..");

const PAGE = pathToFileURL(join(ROOT, "hirakubo_live", "index.html")).href;

// Pixels of the page's loop mode that differ from hirakubo_loop.py's frames (float32 on the GPU
// against numpy's float64), measured on SwiftShader when this test was written; Apple's Metal
// renderer differed by at most 8 more. A change that adds over 2 % to a count fails.
const LOOP_MISMATCH: [number, number][] = [
  [0, 569],
  [360, 5448],
  [1100, 10_662],
];

test("the live page starts and animates without errors", async ({ page }) => {
  const errors: string[] = [];

  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto(PAGE);
  await page.waitForFunction(() => "HK" in window && window.HK.state().t > 1);
  expect(await page.evaluate(() => window.HK.selfTest)).toEqual([]);
  expect(errors).toEqual([]);
});

test("the loop mode stays as close to hirakubo_loop.py as when measured", async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), "hirakubo-loop-"));
  const frames = LOOP_MISMATCH.map(([frame]) => String(frame));

  execFileSync("uv", ["run", "python", "scripts/loop_frames.py", dir, ...frames], { cwd: ROOT });
  await page.goto(`${PAGE}#test`);
  await page.waitForFunction(() => "HK" in window);

  for (const [frame, measured] of LOOP_MISMATCH) {
    const png = readFileSync(join(dir, `loop_${frame}.png`)).toString("base64");

    const differing = await page.evaluate(
      async ([i, b64]) => {
        const got = window.HK.renderLoop(Number(i));
        const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();

        const bitmap = await createImageBitmap(blob, {
          colorSpaceConversion: "none",
          premultiplyAlpha: "none",
        });

        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const g = canvas.getContext("2d");

        if (!g) throw new Error("no 2d context");
        g.drawImage(bitmap, 0, 0);

        const want = g.getImageData(0, 0, bitmap.width, bitmap.height).data;
        let count = 0;

        for (let k = 0; k < want.length; k += 4) {
          if (got[k] !== want[k] || got[k + 1] !== want[k + 1] || got[k + 2] !== want[k + 2]) {
            count++;
          }
        }

        return count;
      },
      [String(frame), png],
    );

    expect(differing, `frame ${frame}`).toBeLessThanOrEqual(Math.ceil(measured * 1.02));
  }
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, hasTouch: true });

  test("a finger drags the view and a mouse does not", async ({ page }) => {
    await page.goto(PAGE);
    await page.waitForFunction(() => "HK" in window && window.HK.state().t > 0.5);

    const drag = (pointerType: string, dx: number) =>
      page.evaluate(
        async ([type, distance]) => {
          const canvas = document.querySelector("#hk");

          if (!canvas) throw new Error("no canvas");

          const fire = (name: string, x: number) =>
            canvas.dispatchEvent(
              new PointerEvent(name, {
                pointerId: 7,
                pointerType: String(type),
                clientX: x,
                clientY: 400,
                bubbles: true,
                isPrimary: true,
              }),
            );

          fire("pointerdown", 300);

          for (let k = 1; k <= 20; k++) {
            await new Promise((resolve) => setTimeout(resolve, 16));
            fire("pointermove", 300 + (Number(distance) * k) / 20);
          }

          // held still before lifting, so the view does not coast on
          await new Promise((resolve) => setTimeout(resolve, 200));
          fire("pointerup", 300 + Number(distance));

          return window.HK.state().view;
        },
        [pointerType, String(dx)],
      );

    const start = await page.evaluate(() => window.HK.state().view);
    const touched = await drag("touch", -200);

    // 200 CSS px at 2 device px each, over a scene drawn 5 device px to its pixel
    expect(touched.cx - start.cx).toBeCloseTo((200 * 2) / start.scale, 6);
    expect((await drag("mouse", 200)).cx).toBe(touched.cx);
  });
});
