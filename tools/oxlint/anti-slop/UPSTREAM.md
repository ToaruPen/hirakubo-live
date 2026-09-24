# Upstream provenance

- Source: https://github.com/dmmulroy/anti-slop (MIT, see `LICENSE`)
- Commit: `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b` (2026-09-10)
- Installed with the repository's `skills/install-anti-slop/scripts/install.mjs` at that commit,
  which copies the skill's bundled plugin. The copy equals the commit's `src/` without its
  `*.test.ts` files.
- Entry points: `index.ts` (generic rules, all enabled in `oxlint.config.ts`); `effect/index.ts`
  is copied but not registered, since this project does not use Effect.
- Local deviations: none. `LICENSE` is the upstream repository's license file, added because the
  installer does not copy it.
