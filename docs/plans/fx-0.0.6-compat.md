# Plan — fx 0.0.5/0.0.6 compatibility + adoption pass

| Field | Value |
| --- | --- |
| Date | 2026-08-25 |
| Source | /implement "they released 0.0.5 and 0.0.6…" + owner grill |
| Config | AGENTS_CONFIG.yml (balanced) |
| Flags | none |
| Gates | grilled by owner (default model / adopt / dormant maps / provider badge answered); plan approval pending |
| Branch | feature/vercel-fx-sh-as-a-new-harness (PR #190) |
| Base SHA | ef601a5 (merge of origin/main; tree clean) |

## 1. Objective & success criteria

Bring the fx harness up to date with fx **0.0.6** (spike-verified against real 0.0.4 vs 0.0.6 binaries; release notes + Zig source diffed at both tags): fix the two things the releases made false in our code/docs, surface the two things they made possible (unauthenticated `fx models --json` / `fx status --json`), follow fx's new default model, and tell the truth about which ACP update kinds fx actually emits. Owner decisions: default → `moonshotai/kimi-k3`; adopt model discovery **and** pre-flight auth check; keep the dormant thinking/plan/usage mappings and document them as dormant; add a provider badge + onboarding copy. *(superseded — see fx-model-catalog-refresh.md: default is now `zai/glm-5.3-flash` (owner pick); the Gateway catalog turned out to be account-scoped, so the curated list was rebuilt and `moonshotai/kimi-k3` became a `catalogOnly` premium row.)*

Done = typecheck clean, full `bun test` green (modulo known env flakes), e2e green, docs truthful, every existing stub binary/e2e fixture still works unchanged (probes fail open).

## 2. Context & constraints (grounded)

**Verified unchanged 0.0.4 → 0.0.6 (nothing breaks):** `fx --help` banner "Fast, native coding agent for the terminal" (probe marker safe); `fx acp [--model] [--log-file]` byte-identical; ACP method set identical (`session/set_mode`/`set_config_option` already existed); `protocolVersion` numeric 1; unauth `initialize` → `-32600` "Fx needs access to Vercel AI Gateway…" byte-identical, then "Not initialized" latch; string protocolVersion → `-32602`; modes `ask`/`code`; permission option kinds `allow_once`/`allow_always`("Allow for this session")/`reject_once` (no `reject_always` in either version — our policy already tolerates it); `FX_PERMISSION_MODE` present; still **no `FX_HOME`** (HOME override stays correct); install/upgrade/exit codes unchanged; `--prompt-permissions` still in `fx ask --help`.

**Changed and relevant:**
- **0.0.5 retired the sandbox** — approved commands run as ordinary host subprocesses; `sandbox_denied` removed from `command_result`; permission mode is the only gate. Our `AGENT_OPTIONS.fx.modes` hints ("fx sandbox + LLM auto-review", "no sandbox — full access"), CLAUDE.md, and plan docs still describe a sandbox. We never parse `sandbox_denied`.
- **0.0.6 default model** → `moonshotai/kimi-k3` (+Fast mode) — `fx status --json` confirms `"model":"moonshotai/kimi-k3"`. Our `DEFAULT_MODEL.fx = zai/glm-5.2-fast` hinted "fx's own default" is false. *(superseded — see fx-model-catalog-refresh.md: default moved again, to `zai/glm-5.3-flash` — the Gateway catalog is account-scoped (230 ids unauthenticated, 158 on a standard `fx login` account) and `kimi-k3` isn't in every account's catalog, so agetor now pins the model fx actually runs on the reference account; `kimi-k3` became a `catalogOnly` premium row.)*
- **Credential checks moved mid-session (0.0.5)** — `session/prompt` and `session/resume` re-validate credentials and can return `-32600` with the same/new provider-specific messages ("fx needs a Codex subscription login… Run fx login codex."). Our driver surfaces prompt errors wrapped ("session/prompt failed: …") and, on a resume auth error, uselessly falls back to `session/load` (which fails identically).
- **Multi-provider auth (0.0.5)** — `fx login [vercel|codex|grok]`, `fx provider …`; `session/new`/`session/load` responses now carry `configOptions[{id:"provider", currentValue:"gateway"|"codex"|"grok", …}]` (additive; we ignore it today). Gateway catalog: 228 ids via `fx models --json` → `{kind, count, shown_count, more_count, private_models_hidden, ids: string[]}` (complete: shown_count == count, no pagination flag; works **unauthenticated with zero filesystem writes**). Our curated `google/gemini-3-pro` is **not** in the catalog; `google/gemini-3.1-pro-preview` is. `moonshotai/kimi-k3`, `kimi-k3-fast`, `zai/glm-5.2-fast`, `anthropic/claude-opus-5`, `anthropic/claude-sonnet-5`, `openai/gpt-5.5` are present. *(superseded — see fx-model-catalog-refresh.md: the catalog is account-scoped, not Gateway-wide — 230 ids unauthenticated vs 158 on a standard `fx login` team account (measured 2026-08-27 on 0.0.6), missing every premium tier; the curated list was rebuilt from the 158 and these premium ids became `catalogOnly` rows or were dropped.)*
- **`fx status --json`** (unauth, no FS writes): `{kind:"status", model, auth:"missing"|…, auth_refreshable, auth_help:"Fx needs access to Vercel AI Gateway. Run fx login…", permission_mode, workspace, …}` — the authenticated value of `auth` is unverified (no credentials), so the only safe rule is: **`auth === "missing"` ⇒ logged out; anything else or a failed/non-JSON probe ⇒ unknown ⇒ proceed**.
- **fx emits exactly six `session/update` kinds** (`agent_message_chunk`, `user_message_chunk`, `tool_call`, `tool_call_update`, `available_commands_update`, `session_info_update` with `_meta.fx.modelResponseRecovery`) in both versions — never `agent_thought_chunk`, `plan`, or `usage_update`. Our mappings for those three are ACP-spec-correct, tested, and **dormant**; CLAUDE.md/README/plan docs claim they light up the TODO tracker and usage chip for fx.
- **Seams:** `agent-discovery.ts` — `runProbe(cmd)` (3s timeout), `discoverGemini()` stub returns `[]`, `refreshDiscoveredModels` sets the cache per kind; `DiscoveredModel = {id, label?}`; `getDiscoveredModels("fx")` already wired into `/agent-models`. `agent-status.ts` — `checkHarness` runs `probeVersion` then fx's `probeHelp` marker check; `HarnessStatus` (`shared/types.ts:187`) has `available/path/version/reason/installHint`. `orchestrator.startTask` pre-flight: `if (!status.available) return {error: "<label> is not available — <reason>. Install it with: <hint>"}`. `OnboardingChecklist` `LOGIN_COMMAND.fx = "fx login"`. `fx-acp.ts` parses `session/new` result `{sessionId, modes}` only; status sentinels + `isInternalStatusSentinel` in `shared/types.ts`; RunPanel derives the usage chip from `FX_USAGE_STATUS_PREFIX` events per run (`usageByRunId`, gated on fx). Test stubs (`orchestrator-fx.test.ts`, `agent-status.test.ts` `plantFakeFxBin`, `e2e/fixtures.ts` `writeFxStubBin`) answer `--version`/`--help` and exit 0 for anything else — a `status --json`/`models --json` call against them yields empty output ⇒ must parse as "unknown", not "logged out"/error.

## 3. Approach & key decisions

1. **Default model** `moonshotai/kimi-k3` (owner); picker: `moonshotai/kimi-k3` first ("fx's compiled default since 0.0.6 — Fast mode"), `moonshotai/kimi-k3-fast`, `zai/glm-5.2-fast` (re-hinted as the cheap/fast tier), `anthropic/claude-opus-5`, `anthropic/claude-sonnet-5`, `openai/gpt-5.5`, `google/gemini-3.1-pro-preview` (replaces the nonexistent `gemini-3-pro`); `MODEL_EFFORT_SUPPORT.fx` keys follow. The exemption comment now cites "fx's compiled default" truthfully. *(superseded — see fx-model-catalog-refresh.md: default is now `zai/glm-5.3-flash`; the catalog turned out account-scoped (230 unauth / 158 standard-account ids), so this curated list was rebuilt from the 158 and `moonshotai/kimi-k3`/`kimi-k3-fast` became a `catalogOnly` premium row that only renders when the account's discovered catalog contains it.)*
2. **Model discovery**: `discoverFx()` runs `[resolveBin(fx), "models", "--json"]` via `runProbe` with fx's harness env (HOME override respected), parses `ids: string[]` → `{id}` (no labels — the picker falls back to the id), returns `[]` on failure/non-JSON. Wired into `refreshDiscoveredModels` + cache like the four siblings. Discovery is unauthenticated by design (spike-verified) — no login needed.
3. **Pre-flight auth**: `HarnessStatus` gains additive `loggedIn: boolean | null` + `authHelp: string | null` (null = not probed/unknown; all non-fx kinds report null). fx's `checkHarness`, after the marker probe, runs `status --json` (2s timeout): `auth === "missing"` ⇒ `loggedIn:false, authHelp` (verbatim fx text); any other value ⇒ `loggedIn:true`; failure/non-JSON ⇒ null. `available` stays true (the binary IS installed). `startTask` pre-flight adds: `if (status.loggedIn === false) return {error: "<label> isn't logged in — <authHelp>"}` — a distinct message from "not available". Fail-open guarantees every existing stub/fixture keeps working.
4. **Mid-session auth errors**: `sendRpc` rejections become `RpcError extends Error { code }`; in `runFxTurn`: a `session/resume` failure with code `-32600` → `failTurn` with the message **verbatim** (no `session/load` fallback — same credential gate would fail again); `session/prompt` failure with code `-32600` → verbatim message (other codes keep the "session/prompt failed: …" wrapper). Matches the `initialize` treatment and covers the new Codex/Grok variants automatically.
5. **Provider badge** (owner): parse `configOptions` from the `session/new` **and** resume/load responses; when an entry has `id:"provider"` and a string `currentValue`, emit one `status` chunk `FX_PROVIDER_STATUS_PREFIX + value` per turn (new sentinel `"fx-provider: "`, added to `isInternalStatusSentinel`); RunPanel derives the latest per run (same memo shape as usage, fx-gated) and renders a small muted chip (`gateway`/`codex`/`grok`) beside the usage chip. Onboarding copy: `fx login` (or `fx login codex` / `fx login grok` for subscription providers).
6. **Sandbox truth**: mode hints → `auto`: "fx's LLM auto-review resolves most tool calls; anything unresolved surfaces as an approval card"; `yolo`: "Disables fx permission checks — full access"; `ask`: unchanged. CLAUDE.md/plan docs: fx has no sandbox since 0.0.5 — permission mode is the only gate (this also strengthens the earlier "auto vs yolo" reasoning: the difference is review vs none, not sandbox vs none).
7. **Dormant mappings** (owner): keep code + tests; docs state plainly that fx 0.0.4–0.0.6 emits only the six kinds above, so thinking/plan/usage are forward-compatible and currently dormant; the fake fx scenario keeps exercising them for the UI.
8. **Fake driver**: the fx fake scenarios emit a `fx-provider: gateway` status so the badge is e2e-visible.

## 4. Work breakdown — implementation

**Wave 1** (disjoint):
- **T1** — owns `src/shared/types.ts`: §3.1 model catalog + default + effort-support keys; §3.6 mode hints; `HarnessStatus.loggedIn/authHelp` (+doc); `FX_PROVIDER_STATUS_PREFIX` + `isInternalStatusSentinel`; fx-related doc comments citing 0.0.4 → "verified through 0.0.6".
- **T2** — owns `src/bun/agent-status.ts`: fx `status --json` probe (fail-open) populating `loggedIn/authHelp`; other kinds null.
- **T3** — owns `src/bun/agent-discovery.ts` + `src/bun/agents.ts`: `discoverFx()` + wiring; fake fx scenarios emit the provider sentinel.
- **T4** — owns `src/bun/fx-acp.ts`: `RpcError{code}`; §3.4 auth handling on resume/prompt; §3.5 provider extraction from new/resume/load responses → sentinel chunk (dedup per turn); header protocol index rows updated ("verified against fx v0.0.4 and v0.0.6"; six emitted kinds; thinking/plan/usage dormant).

**Wave 2** (disjoint; after W1 commit):
- **T5** — owns `src/bun/orchestrator.ts`: logged-out pre-flight error in `startTask`.
- **T6** — owns `src/mainview/**`: provider chip (derive + render, fx-gated, uses the shared sentinel predicate for suppression which T1 already extended); Settings harness row + Onboarding: "installed but not logged in" state from `loggedIn === false` with `authHelp` + login command; onboarding copy for `fx login codex|grok`.
- **T7** — owns `src/cli/**` non-test: if any CLI surface renders `HarnessStatus` (e.g. a status/doctor command), add the logged-out line; otherwise report no-op. Sentinel suppression is automatic via the shared predicate.
- **T8** — owns `CLAUDE.md`, `README.md`, `docs/plans/fx-harness.md`, `docs/plans/fx-acp-interactions.md`, `docs/plans/fx-branch-finalization.md`: sandbox retirement; default model; discovery + auth pre-flight; provider badge; dormant-mapping truth (with the six emitted kinds); version note "verified through 0.0.6".

**Wave 3** (tests; disjoint):
- **T9** — owns `src/bun/fx-acp.test.ts` + `src/bun/fx-acp-mapper.test.ts`: provider sentinel from `session/new` configOptions (+ from resume response); resume `-32600` → verbatim message, no `session/load` attempted (assert via capture); prompt `-32600` → verbatim; non-auth prompt error keeps the wrapper.
- **T10** — owns `src/bun/agent-status.test.ts`, new `src/bun/agent-discovery.test.ts` (or extend if one exists), `src/bun/orchestrator-fx.test.ts`, `src/shared/types.test.ts`: status probe (`auth:"missing"` → loggedIn false + authHelp; other → true; empty/non-JSON/exit≠0 → null; non-fx kinds null); `discoverFx` parse/failure; `startTask` blocked with the auth message when the stub answers `status --json` with `auth:"missing"`, and proceeds when the stub answers nothing (fail-open); sentinel predicate covers the provider prefix; catalog invariant: `DEFAULT_MODEL.fx` is in `AGENT_OPTIONS.fx.models`.
- **T11** — owns `e2e/**`: fx spec asserts the provider chip ("gateway") on the run row; fixture stub unchanged (fail-open) — or answer `status --json` with `auth:"ok"` to exercise the logged-in path, your call, documented.

## 5. Test work breakdown

Per T9–T11. E2e applies (badge is user-visible) via the existing fx spec. Run recipe: `bunx tsc --noEmit`; `bun test`; `bunx playwright test` (check `:5173` isn't owned by another worktree first).

## 6. Execution waves

W1 {T1..T4} → commit → W2 {T5..T8} → commit → opus review → fixes → W3 {T9..T11} → commit → full run → report.

## 7. Blast radius & risks

- `HarnessStatus` shape change is additive (two nullable fields) — every existing consumer keeps compiling; only fx populates them.
- Pre-flight blocks strictly on `auth === "missing"` — a future fx that renames the value fails open, never closed.
- Discovery adds one 3s-bounded probe at boot for fx only when the binary exists (same as siblings).
- `RpcError` changes error objects' class, not their messages — existing message-based tests unaffected; `isTimeoutError` untouched.
- Provider parsing tolerates absent `configOptions` (0.0.4 binaries, stubs).

## 8. Open questions / assumptions

- A1 — **RESOLVED (post-review, empirical)**: `fx status --json` (v0.0.6, `HOME` pointed at an empty dir, zero files written) reports `auth:"missing"` + `auth_help` with no credentials, `auth:"AI_GATEWAY_API_KEY"` when that env var is set, and `auth:"VERCEL_OIDC_TOKEN"` for that one — env-var auth IS reflected, and the probe runs with the same `harnessEnv(harness)` the spawn uses, so a key-authenticated user is never gated out. The rule stays "missing ⇒ logged out, else proceed"; the subscription-login (`fx login codex|grok`) value is still unobserved but can only be a non-`missing` string (fail-open).
- A2: `session/resume`'s response carrying `configOptions` is source-inferred for `session/load`; resume may omit it — handled by tolerance (badge only when present).
- Live authenticated smoke turn still pending (unchanged).

## 9. Completeness ledger

n/a.

## 10. Review outcome (opus, `ef601a5..c701841`) and dispositions

0 critical · 1 high · 3 medium · 6 low. Fixed in the post-review wave unless noted.

- **high — auth gate could refuse an `AI_GATEWAY_API_KEY` user** → not a defect: settled empirically (A1 above); gate kept, observed values recorded in `probeStatus`'s doc comment and above the `startTask` gate.
- **medium — resume `-32600` skipped the `session/load` fallback for *every* Invalid-Request error** → fixed: resume `-32600` now falls through to `session/load` like `-32601`/`-32602`; a `-32600` from `session/load` (the same credential gate) surfaces fx's message verbatim; any other load error keeps the `failed to resume session` wrapper. Text-independent — no message-shape sniffing.
- **medium — `discoverFx` could reject (live DB read outside try) and `Promise.all` would strand every kind's cache + surface an unhandled rejection at boot; module gained DB/signal-handler side effects** → fixed: fx resolved like codex/cursor (`AGETOR_FX_BIN` → `Bun.which`), `./db.ts`/`./agents.ts` imports dropped, body try/catch → `[]`, `refreshDiscoveredModels` uses `Promise.allSettled`.
- **medium — `status --json` probe uncached and serial on Start + the 15s `/harnesses` poll** → fixed: `probeHelp` ‖ `probeStatus` concurrently (fx budget stays 4s worst-case), 60s TTL cache per `harness.id:path`; `startTask` passes `freshAuth: true` so a just-logged-in user is never refused by a stale `false`.
- **low — `parseFxModels` didn't dedupe** → fixed (sibling `seen` Set).
- **low — verbatim `-32600` on prompt drops call attribution** → accepted: a bare non-auth `-32600` on `session/prompt` means our own params were malformed (driver bug caught by tests), and message-shape sniffing is more fragile than the attribution loss. `RpcError.rawMessage` now carries fx's untouched text so "verbatim" is byte-exact (no ` (code -32600)` suffix) on both verbatim paths.
- **low — `agent-discovery.ts` import side effects** → fixed with the discovery item.
- **low — logged-out state missing from `ResolveConflictsDialog`, RunPanel's harness switcher, and the header dot** → fixed: shared `HarnessAuthHint` (also replaces NewTaskForm's inline block), tri-state dots (`danger`/`warning`/`success`), ` (not logged in)` option suffix.
- **low — `ProviderChip` rendered an unbounded external string** → fixed: `extractFxProviderValue` rejects values > 64 chars; chip truncates.
- **low — `isInternalStatusSentinel` JSDoc listed two sentinels** → fixed.
