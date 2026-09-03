# Plan — GPT-6 Astra as the Codex default, `ultra` effort, working Codex discovery, and discovery-driven per-model efforts

| Field | Value |
| --- | --- |
| Date | 2026-09-03 |
| Source | `/implement GPT 6 Astra, which was just released by OpenAI` |
| Config | AGENTS_CONFIG.yml (balanced; host `claude_code`) |
| Flags | none |
| Gates | grilled by owner (3 questions, 2026-09-03); plan v1 approved "plus sweep in the out-of-scope items"; this v2 re-plan re-approved by owner before code |
| Branch | feature/gpt6 (the task's own branch; already checked out) |
| Base SHA | 3a771b3f94988af1a1dfb9a6bf2dcff74a093cb2 (= main, "release v0.1.5"; tree clean) |

## 1. Objective & success criteria

1. `gpt-6-astra` is the **default** Codex model and tops the picker; `gpt-6-astra-aeon` sits right below it.
2. A new **`ultra`** reasoning effort exists in the shared effort picker, offered where Codex offers it (Astra/Aeon, Sol/Terra, Cyber by family assumption; not Luna), passed through as `-c model_reasoning_effort=ultra`.
3. Codex model discovery **works**: `discoverCodex()` speaks `codex app-server` JSON-RPC `model/list`, carrying each model's `supportedReasoningEfforts`.
4. **Per-model efforts are discovery-driven**: wherever agetor decides which efforts a model supports (four pickers, CLI prompt, task creation default, PATCH null-clear guard, model-change cascades), a model's *discovered* effort set wins when the CLI reported one; the curated table stays the fallback. A catalog change that only alters efforts still triggers `agent_models_changed`.
5. The GPT-5.6 family's `none` is *verified kept* (live-accepted on Sol and Luna); `gpt-5.5` gains `none` (the API's own per-model error enumerates it).
6. README and CLAUDE.md are accurate; `bun run typecheck` and the full `bun test` suite are green.

## 2. Context & constraints (grounded)

**Official (developers.openai.com model page + API changelog, learn.chatgpt.com/docs/models — 2026-09-03):** id `gpt-6-astra`, no alias/snapshot; efforts `low`/`medium`/`high`/`xhigh`/`max`, `none` explicitly unsupported; 1,050,000 ctx / 128,000 out; $10 / $1 cached / $50 per MTok; cutoff Apr 30 2026. Codex's models page lists "Astra" with *Light / Medium / High / Extra High / Max / Ultra* (Ultra = subagent fan-out); rollout phased — Trusted Access Program first, ChatGPT plans + API "in the coming days". GPT-5.6 Sol/Terra/Luna stay recommended. `gpt-6-astra-aeon`: tweet-sourced; press calls it the long-horizon Astra variant for multi-day tasks; not on the model page.

**Spikes (real `codex exec` runs on the owner's ChatGPT-plan login, `--sandbox read-only`, trivial prompt; artifacts in the session scratchpad `spikes/`):**

| Probe | Verdict |
| --- | --- |
| `gpt-5.6-sol` + `low`, codex 0.147.0 (installed) | `turn.completed` in 6 s — spike setup valid |
| `gpt-6-astra` (max / none / high) on 0.147.0 **and** 0.153.0 (latest; installed only in the scratchpad) | HTTP 400 `The 'gpt-6-astra' model is not supported when using Codex with a ChatGPT account.` — server-side rollout gate, identical on both versions |
| Built-in model metadata | both binaries: `Model metadata for gpt-6-astra not found. Defaulting to fallback metadata`, id still forwarded (`strings`: `gpt-5.6-sol` ×7, zero `gpt-6` tokens) — no "update your CLI" hint warranted |
| `gpt-6-astra-aeon` + high | same generic 400; absent from both binaries and the model page → unverified id |
| `gpt-5.6-sol` + **`ultra`** on 0.147.0 and 0.153.0 | `turn.completed` — accepted end-to-end |
| `gpt-5.6-luna` + `ultra` | `turn.completed` — the API accepts it even though Codex's catalog doesn't offer ultra for Luna |
| `gpt-5.6-sol` + **`none`**, `gpt-5.6-luna` + `none` | `turn.completed` both — `none` stays valid for the family |
| `gpt-5.5` + `max` | 400 `Unsupported value: 'max' is not supported with the 'gpt-5.5' model. Supported values are: 'none', 'low', 'medium', 'high', and 'xhigh'.` — the API enforces per model and its set includes `none` |
| bogus effort value | global enum `none, minimal, low, medium, high, xhigh, max` (ultra is handled by Codex itself) |
| `codex prompt --models` | `unexpected argument '--models'` on both versions — agetor's discovery has always returned `[]` |
| `codex app-server` → `initialize` → `initialized` → `model/list` | answers in 0.8–1.8 s on both versions: `{data:[…], nextCursor}`; entries `{id, displayName, description, hidden, isDefault, defaultReasoningEffort, supportedReasoningEfforts:[{reasoningEffort, description}], upgrade, …}`; account-scoped, server-fetched (cached in `~/.codex/models_cache.json`); hidden rows already filtered. This account: sol (low…max, **ultra**), terra (same), luna (low…max), gpt-5.5 (low…xhigh), gpt-5.4, gpt-5.4-mini. No entry lists `none`; Astra absent. |
| `cursor-agent models` (2026.09.02), `fx models --json` (0.0.7) | no GPT-6 id in either catalog |
| `/bin/echo app-server` (unit-test stub) | exits at once printing `app-server` — the prober must resolve `[]` on process exit |

**Reading the two sources:** the app-server catalog is what Codex's UI *offers*; the API error text is what it *enforces*, and the enforced set is a superset (adds `none`). Curated rows therefore follow the offering (ultra for Sol/Terra/Astra/Aeon/Cyber, not Luna) and keep `none` where live-verified; discovered efforts override curated when present.

**Codebase (Explore agents, file:line):**
- Effort contract: `src/shared/types.ts:1866-1875` `supportedEfforts(agent, model)` (pure, over `MODEL_EFFORT_SUPPORT` :1768-1854; unknown codex id → `DEFAULT_MODEL.codex`'s set); `:1742-1750` `EFFORT_OPTIONS` (order = picker order); `:1244-1261` `AgentOption`; `:1299` `DEFAULT_MODEL.codex`; `:1343` `DEFAULT_EFFORT`; `:1948-1955` `AGENT_OPTIONS.codex.models`.
- Direct table reads that bypass `supportedEfforts`: `src/bun/orchestrator.ts:3540-3546` (createTask effort default), `src/bun/server.ts:3532-3546` (PATCH "effort cannot be cleared" guard), `src/bun/agents.ts:244-247` `modelDeclinesEffort` (null-effort allowance for `buildCommand`).
- `supportedEfforts` callers: `orchestrator.ts:1806-1819` `effortFallbackForModelChange` (+ `:1957` `applyClaudeLocalSetting` validation), `src/cli/commands/add.ts:306-312`, `RunPanel.tsx:5280-5301` + `:5311-5327` (`onAgentChange`) + `:5420-5445` (render), `NewTaskForm.tsx:270-277` + `:344-358`, `TaskLaunchPickers.tsx:125-131` + `:161-172`. In every webview site the discovered list (`agentModels`/`harnessModels`, or the hook's own fetch) is already in scope; `add.ts:289` has `discovered` in scope too.
- Discovery: `src/bun/agent-discovery.ts:10-13` `DiscoveredModel {id, label?}`; `:121-134` `discoverCodex` (dead probe); `:374-386` `getDiscoveredModels`/`getHarnessDiscoveredModels`; `:613` `__testing`. `src/bun/model-discovery.ts:72-74` snapshot key hashes **ids only**; `:103` `agent_models_changed`. Routes `server.ts:3294-3357` pass cached arrays through. Client types duplicate `{id, label?}` at `src/mainview/lib/api.ts:189-206` and `src/cli/api-client.ts:265-279`. `src/shared/model-options.ts:19-72` `mergeModelOptions` rules 1–7, types `CuratedModel`/`DiscoveredModel`/`ModelOption` (:79-102, deliberately structural), 4 callers (`add.ts:289`, `NewTaskForm.tsx:332`, `RunPanel.tsx:5588`, `TaskLaunchPickers.tsx:153`).
- Tests pinning today's shape: `effort-support.test.ts:98-132` (default, family loop, **order-sensitive `slice(0,4)`**, fallback), `agents.test.ts:77` (`codexDefaults`), `:528-560` (passthrough template), `agent-discovery.test.ts:18-50` (line parser), `:422-434` (planted echo stub, exact `toEqual([{id}])`), `model-discovery.test.ts:100-109` + `:310-335` (planted echo stubs, exact `toEqual`), `model-options.test.ts` (rules 1–7). No component unit tests exist for the pickers.
- Docs: `README.md:250`; `CLAUDE.md:46` (`[--model gpt-5.5]`, "(use gpt-5.5)"). No migration ever adds a model; `lastModel:codex` prefs keep pointing at Sol (still a curated row).

## 3. Approach & key decisions

- **Default → `gpt-6-astra` now** (owner decision, taken with the 400 in front of them). Hint carries the gate. `DEFAULT_EFFORT.codex` stays `high`.
- **`ultra` = shared `EFFORT_OPTIONS` id at index 0**, gated per model like every other id (spike + catalog evidence). Cursor derives efforts from `CURSOR_MODEL_SPECS.effortIds`, claude-code from its own set — neither picker changes.
- **Curated efforts follow Codex's offering, `none` follows live acceptance:** Astra/Aeon `ultra…low` (no `none`, per docs); Sol/Terra/Cyber gain `ultra` and keep `none`; Luna unchanged (catalog: no ultra); `gpt-5.5` gains `none` (API error text). `gpt-5`/`gpt-5-codex` untouched (unverifiable on this account).
- **Discovery via `codex app-server` `model/list`**, carrying `efforts` (bare `reasoningEffort` ids) on each `DiscoveredModel`. Codex stays **out of** `CATALOG_SCOPED_KINDS` (scoping would hide Astra on accounts the rollout hasn't reached).
- **Discovered efforts win, curated is the fallback** — one contract, threaded everywhere the set is decided:
  - `supportedEfforts(agent, model, discoveredEfforts?)`: when the third arg is a non-empty list, return `EFFORT_OPTIONS` filtered to it (canonical order); if none of its ids are known to agetor, fall back to the curated path; otherwise today's behaviour.
  - `mergeModelOptions` attaches `efforts` to a merged row from the discovered entry (curated∩discovered and discovered-only; rule 7's logged-out distrust still discards it); a pure `discoveredEffortsFor(models, id)` helper serves every picker and the CLI.
  - Bun side reads the module caches via a new `getDiscoveredEfforts(kind, model, harnessId?)` (harness cache first, then kind cache).
  - The PATCH guard keeps its *null-clear-only* semantics — it does **not** start rejecting non-null effort ids, because the catalog understates what the API accepts (ultra on Luna, `none` everywhere) and a rejection there would block values that run fine. `modelDeclinesEffort` stays curated-only for the same reason (a null effort is only ever allowed when the curated table says `[]`).
  - `model-discovery.ts`'s change-detection snapshot includes efforts, so an efforts-only catalog change broadcasts.
- **Aeon row** with an "unverified id" hint; effort set = Astra's (assumption).
- No migration, no `MODEL_MODE_DENY` entry, no `agents.ts` change (verbatim passthrough is the tested contract).


- **Cascade rule (orchestrator decision, wave-1 checkpoint):** "discovered wins" narrows what the pickers *offer*, but an *existing* task effort stays valid when either the discovered or the curated set supports it — `retainableEfforts(kind, model, discoveredEfforts)` in `src/shared/types.ts`, the union of both — and only an effort neither source supports triggers RunPanel's cascade or the orchestrator's `effortFallbackForModelChange`. A retained-but-unoffered effort renders as an unlisted row in the effort select (rule-6 analogue). Rationale: a discovery refresh that omits `none` (Codex's catalog never lists it; the API accepts it) must not silently PATCH away an effort the user chose. New-task forms and `createTask` have no prior intent for the task, so they use the discovered-wins set strictly.


- **Review-driven refinements (Phase 5 → 8, opus review under the `code-review` skill; all eight findings swept in):**
  - *Efforts come from the merged rows, never the raw catalog.* Every picker and `agetor add` now pass `mergeModelOptions`' output (`ModelOption[]`, rule 8) to `discoveredEffortsFor`, so rule 7's logged-out distrust applies to efforts too and rule 8 is the single source. `AgentOption.efforts` (never assigned) was removed. `NewTaskForm`'s mount-time pref-seed no longer consults discovery (its `[]`-deps closure predates the boot sweep); the render-path effect, keyed on the offered ids, is the authoritative validator.
  - *`supportedEfforts` checks the cursor unknown-id guard before the discovered branch* — cursor encodes effort in the model id, so a discovered list must never re-open efforts for an unknown cursor id.
  - *RunPanel's retained-but-unoffered effort row* is placed in `EFFORT_OPTIONS` order (a retained `ultra` sits above Max, not below Low) and its hint names the harness rather than hardcoding "Codex".
  - *Codex discovery is per harness, like fx.* `model/list` is account-scoped, so a second codex harness (its own `home` → `HOME`/`CODEX_HOME`) must not inherit the built-in account's catalog and effort sets. `discoverCodex(env?, bin?)` joins the fx per-harness path: `HarnessTarget { harnessId, kind?: "fx" | "codex", env, bin? }` (`FxHarnessTarget` kept as an alias, `opts.fxHarnesses` keeps its name), `discoveryTargets()` enumerates enabled fx **and** codex harnesses, `refreshHarnessTarget` / `modelsForHarness` / `refreshHarnessModels` are kind-aware, and a built-in-like target still drift-corrects the kind cache. This also makes `getDiscoveredEfforts`' harness-first branch reachable for codex.
  - *`discoverCodex` hygiene:* the stdout reader is taken inside a try and cancelled in `finally` (a grandchild inheriting the pipe no longer keeps the process alive — verified); a timeout discards partial pages and returns `[]` as documented (`__testing.setCodexProbeTimeoutMs` exists for tests); a final JSON-RPC line without a trailing newline is flushed instead of dropped.

## 4. Work breakdown — implementation tasks

**Wave 1 (foundations; disjoint files)**

**IMPL-1 — catalog, efforts, default, contract.** Owns `src/shared/types.ts`.
- `EFFORT_OPTIONS`: prepend `{ id: "ultra", label: "Ultra", hint: … }` (Codex's top tier — maximum reasoning plus automatic delegation to internal sub-agents; several times Max's usage; Codex-only today).
- `DEFAULT_MODEL.codex` → `"gpt-6-astra"` with the decision + spike evidence in the comment; `DEFAULT_EFFORT.codex` stays `"high"` (comment: ultra deliberately not default).
- `MODEL_EFFORT_SUPPORT.codex`: `"gpt-6-astra"`, `"gpt-6-astra-aeon"` = `["ultra","max","xhigh","high","medium","low"]`; prepend `"ultra"` to `gpt-5.6-cyber`/`sol`/`terra` (keep `none`); `gpt-5.6-luna` unchanged; `gpt-5.5` = `["xhigh","high","medium","low","none"]`; `gpt-5`/`gpt-5-codex` unchanged. Comments cite the 2026-09-03 catalog + live measurements.
- `AGENT_OPTIONS.codex.models` order: astra ("Recommended default — OpenAI's most capable model. Rolling out in phases; rejected on ChatGPT plans until OpenAI enables it for your account."), aeon ("Long-horizon Astra variant for multi-day tasks. Unverified id — not on OpenAI's model page yet; same rollout gate as Astra."), cyber (unchanged), sol ("Previous recommended default — flagship GPT-5.6; works on ChatGPT plans."), terra, luna, gpt-5.5 ("Previous-generation model — works on ChatGPT plans."), gpt-5-codex, gpt-5.
- `AgentOption` gains `efforts?: readonly string[]` (doc: discovered per-model efforts, set only by `mergeModelOptions` from a CLI-discovered entry).
- `supportedEfforts(agent, model, discoveredEfforts?: readonly string[] | null)` per §3 (doc comment states precedence + the unknown-ids fallback).
- Acceptance: only these edits; typecheck green.

**IMPL-2 — discovery.** Owns `src/bun/agent-discovery.ts` and `src/bun/model-discovery.ts`.
- `DiscoveredModel` gains `efforts?: string[]` (present only when the CLI reported a non-empty list).
- Replace `parseCodexModels` with `parseCodexModelList(result: unknown): DiscoveredModel[]` over the `model/list` result: non-empty string `id`, skip `hidden === true`, dedupe, `label` = `displayName` if string, `efforts` = deduped `supportedReasoningEfforts[].reasoningEffort` strings (omit the key when empty). Export via `__testing` (drop `parseCodexModels`).
- `discoverCodex`: spawn `[bin, "app-server"]` (stdin/stdout piped, stderr ignored), write `initialize` (clientInfo `{ name: "agetor", title: "Agetor", version }`), the `initialized` notification, `model/list`; match responses by `id`; follow `nextCursor` (≤ 5 pages, `{ cursor }`); 5 s budget (measured ≤ 1.8 s); kill the child when done; resolve `[]` on child exit before a result, JSON-RPC error, timeout, or any throw; guard `stdin.write` against an exited child. Rewrite the module comments (`prompt --models` never existed; catalog is account-scoped + server-fetched; keep the "stay a leaf" note).
- New `getDiscoveredEfforts(kind, model, harnessId?)`: looks up `harnessCache.get(harnessId)` first, then `cache.get(kind)`; returns the entry's `efforts` or `null`.
- `model-discovery.ts` snapshot key: hash `id` + `efforts` (joined) so effort-only changes publish.
- Acceptance: typecheck green; behaviour pinned by TEST-2/TEST-3.

**IMPL-3 — model-options.** Owns `src/shared/model-options.ts`.
- `DiscoveredModel.efforts?: string[]`, `ModelOption.efforts?: readonly string[]`; new rule 8 in the doc comment + code: a merged row carries `efforts` from the discovered entry when present (for both curated∩discovered and discovered-only rows; rule 7's distrust discards it with the rest). Rule 5's label/hint precedence unchanged.
- Export `discoveredEffortsFor(models: readonly { id: string; efforts?: readonly string[] }[] | undefined, id: string | null): readonly string[] | null`.
- Acceptance: typecheck green; TEST-4 pins it.

**IMPL-4 — docs.** Owns `README.md` and `CLAUDE.md`.
- `README.md:250`: roster = GPT-6 Astra / Astra Aeon (rolling out; rejected on ChatGPT plans until OpenAI enables them), GPT-5.6 Sol / Terra / Luna (plus the access-gated GPT-5.6 Cyber) and earlier GPT-5 options for Codex; effort bullet mentions Codex's Ultra tier and that Codex's effort menu follows what the signed-in account's Codex reports.
- `CLAUDE.md:46` (codex bullet): example argv `[--model gpt-6-astra]`; replace "(use gpt-5.5)" with the rollout-gate note (measured 2026-09-03 on 0.147.0/0.153.0, HTTP 400 "not supported when using Codex with a ChatGPT account"; pick GPT-5.6 Sol there until it lands); `ultra` = Codex's delegation tier (Sol/Terra/Astra/Aeon; not Luna); one paragraph on discovery: `codex app-server` JSON-RPC `model/list` (account-scoped; `codex prompt --models` never existed), `efforts` carried on `DiscoveredModel`, and the precedence rule (discovered wins, curated fallback; PATCH guard stays null-clear-only because the API accepts more than the catalog offers).
- Acceptance: only those passages change.

**Wave 2 (consumers; depend on Wave 1 signatures; disjoint files)**

**IMPL-5 — bun consumers.** Owns `src/bun/orchestrator.ts` and `src/bun/server.ts`.
- `createTask` (:3540-3546): `const support = supportedEfforts(kind, model, getDiscoveredEfforts(kind, model, harnessId))`; `effort = input.effort ?? (support.length === 0 ? null : (support.some(o => o.id === DEFAULT_EFFORT[kind]) ? DEFAULT_EFFORT[kind] : support[0].id))`.
- `effortFallbackForModelChange` and `applyClaudeLocalSetting`'s validation (:1806-1819, :1957): thread `getDiscoveredEfforts(kind, model, task.agent)` (no behaviour change for claude-code today; keeps one contract).
- PATCH guard (`server.ts:3532-3546`): compute via `supportedEfforts(kind, model, getDiscoveredEfforts(kind, model, harnessId))`; semantics unchanged (null-clear only).
- Acceptance: typecheck green; TEST-5 pins createTask + guard.

**IMPL-6 — webview consumers.** Owns `src/mainview/components/kanban/RunPanel.tsx`, `NewTaskForm.tsx`, `TaskLaunchPickers.tsx`, `src/mainview/lib/api.ts`.
- `api.ts` `AgentModelMap`/`HarnessModelMap` rows gain `efforts?: string[]`.
- `RunPanel.tsx:5280-5301`: `supportedEfforts(kind, task.model, discoveredEffortsFor(harnessModels[task.agent] ?? agentModels[kind], task.model))`; `onAgentChange` (:5311-5327) same for the next harness/model; the Effort `<CompactSelect>` keeps reading the memoized result. Cascade semantics unchanged.
- `NewTaskForm.tsx:270-277` and `:344`: pass `discoveredEffortsFor(discoveredForAgent, model)` (the pref-seed site uses the same list for that agent).
- `TaskLaunchPickers.tsx:125-131` and `:161`: pass `discoveredEffortsFor(<the hook's discovered list for nextKind/kind>, model)`.
- Acceptance: typecheck green; no visual change when discovery is empty.

**IMPL-7 — CLI consumers.** Owns `src/cli/commands/add.ts` and `src/cli/api-client.ts`.
- `api-client.ts` model rows gain `efforts?: string[]`.
- `add.ts:306-312`: `supportedEfforts(kind, model ?? null, discoveredEffortsFor(discovered, model))` using the `discovered` list already built at :289.
- Acceptance: typecheck green; TEST-4 pins the helper the CLI relies on.

## 5. Work breakdown — test tasks (Wave 3; disjoint files)

**TEST-1** — owns `src/bun/effort-support.test.ts`, `src/bun/agents.test.ts`. Default `gpt-6-astra` / effort `high`; Astra & Aeon = `ultra…low`; Sol/Terra/Cyber = `ultra…low,none`; Luna = `max…none`; `gpt-5.5` = `xhigh…low,none`; picker order `slice(0,6)`; unknown-id fallback = Astra's set; `EFFORT_OPTIONS[0].id === "ultra"`, never offered for `opus-5` / `cursor-grok-4.6`; **`supportedEfforts` third arg**: discovered wins (e.g. `["low","high"]` → `[high, low]` in canonical order), unknown-only ids fall back to curated, `null`/`[]` = today's behaviour; `codexDefaults` → astra; passthrough tests for astra, aeon, and `-c model_reasoning_effort=ultra`.

**TEST-2** — owns `src/bun/agent-discovery.test.ts`. `parseCodexModelList` (ids, labels, efforts, hidden, dedupe, malformed → `[]`); `discoverCodex` with planted stubs: (a) protocol-speaking stub printing the `initialize` + `model/list` responses then `cat > /dev/null` → `[{id,label,efforts}]`; (b) `/bin/echo` → `[]` promptly; (c) JSON-RPC error → `[]`; (d) two-page `nextCursor` → merged; `getDiscoveredEfforts` harness-first lookup. Update `:422-434` to the protocol stub.

**TEST-3** — owns `src/bun/model-discovery.test.ts` (and `model-discovery-endpoint.test.ts` only if its codex fixtures break). Convert the `:310-335` codex stubs to the protocol shape; add: an efforts-only catalog change publishes `agent_models_changed`.

**TEST-4** — owns `src/shared/model-options.test.ts`. Rule 8 (efforts attached for curated∩discovered and discovered-only; absent on discovery-empty; discarded under `loggedIn === false`); `discoveredEffortsFor` (hit, miss, `null` id, undefined list).

**TEST-5** — owns a new `src/bun/orchestrator-discovered-efforts.test.ts`. With a planted app-server stub + `refreshKindModels("codex")`: `createTask` on a discovered-only id defaults effort to `high` when reported, else the first reported; the PATCH null-clear guard honours the discovered set; with discovery empty, curated behaviour holds. Mirror the harness pattern of `orchestrator-codex.test.ts` / `model-discovery-endpoint.test.ts`.

**E2E: not applicable.** No new user flow — the pickers are data-driven and their inputs are pinned by the unit layers above; the Playwright suite has no codex-picker spec and its fixtures never start a codex run (`e2e/fixtures.ts:319-323`). Recorded as a decision.

## 6. Execution waves

- **Wave 1 (sonnet, parallel):** IMPL-1 ∥ IMPL-2 ∥ IMPL-3 ∥ IMPL-4. Checkpoint: typecheck, commit.
- **Wave 2 (sonnet, parallel):** IMPL-5 ∥ IMPL-6 ∥ IMPL-7. Checkpoint: typecheck, commit.
- **Phase 5 review (opus)** on `git diff 3a771b3...HEAD` (plus uncommitted).
- **Wave 3 (sonnet, parallel):** TEST-1 ∥ TEST-2 ∥ TEST-3 ∥ TEST-4 ∥ TEST-5. Checkpoint: commit.
- **Phase 7 (haiku, background):** `export PATH="$HOME/.bun/bin:$PATH"; bun run typecheck && bun test` (full suite; `node_modules` installed).
- **Phase 8:** fix agents per failure cluster; re-run; ≤ 3 rounds.

## 7. Blast radius & risks

- **Default flip:** new codex tasks on ChatGPT-plan accounts 400 until OpenAI's rollout reaches them. Accepted by the owner; hint explains; Sol one click away; existing tasks and `lastModel:codex` prefs untouched; no migration (precedent 8542ad5).
- **Discovered-wins precedence:** on an account whose catalog omits `none` (every account today) the picker stops offering `none` for Sol/Terra/Luna even though the API accepts it — the picker now mirrors Codex's own menu. A user who wants `none` can still set it via `agetor edit --effort none` (raw passthrough; the guard only blocks clearing). Documented in CLAUDE.md.
- **`ultra` cost:** several times Max's usage per turn; never a default.
- **Discovery:** bounded 5 s, off the boot path; stubs/missing binary yield `[]` promptly; `hidden` filtering is defensive; pagination bounded. Efforts-only changes now publish (snapshot key).
- **Unknown-id curated fallback** for codex now yields Astra's set (no `none`); with discovery working this fallback only matters when the CLI is absent.
- **Aeon:** unverified id; honest hint; trivially removable.

## 8. Open questions / assumptions

- **A1** `gpt-6-astra-aeon` exists as a Codex id and shares Astra's effort set (tweet-sourced; owner chose to add it).
- **A2** Astra supports `ultra` via `codex exec` (Codex models page; not live-verifiable on this account until rollout).
- **A3** Cyber supports `ultra` (mirrors Sol; not in this account's catalog).
- **A4** `initialize` needs only `clientInfo` — verified on 0.147.0/0.153.0; older CLIs fall to `[]`.
- Grill answers (2026-09-03): default → flip now; efforts → add `ultra`; sweep → CLAUDE.md fix, Aeon row, discovery fix. Plan-gate answer: also sweep in the ledgered out-of-scope items (discovery-driven efforts; `none` verification).

## 9. Completeness ledger

| Candidate remainder | Disposition |
| --- | --- |
| Astra row, default flip, hint re-labels | **in** — IMPL-1 |
| Aeon row | **in** — IMPL-1 (A1) |
| `ultra` shared effort id; propagated to Sol/Terra/Cyber (not Luna) | **in** — IMPL-1 |
| `none` on the GPT-5.6 family | **verified keep** (live-accepted on Sol and Luna) — no change; `gpt-5.5` gains `none` (API error text) — IMPL-1 |
| Dead `codex prompt --models` → app-server `model/list` (+ efforts) | **in** — IMPL-2 |
| Discovered efforts drive `supportedEfforts` everywhere (pickers, CLI, createTask, PATCH guard, cascades) | **in** — IMPL-1/3/5/6/7 |
| Effort-only catalog changes publish `agent_models_changed` | **in** — IMPL-2 |
| Client/CLI types carry `efforts` | **in** — IMPL-6/7 |
| README / CLAUDE.md | **in** — IMPL-4 |
| Tests for all of the above | **in** — TEST-1…5 |
| PATCH rejecting non-null effort ids outside the set | **out of scope** — would block values the API accepts (ultra on Luna, `none` everywhere); the catalog is an offering, not the enforcement truth |
| `modelDeclinesEffort` consulting discovered efforts | **out of scope** — codex never reports an empty set; the null-effort allowance stays a curated fact |
| Make codex a `CATALOG_SCOPED_KINDS` member | **out of scope** — would hide Astra on accounts the rollout hasn't reached, contradicting the default flip |
| GPT-6 rows for Cursor / fx | **out of scope** — neither catalog carries a GPT-6 id yet (2026-09-03) |
| Migration / backfill; "update your Codex CLI" hint | **out of scope** — nothing to backfill; both CLI versions forward the id |
| Per-harness codex discovery (a second codex account must not inherit the built-in's catalog/efforts) — review finding | **in** — Phase 8 (`HarnessTarget{kind}`, `refreshHarnessTarget`, kind-aware targets/caches) |
| `discoverCodex` reader cancel / timeout → `[]` / newline flush — review findings | **in** — Phase 8 |
| Pickers/CLI read efforts from merged rows (rule 7 applies); `AgentOption.efforts` removed; cursor guard order; RunPanel unlisted row order + hint; NewTaskForm seed no-op — review findings | **in** — Phase 8 |
| Owner-deferred | none |
