import { defineConfig } from "oxlint";

// Policy: every enabled rule is an error. Fix the code, or disable a rule at the call site with a
// comment that says why it does not apply there.
export default defineConfig({
  env: { browser: true, node: true, es2024: true },
  // hirakubo_env.js defines HKEnv; the build inlines it before the page's own script
  globals: { HKEnv: "readonly" },
  categories: {
    correctness: "error",
    suspicious: "error",
    perf: "error",
  },
  ignorePatterns: [
    ".claude/**",
    "tools/oxlint/anti-slop/**",
    "hirakubo_live/**",
    "node_modules/**",
  ],
  jsPlugins: [{ name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" }],
  rules: {
    "oxc/no-accumulating-spread": "error",
    "anti-slop/no-array-filter-map": "error",
    "anti-slop/no-reduce-accumulator-copy": "error",
    "anti-slop/no-chained-type-assertions": "error",
    "anti-slop/no-conditional-empty-object-spread": "error",
    "anti-slop/no-known-value-widening": "error",
    "anti-slop/no-module-mocking": "error",
    "anti-slop/no-object-parameters": "error",
    "anti-slop/no-reflect-apply": "error",
    "anti-slop/no-reflect-get": "error",
    "anti-slop/no-runtime-typeof": "error",
    "anti-slop/no-shape-in-symbol-names": "error",
    "anti-slop/no-unknown-parameters": "error",
    "anti-slop/no-unknown-returns": "error",
    "anti-slop/no-unknown-type-aliases": "error",
    "anti-slop/no-unsafe-dictionary-type": "error",
    "anti-slop/no-widen-then-assert": "error",
    "anti-slop/require-readable-spacing": "error",
    "anti-slop/require-safety-comment-for-type-assertion": "error",
  },
});
