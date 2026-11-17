# Plan — Dynamic model & effort catalog per harness

| Field | Value |
| --- | --- |
| Date | 2026-11-17 |
| Source | Pipeline task "Alamo Pipeline (No Video)" (goal quoted in §1; it lives outside the repo) + `docs/plans/dynamic-model-catalog-investigation.md` + `docs/plans/dynamic-model-catalog-grill.md` (32 decisions, rounds in `docs/plans/dynamic-model-catalog-grill/round-{1,2,3}/`) |
| Flags | none |
| Gates | grilled + approved by owner (2026-11-17: one PR; copilot `auto` pinned) |
| Status | implemented — waves 0–5 committed on the branch; code review, then merge |
| Branch | `feature/agetor-dynamic-model-list` |
| Base SHA | `32aa7c3a` (code base; docs commit `639bc187` on top) |

## 1. Objective & success criteria

**The goal, verbatim** (pipeline task text, the only statement of the ask; copied here per grill decision #32):

> Currently we're kinda manually adding support for models in the list for most of the harnesses.
>
> What I want is a dynamic way for picking the models and their efforts automatically from the harnesses, so we don't have to come release by release when a new model drops.
>
> We still have to support older version, so it must be flexible too.

**Objective.** Each harness CLI reports its own models, per-model effort ladders, defaults and speed tiers at runtime. Agetor merges what it reports with the curated tables, which stay frozen as the fallback for old, offline, logged-out or failed-probe CLIs and as a label/hint overlay. When a model ships, the only agetor change is optional: a curated row to override a label or hint.

Each criterion names its production path (entry point → … → new code) and the test that drives that path.

| # | Criterion | Production path | Proven by |
| --- | --- | --- | --- |
| C1 | **Acceptance (#31).** A stub claude reporting `claude-opus-6` with its own effort ladder makes **Opus 6** appear in the New Task picker, the task editor and `agetor add`, with that ladder, and no agetor change. | boot `void refreshAllModels()` (`src/bun/index.ts:558`, `src/bun/headless.ts:409`) → `model-discovery.ts` claude kind target (T12) → `agent-discovery.ts` `runRefresh` (T10) → `discovery/claude-probe.ts` `probeClaudeModels` (T7) → cache → `GET /agent-models` + `/agent-models/harnesses` (`server.ts:5918`, unchanged) → `buildModelOptions` / `effortOptionsFor` (`shared/model-catalog.ts`, T11) → `NewTaskForm.tsx` (T17), `RunPanel.tsx` (T18), `cli/commands/add.ts` (T21) | E1 Playwright `e2e/claude-models.spec.ts`; U4a `add.test.ts`; U2a probe parser test |
| C2 | An old CLI (claude < 2.1.49: ids and labels only) or a failed probe gives today's curated picker: curated rows, curated effort ladders. | the same path; an empty or effort-less probe falls back through `mergeModelOptions` rule 2 and `supportedEfforts`' curated branch | U2a (old-shape fixture), U1a, E1 negative case (stub with no catalog) |
| C3 | No merged picker has two rows for the same CLI model, or two rows with the same label (the S2 doubling bug), for any kind. | `buildModelOptions` (T11) over every kind's fixture | U2e cross-kind invariant in `model-catalog.test.ts` |
| C4 | A CLI-reported effort agetor doesn't know shows as a synthesized row (CLI label, else the id title-cased), placed in the ladder where its neighbours are known, and reaches the CLI only when it is in that model's discovered set and matches `^[a-z0-9_-]{1,32}$`. | `supportedEfforts` (T2) via `effortOptionsFor` (T11) → pickers; spawn: `buildCommand` claude env / codex `-c` / copilot `--reasoning-effort` / cursor variant id (T13) | U1b, U1c, U3b |
| C5 | Gemini ≥ 0.67 lists its models; copilot's ACP probe yields models (+ efforts where exposed) and falls back to `help config`; cursor's flat list becomes base + effort + fast rows; codex reports its default model, per-model default effort and Fast tier. | `runRefresh` → `discoverGemini`/`discoverCopilot`/`discoverCursor`/`discoverCodex` (T10, using T5/T8/T9) | U1e, U2b, U2c, U2d |
| C6 | The last discovered catalog survives a restart and an offline start, is dropped when the CLI version changes, and never contains claude's account, email or org fields. | `refreshAllModels` first call hydrates from `preferences` `modelCatalog:*`; the settle hook persists (T12) | U3a |
| C7 | Pre-flight and harness-stack failover check the discovered catalog first for codex and copilot (a model missing from a non-empty, trusted catalog is refused with an "upgrade the CLI" message); `MODEL_MIN_CLI_VERSION` applies only when discovery is empty. | `minCliVersionError` (`orchestrator.ts:8937`, T14), `harness-failover.ts:253` (T15), via `modelCatalogVerdict` (T11) | U3c, U3d |
| C8 | Codex (and claude, if spike G1 finds a per-run switch) gets the per-task Speed picker from discovered per-model flags; the last pick is remembered per kind; an unsupported remembered Fast falls back to Standard and the fallback overwrites the memory; Fast shows the CLI's own cost text; a change applies on the next spawn. | pickers via `speedOptionsFor` (T11, T6) → `PATCH`/`POST /tasks` (unchanged) → `buildCommand` (T13) | U1f, U3b, U4a; E1 asserts claude Speed only when G1 shipped it |
| C9 | Model names are prettified everywhere a person sees one (catalog label, else `opus-5.5` → `Opus 5.5`), including the task card, run panel, badges and CLI/TUI output, with terminal escaping in the CLI. | `modelDisplayName` (`shared/model-display.ts`, T4) at each display site (T18, T20, T21) | U1d, U4b |
| C10 | Curated Opus 4.6 no longer offers `xhigh`; a stored `xhigh` on existing tasks is kept. | `MODEL_EFFORT_SUPPORT["claude-code"]["opus-4.6"]` (T2); retention via `retainableEfforts` (unchanged) | U1b |
| C11 | The docs say a new model needs no PR unless it wants a label/hint override, and describe each new probe. | T22 | review |

## 2. Context & constraints

### 2.1 Where things stand (file:line at `32aa7c3a`)

- **Probes** — `src/bun/agent-discovery.ts` (1,682 lines, a *leaf*: it must never import `db.ts` or `agents.ts`, `:277-279`). `discoverClaude` and `discoverGemini` return `[]` (`:465`, `:475`). `discoverCursor` runs `cursor-agent --list-models` with a loose line parser that keeps flat variant ids and drops labels (`:152-181`). `parseCodexModelList` reads only `id`, `displayName`, `supportedReasoningEfforts`, `hidden` (`:107-142`). Copilot uses `copilot help config` (`:1317-1388`). Caches: `cache` / `harnessCache` (`:1201-1202`), serialized by `enqueue` (`:1219-1225`); `runRefresh`'s probe list and its index-aligned `kinds` array (`:1423-1437`), `runRefreshKind` (`:1557-1590`), `__testing` (`:1668`). The bun `DiscoveredModel` (`:29-39`) is a structural twin of the shared one.
- **Scheduler** — `src/bun/model-discovery.ts`: `PER_HARNESS_KINDS = {fx, codex, opencode}` (`:48`), `discoveryTargets` (`:72`), `snapshotKey` (`:98`), `publishIfChanged` (`:120`), `refreshAllModels` (`:160`), `refreshHarnessModels` (`:184`), `getHarnessModelMap` (`:238`), `noteHarnessStatuses` (`:296`), 15-minute sweep (`:331`). Boot callers: `index.ts:558`, `headless.ts:409`.
- **Merge** — `src/shared/model-options.ts` `mergeModelOptions` with rules 1–9 (`:19-107`); rule 4 (unscoped, non-empty discovery) puts curated rows first and appends discovered-only ids (`:283-294`).
- **Curated tables** in `src/shared/types.ts`: `DEFAULT_MODEL` (`:3445`), `CATALOG_SCOPED_KINDS = {fx, opencode}` (`:3529`), `DEFAULT_EFFORT` (`:3530`), `MODEL_MIN_CLI_VERSION` (`:3595`), `CURSOR_MODEL_SPECS` (`:3621`), `cursorModelSupportsFast` / `cursorModelIdCoveredByCatalog` / `cursorModelArg` (`:4074-4115`), `EFFORT_OPTIONS` (`:4204`), `MODEL_EFFORT_SUPPORT` (`:4237`; the Opus 4.6 `xhigh` drift is at `:4269`), `MODEL_DEFAULT_EFFORT_KINDS` (`:4574`), `supportedEfforts` (`:4620`, filters discovered ids to `EFFORT_OPTIONS`), `retainableEfforts` (`:4702`), `MODEL_MODE_DENY` (`:4730`, every claude row empty), `AGENT_OPTIONS` (`:4797`).
- **Speed** — `src/shared/speed.ts` `supportedSpeeds` (`:54-68`): cursor via its specs, fx via discovered flags, every other kind `["off"]`. Task `speed` already reaches every spawn (`orchestrator.ts:2844, 9075, 9285, …`).
- **Spawn** — `src/bun/agents.ts`: `CLAUDE_MODEL_FLAG` (`:252-269`, all 16 rows follow the derivation rule), `toClaudeModelArg` (`:278`), `claudeModelIdFromArg` (`:296`), `claudeModelPickerFamily` hand switch (`:345-358`), `CLAUDE_EFFORT_VALUES` closed set (`:372`), claude `--model` (`:696`) and `CLAUDE_CODE_EFFORT_LEVEL` (`:777-783`), cursor `cursorModelArg` (`:799`), copilot `--reasoning-effort` (`:1070-1072`), codex `-c model_reasoning_effort=` (`:1112-1116`, unvalidated today).
- **Pickers** — the same "merge + cursor covered-by-catalog filter" is duplicated at `NewTaskForm.tsx:439-447`, `RunPanel.tsx:9077-9094`, `TaskLaunchPickers.tsx:430-438` and `:466-476`, `cli/commands/add.ts:845-867`. Seeds validate the remembered model against curated rows only: `NewTaskForm.tsx:361` and `TaskLaunchPickers.tsx:418` (round-3 finding). `lastSpeed:<kind>` is written as `"off"` for every kind but cursor/fx (`NewTaskForm.tsx:690`). Refresh button: `NewTaskForm.tsx:1050` → `POST /agent-models`.
- **Floors** — `minCliVersionError` (`orchestrator.ts:8937-8967`) and failover (`harness-failover.ts:241-259`, already refuses a model missing from a *per-harness* catalog at `:249-251`).
- **Display** — raw ids print at `TaskCard.tsx:331-334`, `cli/commands/show.ts:80`, `cli/stack-display.ts:29`, plus `AgentProfileCard.tsx`, `ImportSessionsDialog.tsx`, `HarnessAccountRow.tsx`, `ImportBundleDialog.tsx`, `lib/stack-badge.ts`, `lib/stack-editor.ts` (grep `task\.model|profile\.model|row\.model` under `src/mainview`). `claudeModelIdFromDisplayName` matches curated labels only (`claude-local-setting.ts:69-86`).
- **Bundles** — `knownModelsFor` (`bun/bundle.ts:358-370`) treats only fx/codex as per-harness (opencode is per-harness too) and knows no cursor variants.
- **Preferences** — `preferences.get/list/set` (`db.ts:2133-2155`); `GET /preferences` returns every key and `PUT /preferences/:key` stores opaque strings (`server.ts:4257-4275`). `dataDir` is exported from `db.ts:59`. The built-in harness's `home`/`bin`/`env` can't be edited (`db.ts:2480`).
- **Versions** — `cachedCliVersion` / `peekCachedCliVersion` (`agent-status.ts:475-495`), `checkHarness` (`:723`).
- **API types** — webview `AgentModelMap` / `HarnessModelMap` hand-write `{id,label?,efforts?,fast?,ultrafast?}` (`mainview/lib/api.ts:224-245`); CLI `DiscoveredModelRow` (`cli/api-client.ts:1017`).
- **E2E seam** — `e2e/fixtures.ts`: `provisionBackend(…, extraEnv)` (`:455-468`, merged last at `:651-653`); claude runs with `AGETOR_CLAUDE_DRIVER=fake` and `AGETOR_CLAUDE_BIN=/bin/echo` (`:533-534`); the fx stub (`writeFxStubBin`, `:145`) answers `models --json` from `AGETOR_E2E_FX_MODELS_JSON`; precedent for an opt-in stub swap: `AGETOR_E2E_COPILOT_STUB` (`:605`).

### 2.2 Repo rules that bear on this change (`CLAUDE.md` unless noted)

- Every spawn goes through `coreSpawn` with `env: childEnv(...)` (`core-spawn.ts:49`); `core-spawn-allowlist.test.ts` fails on a raw spawn.
- No new route (so no `ROUTE_POLICY` work) and no new SSE stream (WKWebView's six-connection budget). Reuse `agent_models_changed`.
- The Bun main thread is shared: probes are async, parsing is small, nothing loops synchronously over big inputs.
- `src/shared/` has no runtime imports from either process. `model-options.ts` stays structural (`:11-17`).
- CLI/TUI output of third-party text goes through `src/shared/terminal-text.ts` (`escapeControlChars` for ids, `escapeFreeText` for labels).
- Tests importing `db.ts`/`orchestrator.ts` set `AGETOR_DATA_DIR` at the top level, load with `await import`, clean up with `rmTestDataDir`, and use `snapshotHarnessState` when they touch harnesses. Fake bins go under `/tmp` via `fakeBinDir` (memory: TMPDIR bloat). `bun test` runs every file in one process: restore any env override.
- Migrations: none in this change (#4, #16).
- `docs/architecture/harnesses.md` add-a-kind / add-a-model checklist; each `harness-<kind>.md` documents its probe. A behavior change updates its doc in the same change.
- No real ticket ids, account names, emails or org names in code or fixtures (memory). The claude `initialize` response carries the account email and org: fixtures are redacted and the parser whitelists `models[]`.
- `memory`: run e2e with `bun node_modules/@playwright/test/cli.js test`, one Playwright run at a time; export `PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH"` and `bun install` in a fresh worktree; live smokes against `~/.agetor-dev` on a headless core at `:4319`, never prod `~/.agetor`; macOS has no `timeout` (use `perl -e 'alarm N; exec @ARGV'`).
- Decision 785c5209 (GPT-6 Astra): the PATCH effort guard is null-clear only and never rejects a non-null effort; any cascade that narrows efforts goes through `retainableEfforts`.

### 2.3 Spike verdicts (investigation §2, run 2026-11-17)

| Spike | Verdict | Versions |
| --- | --- | --- |
| S1 claude `initialize` | `claude -p --input-format stream-json --output-format stream-json --verbose --settings '{"disableAllHooks":true}' --no-session-persistence` plus one stdin line `{"type":"control_request","request_id":"init-1","request":{"subtype":"initialize"}}` returns `models[]` with `{value, resolvedModel, displayName, description, supportsEffort, supportedEffortLevels[], supportsFastMode, …}`; ~1.7 s, no prompt, no session dir. 14 rows: `default` (→ `claude-opus-5-5`), aliases `opus`/`fable`/`sonnet`/`haiku`, then full ids incl. dated `claude-haiku-4-5-20251001` (no effort fields). Effort levels come ascending (`low…max`). Capability fields exist since **2.1.49**. | 2.1.321, 2.1.326 |
| S1d | CLI says `claude-opus-4-6` → `low,medium,high,max`; curated offers `xhigh` too. | 2.1.326 |
| S2 | Feeding S1 into today's merge gives 29–30 rows for 16 curated, 12–13 duplicated labels; no test notices. | HEAD |
| S3 codex `model/list` | Per model: `isDefault`, `defaultReasoningEffort`, `supportedReasoningEfforts[{reasoningEffort, description}]`, `additionalSpeedTiers:["fast"]`, `serviceTiers[{id:"priority", name:"Fast", description:"2x speed, increased usage"}]`, `defaultServiceTier` (`"priority"` on some models, e.g. `gpt-6.1-terra`). | codex-cli 0.166.0 |
| S4 cursor | `cursor-agent models` / `--list-models`: 284 `id - Label` lines; grammar `<base>[-thinking][-<effort>][-fast]`, a bare id may be the default variant, labels carry zero-width spaces; irregular cases (`claude-4.6-sonnet-medium-thinking`, `cursor-grok-4.5-*`). The ACP parameterized probe is rejected (52 s, writes `~/.cursor/cli-config.json`). | 2026.10.22 |
| S5/S6 | fx and opencode discovery unchanged. | fx 0.0.15, opencode 2.1.3 |

Web-only facts: Gemini CLI ≥ **0.67.0** has `gemini models -o json` (`modelId, id, name, displayName, description`, no thinking levels); older CLIs have no list. Copilot has an ACP server (public preview) exposing ACP `configOptions` (categories `model`, `thought_level`). Not installed here: gemini, agy, copilot.

### 2.4 Runtime & trust shape

- One Bun core owns discovery (the port bind is the ownership claim); the webview and CLI read `GET /agent-models*` and trigger `POST /agent-models`. No second process probes concurrently; every probe runs through `enqueue`.
- Probe output is third-party: ids, labels and descriptions are rendered in the webview (React-escaped) and the CLI (must be escaped); effort ids reach argv/env (charset check, C4).
- Probes run under the user's credentials and binaries on an agent-plantable `PATH` (hence `coreSpawn`). The claude probe must not start the user's MCP servers or hooks, must not create a session, and must never log or persist the raw response.
- The persisted catalog sits in the same SQLite file as everything else. An agent running as the user can already rewrite that file, so the store adds no new trust boundary; the HTTP surface must not add one either: `modelCatalog:*` keys are refused on `PUT /preferences` (both tokens) and omitted from `GET /preferences`.

## 3. Approach & key decisions

**Shape.** Probes normalize in the core, the shared layer composes, every surface calls one helper.

1. **New leaf probe modules** under `src/bun/discovery/` (precedent: `src/bun/usage/`), wired into `agent-discovery.ts`: claude `initialize` (T7), gemini (T8), copilot ACP (T9). Each normalizes to agetor ids before anything else sees the data. Claude ids are derived by rule (#4) at parse time, so the S2 doubling can't happen downstream. Cursor's flat list is grouped into base + effort + fast rows by a pure shared parser (T5), with `CURSOR_MODEL_SPECS` winning where it covers a variant.
2. **One shared composition module**, `src/shared/model-catalog.ts` (T11), replaces the five copies of "merge + cursor filter" and owns defaults, seeds, speed tiers, known-id sets and the CLI-floor verdict. Pickers, CLI, bundles, pre-flight and failover all call it.
3. **Merge rule 4 changes to CLI order (#13)**: for unscoped kinds with non-empty trusted discovery, rows appear in the CLI's order (carrying a curated label/hint when the id has a curated row, else the sanitized CLI label and description), then curated-only rows in curated order. Scoped kinds (fx, opencode) keep rule 3 (#1: fx and opencode unchanged).
4. **Efforts (#12, #15)**: `supportedEfforts` keeps known ids and synthesizes rows for unknown discovered ids that pass the charset, ordered by `orderEfforts` (known ids in `EFFORT_OPTIONS` order; an unknown id is placed between its nearest known neighbours in the CLI list, else last). The spawn check lives in one shared function (`effortPassesSpawnCheck`, T3) used by every `buildCommand` branch.
5. **Persistence (#16)** lives in `model-discovery.ts` (it may import `db.ts`); `agent-discovery.ts` stays a leaf and exposes a settle hook and a seed function.
6. **Speed (#24–#29)**: discovery sets `fast` (+ `fastHint`, codex `fastTier`, `defaultFast`); `supportedSpeeds` offers Fast for kinds in `DISCOVERED_SPEED_KINDS`, whose membership the wave-0 spikes decide. `buildCommand` only emits the fast switch when the discovered row says the model supports it, so a stale stored `fast` never reaches an unsupporting model.
7. **CLI floors (#14)**: `modelCatalogVerdict` returns `offered | missing | unknown` for the CLI-authoritative kinds (codex, copilot; copilot's `auto` exempt); the frozen `MODEL_MIN_CLI_VERSION` is consulted only on `unknown`.

**Rejected alternatives.** Normalizing claude ids in the webview (every surface would need the rule; bundles and pre-flight would disagree). Claude per-harness probing (owner chose one kind-level probe, #7). A cursor ACP parameterized probe (52 s and it writes the user's cursor config, S4). A DB table for the catalog (owner chose `preferences`, #16). Folding cursor flat ids with a migration (#18: read-time, no more migrations).

**Evidence vs reasoning.** Probe shapes for claude, codex and cursor rest on live spikes (§2.3). Gemini and copilot rest on docs and the ACP spec (#21, stub-only). Claude's per-run fast switch, codex's per-run tier flag and the claude probe's MCP/hook isolation are unproven and gated by wave-0 spikes (§6).

### 3.1 Pinned interfaces (same-wave tasks code against these)

```ts
// src/shared/model-options.ts — the ONE DiscoveredModel type. The bun twin
// in agent-discovery.ts becomes `export type { DiscoveredModel } from "../shared/model-options.ts"`.
export interface CursorVariantSpecShape { effortIds?: Partial<Record<string, string>>; fastEfforts?: string[]; fastId?: string }
export interface DiscoveredModel {
  id: string;                          // agetor id (claude: rule-derived; cursor: base id)
  label?: string;                      // sanitized CLI display name
  description?: string;                // sanitized; hint for discovered-only rows
  efforts?: readonly string[];         // CLI order, deduped; semantics unchanged (opencode [] carve-out)
  effortLabels?: Readonly<Record<string, string>>; // CLI-provided effort labels (copilot ACP)
  defaultEffort?: string;              // codex defaultReasoningEffort
  cliDefault?: true;                   // CLI's own default model (codex isDefault; claude `default` row)
  fast?: boolean; ultrafast?: boolean; // never attached as false
  fastHint?: string;                   // CLI's own Fast description (codex serviceTiers[].description)
  fastTier?: string;                   // codex service tier id to request ("priority")
  defaultFast?: true;                  // codex defaultServiceTier is non-null
  cliId?: string;                      // claude: exact CLI model id (resolvedModel)
  alias?: string;                      // claude: CLI alias the row came from ("opus")
  cursor?: CursorVariantSpecShape;     // cursor: variant map of a discovered-only base
}
// ModelOption gains the same optional fields minus cliId/alias (rule 8 copies them).

// src/shared/types.ts
export type CursorVariantSpec = Pick<CursorModelSpec, "effortIds" | "fastEfforts" | "fastId">;
export function orderEfforts(ids: readonly string[]): string[];
export function supportedEfforts(agent, model, discoveredEfforts?, opts?: { labels?: Readonly<Record<string, string>> }): AgentOption[];
export function cursorModelArg(model, effort, fast, maxMode = false, discovered?: CursorVariantSpec): string;
export function cursorModelSupportsFast(model, effort, discovered?: CursorVariantSpec): boolean;

// src/shared/claude-model-id.ts
export const CLAUDE_CLI_MODEL_EXCEPTIONS: Readonly<Record<string, string>>; // starts empty
export function claudeIdFromCliModel(cliId: string): string | null;   // claude-opus-5-5 → opus-5.5; "default"/non-claude- → null
export function claudeCliModelFor(id: string, discovered?: readonly DiscoveredModel[]): string; // exception → discovered cliId → rule → verbatim

// src/shared/effort-check.ts
export const EFFORT_ID_RE = /^[a-z0-9_-]{1,32}$/;
export function effortPassesSpawnCheck(kind: AgentKind, effort: string, discovered: readonly string[] | null): boolean;

// src/shared/model-display.ts
export function sanitizeCliLabel(s: string): string;   // drop U+200B–U+200D, U+2060, U+FEFF, C0/C1 controls; collapse spaces; trim; cap 80
export function prettifyModelId(id: string): string;
export function modelDisplayName(kind: AgentKind, id: string, rows?: readonly { id: string; label: string; unlisted?: boolean }[]): string;

// src/shared/cursor-catalog.ts
export function parseCursorModelList(stdout: string): DiscoveredModel[];
export function cursorSpecKeyFor(flatId: string): string | null;     // CURSOR_MODEL_SPECS overlay
export function cursorVariantOf(flatId: string, rows: readonly DiscoveredModel[]): { base: string; effort: string | null; fast: boolean; label?: string } | null;

// src/shared/speed.ts
export const DISCOVERED_SPEED_KINDS: ReadonlySet<AgentKind>; // fx + whichever of codex/claude-code the spikes clear
export function supportedSpeeds(kind, model, effort, option?: SpeedOptionFlags & { cursor?: CursorVariantSpec }): Speed[];

// src/shared/model-catalog.ts
export const CLI_AUTHORITATIVE_CATALOG_KINDS: ReadonlySet<AgentKind>; // codex, copilot
export function buildModelOptions(kind, input: { discovered: readonly DiscoveredModel[]; selected?: string | null; loggedIn?: boolean | null }): ModelOption[];
export function effortOptionsFor(kind, model, rows: readonly ModelOption[]): AgentOption[];
export function retainableEffortsFor(kind, model, rows, current): ReadonlySet<string>;
export function speedOptionsFor(kind, model, effort, rows): Speed[];
export function speedTiersKnown(kind, discovered, loggedIn): boolean;
export function resolveDefaultModel(kind, discovered, loggedIn): string;   // #11
export function resolveDefaultEffort(kind, model, rows): string | null;    // #11
export function resolveSeedModel(kind, stored: string | null | undefined, rows): string | null;
export function knownModelIds(kind, discovered, loggedIn): string[];       // merged ids + cursor variant ids
export function modelCatalogVerdict(kind, model, discovered, loggedIn): "offered" | "missing" | "unknown";

// src/bun/agent-discovery.ts
export type DiscoveryCacheKey = { scope: "kind"; kind: AgentKind } | { scope: "harness"; kind: AgentKind; harnessId: string };
export type DiscoverySettleHook = (key: DiscoveryCacheKey, fresh: DiscoveredModel[], previous: DiscoveredModel[] | undefined) => DiscoveredModel[];
export function setDiscoverySettleHook(hook: DiscoverySettleHook | null): void; // null = today's "fresh replaces"
export function seedDiscoveryCache(key: DiscoveryCacheKey, models: DiscoveredModel[]): void; // ignored once a probe has settled that key
export interface KindProbeTarget { env: Record<string, string>; bin?: string; cwd?: string; skip?: boolean }
export function refreshDiscoveredModels(opts?: { fxHarnesses?: FxHarnessTargetsOption; kindTargets?: () => Promise<Partial<Record<AgentKind, KindProbeTarget>>> }): Promise<void>;
export function refreshKindModels(kind: AgentKind, target?: KindProbeTarget): Promise<void>;

// src/bun/discovery/spawn-probe.ts (T7) — line-oriented JSON child with kill + reader.cancel (codex leak-safety pattern, agent-discovery.ts:256-275)
export function runJsonLineSession(opts: { cmd: string[]; env?: Record<string, string>; cwd?: string; timeoutMs: number;
  start(write: (obj: unknown) => void): void; onMessage(msg: unknown, write: (obj: unknown) => void): "done" | void }): Promise<{ timedOut: boolean }>;
// src/bun/discovery/claude-probe.ts (T7)
export function claudeProbeArgv(bin: string): string[];
export function parseClaudeInitModels(initResponse: unknown): DiscoveredModel[];
export function probeClaudeModels(opts: { bin: string; env?: Record<string, string>; cwd?: string; timeoutMs?: number }): Promise<DiscoveredModel[]>;
// src/bun/discovery/gemini-probe.ts (T8)
export const GEMINI_MODELS_MIN_VERSION = "0.67.0";
export function parseGeminiModelsJson(stdout: string): DiscoveredModel[];
export function probeGeminiModels(opts: { bin: string; env?: Record<string, string> }): Promise<DiscoveredModel[]>;
// src/bun/discovery/copilot-acp-probe.ts (T9)
export const COPILOT_ACP_PROBE_ENV = "AGETOR_COPILOT_ACP_PROBE";
export function copilotAcpProbeEnabled(env?: Record<string, string | undefined>): boolean; // "0"/"false"/"off"/"no" disable
export function parseCopilotSessionNew(result: unknown): DiscoveredModel[];
export function probeCopilotAcp(opts: { bin: string; env?: Record<string, string>; cwd?: string; timeoutMs?: number }): Promise<DiscoveredModel[]>;
```

Persisted value (`preferences`): key `modelCatalog:kind:<kind>` or `modelCatalog:harness:<harnessId>`; value `{"v":1,"cliVersion":string|null,"savedAt":number,"models":DiscoveredModel[]}`.

## 4. Work breakdown — implementation tasks

Risk tags: `trust`, `data`, `external`, `concurrency`, `state`, `tests`, `none`.

| ID | Goal | Owned files | Depends on | Acceptance (scenarios) | Risk | Wired by |
| --- | --- | --- | --- | --- | --- | --- |
| W0 | Spike gates G1–G3 and redacted fixture capture | `docs/plans/dynamic-model-catalog-spikes.md` (new); `src/bun/fixtures/model-discovery/` (new): `claude-init-2.1.326.json` (models only), `claude-init-old.json` (synthetic pre-2.1.49 shape: `value/displayName/description` only), `codex-model-list-0.166.0.json`, `cursor-models-2026.10.22.txt`, `gemini-models.json` (from the docs' field list), `copilot-acp-session-new.json` (from the ACP spec) | — | **G1 claude per-run fast switch**: from `claude --help`, the binary's settings schema (memory: spike the claude TUI + read its binary) and the `initialize` response under `--settings '{"<key>":true}'`, determine whether a flag or per-run `--settings` key turns fast mode on for one process without writing `~/.claude/settings.json`; record the exact form, the CLI's own fast-mode description text, and evidence. No billed turn; inconclusive = absent (→ claude Speed cut, #27). **G2 codex tier flag**: on codex-cli 0.166.0, from `codex exec --help`, the config schema and the app-server's config resolution, find the per-run form that requests a service tier (`-c service_tier="priority"` or similar) and whether a value forces the standard tier for a model whose `defaultServiceTier` is `priority`; record both. Inconclusive = absent (→ codex Speed cut). **G3 claude probe isolation**: in a temp cwd containing a project `.mcp.json` whose stub server writes a marker file on start and a project `.claude/settings.json` SessionStart hook writing another marker, run the S1 probe argv plus `--strict-mcp-config`; assert no marker, no `~/.claude/projects/<encoded cwd>` dir, and record wall time. Any marker = **STOP**: report to the owner before wave 2 (claude stays curated, C1 can't pass as specified). Fixtures carry no email/org/account/subscription fields (grep proves it). | external | — (docs + fixtures) |
| T1 | Shared discovery types; merge rule 4 → CLI order; rule 8 copies the new fields; API types follow | `src/shared/model-options.ts`, `src/mainview/lib/api.ts` (`AgentModelMap`/`HarnessModelMap` rows become the shared `DiscoveredModel`), `src/cli/api-client.ts` (`DiscoveredModelRow` = shared `DiscoveredModel`) | — | Unscoped kind, discovery `[opus-6, opus-5.5]`, curated `[mythos-5.2, opus-5.5, haiku-4.5]` → `[opus-6, opus-5.5 (curated label), mythos-5.2, haiku-4.5]`. Discovery empty → curated order (rule 2). `loggedIn:false` → rule 2 + rule 6. Scoped (fx/opencode) order unchanged. Pinned rows still first. A discovered-only row with `description` gets it as `hint`; an unlisted selected row keeps the existing hint text. New fields are copied only from a trusted entry; `false`/empty never attached (except the opencode `[]` carve-out). Typecheck green with the widened API types. | none | existing callers of `mergeModelOptions` |
| T2 | Curated fix + efforts synthesis + cursor spec param | `src/shared/types.ts` | — | `MODEL_EFFORT_SUPPORT["claude-code"]["opus-4.6"]` = `max,high,medium,low`. `supportedEfforts("codex", "gpt-7", ["low","turbo","high"])` → High, Turbo (synth, title-cased), Low in `orderEfforts` order (Turbo between High and Low). Labels from `opts.labels` win over title-casing. An id failing `^[a-z0-9_-]{1,32}$` is dropped. `auto` still dropped outside `MODEL_DEFAULT_EFFORT_KINDS`. Discovered empty → curated (unchanged), unknown model → default model's ladder (unchanged). Cursor: unknown id with no discovered efforts → `[]` (unchanged); unknown base with discovered efforts → those efforts. `cursorModelArg("gpt-7", "high", true, false, {effortIds:{high:"gpt-7-high"}, fastEfforts:["high"]})` → `gpt-7-high-fast`; with a `CURSOR_MODEL_SPECS` entry the spec wins over `discovered`. `retainableEfforts` still unions discovered ∪ curated, so a stored `xhigh` on Opus 4.6 is retained. `MODEL_MIN_CLI_VERSION` doc comment says "frozen fallback, no new rows". The curated copilot `auto` ("Model default") row gets `pinned: true` (owner, plan approval), so it stays first under the CLI-order rule. | none | `supportedEfforts` callers; `cursorModelArg` caller T13 |
| T3 | Claude id rule + spawn effort check | `src/shared/claude-model-id.ts` (new), `src/shared/effort-check.ts` (new) | — | Rule: `claude-opus-5-5`→`opus-5.5`, `claude-haiku-4-5-20251001`→`haiku-4.5`, `claude-opus-6`→`opus-6`, `claude-sonnet-4-6`→`sonnet-4.6`, `default`/`opus`→`null`. Reverse: each of the 16 current `CLAUDE_MODEL_FLAG` pairs round-trips to exactly today's string; `opus-6`→`claude-opus-6`; a discovered `cliId` wins over the rule; an id outside the friendly shape passes verbatim. Effort check: claude accepts `low…max` always, an unknown id only when in `discovered` and matching the charset; codex/copilot accept `EFFORT_OPTIONS` ids except `auto` (copilot: `auto` is never passed anyway), unknown only via discovered + charset; `"x y"`, `"a;b"`, a 33-char id → false. | trust | T13 (agents.ts) |
| T4 | Display names | `src/shared/model-display.ts` (new) | T1 types (pinned) | `prettifyModelId`: `opus-5.5`→`Opus 5.5`, `haiku-4.5`→`Haiku 4.5`, `opus-6`→`Opus 6`, `gpt-6.1-sol`→`GPT-6.1 Sol`, `grok-4.7`→`Grok 4.7`, `kimi-k3`→`Kimi K3`, `gemini-4-argon`→`Gemini 4 Argon`, `auto`→`Auto`, `deepseek/deepseek-v4-flash`→`DeepSeek V4 Flash` (part after the last `/`, a small acronym/brand table). `modelDisplayName`: a non-unlisted row label → curated label (`AGENT_OPTIONS`, cursor `CURSOR_MODEL_SPECS`) → prettified id. `sanitizeCliLabel("Grok 4.7  High​​")` → `Grok 4.7 High`. | none | T11, T18, T20, T21 |
| T5 | Cursor flat-list parser with the spec overlay | `src/shared/cursor-catalog.ts` (new) | T1, T2 (pinned) | On the 284-line fixture: every id covered by `CURSOR_MODEL_SPECS` collapses to one row `{id: <spec key>}` with no efforts/fast/cursor fields (spec wins; first-seen order); an uncovered variant of a spec'd base (e.g. a new `grok-4.7-max`) stays its own plain row; uncovered families group as `{id: base, label, efforts (CLI order), fast?, cursor:{effortIds, fastEfforts, fastId}}`, peeling trailing `-fast` then one effort token from `low|medium|high|xhigh|max|none|minimal|extra-high`, with `-thinking` kept in the base; a lone id with only a `-fast` twin gets `fastId`; an unparseable id (`claude-4.6-sonnet-medium-thinking`) stays a plain row. Labels are sanitized and lose the parsed effort/Fast words. Header and `Tip:` lines skipped. `cursorVariantOf("gpt-7-high-fast", rows)` → `{base:"gpt-7", effort:"high", fast:true}`. | none | T10 (`discoverCursor`), T11 |
| T6 | Speed tiers for discovered kinds | `src/shared/speed.ts` | T1, T2 (pinned); W0 verdicts | `DISCOVERED_SPEED_KINDS` = `{fx}` ∪ `{codex}` if G2 passed ∪ `{claude-code}` if G1 passed. Codex with `option.fast` → `["off","fast"]`; without → `["off"]`; codex not in the set → `["off"]`. fx unchanged. Cursor: a discovered-only base with `option.cursor.fastEfforts` including the effort → Fast. | none | T11 |
| T7 | Claude `initialize` probe | `src/bun/discovery/spawn-probe.ts` (new), `src/bun/discovery/claude-probe.ts` (new) | T1, T3; W0 G3 passed | `claudeProbeArgv` = S1 argv + `--strict-mcp-config` + any extra isolation G3 required; never appends `AGETOR_CLAUDE_ARGS`. Spawns via `coreSpawn` with `env: childEnv(env)`, stdin `pipe`, the given empty `cwd`, 10 s budget; writes the control request; resolves on the `control_response` for `init-1`; kills the child and cancels the reader in `finally`. Parser on the fixture: 13 rows (the `default` row dropped, its `resolvedModel` marks `opus-5.5` `cliDefault`), ids by rule, `alias` on alias rows, `cliId` = `resolvedModel`, efforts in CLI order only when `supportsEffort !== false` and the array is non-empty (haiku-4.5: none), `fast: true` iff `supportsFastMode === true`, labels sanitized. Old-shape fixture → rows with labels and no efforts. Malformed / non-JSON / missing `models` / timeout / non-zero exit → `[]`. The raw response never reaches a log or a return value (the parser reads `models[]` only; the test asserts a planted `account.email` string appears nowhere in the output or captured console). | external, trust | T10 |
| T8 | Gemini model list | `src/bun/discovery/gemini-probe.ts` (new) | T1, T4 | Runs `<bin> --version` (2 s) and, **only if** it parses ≥ `0.67.0` (`cliVersionSatisfies`), `<bin> models -o json` (5 s). An older or unparseable version never runs `models` (an old gemini could take `models` as a prompt). Parses an array or `{models:[…]}`; id = `modelId ?? id ?? name`; label = `displayName`; `description`; no efforts. Malformed → `[]`. | external | T10 |
| T9 | Copilot ACP probe (read-only) with kill switch | `src/bun/discovery/copilot-acp-probe.ts` (new) | T1, T7 (`runJsonLineSession`, pinned) | Disabled when `AGETOR_COPILOT_ACP_PROBE` is `0/false/off/no` → resolves `[]` without spawning. Otherwise speaks ACP over stdio (`initialize` → `session/new {cwd, mcpServers: []}`), 6 s budget, then kills the child. It **never** sends `session/prompt`, `session/set_config_option`, `session/set_model` or `session/set_mode`. Models come from the `configOptions` entry with category `model` (options' `value`/`name`/`description`) or, failing that, `models.availableModels`; efforts from the `thought_level` option attach only to the model that is current in the response (others fall back to curated), with `effortLabels` from the option names. Argv per the Copilot ACP server reference (recorded in the module doc with its source URL). Spec fixture parses; garbage, error replies, timeout → `[]`. | external, trust | T10 |
| T10 | Wire probes into discovery; codex fields; settle/seed hooks; kind targets | `src/bun/agent-discovery.ts` | T1, T5, T7, T8, T9 | `DiscoveredModel` is the shared type. `discoverClaude(target)` → `probeClaudeModels` (target.skip or no target → `[]`); `discoverGemini` → `probeGeminiModels` with `AGETOR_GEMINI_BIN ?? "gemini"`; `discoverCopilot(target?)` → ACP first when enabled and the result is non-empty, else `help config` (today's parser); `discoverCursor` → `parseCursorModelList`. `parseCodexModelList` adds `description`, `cliDefault` (`isDefault === true`), `defaultEffort`, `fast` (`additionalSpeedTiers` includes `fast` or `serviceTiers` non-empty), `fastTier` (first `serviceTiers[].id`), `fastHint` (its sanitized description), `defaultFast` (`defaultServiceTier` non-null); hidden still skipped. Every cache write (`runRefresh`, `runRefreshHarnessTarget`, `runRefreshKind`) goes through the settle hook when set (null hook = today's behavior, so existing tests hold). `seedDiscoveryCache` fills a key only until a probe settles it. `kindTargets` thunk resolved inside the enqueued run. Still a leaf: imports only `core-spawn`, `shared/*`, `./discovery/*`. `__testing` exposes the new parsers. | external, concurrency | `model-discovery.ts` (T12) |
| T11 | Shared composition + CLI-floor verdict + messages | `src/shared/model-catalog.ts` (new), `src/shared/cli-version.ts` | T1–T6 | `buildModelOptions` = `mergeModelOptions` with curated `AGENT_OPTIONS[kind].models`, `scoped = CATALOG_SCOPED_KINDS.has(kind)`; for cursor, a selected flat variant id known through `cursorVariantOf` becomes the unlisted row with the variant's label and the hint "Saved as a specific variant — pick the base model to change its effort" (read-time normalization, #18), never a migration. `effortOptionsFor` passes the row's `efforts` and `effortLabels`. `resolveDefaultModel`: owner pick unless trusted discovery is non-empty and lacks it, then the `cliDefault` row, else the owner pick. `resolveDefaultEffort`: `DEFAULT_EFFORT[kind]` if offered, else the row's `defaultEffort` if offered, else the first offered, else `null`. `resolveSeedModel`: stored id kept when in curated ∪ rows. `speedTiersKnown`: cursor always; fx/codex/claude when trusted discovery is non-empty. `knownModelIds`: merged ids plus every cursor variant id. `modelCatalogVerdict`: kinds outside `CLI_AUTHORITATIVE_CATALOG_KINDS`, `loggedIn === false`, or empty discovery → `unknown`; copilot `auto` → `offered`; otherwise `offered`/`missing`. `formatModelNotOfferedError({harnessLabel, installedRaw, modelLabel, kind, installHint})` in `cli-version.ts`: "<model> isn't in <harness>'s model list (<cli> <version>). Upgrade the CLI (<hint>) or pick a model it offers." | none | T12–T21 |
| T12 | Persistence, version drop, claude/copilot kind targets | `src/bun/model-discovery.ts` | T10, T11 | First `refreshAllModels()` call hydrates synchronously (before its first `await`) from `modelCatalog:*` (shape-validated, ≤ 2,000 rows per key, unknown fields dropped; harness keys only for existing enabled harnesses) via `seedDiscoveryCache`. Settle hook: fresh non-empty → cache + persist `{v:1, cliVersion, savedAt, models}` when the snapshot or version changed (no write on an identical sweep); fresh empty → keep the previous catalog unless the harness is known unavailable or its known version differs from the persisted one (then clear cache + delete key); a claude target skipped for logged-out → `[]` without touching the persisted key. `cliVersion` = `peekCachedCliVersion(builtin-or-harness)`. Claude kind target: the built-in claude harness (`harnesses.getByIdOrKind("claude-code")`), skipped when disabled, unavailable or `checkHarness(...).loggedIn === false`; `env: harnessEnv`, `bin: resolveBin`, `cwd: <dataDir>/discovery/probe-cwd` (created empty). Copilot kind target: built-in copilot, `env` = `harnessEnv` + `COPILOT_HOME` from `copilotHome(...)`, same cwd. A claude or copilot harness edit/status change refreshes its kind with that target. `noteHarnessStatuses` keeps `{available, version, loggedIn}` per harness for the hook and drops a persisted entry whose non-null `cliVersion` differs from a newly seen version. `snapshotKey` hashes every row field. `PER_HARNESS_KINDS` unchanged (claude not added, #7). | data, state, concurrency | boot `refreshAllModels` (`index.ts:558`, `headless.ts:409`), sweep, `POST /agent-models` |
| T13 | Spawn: claude ids by rule, discovered efforts, cursor discovered spec, Speed | `src/bun/agents.ts` | T2, T3, T6, T10; W0 G1/G2 | `toClaudeModelArg(id)` = `claudeCliModelFor(id, getDiscoveredModels("claude-code"))` and returns today's string for all 16 curated ids; `CLAUDE_MODEL_FLAG` removed (exceptions live in `claude-model-id.ts`). `claudeModelIdFromArg("claude-opus-6")` → `opus-6`, aliases still `null`. `claudeModelPickerFamily(id)`: with non-empty claude discovery, the family of the row whose `alias` ∈ {opus, sonnet, fable, haiku} and id matches, else `null`; empty discovery → today's switch. Claude env, codex `-c model_reasoning_effort=`, copilot `--reasoning-effort` all gated by `effortPassesSpawnCheck` (a failing effort is dropped with a warning that doesn't echo the value; claude's "effort required" throw unchanged). Cursor passes the discovered row's `cursor` spec to `cursorModelArg`. Speed: claude adds the G1 switch only when `speed === "fast"`, `claude-code ∈ DISCOVERED_SPEED_KINDS` and the discovered row has `fast`; codex adds the G2 form with the row's `fastTier` under the same conditions, and when Off on a `defaultFast` model passes the G2 standard-tier value if one exists. Never writes any user config. `agents.ts` may import `agent-discovery.ts` (a leaf); the reverse stays forbidden. | trust, external | `spawnAgent`/`buildCommand` (every run) |
| T14 | Orchestrator: discovery-first floors, defaults | `src/bun/orchestrator.ts` | T11, T12 | `minCliVersionError`: skip env honored first; then `modelCatalogVerdict` over codex per-harness / copilot kind-level discovery with the harness's `loggedIn`: `missing` → `formatModelNotOfferedError`; `offered` → `null`; `unknown` → today's table check. Covers every existing caller (start `:2554`, follow-up `:8594`, `:9011`, copilot `:10263`, clone route via `server.ts:2022`). The error's model label uses `modelDisplayName`. `createTask` with no model uses `resolveDefaultModel(kind, discovered, loggedIn)`; its effort default and `effortFallbackForModelChange` (`:12427`) use `resolveDefaultEffort`. Nothing else changes for stored tasks. | state | existing pre-flights and `createTask` |
| T15 | Failover, `/model` display names, bundles | `src/bun/harness-failover.ts`, `src/bun/claude-local-setting.ts`, `src/bun/bundle.ts` | T11, T12 | Failover (`:241-259`): keeps the per-harness "not offered" check; adds `modelCatalogVerdict` for codex/copilot (`missing` → `model <m> not offered`); the table floor applies only on `unknown`. `claudeModelIdFromDisplayName("Opus 6")` → `opus-6` when discovery lists it (curated labels first, then discovered labels, longest word-boundary match); the claude local-setting effort parse accepts an id in the discovered claude efforts when it passes the charset. `knownModelsFor` = `knownModelIds(kind, getHarnessModelMap().byHarness[h.id] ?? [], loggedIn)`, so opencode is per-harness and cursor variant ids are known. | state | `pickFailoverTarget`, `reconcileTaskSession`, bundle planner |
| T16 | Preferences guard for catalog keys | `src/bun/server.ts` | — | `GET /preferences` omits keys starting `modelCatalog:`; `PUT /preferences/modelCatalog:<x>` → `403 {error, code: "server-managed"}` for both tokens, nothing stored. Other keys unchanged. | trust | `/preferences` routes |
| T17 | New Task form on the shared helpers; seed fix; Speed for claude/codex | `src/mainview/components/kanban/NewTaskForm.tsx` | T1, T11, T19 (props pinned) | Uses `buildModelOptions`/`effortOptionsFor`/`speedOptionsFor`/`resolveDefaultEffort`; the cursor filter is gone. Seed: a remembered `lastModel:<kind>` outside the curated list is held pending and applied once rows load if `resolveSeedModel` accepts it and the user hasn't changed the model (round-3 finding). A new form's model is `resolveDefaultModel` when there is no remembered pick. Speed: the picker shows whenever `speedOptionsFor` offers more than Off; the reset-to-Off effect generalizes from cursor to every kind whose tiers are known (`speedTiersKnown`); submit writes `lastSpeed:<kind>` = the current (possibly fallen-back) speed for every kind, so the fallback overwrites the memory (#26). Picking Fast shows the row's `fastHint` (or claude's G1 text) as a notice with the same weight as the Fable 2x notice. The refresh button still calls `POST /agent-models`. | state | App board |
| T18 | Run panel editor + header display | `src/mainview/components/kanban/RunPanel.tsx` | T1, T4, T11, T19 | `mergedModels` → `buildModelOptions`; effort cascade uses `retainableEffortsFor` (never PATCHes away a retained effort); the Speed control appears for claude/codex with the "Applies on the next run" note (#28); every place the panel shows a model name uses `modelDisplayName`. Per-task reset effect gets a line for any new per-task state (run-panel.md). | state | RunPanel |
| T19 | Launch pickers + Speed picker props | `src/mainview/components/kanban/TaskLaunchPickers.tsx`, `src/mainview/components/kanban/SpeedPicker.tsx` | T1, T11 | Both merge sites → shared helpers; the seed at `:418` validates with `resolveSeedModel` against the loaded rows; speed follows `speedOptionsFor`. `SpeedPicker` gains optional `fastHint?: string` and `note?: string` props (pinned for T17/T18), rendered under the control; no hint → unchanged DOM. | none | agent profile / launch dialogs |
| T20 | Display-name sweep (webview) | `src/mainview/components/kanban/TaskCard.tsx`, `src/mainview/components/kanban/AgentProfileCard.tsx`, `src/mainview/components/kanban/ImportSessionsDialog.tsx`, `src/mainview/components/settings/HarnessAccountRow.tsx`, `src/mainview/components/bundle/ImportBundleDialog.tsx`, `src/mainview/lib/stack-badge.ts`, `src/mainview/lib/stack-editor.ts` | T4 | Every model shown as text uses `modelDisplayName` (task card: `Opus 5.5 · auto`). Ids used for matching (cooldown keys, stack rows) are untouched — the implementer classifies each hit and lists the display ones in the commit message. | none | board/settings render |
| T21 | CLI: `agetor add`, show, stacks, profiles, cooldowns | `src/cli/commands/add.ts`, `src/cli/commands/show.ts`, `src/cli/stack-display.ts`, `src/cli/commands/agent-profile.ts`, `src/cli/commands/harness.ts` | T1, T4, T11 | `agetor add` uses `buildModelOptions`/`effortOptionsFor`/`speedOptionsFor`/`resolveSeedModel`; `--model opus-6` accepted (unknown ids still pass verbatim); `--effort <discovered unknown id>` accepted for that model; the Speed step appears for codex/claude when offered. Model names print via `modelDisplayName` + `escapeFreeText`, ids via `escapeControlChars`. A label with ANSI/zero-width bytes from discovery prints escaped. | trust | CLI entry (`src/cli/index.ts`, unchanged) |
| T22 | Docs | `docs/architecture/harnesses.md`, `docs/architecture/harness-claude-code.md`, `docs/architecture/harness-codex.md`, `docs/architecture/harness-cursor.md`, `docs/architecture/harness-gemini.md`, `docs/architecture/harness-copilot.md`, `docs/architecture/persistence.md`, `CLAUDE.md`, `README.md` | all code tasks | `harnesses.md`: the add-a-model checklist says a new model needs no PR (a curated row only to override a label/hint); `MODEL_MODE_DENY`, `CLAUDE_MODEL_FLAG` and cursor-migration items removed; the merge-order rule and the effort synthesis documented. Each harness doc describes its probe, fallback and (claude) isolation flags; copilot documents `AGETOR_COPILOT_ACP_PROBE`. `persistence.md`: the `modelCatalog:*` keys. `CLAUDE.md`: probe facts in "Agent kinds at a glance", `AGETOR_COPILOT_ACP_PROBE` in the env-var list. README model mentions checked. | none | — |
| T23 | Live smoke + final refresh | this plan's `Status`, `docs/plans/dynamic-model-catalog-spikes.md` (append) | E1, all | On a headless core at `:4319` with `~/.agetor-dev` (`bun run` per memory recipe), `GET /agent-models`: claude rows match the live CLI (no duplicate labels), codex rows carry `cliDefault`/`fast`, cursor rows are grouped; restart the core offline-ish (kill + restart) and confirm the persisted catalog is served before the first sweep; `sqlite3 ~/.agetor-dev/agetor.sqlite "select value from preferences where key like 'modelCatalog:%'"` contains no email/org. Cursor side-effect check (#20): diff `~/.cursor/cli-config.json` before/after one minimal agetor cursor run; if it changed, write the finding for a separate ticket (no code here). Update `Status`. | external | — |

## 5. Work breakdown — test tasks

Every test must be able to fail: each test task shows its key assertions red against a deliberately broken copy (or `git stash`-free revert of the one-line behavior) before going green, and records that in its commit message. A missing binary or env never makes a test silently pass: probe tests use stub bins written under `/tmp` via `fakeBinDir`.

| ID | Layer | Covers | Owned files | Acceptance |
| --- | --- | --- | --- | --- |
| U1a | unit | T1 | `src/shared/model-options.test.ts` | Rule-4 CLI order, curated-only after, rule 2/7/6/9 unchanged, scoped order unchanged, new-field copying incl. never-false. Existing tests updated where they pinned curated-first order for an unscoped kind. |
| U1b | unit | T2 | `src/shared/types.test.ts`, `src/bun/effort-support.test.ts` | Opus 4.6 ladder; copilot `auto` row is `pinned`; synthesis/order/labels/charset; `auto` gating; cursor unknown-id and discovered-base cases; `cursorModelArg` with a discovered spec and spec precedence; `retainableEfforts` keeps a stored `xhigh` on Opus 4.6. |
| U1c | unit | T3 | `src/shared/claude-model-id.test.ts` (new), `src/shared/effort-check.test.ts` (new) | All 16 legacy pairs round-trip; dated, alias, `default`, new-family cases; effort check positive/negative incl. injection-shaped strings. |
| U1d | unit | T4 | `src/shared/model-display.test.ts` (new) | Every example in T4; sanitize removes zero-width and controls. |
| U1e | unit | T5 | `src/shared/cursor-catalog.test.ts` (new) | The 284-line fixture: spec-covered collapse, spec'd-base leftovers as plain rows, discovered-only grouping, thinking bases, fastId, irregular ids plain, no duplicate ids, `cursorVariantOf`. |
| U1f | unit | T6 | `src/shared/speed.test.ts` | Codex/claude tiers on and off the gate set; fx unchanged; cursor discovered spec. |
| U2a | unit | T7 | `src/bun/discovery/claude-probe.test.ts` (new) | Parser on both fixtures; a stub claude script (answers the control request from a fixture file, records its argv) proves the isolation flags, no `AGETOR_CLAUDE_ARGS`, kill on timeout (stub that never answers, 300 ms budget), `[]` on garbage; a planted email never leaves the module (output + spied console). |
| U2b | unit | T8 | `src/bun/discovery/gemini-probe.test.ts` (new) | Version gate: a stub printing `0.66.0` never receives `models` (argv log); `0.67.0` → parsed fixture; malformed → `[]`. |
| U2c | unit | T9 | `src/bun/discovery/copilot-acp-probe.test.ts` (new) | Kill switch spawns nothing; a stub ACP server (spec fixture) yields models + current-model efforts with labels; the stub records every method it received and the test asserts none of `session/prompt`, `set_config_option`, `set_model`, `set_mode`; error/timeout → `[]`. |
| U2d | unit/integration | T10 | `src/bun/agent-discovery.test.ts` | Codex new fields from the 0.166.0 fixture; cursor via `--list-models` stub; copilot ACP-then-help-config fallback; settle hook sees every write path; seed ignored after a settle; `kindTargets` resolved late; existing tests stay green with no hook. |
| U2e | unit | T11 | `src/shared/model-catalog.test.ts` (new), `src/shared/cli-version.test.ts` | **Cross-kind invariant (C3)**: for every kind, fixture discovery → no duplicate ids and no duplicate labels in `buildModelOptions`, including claude's 14-row fixture (13 rows in CLI order, then Mythos rows); copilot's `auto` row is first with ACP or `help config` discovery. Defaults, seeds, verdict matrix (codex/copilot/other kinds, logged out, empty, copilot `auto`), `knownModelIds` incl. cursor variants, read-time cursor variant row, message formatting. |
| U3a | integration | T12 | `src/bun/model-discovery.test.ts`, `src/bun/agent-models-endpoint.test.ts` | Persist → reset module state → hydrate serves the catalog before any probe; identical sweep doesn't rewrite (`updated_at` unchanged); version change drops; empty-on-transient keeps, empty-on-unavailable drops; logged-out claude skip; persisted JSON contains no `email`/`organization`/`account`; `GET /agent-models` serves hydrated rows. Top-level `AGETOR_DATA_DIR`, `rmTestDataDir`, `snapshotHarnessState`. |
| U3b | unit | T13 | `src/bun/agents.test.ts` | `toClaudeModelArg` regression for 16 ids + discovered `opus-6`; `claudeModelIdFromArg`; picker family from discovered aliases and fallback; claude env / codex `-c` / copilot flag for known, discovered-unknown and charset-failing efforts; cursor discovered spec argv; Speed flags present only when gated + discovered `fast`, absent otherwise; Off on a `defaultFast` codex model per G2. |
| U3c | integration | T14 | `src/bun/orchestrator.test.ts` (min-CLI and `createTask` default sections only) | Codex model missing from a non-empty trusted catalog → refused with the new message even with no table floor; offered → allowed even if the table floor would fail; empty discovery → table behavior unchanged; skip env wins; `createTask` default falls back to the `cliDefault` row only when the owner pick is missing from trusted discovery. |
| U3d | unit/integration | T15 | `src/bun/harness-failover.test.ts`, `src/bun/claude-local-setting.test.ts`, `src/bun/bundle-endpoint.test.ts` | Copilot backup missing the model is skipped; table only on unknown; `Opus 6` display name resolves; bundle known-ids include opencode per-harness and cursor variants. |
| U3e | integration | T16 | `src/bun/preferences-catalog-keys.test.ts` (new) | GET omits catalog keys; PUT refused for app and CLI tokens; other keys unaffected. |
| U4a | integration | T21 | `src/cli/commands/add.test.ts` | Stubbed `/agent-models` with `opus-6` + an unknown effort → offered by the wizard and accepted via flags; codex Speed step when offered. |
| U4b | unit | T21 | `src/cli/show.test.ts` | Pretty name printed; hostile label escaped. |
| E1 | e2e | C1, C2, C8 (claude), C9 | `e2e/claude-models.spec.ts` (new), `e2e/fixtures.ts` | `fixtures.ts` adds `writeClaudeStubBin` (default: behaves like `/bin/echo`, so other specs are unchanged) selected by `extraEnv.AGETOR_E2E_CLAUDE_STUB === "1"`; with `AGETOR_E2E_CLAUDE_MODELS_JSON` it answers the `initialize` control request from that file. Spec: (1) catalog with `claude-opus-6` (ladder `low…max` + unknown `turbo`) → **Opus 6** is first in the New Task picker, its effort dropdown shows the ladder incl. "Turbo", a task created with it shows "Opus 6" on the card and in the run panel editor; (2) a backend whose stub reports nothing → curated picker, Opus 5.5 default; (3) claude Speed visible on a `supportsFastMode` model only if G1 shipped it, else absent. |
| E2 | e2e | regressions | `e2e/speed-picker.spec.ts` | Update only if the generalized `lastSpeed` write or reset changes an fx/cursor assertion; full suite run in wave 5. |

**E2E decision: applies** (UI → API → core → CLI child process). Run recipe:

```bash
export PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH"
bun install
bun run typecheck && bun test
bun run build            # e2e loads the bundled webview
bun node_modules/@playwright/test/cli.js test e2e/claude-models.spec.ts
bun node_modules/@playwright/test/cli.js test   # full suite, one Playwright run at a time
```

The backend is provisioned per spec by `e2e/fixtures.ts` (`provisionBackend` + `extraEnv`); no credentials, no network. Live CLIs are used only in W0 and T23.

## 6. Execution waves

| Wave | Tasks (parallel within the wave) | Barrier |
| --- | --- | --- |
| 0 | W0 | Spike verdicts recorded. **G3 failure stops the run** and goes back to the owner. G1/G2 failures cut claude/codex Speed (decision #27) and are reported, nothing else changes. |
| 1 | T1, T2, T3, T4, T5, T6 · U1a–U1f | `bun run typecheck` + `bun test` green. Checkpoint commit. |
| 2 | T7, T8, T9, T10, T11 · U2a–U2e | Green. Checkpoint. |
| 3 | T12, T13, T14, T15, T16 · U3a–U3e | Green + a headless boot smoke (`GET /agent-models` answers). Checkpoint. Review trust-tagged waves (2, 3) before wave 4 builds on them. |
| 4 | T17, T18, T19, T20, T21 · U4a, U4b | Green + `bun run build`. Checkpoint. |
| 5 | E1 (+E2 fixes), T22, then T23 last | Full e2e green, docs done, smoke done, Status updated. |

Owned-file check: no path appears twice within a wave. Same-wave dependencies (T5→T1/T2, T6→T1/T2, T9→T7, T10→T7–T9, T17/T18→T19 props) code against §3.1 signatures; T11→T4–T6 is cross-wave.

**Collateral tests.** A behavior change can turn a test red in a file no task in that wave owns (expected: the rule-4 order change in wave 1 against picker-order assertions in `src/cli/commands/add.test.ts` or `src/bun/agent-models-endpoint.test.ts`; T10's cursor grouping in wave 2 against flat-id assertions). The test task paired with the change (U1a for T1, U2d for T10) runs the full suite and owns those files for that wave only; later waves own them again as listed. No barrier is knowingly red.

**Behavior-neutral checkpoints.** Wave 2 adds the claude probe but runs it only when a kind target is passed, which first happens in T12 (wave 3), so the wave-2 checkpoint changes no claude behavior. Claude rows reach production together with the spawn rule (T13) in wave 3. Cursor is the exception: T10's grouping lands in wave 2 but the discovered-spec spawn (T13) lands in wave 3, so at the wave-2 checkpoint a discovered-only cursor base would spawn with its bare base id. Tests stay green (no test spawns a discovered-only cursor base before U3b), but nobody dogfoods a wave-2 checkpoint, and slice A ends at wave 3.

**Delivery (owner, plan approval): one PR**, with the slices below as ordered commit groups (precedent: #296). Each slice stays green on its own so a reviewer can walk the commits in order:
- **Slice A — core** (waves 0–3): probes, shared composition, persistence, spawn, pre-flight. The existing pickers already render the new rows through `mergeModelOptions`.
- **Slice B — surfaces** (wave 4): consolidated pickers, seeds, Speed UI, display names, CLI.
- **Slice C — proof & docs** (wave 5).
The per-wave checkpoint commits already follow this order; the PR body lists the slice boundaries by commit.

## 7. Invariants, runtime shape & risks

**Invariants** — each has one enforcement point; every path goes through it.

- Claude CLI id ↔ agetor id: `src/shared/claude-model-id.ts` (probe parser, `toClaudeModelArg`, `claudeModelIdFromArg`).
- Effort reaching argv/env: `effortPassesSpawnCheck` (`src/shared/effort-check.ts`), called by every `buildCommand` effort branch.
- Picker rows for any surface: `buildModelOptions` (`src/shared/model-catalog.ts`). No surface calls `mergeModelOptions` directly after wave 4 (grep check in T21's acceptance).
- CLI-floor decision: `modelCatalogVerdict`, used by `minCliVersionError` and failover.
- Discovery cache writes: the settle hook (`agent-discovery.ts`), installed by `model-discovery.ts`; persistence only there.
- No discovery or run writes user CLI config: claude probe flags (T7), copilot probe method allow-list (T9), cursor stays on the flat list (T5/T10), Speed only via per-run flags (T13).
- Raw claude `initialize` data never logged or stored: `parseClaudeInitModels` whitelist.

**Runtime shape.** One core; probes serialized by `enqueue`, async, budgets 10 s (claude), 6 s (copilot ACP), 2 s + 5 s (gemini), unchanged elsewhere. A crash mid-probe leaves the persisted catalog as it was (writes happen after settle). Restart: hydrate → boot sweep replaces. Offline: transient empties keep the last catalog. Kill switches: `AGETOR_COPILOT_ACP_PROBE=0` (copilot → `help config`); claude has none beyond G3's verdict (if a field issue appears, the fallback is curated, the same as a failed probe). `AGETOR_SKIP_CLI_VERSION_FLOOR=1` now also skips the discovery-first check.

**Blast radius.** Picker order changes for claude/codex/cursor/gemini/antigravity/copilot (#13); copilot's curated `auto` row stays first because it is now `pinned`. `toClaudeModelArg` is on every claude spawn (regression-pinned for the 16 ids). Codex effort strings are now validated. Pre-flight can newly refuse a codex/copilot model the account's catalog lacks. The preferences table gains ~10 rows. Rollback: revert the branch; the `modelCatalog:*` rows are inert for older builds (opaque keys nobody reads). No migration.

**Cross-repo dependencies:** none.

## 8. Open questions / assumptions

No unratified one-way decisions: the two one-way doors (claude id scheme, claude fast mechanism) were answered by the owner.

1. **Copilot ACP probe is harmless on real installs** (owner-accepted risk, r3). It may create a copilot session record under `COPILOT_HOME` (a `session/new` side effect); it never selects a model or effort. One env flip disables it.
2. **Copilot ACP shape follows the spec**; per-model efforts are only known for the model current in `session/new`. The rest use curated tables.
3. **Gemini `models -o json` fields match the docs** (stub-only, #21).
4. **Spikes G1/G2/G3** decide claude Speed, codex Speed and the claude probe (§6).
5. **Codex "Off" on a `defaultFast` model**: if G2 finds no standard-tier value, Off passes nothing and the model's own default tier applies; the Off row then carries the hint "This model's default tier applies".
6. **Resolved at plan approval:** copilot's "Model default" (`auto`) row is marked `pinned` (merge rule 9), so it stays the first row under the CLI-order rule (T2).
7. **A codex model the account's catalog hides** (`hidden: true` or absent) is now refused at pre-flight (#14), where today it would fail inside codex. Intended.
8. **Claude's list is account-independent except Mythos-style gating** (#7); per-account differences are ignored.
9. **Cursor grammar stays parseable**; an unrecognized suffix shows as an extra plain row (#18, assumption 8 of the grill).
10. **Keep-on-empty can keep a stale catalog** while the same CLI version keeps failing (e.g. an opencode harness whose providers were all removed). The next non-empty probe or a version change clears it; a manual refresh of an empty result does not. Acceptable per #16 ("used until a fresh probe replaces it").
11. **A discovered claude model with `supportsEffort: false` and no curated row** falls back to the default model's ladder (#15 literal). The CLI ignores the env var for such models.

## 9. Completeness ledger

| Item | Disposition | Task / reason / who deferred |
| --- | --- | --- |
| Claude `initialize` probe + parser + isolation | in this run | W0 (G3), T7, T10, T12 |
| Claude id rule; `CLAUDE_MODEL_FLAG` → exception list; `toClaudeModelArg` / `claudeModelIdFromArg` on the rule | in this run | T3, T13 |
| `claudeModelPickerFamily` derived from discovered aliases, switch as fallback | in this run | T13 |
| `claudeModelIdFromDisplayName` matches discovered labels; local-setting effort parse accepts discovered efforts | in this run | T15 |
| `MODEL_MODE_DENY` claude rows: no code change, checklist stops requiring a row | in this run (docs) | T22 |
| Gemini ≥ 0.67 probe, older → `[]` | in this run | T8, T10 |
| Cursor flat-list grouping, spec overlay, read-time normalization, the 5 duplicated filters removed | in this run | T5, T10, T11, T17–T19, T21 |
| Codex `isDefault` / `defaultReasoningEffort` / speed tiers | in this run | T10, T11, T13 |
| Copilot ACP probe, shipped on, env kill switch | in this run | T9, T10, T12 |
| Copilot `auto` row pinned first under CLI order | in this run | T2 (owner, plan approval) |
| Speed for claude (if G1) and codex (if G2), `lastSpeed`, disable-unsupported, memory overwrite, cost hint, next-run note | in this run | W0, T6, T13, T17–T19, T21 |
| `modelDisplayName` at every display site incl. CLI/TUI | in this run | T4, T18, T20, T21 (the TUI prints no model today: grep in T21 confirms) |
| NewTaskForm seed validates against curated only (`:361`) | in this run | T17 |
| Same seed bug in `TaskLaunchPickers.tsx:418` (found while planning) | in this run | T19 |
| Persisted catalog in `preferences`, version drop, raw never stored | in this run | T12 |
| `modelCatalog:*` keys guarded on `/preferences` (found while planning) | in this run | T16 |
| Unknown-effort synthesis + spawn charset check (claude, codex, copilot, cursor) | in this run | T2, T3, T13 |
| `MODEL_MIN_CLI_VERSION` discovery-first at pre-flight and failover | in this run | T11, T14, T15 |
| Opus 4.6 `xhigh` fix | in this run | T2 |
| Bundles `knownModels` on curated ∪ discovered (+ opencode per-harness, cursor variants: found while planning) | in this run | T15 |
| `agetor add` / CLI validation on curated ∪ discovered, escaped output | in this run | T21 |
| `createTask` default model/effort with the CLI default as fallback (#11) | in this run | T14 |
| Webview/CLI API row types widened to the shared `DiscoveredModel` | in this run | T1 |
| Bun `DiscoveredModel` twin removed (one type) | in this run | T1, T10 |
| Tests pinning curated content kept; new tests per #31 | in this run | U1–U4, E1 |
| Docs per #32 (+ persistence.md, env var in CLAUDE.md) | in this run | T22 |
| Cursor runs possibly changing the user's interactive cursor default | out of scope: checked once in T23; a confirmed change becomes a separate ticket | owner, grill #20 |
| Claude per-account catalogs | out of scope | owner, grill #7 |
| Claude "latest" alias rows | out of scope | owner, grill #6 |
| Live verification against copilot / gemini / agy | out of scope | owner, grill #21 |
| Migrating stored claude ids or cursor variant ids | out of scope (not needed) | grill #4, #18 |
| A DB table for the catalog | out of scope | grill #16 |
| Antigravity probe changes | out of scope | grill #1 (curated-table policy only) |
