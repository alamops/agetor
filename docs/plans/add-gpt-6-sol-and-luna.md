# Plan — Add GPT-6 Sol and GPT-6 Luna (codex default → Sol, fx catalog-gated rows, codex minimum-CLI-version pre-flight)

| Field | Value |
| --- | --- |
| Date | 2026-09-22 |
| Source | Task "Add GPT-6 Sol and Luna to Codex harness and others that support it" + five reference URLs (OpenAI launch post, GPT-6 Astra system card + Sol/Luna appendix, `gpt-6-sol` / `gpt-6-luna` API model pages) |
| Config | AGENTS_CONFIG.yml (balanced, v1 schema; host = claude_code) |
| Flags | none |
| Gates | grilled + approved by owner (grill answered and plan approved 2026-09-22) |
| Branch | feature/add-gpt-6-sol-and-luna |
| Base SHA | 6bbe2f8 |

## 1. Objective & success criteria

Add OpenAI's two new GPT-6 tiers — **GPT-6 Sol** (`gpt-6-sol`) and **GPT-6 Luna** (`gpt-6-luna`), released 2026-09-22 as the replacements for GPT-5.6 Sol/Luna — to every agetor harness catalog that can actually run them, and make **GPT-6 Sol the codex default** (owner decision, grill Q1).

Done means:

1. The codex picker (New Task form, task details, both launch dialogs, `agetor add`) offers GPT-6 Sol and GPT-6 Luna directly under Astra/Aeon, each with an honest hint that names the codex CLI version floor.
2. `DEFAULT_MODEL.codex === "gpt-6-sol"`; a new codex task with no model given lands on Sol at effort `high`.
3. Effort pickers offer Sol `ultra/max/xhigh/high/medium/low/none` and Luna `max/xhigh/high/medium/low/none` (grill Q3), unless the signed-in CLI's own discovery reports a different set (existing precedence, unchanged).
4. fx offers `openai/gpt-6-sol` and `openai/gpt-6-luna` as `catalogOnly` rows with efforts `high/medium/low/none/auto` (grill Q5 — Gateway `reasoning_options` are the truth for fx).
5. Starting a codex task whose model needs a newer codex than the one installed fails **before any state mutation** with an actionable error naming the installed version, the required floor and the upgrade command (grill Q6) — strictly fail-open when the version can't be read.
6. Stale picker copy is refreshed in the same run (grill Q4): Astra's "rejected on ChatGPT plans" hint, the 5.6 Sol/Terra/Luna hints ("superseded by GPT-6 …"), and GPT-5.5's 2026-10-14 retirement.
7. `bun run typecheck` and the full `bun test` are green; README/CLAUDE.md describe the new lineup and the version gate.

## 2. Context & constraints (grounded)

All of the following were measured on 2026-09-22 on the owner's machine (ChatGPT-plan codex login, fx 0.0.10 unauthenticated, cursor-agent 2026.09.18). Scratch artifacts: `<scratchpad>/spikes/codex-gpt6/` (transcripts), `<scratchpad>/spikes/codex-0155-home/` (throwaway `CODEX_HOME` holding a copy of `auth.json` + the 0.155.1-fetched `models_cache.json`).

**API facts** (OpenAI model pages): `gpt-6-sol` — "Built for complex coding and agentic workflows", 1.05M context / 128K output, $2 / $10 per MTok, reasoning effort `none|low|medium|high|xhigh|max` (default medium), cutoff 2026-04-20. `gpt-6-luna` — "our most efficient model for focused, high-volume tasks", same window, $0.1 / $0.5 per MTok, same effort set, cutoff 2026-05-18. Launch post (via 9to5mac, the OpenAI page 403s to fetchers): available in ChatGPT + Codex for Plus/Pro/Business/Enterprise/Edu from launch day; they *replace* the GPT-5.6 Sol/Luna rows; API prices are 50% under 5.6 promo pricing; no GPT-6 Terra exists.

**Codex CLI — the catalog is client-version-gated.** `chatgpt.com/backend-api/codex/models` filters by `client_version` (NousResearch/hermes-agent#119412: `0.0.0` omits Sol/Luna, `0.155.0` includes them). Live results:

| codex-cli | `gpt-6-astra` | `gpt-6-sol` | `gpt-6-luna` | catalog (`models_cache.json`) |
| --- | --- | --- | --- | --- |
| 0.147.0 (installed) | 400 "requires a newer version of Codex" | 400 "not supported when using Codex with a ChatGPT account" | same 400 | 5.6 Sol/Terra/Luna, 5.5 only |
| 0.153.0 (npx) | **OK** | 400 (ChatGPT-account text) | not probed | — |
| 0.154.0 (npx) | **OK** | 400 (ChatGPT-account text) | not probed | — |
| 0.155.1 (npx, latest) | **OK** | **OK** (`low`) | **OK** (`low` and `none`) | Sol `low/medium/high/xhigh/max/ultra` default medium; Luna `low/medium/high/xhigh/max` (no ultra) default medium; Astra `…/ultra` default low; 5.6 Sol/Terra carry `upgrade → gpt-6-sol`, 5.6 Luna `upgrade → gpt-6-luna`; 5.5 `retirement_at 2026-10-14T19:00:00Z` |

So the 09-03 "rejected on ChatGPT plans during the phased rollout" note on Astra is stale: the rollout has landed and the only remaining gate is the client version. Note the *same* ChatGPT-account 400 text now means "your CLI is too old" for Sol/Luna — the message is not trustworthy as an account diagnosis, which is why agetor needs its own pre-flight (§3 D4).

**fx / Vercel AI Gateway**: `fx models --json` (unauth, 255 ids — up from 246 on 2026-09-21) contains `openai/gpt-6-sol`, `openai/gpt-6-luna` and their `-fast` twins. `https://ai-gateway.vercel.sh/v1/models` `reasoning_options` for BOTH new ids = `{toggle} + effort [none, low, medium, high]` — narrower than the API page (no xhigh/max) and narrower than `openai/gpt-5.6-sol` (`none…max`). Per the existing fx contract (`MODEL_EFFORT_SUPPORT.fx` is the Gateway's per-model `reasoning_options`, `docs/plans/add-grok-4-7.md`), the fx rows get exactly `["high","medium","low","none","auto"]`. Whether the owner's *signed-in* standard catalog carries them is unverified (last signed-in measurement 2026-09-14, 154 ids) → `catalogOnly`, same reasoning as `openai/gpt-6-astra` / `openai/gpt-5.6-sol`.

**Cursor**: `cursor-agent --list-models` has zero `gpt-6-*` ids (no Astra either; the GPT-5.6 Sol/Terra/Luna variant families are unchanged). Nothing to add, no `CURSOR_MODEL_SPECS` entry, no variant-normalization migration (`055_normalize_cursor_grok_4_7.sql` pattern not triggered).

**Code anchors** (all `src/shared/types.ts` unless noted):
- `DEFAULT_MODEL.codex` + rationale comment — `:1800-1807`.
- `AgentOption.catalogOnly` doc-comment counts ("thirteen `catalogOnly` rows") — `:1834`.
- `MODEL_EFFORT_SUPPORT.codex` + evidence comment — `:2384-2410`; `.fx` OpenAI rows — `:2455-2477`, tail `:2478-2484`.
- `AGENT_OPTIONS.codex.models` — `:2671-2682` (no count comment); `AGENT_OPTIONS.fx.models` history comment `:2731-2768`, catalogOnly rows `:2786-2798`, efforts comment `:2804-2808` ("16 of the 29 … other 13").
- `src/bun/orchestrator.ts:5405-5409` — the same 16/29/13 prose; `startTask` pre-flight `:1228-1266` (`checkHarness` → `!available` → `loggedIn === false` → `prepareWorkdir`).
- `src/bun/agent-status.ts:20-46` `probeVersion` returns the first line of `<bin> --version` verbatim (`codex-cli 0.147.0`; `/bin/echo --version` yields the literal `--version` under the test overrides) → `HarnessStatus.version: string | null` (`:486`). No semver helper exists anywhere in `src/`.
- Tests pinning today's catalog: `src/bun/effort-support.test.ts:102-138,153-157` (default = Astra, per-family effort sets, **exact first-6 picker order**, unknown-id fallback = Astra's set); `src/shared/types.test.ts:162-212,279-300` (fx 16/13/29 counts, exact catalogOnly set of 13); `src/bun/orchestrator-discovered-efforts.test.ts:129-160,316,324` (createTask default model literal `gpt-6-astra`); `src/bun/agents.test.ts:535-596,682-701` (argv passthrough examples — additive only); `src/bun/agent-discovery.test.ts:314-330` (fx filler test is derived from `curatedIds`, self-adjusting; the "28 then-curated" prose is historical and stays).
- Docs: `README.md:265` codex lineup sentence; `CLAUDE.md` codex bullet (`[--model gpt-6-astra]`, the ChatGPT-account 400 paragraph, "Effort `ultra` … (offered for Sol/Terra/Astra/Aeon, not Luna)") and the fx bullet's catalogOnly enumeration ("thirteen catalog-gated rows … `spacexai/grok-4.7` …").
- `src/cli/commands/add.ts` is fully catalog-driven (no literal ids) — no change.

**Fleet**: peer `fluid-snow-8ce7` (branch `feature/add-claude-opus-5-5`) is concurrently bumping the same fx count comments (to 30/14/17) and adding an fx catalogOnly row. Both branches conflict on those comment lines and on `types.test.ts`'s count assertions; the second to land rebases (messaged 2026-09-22). This plan's numbers are relative to base `6bbe2f8` (29 curated / 13 catalogOnly / 16 effort / 13 no-effort).

## 3. Approach & key decisions

- **D1 — Sol is the codex default** (owner, Q1; supersedes the 2026-09-03 Astra decision). Rests on spike evidence: Sol runs on the owner's account with a current CLI, OpenAI positions it as the daily driver for complex coding, and codex's own catalog points 5.6 Sol/Terra at it. Astra stays one row above it. `DEFAULT_EFFORT.codex` stays `high`.
- **D2 — Generation-major picker order** (owner, Q2): `gpt-6-astra, gpt-6-astra-aeon, gpt-6-sol, gpt-6-luna, gpt-5.6-cyber, gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5.5, gpt-5-codex, gpt-5`.
- **D3 — Effort sets follow codex's catalog for `ultra`, live acceptance for `none`** (owner, Q3; same rule the 5.6 rows already encode): Sol `["ultra","max","xhigh","high","medium","low","none"]`, Luna `["max","xhigh","high","medium","low","none"]`. `none` on Luna is live-verified (0.155.1); `none` on Sol rests on the API page + the identical 5.6-Sol precedent (assumption A1). Discovered efforts keep overriding this table whenever the CLI reports a set.
- **D4 — Codex minimum-CLI-version pre-flight, fail-open** (owner, Q6 "good to have"). A new shared, zero-import module `src/shared/cli-version.ts` exports `parseCliVersion(raw) → {major,minor,patch} | null` (first `\d+\.\d+\.\d+` in the probe line; tolerant of `codex-cli 0.155.1`, `0.155.1`, `v0.155.1`) and `cliVersionSatisfies(raw, min) → boolean | null` (`null` = couldn't parse either side → caller must not block). A new `MODEL_MIN_CLI_VERSION: Partial<Record<AgentKind, Record<string, string>>>` in `types.ts` carries `codex: { "gpt-6-sol": "0.155.0", "gpt-6-luna": "0.155.0", "gpt-6-astra": "0.153.0", "gpt-6-astra-aeon": "0.153.0" }` (Sol/Luna floor = the catalog gate in hermes-agent#119412, verified 0.154.0 ✗ / 0.155.1 ✓; Astra/Aeon floor = lowest *verified-working* version — A2 below). `startTaskInner` adds one check between the `loggedIn` gate and `prepareWorkdir`: resolve `model = task.model ?? DEFAULT_MODEL[kind]`, look up the floor, and only when `cliVersionSatisfies(status.version, floor) === false` return `{ error: "<label> <installed> can't run <model label> — it needs <kind> CLI ≥ <floor>. Upgrade with: <installHint>" }`. Unparseable/absent versions (every `/bin/echo` test override, a stub binary) never block. The check is generic over kinds so a future gemini/cursor floor is a one-line table entry, but only codex carries entries today. Chosen over (a) hiding the rows when the CLI is old (would hide them on the discovery-empty fallback too and punish users mid-upgrade) and (b) parsing codex's 400 after spawn (too late — run row and worktree already exist, and the 400 text lies about the cause).
- **D5 — Hints tell the truth about the gate** (owner, Q4): new rows say "needs codex CLI ≥ 0.155 — older CLIs get a 400"; Astra/Aeon hints drop the phased-rollout sentence in favour of "needs codex CLI ≥ 0.153"; 5.6 Sol/Terra/Luna say "superseded by GPT-6 Sol/Luna (codex offers the upgrade)"; GPT-5.5 says "retires 2026-10-14".
- **D6 — fx rows are `catalogOnly`** (owner, Q5), effort set from the Gateway (`high/medium/low/none/auto`), labels "GPT-6 Sol" / "GPT-6 Luna", hint text identical to the sibling premium rows. `-fast` twins stay discovery-only like every other `-fast` id.
- **D7 — No Cursor change, no migration** (spike: no ids exist). No e2e (see §5).

## 4. Work breakdown — implementation tasks

| ID | Goal | Owns (exclusively) | Depends on | Acceptance |
| --- | --- | --- | --- | --- |
| T1 | Catalog + contract edits in `src/shared/types.ts`: (a) `AGENT_OPTIONS.codex.models` rows in D2 order with D5 hints; (b) `DEFAULT_MODEL.codex = "gpt-6-sol"` + rewrite its rationale comment (today's evidence table in one paragraph); (c) `MODEL_EFFORT_SUPPORT.codex` rows for `gpt-6-sol` / `gpt-6-luna` + a dated paragraph in the evidence comment; (d) new exported `MODEL_MIN_CLI_VERSION` (D4) with a doc comment citing the spike + hermes-agent#119412; (e) fx: `MODEL_EFFORT_SUPPORT.fx` entries `"openai/gpt-6-sol": ["high","medium","low","none","auto"]`, `"openai/gpt-6-luna": [same]` with a dated comment, two `catalogOnly` rows appended after `spacexai/grok-4.7`, a dated 2026-09-22 paragraph in the fx history comment (255-id unauth catalog), and every count updated in lockstep — `AgentOption.catalogOnly` doc-comment (`:1834` "thirteen" → "fifteen"), fx history comment ("thirteen catalogOnly rows, 29 curated" → "fifteen … 31"), fx `efforts` comment ("16 of the 29 … other 13" → "18 of the 31 … other 13"). | `src/shared/types.ts` | — | `bun run typecheck` green; `grep -c catalogOnly: true` on the fx block = 15; all count comments agree (31 curated = 18 effort + 13 no-effort). |
| T2 | New pure helper `src/shared/cli-version.ts` (D4): `parseCliVersion`, `cliVersionSatisfies`, plus `formatMinCliVersionError({ harnessLabel, installedRaw, modelLabel, kindLabel, floor, installHint })` that builds the exact user-facing string so the orchestrator and tests share one source. Zero runtime imports (shared-module rule). | `src/shared/cli-version.ts` | — | Module compiles standalone; `bun -e 'import …'` sanity; semantics per D4 (`null` on unparseable, numeric compare, `0.155.1 ≥ 0.155.0`, `0.9.0 < 0.155.0`). |
| T3 | Wire the pre-flight in `src/bun/orchestrator.ts` `startTaskInner` right after the `loggedIn === false` gate (before `prepareWorkdir`), using T1's `MODEL_MIN_CLI_VERSION` + T2's helpers, with `status.installHint ?? upgradeHintFor(kind, status.path)` as the upgrade hint (`status.installHint` is always null once the availability gate passed — `INSTALL_HINTS` is exported for that; a Homebrew-installed binary gets `brew upgrade <formula>`) and the model's picker label (`AGENT_OPTIONS[kind].models.find(...)?.label ?? id`). Add a doc comment explaining fail-open and why the 400 text can't be trusted. Also update the fx prose at `:5405-5409` (18 / 31 / 13). | `src/bun/orchestrator.ts` | T1, T2 | Typecheck green; manual reasoning check: with `AGETOR_CODEX_BIN=/bin/echo` no existing test path can trip the gate. |
| T4 | Docs: `README.md:265` lineup sentence (GPT-6 Astra / Astra Aeon / **Sol (default)** / Luna, version floors, 5.6 rows superseded); `CLAUDE.md` codex bullet — `[--model gpt-6-sol]` example, replace the 2026-09-03 ChatGPT-account paragraph with the client-version-gate finding + the new pre-flight (D4), extend the `ultra` sentence ("offered for Astra/Aeon/Sol/GPT-6 Sol/Terra/Cyber, not either Luna"); `CLAUDE.md` fx bullet — "fifteen catalog-gated rows" enumeration gains `gpt-6-sol`, `gpt-6-luna` (2026-09-22) and the "16 of the 28/29" style counts move to 18/31; and this plan's Branch/Base rows are already filled. | `README.md`, `CLAUDE.md`, `docs/plans/add-gpt-6-sol-and-luna.md` | — | No remaining `grep -n "rejected on ChatGPT plans until" README.md CLAUDE.md` hits for Astra; fx counts in CLAUDE.md match T1. |

## 5. Work breakdown — test tasks (Wave 3, disjoint files)

| ID | Covers | Owns (exclusively) | What |
| --- | --- | --- | --- |
| T5 | T1 (fx), T2 | `src/shared/types.test.ts`, `src/shared/cli-version.test.ts` (new) | Extend `FX_EFFORT_MODELS` with both ids, counts 16→18 / 29→31 (no-effort stays 13), `expectedCatalogOnly` gains both ids (13→15) with a dated comment, keep the bidirectional and uniqueness tests. New `cli-version.test.ts`: parse `codex-cli 0.155.1`, `0.147.0`, `v1.2.3`, `--version` (→ null), empty/null; satisfies true/false/null matrix incl. equal-to-floor and patch/minor/major boundaries; `formatMinCliVersionError` snapshot string. |
| T6 | T1 (codex) | `src/bun/effort-support.test.ts`, `src/bun/agents.test.ts`, `src/bun/orchestrator-discovered-efforts.test.ts` | Default = `gpt-6-sol`; new tests "GPT-6 Sol supports ultra through none" and "GPT-6 Luna supports max through none, no ultra"; picker-order test pins the first 8 ids in D2 order; unknown-model fallback now = Sol's set (with `none`); `MODEL_MIN_CLI_VERSION.codex` has exactly the four ids with `0.155.0`/`0.153.0`. `agents.test.ts`: `--model gpt-6-sol` / `gpt-6-luna` verbatim passthrough, `ultra` on Sol and `none` on Luna passthrough (additive). `orchestrator-discovered-efforts.test.ts`: every `gpt-6-astra` literal that stands for "the default" becomes `gpt-6-sol` (`:129-160`, `:316`, `:324`) and the fallback-effort comment says Sol's set. |
| T7 | T3 | `src/bun/orchestrator-min-cli-version.test.ts` (new) | Plant a fake codex binary (pattern: `plantFakeFx`/`plantFakeCodexAppServer` in `agent-status.test.ts` / `agent-discovery.test.ts`) whose `--version` prints a chosen string; with `AGETOR_CODEX_DRIVER=fake` + `isolation: "none"` + a temp `AGETOR_DATA_DIR`: (1) `codex-cli 0.147.0` + model `gpt-6-sol` → `startTask` returns `{ error }` containing "0.147.0", "0.155.0" and the install hint, task column unchanged, no run row; (2) `codex-cli 0.155.1` + `gpt-6-sol` → no error (run starts via the fake driver); (3) `--version` → fail-open, starts; (4) `codex-cli 0.147.0` + `gpt-5.6-sol` (no floor) → starts; (5) `codex-cli 0.152.0` + `gpt-6-astra` → error naming `0.153.0`. Mirror the harness/env setup of `src/bun/orchestrator-codex.test.ts`. |

**e2e: not applicable.** Every change is data (catalog rows, effort tables, copy) or a server-side pre-flight whose error rides the existing `startTask` `{ error }` surface the webview already renders as a toast — no new component, route shape or user flow. The pre-flight is proven at the orchestrator layer (T7), which is the same layer the existing "not available"/"isn't logged in" gates are pinned at. No e2e spec references codex model labels today.

Run recipe (from Phase 1): `bun run typecheck`; targeted `bun test src/shared/types.test.ts src/shared/cli-version.test.ts src/bun/effort-support.test.ts src/bun/agents.test.ts src/bun/orchestrator-discovered-efforts.test.ts src/bun/orchestrator-min-cli-version.test.ts src/bun/agent-discovery.test.ts`; then the full `bun test` (≈4 min; check `uptime` first — the CLI suite stalls under load 30+; one suite at a time).

## 6. Execution waves

- **Wave 1 (parallel, disjoint):** T1 (`types.ts`), T2 (`cli-version.ts`), T4 (docs). Barrier: typecheck. Commit `wave 1: GPT-6 Sol/Luna catalog rows, Sol default, cli-version helper, docs`.
- **Wave 2:** T3 (`orchestrator.ts`) — needs T1/T2 exports. Barrier: typecheck. Commit `wave 2: codex minimum-CLI-version pre-flight`.
- **Phase 5:** code review of `git diff 6bbe2f8...HEAD` (opus, code-review skill).
- **Wave 3 (parallel, disjoint):** T5, T6, T7. Barrier: targeted tests, then full `bun test`. Commit `wave 3: tests`.
- **Phase 8:** review must-fixes + failures, re-run to green.

## 7. Blast radius & risks

- **Default change** (`DEFAULT_MODEL.codex`): affects `createTask` with no model, `NewTaskForm`'s codex seed (`:271`), CLI `resolveInitialModel`, and `supportedEfforts`' unknown-id fallback (now includes `none`). Existing tasks/profiles/`lastModel:codex` prefs pinned to Astra are untouched — Astra stays curated. Rollback = revert the one constant.
- **Pre-flight gate**: strictly additive and fail-open; the only new refusal is "old codex + GPT-6 model", which today fails anyway with a misleading 400 after a run row + worktree were created. Wrong floor risk is bounded by A2 (Astra) and mitigated by the error naming the exact floor and upgrade command. Tests using `/bin/echo` overrides are unaffected (unparseable → allowed).
- **fx counts**: three comment sites + two test assertions must move together (T1, T3, T5) — and will conflict with the peer's Opus 5.5 branch on merge; resolve by re-counting from the file, never by taking either side's number.
- **Discovery on an old CLI**: `codex app-server model/list` on 0.147.0 won't list Sol/Luna; codex isn't `CATALOG_SCOPED`, so the curated rows still show and the pre-flight is what catches the mismatch. Intentional (D4 rationale).
- No migration, no schema, no route-shape change; `ALLOWED_PATCH_FIELDS` unchanged.

## 8. Open questions / assumptions

- **A1** — `none` on `gpt-6-sol` via codex is untested live (only `low`); it rests on the API page ("supports none") and the identical GPT-5.6 Sol precedent (`none` accepted live there despite the catalog omitting it). Consequence if wrong: the picker offers a value the API rejects — same class as the existing 5.6 rows; a live `codex exec -m gpt-6-sol -c model_reasoning_effort=none` would settle it in one call.
- **A2** — Astra/Aeon floor `0.153.0` is the lowest *verified* working version (0.147.0 ✗, 0.153.0 ✓); 0.148–0.152 were not probed, so the true floor may be lower. Consequence if wrong: a user on 0.148–0.152 is told to upgrade one release early — actionable, not harmful.
- **A3** — Luna's `0.155.0` floor mirrors Sol's (both are gated by the same `client_version` filter per hermes-agent#119412; only 0.147.0 ✗ / 0.155.1 ✓ were probed for Luna).
- **A5** — Every version-floor measurement was made on a ChatGPT-plan codex login; the gated endpoint is the ChatGPT-auth backend, so an API-key account on an older CLI *might* run the GPT-6 ids and be refused by agetor anyway. Mitigation (review finding 3): the `AGETOR_SKIP_CLI_VERSION_FLOOR=1` escape hatch disables the pre-flight; the assumption stands until an API-key account is probed.
- **A4** — Whether the owner's *signed-in* Gateway catalog includes the two OpenAI ids is unknown → `catalogOnly` (fail-closed, as with every premium row).
- Grill Q&A (owner, 2026-09-22): Q1 default → Sol; Q2 order → yes; Q3 efforts → confirm; Q4 hints → in this run; Q5 fx → catalogOnly; Q6 → sweep in the pre-flight check.

## 8b. Review outcome (Phase 5, opus, code-review skill — 2026-09-22)

7 findings: 1 must-fix, 2 should-fix, 4 nice-to-have; all seven addressed in Phase 8, none deferred.
1. must-fix — the upgrade hint never appeared (`status.installHint` is null once the availability gate passed) → fallback to the kind's install/upgrade command; pinned by `orchestrator-min-cli-version.test.ts`.
2. should-fix — follow-up codex turns (`spawnCodexTurnNow`, reached by every `sendInput`) skipped the floor although the model is PATCH-able between turns → extracted `minCliVersionError(harness, model, status?)` and gated the follow-up spawn before its run row; a follow-up already *queued* behind an in-flight turn that the drain then refuses is restashed to the backlog (all stranded lines, in send order — `backlog.add` prepends) with a status line on the run, pinned by `orchestrator-codex-queue-floor.test.ts`.
3. should-fix — API-key accounts unverified → A5 + `AGETOR_SKIP_CLI_VERSION_FLOOR` escape hatch.
4. nice — `0.155.0-alpha.3` counted as the release → a pre-release tag on the exact floor version now yields `null` (fail-open).
5. nice — `npm i -g` is the wrong upgrade for a Homebrew install → `upgradeHintFor(kind, path)`.
6. nice — three names for one check → "Pre-flight 1b" everywhere.
7. nice — the clone route validates the explainer launch before cloning but not the floor → checked there too (400 before `cloneRepo`). The webview picker-level warning stays out of scope (ledger).

## 9. Completeness ledger

| Candidate remainder | Disposition |
| --- | --- |
| Codex picker rows + hints for Sol/Luna | **in this run** — T1 |
| Codex default → Sol (+ comment, consumers' tests) | **in this run** — T1, T6 |
| Effort sets for Sol/Luna | **in this run** — T1, T6 |
| Stale Astra/Aeon rollout hints; 5.6 Sol/Terra/Luna "superseded"; GPT-5.5 retirement note | **in this run** — T1 (owner Q4) |
| fx catalogOnly rows + effort entries + every count comment/assertion (types.ts ×3, orchestrator.ts, types.test.ts, CLAUDE.md) | **in this run** — T1, T3, T4, T5 |
| Codex minimum-CLI-version pre-flight + helper + tests | **in this run** — T2, T3, T5, T7 (owner Q6) |
| README / CLAUDE.md lineup + gate docs | **in this run** — T4 |
| Cursor rows for GPT-6 Sol/Luna | **out of scope** — no such ids exist in cursor-agent 2026.09.18 (spike); nothing to add, no migration |
| `gpt-6-terra` / `gpt-6-cyber` rows | **out of scope** — no such models exist (launch post: no GPT-6 Terra) |
| A picker-level "your codex is too old" warning in the webview (beside the harness-availability hint) | **out of scope** — a separate UI ticket; the reachable failure state is handled by the pre-flight error the UI already toasts (start AND every follow-up turn, plus the clone route's pre-validation), and the row hint names the floor |
| Retiring `gpt-5.5` (codex says 2026-10-14) | **out of scope** — future dated event; retiring a curated id is its own three-store change (knowledge `c1efe6a2`) |
| `openai/gpt-6-*-fast` fx rows | **out of scope** — `-fast` twins are discovery-only for every fx model today |
| Historical "28 then-curated" prose in `agent-discovery.test.ts` | **out of scope** — dated measurement, not a live assertion; the filler test derives from `curatedIds` |
| Owner-deferred | none |
