# Plan — fx.sh model catalog refresh: account-scoped picker + discovery triggers

| Field | Value |
| --- | --- |
| Date | 2026-08-27 |
| Source | `/implement update the fx.sh available models based on the models available in fx.sh` + 8 screenshots of fx's `Models 158` picker and agetor's stale fx picker; mid-turn owner directive "define glm-5.3-flash as the default"; owner reply "keep account scoped … we need a better way to discover, or more triggers" |
| Config | AGENTS_CONFIG.yml (balanced: investigate/implement/tests sonnet, review opus, test-running haiku; planning self) |
| Flags | none |
| Gates | grilled by owner (2 passes) + approved 2026-08-27 ("drop the premiums if they're not available for the signed in account" → D2 resolved as catalog-gated rows) |
| Branch | `feature/update-available-models-in-fx-sh` (already checked out; not `main`) |
| Base SHA | `89d9b926e4b7098492a7b78881fb70fee18f7796` (tree clean at plan time) |

## 1. Objective & success criteria

Make agetor's fx model picker show **what `fx models` shows for the account that will actually run the task**, and keep it that way without an app restart.

Done means:

1. `DEFAULT_MODEL.fx === "zai/glm-5.3-flash"` (owner decision), present in the curated list.
2. The curated `AGENT_OPTIONS.fx.models` is rebuilt from the live catalog (§3 D1/D2); none of the seven stale ids (`moonshotai/kimi-k3`, `-fast`, `zai/glm-5.2-fast`, `anthropic/claude-opus-5`, `-sonnet-5`, `openai/gpt-5.5`, `google/gemini-3.1-pro-preview`) survive *as unconditional rows* — they may only appear as a clearly-marked premium group that hides itself when the account's catalog lacks them (D2).
3. For fx, the picker (New Task form, task-details editor, CLI `agetor add`) renders **curated ∩ discovered** (labels/hints kept), then discovered-only ids, then — only if needed — the currently-selected id as an unlisted row. When discovery has nothing (fx not installed / probe failed / not ready yet) the full curated list shows, exactly as today.
4. Discovery is **per fx harness** (each harness probed with its own `harnessEnv`, so an additional-account `fx-2` harness sees *its* account's catalog), and it re-runs on every trigger in §3 D4 — boot race closed, `fx login` / install / enable flips picked up, manual ↻, periodic.
5. The false statements about `fx models --json` ("unauthenticated, Gateway-wide, 228 ids") in `agent-discovery.ts`, CLAUDE.md, and `docs/plans/fx-0.0.6-compat.md` are corrected to the measured truth (§2).
6. `bun run typecheck` green; `bun test` green; the new Playwright spec green.

## 2. Context & constraints (grounded findings)

All measured 2026-08-27 on fx **0.0.6** (`build_revision 79666393e5f6`, `~/.local/bin/fx`), spike artifacts under the session scratchpad `spikes/fx-catalog-scope/` and `spikes/discovery-boot-race/`.

- **The catalog is account-scoped.** `HOME=<empty> fx models --json` → **230** ids, `private_models_hidden: true`, every flagship present. Same binary with the owner's `fx login` (team `alamoweb`) → **158** ids, `private_models_hidden: false`, a *strict subset* (0 ids only-in-auth, 72 only-in-unauth). The 72 missing are precisely the premium tiers: every Anthropic id except `anthropic/claude-3-haiku`, every OpenAI `gpt-5.4`/`5.5`/`5.6`/`-pro` tier, all `google/gemini-3.x` + `2.5-pro`, `grok-4.5`/`4.20`, `kimi-k3`(+fast), non-flash `glm-5.x`, `deepseek-v4-pro`. Zero filesystem writes in either mode (verified: empty HOME stays empty). Latency 0.34 s unauth, 0.56–0.90 s auth — well inside `runProbe`'s 3 s timeout.
- **All seven curated ids are absent from the owner's 158.** fx's *compiled* default is still `moonshotai/kimi-k3` (empty-HOME `fx status --json`), but the owner's `~/.fx/settings.json` runs `zai/glm-5.3-flash` because K3 isn't in their catalog.
- **`discoverFx()` already returns the account catalog** — `runProbe` spawns with the process env (real `HOME`), so a logged-in user gets 158, not the 230 its doc comment promises. The comment ("unauthenticated and doesn't read/write HOME") is wrong on the *read* half. `src/bun/agent-discovery.ts:184-196`.
- **Boot race, reproduced.** Headless daemon from this worktree, `GET /agent-models` polled after `/health` was up: `t+0 s fx=0`, `t+0.5 s fx=0`, `t+1 s fx=158` (cursor=203 at the same tick; codex=0, claude-code=0, gemini=0). The webview fetches `/agent-models` exactly once at mount (`src/mainview/App.tsx:405-407`) and never again — no interval, no visibility hook, no SSE. That is the owner's screenshot: 7 curated rows, zero discovered. (Owner's app booted 00:46:35; `~/.fx` was created 00:48:26 — so even without the race, boot discovery ran *unauthenticated* and would now be stale.)
- **Discovery fires only at boot** — `src/bun/index.ts:173`, `src/bun/headless.ts:120` (`void refreshDiscoveredModels()`), plus an unused-by-the-webview `POST /agent-models` (`src/bun/server.ts:3240`). Cache is `Map<AgentKind, DiscoveredModel[]>` (`agent-discovery.ts:246`), keyed by kind, so every fx harness shares one list.
- **Merge sites** (curated + discovered, discovered-only appended): `src/mainview/components/kanban/NewTaskForm.tsx:407-422`, `src/mainview/components/kanban/RunPanel.tsx:5427-5437` (`mergedModels`), CLI `src/cli/commands/add.ts:163,184` (`mergeModels`, typed `Record<string,string[]>` against a server that actually returns `{id,label?}[]`).
- **Harness plumbing available to reuse:** `harnessEnv(harness)` (`src/bun/agents.ts:285`, fx → full `HOME` override); `checkAllHarnesses()` runs every 15 s from the webview (`App.tsx:455`) and `HarnessStatus` carries `available/path/version/loggedIn` (`src/shared/types.ts:199-225`); fx auth status is memoized 60 s (`agent-status.ts:161`); app-level SSE `GET /app/events` with `broadcastAppEvent` (`src/bun/quit-guard.ts:30`) and the `AppEvent` union (`src/shared/types.ts:2823`), subscribed in `App.tsx:591`.
- **Constraints inherited from the codebase:** `agent-discovery.ts` must stay a leaf (no `db.ts`, no `agents.ts` import — see its own comment at `:196-210`); timers in `headless.ts` must be `.unref()`'d; the `/agent-models` GET response shape is consumed by the CLI (`api-client.ts:245`, `manage.test.ts:126`) and `fx-permissions-endpoint.test.ts:182` — keep it byte-compatible; no `bg-popover`-style undefined tokens in new UI; e2e fx stub (`e2e/fixtures.ts:82-104`) implements only `--help`/`--version`, deliberately not `status --json`.
- **Sibling precedent for shared pure modules:** `src/shared/todo-progress.ts` (runtime-import-free, used by webview + bun). The CLI imports only from `src/shared`, so a merge helper placed there serves all three pickers.
- Peer coordination: the agent that shipped the fx harness (`ocean-storm-7133`) was messaged; its branch is merged (`#190`), no overlap. Advisory claim held on `types.ts#AGENT_OPTIONS.fx…` (JubarteAI).

## 3. Approach & key decisions

**D1 — Curated list rebuilt from the account's 158 (owner directive; evidence-based).** Sixteen labeled rows, provider-grouped in fx's own tab order after the default, each hint carrying context/output from the screenshots:

| id | label | hint |
| --- | --- | --- |
| `zai/glm-5.3-flash` | GLM 5.3 Flash | **Default** — 1M context · 131K output. The model fx itself runs on this account. |
| `zai/glm-5v-turbo` | GLM 5V Turbo | 200K · 128K, vision-capable turbo tier. |
| `zai/glm-4.7` | GLM 4.7 | 200K · 120K, prior Z.AI flagship. |
| `openai/gpt-5.2` | GPT-5.2 | 400K · 128K — top OpenAI tier on a standard Gateway plan; `-fast` sibling via discovery. |
| `openai/gpt-5.1-codex-max` | GPT-5.1 Codex Max | 400K · 128K, codex-tuned. |
| `openai/gpt-5.4-mini` | GPT-5.4 Mini | 400K · 128K, newest-gen small model. |
| `spacexai/grok-4.6` | Grok 4.6 | 500K · 500K. |
| `spacexai/grok-build-0.1` | Grok Build 0.1 | 256K · 256K, xAI's coding-agent model. |
| `moonshotai/kimi-k2.7-code` | Kimi K2.7 Code | 256K · 32K — nearest available successor to fx's compiled default (K3). |
| `deepseek/deepseek-v4-flash` | DeepSeek V4 Flash | 1M · 384K. |
| `minimax/minimax-m3` | MiniMax M3 | 1M · 1M. |
| `alibaba/qwen3.8-flash` | Qwen 3.8 Flash | 991K · 128K. |
| `alibaba/qwen3-coder-plus` | Qwen3 Coder Plus | 1M · 65K, coding-tuned. |
| `mistral/devstral-2` | Devstral 2 | 256K · 256K, coding-tuned. |
| `google/gemini-2.5-flash` | Gemini 2.5 Flash | 1M · 65K. |
| `anthropic/claude-3-haiku` | Claude 3 Haiku | 200K · 4K — the only Anthropic id a standard Gateway plan exposes. |

Fast/highspeed siblings are **not** duplicated as curated rows (Q4 default) — they surface through discovery one row below.

**D2 — Premium group: catalog-gated (owner: "drop the premiums if they're not available for the signed in account").** Five labeled rows — `anthropic/claude-opus-5`, `anthropic/claude-sonnet-5`, `openai/gpt-5.5`, `google/gemini-3.1-pro-preview`, `moonshotai/kimi-k3` — carry a new optional `AgentOption.catalogOnly: true` flag and are offered **only when the harness's discovered catalog positively contains them**. Unlike ordinary curated rows they are *not* shown on the discovery-empty fallback either: no evidence of availability → not offered. For the owner's account (158, no premium tiers) they never render; for a paid-plan account they render labeled. *Rests on evidence:* all five are in the 230-id unauth catalog and none in the owner's 158.

**D3 — Account-scoped filtering, fx only (owner: yes).** New pure helper `mergeModelOptions` in `src/shared/model-options.ts`:
- `discovered.length === 0` → curated as-is (+ unlisted selected). Today's behavior; covers not-installed / probe-failed / not-ready.
- kind is catalog-scoped (`CATALOG_SCOPED_KINDS = new Set<AgentKind>(["fx"])` in `types.ts`) → `curated.filter(inDiscovered)` + discovered-only extras (bare id as label) + selected-if-unlisted (label = id, hint "not in this account's catalog").
- other kinds → curated + extras, unchanged. Callers keep their own pre-filters (cursor's `cursorModelIdCoveredByCatalog`) by applying them to `discovered` before calling.
- Always dedupes by id; never returns an empty list while `selected` is set (a `<Select>` whose value has no `<option>` renders blank).

**D4 — Per-harness discovery + triggers (owner: "a better way / more triggers").** Chosen over triggers-only because D3 makes the kind-keyed cache *wrong* for `fx-2`-style harnesses (it would filter against the built-in account's catalog).
- `agent-discovery.ts` gains `discoverFx(env?)` (env merged into the spawn — the account-scoping is now explicit and documented) and a harness-keyed cache alongside the kind cache: `refreshDiscoveredModels({ fxHarnesses: [{ harnessId, env }] })`, `getHarnessDiscoveredModels(id)`, `isDiscoveryReady()` (true after the first full sweep resolves). Stays a leaf — callers pass envs in.
- New scheduler `src/bun/model-discovery.ts` (may import `db.ts` + `agents.ts`): `refreshAllModels()` builds targets from `harnesses.list()` (enabled only; every enabled fx harness → `harnessEnv(h)`), runs the sweep, and broadcasts `AppEvent { type: "agent_models_changed", harnessIds, ts }` when any harness's list changed; `refreshHarnessModels(id)`; `noteHarnessStatuses(statuses)` — a transition detector keyed by harnessId on `{available, path, version, loggedIn}` that schedules a debounced (500 ms) per-harness refresh on *change* (never on first sight — boot already covered it); `startPeriodicDiscovery(15 min)` with `.unref()`.
- Triggers wired: (1) boot — `index.ts`/`headless.ts` call `refreshAllModels()`; (2) `GET /harnesses` handler feeds `noteHarnessStatuses` after `checkAllHarnesses()` — catches install, `fx login` (≤ 60 s status-cache + 15 s poll), binary/version change; (3) harness mutations (`POST/PATCH /harnesses…` create/enable/update-home) → `refreshHarnessModels(id)`; (4) `POST /agent-models[?harness=<id>]` (manual ↻) → scheduler; (5) periodic 15 min; (6) webview: SSE `agent_models_changed` → refetch, `visibilitychange`/`focus` → refetch, and while `!ready` a 2 s retry — this last one is what deterministically closes the boot race even if the SSE connects after the sweep finished.
- API: `GET /agent-models` **unchanged** (kind-level; fx = built-in harness's list). New `GET /agent-models/harnesses` → `{ ready: boolean, byHarness: Record<harnessId, {id,label?}[]> }` (non-fx harnesses map to their kind's list, so callers have one lookup). `POST /agent-models` keeps returning the kind map and additionally accepts `?harness=`.

**D5 — Webview.** `App.tsx` owns `harnessModels` + `discoveryReady`; passes `harnessModels` and an `onRefreshModels` callback down the same prop path as `agentModels`. `NewTaskForm` gets a small `RefreshCw` icon button beside the "Model" label (`title="Refresh model list"`, spinning while in flight, semantic tokens only). `RunPanel.mergedModels` delegates to the shared helper with the task's `harnessId`.

**D6 — CLI parity.** `agetor add`'s picker uses the same helper and the per-harness route (falls back to the kind map if the route is missing/old daemon), so CLI and app can't disagree on what's pickable.

**D7 — Docs tell the truth.** CLAUDE.md fx bullet: default → `zai/glm-5.3-flash` (owner pick; fx's compiled default K3 isn't in every account's catalog), catalog account-scoped (230 unauth / 158 on the reference account), discovery per-harness + trigger list, curated-∩-discovered rule. `docs/plans/fx-0.0.6-compat.md` gets `(superseded — see fx-model-catalog-refresh.md …)` annotations on the default-model and "228 ids, unauthenticated" statements, matching how `fx-harness.md`/`fx-branch-finalization.md` were annotated before.

Alternatives rejected: triggers-only with a kind-keyed cache (wrong for multi-account under D3); blocking boot on discovery (violates the "never delay the API/window" contract at `index.ts:170-173`); making the webview poll `/agent-models` on the 2 s task tick forever (wasteful; SSE + ready-retry is exact).

## 4. Work breakdown — implementation tasks

| ID | Goal | Owns (exact files) | Depends on | Acceptance |
| --- | --- | --- | --- | --- |
| T1 | Curated fx list (D1 + D2 group), `DEFAULT_MODEL.fx`, `MODEL_EFFORT_SUPPORT.fx` keys, `CATALOG_SCOPED_KINDS`, `AppEvent` `agent_models_changed` variant; rewrite the fx comments at `types.ts:1287-1295` and `:1763-1774`; update the invariant tests | `src/shared/types.ts`, `src/shared/types.test.ts` | — | typecheck; tests assert default present, effort keys ⇔ catalog ids, no stale-unconditional ids, unique ids/labels, every id is `provider/model` |
| T2 | Pure `mergeModelOptions` helper + unit tests (D3) | `src/shared/model-options.ts`, `src/shared/model-options.test.ts` | T1 (reads `CATALOG_SCOPED_KINDS`; may stub locally until T1 lands — same wave, so use the literal set and switch to the import at checkpoint) | tests for all four branches of D3 + dedupe + selected-unlisted |
| T3 | `discoverFx(env?)`, harness-keyed cache, `isDiscoveryReady`, corrected doc comments; tests with a HOME-reading stub | `src/bun/agent-discovery.ts`, `src/bun/agent-discovery.test.ts` | — | existing tests still pass; new: two fx harnesses with different `HOME` get different lists; `ready` false→true |
| T4 | Docs truth (D7) | `CLAUDE.md`, `docs/plans/fx-0.0.6-compat.md` | — (describes the final design in this plan) | no remaining "228 ids"/"unauthenticated catalog"/"kimi-k3 default" claims; annotations match sibling plans' style |
| T5 | Test fixture hygiene: default expectation → `zai/glm-5.3-flash`; swap now-unavailable ids used as arbitrary fixture values to catalog ids | `src/bun/orchestrator-fx.test.ts`, `src/bun/agents.test.ts` | T1's value (edit-only; runs in Phase 7) | tests green after T1 |
| T6 | Scheduler + wiring + routes (D4): new module, boot calls, `/harnesses` hook, harness-mutation hooks, `GET /agent-models/harnesses`, `POST /agent-models?harness=`; endpoint test | `src/bun/model-discovery.ts`, `src/bun/model-discovery.test.ts`, `src/bun/index.ts`, `src/bun/headless.ts`, `src/bun/server.ts`, `src/bun/agent-models-endpoint.test.ts` (new) | T1, T3 | transition detector: refresh on `loggedIn` null/false→true and `available` false→true, not on first sight or unchanged; broadcast only on change; timers `.unref()`'d; old `GET /agent-models` byte-compatible (`fx-permissions-endpoint.test.ts:182` and `manage.test.ts:126` still pass) |
| T7 | Webview (D5): api client + types, App state/SSE/ready-retry/visibility, NewTaskForm helper + ↻ button, RunPanel helper | `src/mainview/lib/api.ts`, `src/mainview/App.tsx`, `src/mainview/components/kanban/NewTaskForm.tsx`, `src/mainview/components/kanban/RunPanel.tsx` | T1, T2, T6's route contract (stated above — implement against it in parallel) | typecheck; manual: picker shows 158-derived list without reload; ↻ works; non-fx pickers unchanged |
| T8 | CLI parity (D6) | `src/cli/api-client.ts`, `src/cli/commands/add.ts` | T2, T6's route contract | `agetor add` fx picker = app picker; falls back cleanly when the route 404s |

## 5. Work breakdown — test tasks

Unit tests ride with their modules in T1/T2/T3/T6 (repo idiom: `x.ts` + `x.test.ts`). Phase 6 adds:

| ID | Layer | Covers | Owns |
| --- | --- | --- | --- |
| TT1 | e2e (Playwright) | fx picker = curated ∩ stub catalog + discovered-only id, populated without reload (boot race closed); ↻ button present and keeps the list; task-details editor shows the same set | `e2e/fixtures.ts` (extend `writeFxStubBin` with `models --json` → `{"ids":["zai/glm-5.3-flash","openai/gpt-5.2","e2e/discovered-only"]}`; still no `status --json`), `e2e/fx-models.spec.ts` (new) |
| TT2 | integration (bun) | `/harnesses` GET → status transition → `agent_models_changed` broadcast → `GET /agent-models/harnesses` reflects the new list, using a stub whose catalog changes between calls | `src/bun/model-discovery-endpoint.test.ts` (new) |
| TT3 | unit gap-fill | anything the Phase 5 review flags as untested in T2/T3/T6 | files named by the review |

**E2E applies** — this is a user-visible flow crossing webview → API → CLI probe, and the repo has a Playwright harness (`playwright.config.ts`, `e2e/`, `scripts/dev-headless.sh`, per-worker headless backends on ports from 4600). Run recipe (Phase 1): `bun node_modules/@playwright/test/cli.js test e2e/fx-models.spec.ts` (not `bunx`); the fixture boots its own backend with `AGETOR_FX_DRIVER=fake` + `AGETOR_FX_BIN=<stub>`; no credentials or external services; existing e2e specs reference no fx model labels, so the stub's new `models --json` output can't break them. Unit/integration: `bun test`; typecheck: `bun run typecheck`.

## 6. Execution waves

- **Wave 1 (parallel, file-disjoint):** T1, T2, T3, T4, T5. Checkpoint: typecheck + `bun test src/shared src/bun/agent-discovery.test.ts`; commit `wave 1: fx curated catalog, merge helper, per-harness discovery, docs`.
- **Wave 2 (parallel, file-disjoint; barrier on wave 1):** T6, T7, T8. Checkpoint: typecheck + full `bun test`; commit `wave 2: discovery scheduler + triggers, picker wiring, CLI parity`.
- **Phase 5** review of `git diff 89d9b92...HEAD`.
- **Wave 3 (Phase 6, parallel):** TT1, TT2 (+ TT3 if any). **Phase 7:** `bun run typecheck && bun test && bun node_modules/@playwright/test/cli.js test e2e/fx-models.spec.ts` (plus the full e2e suite once, to prove the stub change is inert). **Phase 8** as needed, ≤ 3 rounds.

## 7. Blast radius & risks

- **Every fx picker changes shape** (app form, task-details, CLI). Mitigation: D3's empty-discovered branch reproduces today's behavior exactly; non-fx kinds go through the same helper's unchanged branch (tests pin it).
- **Existing tasks whose `model` is a now-unavailable id** (e.g. a task created with `moonshotai/kimi-k3`): rows aren't migrated (no data change); the editor shows the id as an unlisted row with a hint, and the next spawn fails at the Gateway with fx's own error, same as today. Not silently rewritten — a model choice is the user's.
- **`/harnesses` handler gains a side effect** (scheduling a probe). Bounded: debounced, per-harness, only on transitions; probes are read-only and ≤ 3 s.
- **Periodic + boot probes for every enabled fx harness** — one 0.5–0.9 s spawn per harness per 15 min. Negligible; the discovery `inflight` guard already serializes overlapping sweeps.
- **SSE variant addition** — `subscribeAppEvents` forwards unknown variants as-is (`api.ts:1611`), so an old webview against a new daemon ignores it safely; the `ready` retry covers a new webview against an old daemon (route 404 → treat as `ready: true` with empty map → today's kind-level behavior).
- **Rollback:** revert the two wave commits; no migration, no persisted state.
- Out of scope (different tickets, noted for the owner): codex discovery returned 0 ids in the spike (`codex models` output likely changed) — unrelated to fx; the fx auth-status 60 s cache means a `fx login` is reflected in the *status dot* after ≤ 60 s (unchanged); reflecting fx's `status --json` `model` field as a "what fx would run" hint.

## 8. Open questions / assumptions

Owner-decided: default `zai/glm-5.3-flash`; account-scoped filtering **yes**; "more triggers / better discovery" → D4.

Defaults taken where the owner didn't object (reversible at approval):

| # | Question | Answer taken | Source | Confidence |
| --- | --- | --- | --- | --- |
| Q1 | Curated set | the 16 rows in D1 | screenshots + `fx models --json` (158) | high on membership, medium on *which* 16 — taste |
| Q2 | Premium ids | keep 5 as a self-hiding premium group (D2) — **confirm or drop** | reasoning (D3 makes it safe); owner's literal ask leans "drop" | medium |
| Q4 | Fast siblings | not duplicated; via discovery | prior list had one such row; hints mention them | high |
| — | Hint text uses screenshot context/output sizes | yes, kept short | screenshots | high (may drift as the Gateway changes; hints are non-functional) |
| — | Disabled harnesses aren't probed; enabling one triggers a probe | yes | `harnesses.list()` returns all; picker offers enabled only | high |

## 9. Completeness ledger

*(not under `--no-follow-ups`; recorded anyway because the owner routinely sweeps deferrals back in)*

| Candidate remainder | Disposition |
| --- | --- |
| CLI `agetor add` picker parity | **in this run** — T8 |
| Task-details editor picker | **in this run** — T7 |
| Additional-account fx harness catalog | **in this run** — D4 per-harness discovery |
| Docs/comments claiming Gateway-wide 228-id catalog | **in this run** — T3, T4 |
| Existing tasks pinned to a now-unavailable model | out of scope — user data, not rewritten (see §7) |
| Codex discovery returning 0 ids | out of scope — unrelated probe, separate ticket |
| Onboarding checklist / Settings mentioning fx models | none exist (grep) — nothing to do |
