# Plan — Per-worker e2e backends (remove the Playwright workers:1 cap)

| Field | Value |
| --- | --- |
| Date | 2026-08-12 |
| Source | User: "fix it" — the proper fix flagged in c740d3a: per-worker data dir + port instead of serializing on a shared backend |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | feature/cmd-cmd-font-size-controller |
| Base SHA | c740d3a |
| Mode | Autonomous (assumptions in §5) |

## 1. Objective

`bunx playwright test` runs all spec files in parallel (no `workers: 1` cap) deterministically: each Playwright worker provisions its own headless backend (own `AGETOR_DATA_DIR`, own API port, own token), while a single shared Vite serves the static webview to all of them. Suite green across repeated runs at default parallelism; no leaked processes or data dirs.

## 2. Ground truth (investigation anchors)

- The cap guards two things at once: shared SQLite preference state AND the single static `webServer` block that can only start one backend (`playwright.config.ts:36,45-89`).
- Vite must stay single-instance (`vite.config.ts:18-19` — `port: 5173, strictPort: true`) and CAN be shared: no proxy; the client reads `#api=<port>&token=<token>` from the hash (`src/mainview/lib/api.ts:265`).
- `src/bun/headless.ts` supports N simultaneous instances on distinct dir/port pairs — env read per process (`AGETOR_DATA_DIR` at `db.ts:42` module load; `AGETOR_API_PORT`/`AGETOR_API_TOKEN` via `api-config.ts:21-24`); creds/pid state all lives under `dataDir`. **Trap**: idle self-shutdown after ~5 min unless `AGETOR_DAEMON_IDLE_MS=0` (`headless.ts:129-143`).
- Fake-driver env (`AGETOR_CLAUDE_DRIVER=fake`, `AGETOR_CLAUDE_BIN=/bin/echo`, `AGETOR_TMUX_BIN=/bin/echo`, `AGETOR_CLAUDE_ARGS=""`) currently rides on `webServer.env` (`playwright.config.ts:67-88`) and is required by quote.spec.ts (creates + starts a real run) — must move onto each per-worker backend's env.
- Ports claimed elsewhere: 4317 (packaged default), 4318 (dev/e2e), 4399–4531 (bun unit tests, one static port per file). Per-worker ports go to **4600 + parallelIndex**.
- No fixture infra exists (zero `test.extend` hits); all three specs import `E2E_API_PORT`/`E2E_API_TOKEN`/`E2E_BASE_URL` from `../playwright.config` and duplicate `gotoApp`/`openSettingsGeneral`/preference helpers.
- `scripts/dev-headless.sh` stays untouched — it remains the manual/interactive recipe; the fixture spawns `bun src/bun/headless.ts` directly (no nohup/pidfile indirection needed when the fixture owns the child process handle).

## 3. Design

**New `e2e/fixtures.ts`** — the only place backend lifecycle lives:
- `export const test = base.extend<{}, { backend: E2EBackend }>` with a **worker-scoped** `backend` fixture; `export { expect }`.
- `E2EBackend = { apiPort: number; apiToken: string; apiBase: string; bootBase: string; dataDir: string }` where `apiBase = http://127.0.0.1:<port>` and `bootBase = ${E2E_BASE_URL}/#api=<port>&token=<token>` (specs append `&theme=`/`&fontSize=` etc. as today).
- Provision: `apiPort = 4600 + workerInfo.parallelIndex`; `apiToken` = unique per worker (fixed prefix + index is fine — loopback-only, disposable); `dataDir = mkdtemp(os.tmpdir()/agetor-e2e-)` — a fresh dir per worker per run kills the stale-state class entirely and needs no pretest sweep.
- Spawn `bun src/bun/headless.ts` (child_process, stdio to a log file under the dataDir for debuggability) with env: the dir/port/token trio + `AGETOR_DAEMON_IDLE_MS=0` + the fake-driver quartet. Poll `GET /health` until 200 (≤30s) before yielding.
- Teardown (after `use`): SIGTERM, wait ≤4s, SIGKILL fallback, then `rm -rf` the temp dataDir. The fixture holds the ChildProcess handle, so no pidfiles.

**`playwright.config.ts`**:
- `webServer` becomes Vite-only: command `bun run hmr`, `url: E2E_BASE_URL`, keep `reuseExistingServer: !CI` (an interactive `bun run dev:hmr` Vite on 5173 is reusable — it serves the same bundle). Drop the trap/tail wrapper and the backend env block (moved to the fixture).
- Remove `workers: 1` (keep `fullyParallel: false` — within-file serial is still intended; the specs are written stateful-serial by design).
- Keep `E2E_VITE_PORT`/`E2E_BASE_URL` exports. Remove `E2E_API_PORT`/`E2E_API_TOKEN`/`E2E_DATA_DIR` exports once nothing imports them (dev-headless.sh does not — it has its own defaults).

**New `e2e/helpers.ts`** — consolidate the duplicated per-spec helpers, parametrized by `E2EBackend`: `gotoApp`, `openSettingsGeneral`, `putPreference`/`getPreferences` (bearer-token fetch wrappers). Specs keep any spec-specific helpers local.

**Spec migrations** (`theme.spec.ts`, `font-size.spec.ts`, `quote.spec.ts`): import `test`/`expect` from `./fixtures`; derive `API_BASE`/`BOOT_URL`/auth from the `backend` fixture (worker-scoped, so a file-level `test.beforeAll(({ backend }) => …)` or per-test destructuring — implementer picks the least-churn shape); swap duplicated helpers for `helpers.ts`. Test bodies/assertions unchanged.

## 4. Work breakdown & execution

- **I1 (sonnet, single agent — the pieces are tightly coupled)**: everything in §3. Verify: `bun run typecheck`; `bunx playwright test` at default parallelism 3× consecutively green; one `--workers=1` run also green (both modes must work); confirm no leftover `agetor-e2e-*` dirs in tmp and no orphan `headless.ts` processes after runs.
- **Review (opus)**: diff review, focus on lifecycle correctness (leaks on failure paths, health-poll robustness, teardown ordering) and port/token collision reasoning.
- **Fixes if needed → final runner (haiku)**: typecheck + bun test + playwright (default workers).

## 5. Assumptions (autonomous)

1. Worker backends spawn `headless.ts` directly instead of reusing `dev-headless.sh` — the script keeps its manual-use contract untouched; the fixture owns its child handle, which is strictly more robust than pidfiles.
2. Temp-dir data dirs (not `~/.agetor-dev-e2e-<n>`) — fresh state per run is a feature for tests; the named `~/.agetor-dev-e2e` dir remains only for whoever uses dev-headless.sh manually.
3. Port base 4600, disjoint from all known claims.
4. `fullyParallel` stays `false`; parallelism unit remains the spec file.
