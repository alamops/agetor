/** Dev-mode default API port, distinct from the packaged-app default
 *  (4317 — see `getApiPort()` in `api-config.ts`) so a stale `bun run dev`
 *  process can't silently collide with a `.app` launch. Hardcoded here as
 *  the single source of truth — `scripts/wipe-dev.ts` imports this, and
 *  `package.json`'s `dev` / `dev:hmr` scripts embed the same literal in
 *  their env-var prefix (`AGETOR_API_PORT=4318 …`). The accompanying
 *  test in `dev-defaults.test.ts` greps `package.json` to enforce that
 *  the two sides don't drift. */
export const DEV_API_PORT = 4318;
