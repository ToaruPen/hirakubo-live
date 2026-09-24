import { defineConfig } from "@playwright/test";

// The smoke test opens the built page (pnpm build) from disk. WebGL runs on SwiftShader
// everywhere, so a laptop and a GPU-less CI runner draw the same pixels.
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 120_000,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? "github" : "list",
  use: {
    browserName: "chromium",
    launchOptions: { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] },
  },
});
