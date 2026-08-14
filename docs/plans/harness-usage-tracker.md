# Plan — Per-Harness/Account Usage Tracker in the Topbar

| Field | Value |
| --- | --- |
| Date | 2026-08-12 |
| Source | `/implement` — "usage tracker per harness/account in the Agetor topbar" (CodexBar-inspired) |
| Config | AGENTS_CONFIG.yml (balanced preset) |
| Branch | feature/add-the-usage-tracking-per-harness-to-th (already checked out) |
| Base SHA | 2a4f1a1f3eb8a88aae8bd9581592a5c109d87a85 |

## 1. Objective & success criteria

Show a live usage/quota meter for each **enabled harness** (= each account row, since multi-account
= multiple `Harness` rows with distinct `home` dirs) in the topbar chip strip. Each chip gains a
compact mini-bar of its **worst** meter, colored by a warn band; clicking the chip opens a popover
listing every meter the provider reports (percent, bar, reset time), a "last updated" line, and a
manual Refresh button. Data refreshes periodically and on demand.

**Done when:**
- Claude harnesses (the main account plus any additional aliased accounts) show session/weekly/opus/sonnet/routines/extra-credit meters, live from the OAuth usage endpoint, falling back to the on-disk `.claude.json` cache when the API is unavailable.
- Codex shows session/weekly/credits meters, live from the ChatGPT backend, falling back to the newest sessions JSONL `rate_limits`.
- Cursor shows plan/on-demand usage via the imported browser/IDE web session (best-effort; degrades cleanly to "no data" when no cookie is obtainable).
- Uncovered/disabled harnesses (gemini, grok) render just the existing availability dot — no error, no meter.
- Warn coloring: **≥70% used = amber, ≥90% used = red**, neutral below.
- Meters refresh on a background cadence and via the popover Refresh button; the UI updates without a full reload (SSE push preferred, poll acceptable).
- `bun run typecheck` green; new pure-logic modules have co-located `bun test` coverage; an e2e spec asserts the topbar renders meters against a seeded fake backend.

**Non-goals (v1):** historical usage charts/graphs; cost-in-dollars accounting beyond what a provider directly reports; gemini/grok live data; a `guard`-style CLI gate; burn-rate/pace projection (leave a seam, don't build it).

## 2. Context & constraints (grounded findings, Phase 1)

**Mount point.** Topbar is inlined in `AppInner()` — the per-harness chip strip is `src/mainview/App.tsx:756-777`
(icon + label + `bg-success-solid`/`bg-danger-solid` availability dot, driven by `agents: AgentStatus[]`
joined to `harnesses: Harness[]`, refreshed every 15s). Interactive elements inside the drag-region
`<header>` must carry class `electrobun-webkit-app-region-no-drag` or clicks are swallowed
(App.tsx:756, 779; double-click-zoom guard at App.tsx:746-747).

**No usage telemetry exists server-side today.** Repo-wide grep for token/cost/quota fields = zero hits
in `src/bun`/`src/shared` outside GitHub API rate-limit code. The existing `HarnessUsage` type
(`src/shared/types.ts:131-141`), `harnesses.usage()` (`src/bun/db.ts:735-751`), and route
`GET /harnesses/:id/usage` (`src/bun/server.ts:2963`) are **task-count blast-radius** for the
disable-confirmation dialog — unrelated. **Naming collision: the new feature must NOT reuse
`HarnessUsage` or `/harnesses/:id/usage`.** New type = `HarnessQuota`; new route = `GET /usage`.

**Harness/account model.** `AgentKind = "claude-code" | "codex" | "cursor" | "gemini"`
(`src/shared/types.ts:69`; `grok` is in the DB CHECK constraint as a placeholder but is NOT a real
kind yet — ignore it). `home` semantics (`src/shared/types.ts:87-106`, `harnessEnv` at
`src/bun/agents.ts:207-246`): claude-code → `CLAUDE_CONFIG_DIR=home` (HOME untouched — keychain
reasons); codex → `HOME=home` + `CODEX_HOME=home/.codex`; cursor → `HOME=home`; gemini →
`GEMINI_CLI_HOME=home`. `home=null` ⇒ inherit the agetor process env (the built-in main accounts).

**Credential/config resolution per kind** (measured on this machine, Phase 1 local probe + Phase 5 research):
- **claude-code**, `home` set (additional aliased accounts): config `<home>/.claude.json` (has
  `cachedUsageUtilization` when the CLI has fetched it — one probed alias's was absent/idle), creds file
  `<home>/.credentials.json`. `home=null` (main): config `~/.claude.json`, creds in **macOS Keychain**
  service `"Claude Code-credentials"` (`security find-generic-password -s "Claude Code-credentials" -w`,
  one-time per-app access grant). Resolution must mirror `jsonlPathFor`'s fresh/legacy fallback
  (`src/bun/claude-tmux.ts:2076-2087`): try new-layout path, then legacy `<home>/.claude/…`.
  - OAuth endpoint: `GET https://api.anthropic.com/api/oauth/usage`, `Authorization: Bearer <accessToken>`,
    `anthropic-beta: oauth-2025-04-20`, `User-Agent: claude-code/<version>`. Token from
    `{claudeAiOauth:{accessToken,…,scopes}}`; **requires the `user:profile` scope** or the endpoint 401s.
    Response: `{five_hour, seven_day, seven_day_opus, seven_day_sonnet, seven_day_routines, extra_usage, limits[]}`
    — `utilization` is 0..1; prefer `limits[]` (model-scoped) when present.
  - Local fallback shape: `.claude.json` → `cachedUsageUtilization.utilization.{five_hour, seven_day, …, limits[]}`
    (already normalized to the same field names — carries `fetchedAtMs` so we can label staleness).
- **codex** (`~/.codex`, or `<CODEX_HOME>` = `<home>/.codex` for an alias): creds `auth.json`
  (`{tokens:{access_token,account_id,…}}`, plain file, mode 600, no keychain). OAuth endpoint:
  `GET https://chatgpt.com/backend-api/wham/usage`, `Authorization: Bearer <access_token>`,
  optional `ChatGPT-Account-Id: <account_id>`. Response: `{plan_type, rate_limit:{primary_window,
  secondary_window,individual_limit}, credits, additional_rate_limits[]}`; window role inferred from
  `limit_window_seconds` (300min→session, 10080min→weekly). Local fallback: newest
  `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl`, `event_msg` events with `payload.type=="token_count"`,
  read `rate_limits.{primary,secondary,credits}` (used_percent, window_minutes, resets_at) — **but this
  is `null` in exec-mode sessions per openai/codex#14728, so it may be missing; treat absent as "no data".**
- **cursor** (`~/.cursor`, or `<home>` for an alias): **no local usage/quota data at all** (probe
  confirmed — `cli-config.json` and the `ai-tracking` SQLite DB carry no quota). Only known path is
  CodexBar's: obtain the Cursor **web** session cookie (`WorkosCursorSessionToken`) from a browser
  cookie store or the Cursor IDE `state.vscdb`, then `GET https://cursor.com/api/usage-summary` +
  `GET https://cursor.com/api/auth/me`. This is invasive and OS-permission-gated (encrypted Chrome
  cookies, Full-Disk-Access-gated Safari `Cookies.binarycookies`) — **best-effort, degrades to
  "no data" whenever a cookie can't be read.**

**Endpoints are undocumented, reverse-engineered.** Both Anthropic `oauth/usage` and OpenAI `wham/usage`
are internal endpoints (CodexBar's source is the reference). They can change without notice — the local-file
fallback is the safety net, and every fetch must fail soft (never throw into the poller/UI).

**Bun main can fetch arbitrary hosts** (the CSP that restricts artifacts does not apply here). Fetches
run in the Bun process, not the webview.

**Poller precedent.** The idle-session reaper is the shape to copy: `reapIdleSessions()`
(`src/bun/orchestrator.ts:2853+`, in-flight guard, `await Bun.sleep(0)` yields, per-row DB re-check),
constants in `src/shared/types.ts:766,769`, wired in `src/bun/index.ts:138-147` (post-boot `setTimeout`
+ `setInterval`) and mirrored in `src/bun/headless.ts:74-93` **with `.unref()`** so it can't block the
5-min idle shutdown. Availability probing already fans out over all harnesses concurrently
(`checkAllHarnesses()`, `src/bun/agent-status.ts:128-130`).

**SSE push.** `GET /app/events` (`src/bun/server.ts:4532-4574`) streams `AppEvent`s
(`src/shared/types.ts:2476-2487`); `broadcastAppEvent(e)` (`src/bun/quit-guard.ts:30-32`) pushes to every
webview. Webview subscribes via `api.subscribeAppEvents` (`App.tsx:364`). We add a `harness_usage`
`AppEvent` variant.

**Storage.** Never alter the `harnesses` table shape — the table-rebuild recipe caused two prod incidents
(migrations 024/032/037/038 self-heal). A **new, separate `harness_usage` table** (keyed on `harness_id`,
no FK — the schema uses app-layer resolution) sidesteps that entirely and persists the last snapshot
across restarts. Latest migration = `041`; ours is `042_harness_usage.sql`, appended to the array in
`src/bun/migrations/index.ts`.

**UI primitives.** Semantic tokens `--success/--warning/--info/--danger` (+ `-foreground`) live in both
`src/mainview/index.css` and `tailwind.config.*` — **a new token must land in both files or Tailwind emits
nothing (transparent element)**. No `Progress`/`Tooltip`/`Popover`/`DropdownMenu` primitives exist; the
mini-bar is a hand-rolled div, and the popover follows the click-toggle + outside-click + Escape pattern of
`src/mainview/components/ui/info-tip.tsx`. Warn amber uses `--warning`, red uses `--danger`.

**Tests.** No React render tests — pure logic goes in `src/mainview/lib/*.ts` with a co-located `.test.ts`
(precedents: `lib/todo-progress.ts`, `lib/font-size.ts`). Bun-side: set `AGETOR_DATA_DIR` to a `mkdtemp`
before importing `db.ts`; provider parsers are pure functions over fixture JSON. E2E: Playwright in `e2e/`,
worker-scoped `E2EBackend` fixture (`e2e/fixtures.ts`), helpers `gotoApp`/`putPreference` (`e2e/helpers.ts`),
run via `bunx playwright test` (no `test:e2e` npm script). Dev run: `bun run dev:hmr`.

## 3. Approach & key decisions

- **Provider seam.** One module per kind under `src/bun/usage/` exposing a uniform
  `fetchQuota(harness): Promise<HarnessQuota>` that internally does API-first → file-fallback and
  **always resolves** (errors become a `HarnessQuota` with `status:"error"|"unavailable"` + reason, never a
  throw). Adding gemini/grok later = one new module + one registry line. (Evidence-based: each provider's
  data source was ground-truthed in Phase 1.)
- **Normalized `HarnessQuota` shape** in `src/shared/types.ts`: `{ harnessId, kind, planType?, status,
  fetchedAtMs, source: "api"|"cache"|"scrape", meters: QuotaMeter[], reason? }` where
  `QuotaMeter = { id, label, usedPercent, resetsAtMs?, scope? }`. Meters are **dynamic** — render whatever
  the provider returns (Claude may return 6, codex 3, cursor 2). This directly serves the user's open-ended
  "session, weekly, routines, credits, …" list without hardcoding a fixed set.
- **Warn band = pure function** `warnTier(usedPercent): "ok"|"warn"|"crit"` (≥90 crit, ≥70 warn) shared by
  the mini-bar color and the popover, in `src/mainview/lib/usage.ts`. Chip shows `worstMeter(meters)` (max
  usedPercent).
- **Refresh: SSE push + background poller.** Poller cadence: default 10 min, floored per provider so we
  never hammer an endpoint; force-refresh route bypasses the floor. Poll only enabled harnesses; skip a
  harness whose cached snapshot is fresh (< cadence). Broadcast each new snapshot as a `harness_usage`
  `AppEvent`. The webview also fetches `GET /usage` once on boot to seed. (Cadence within the reaper's
  2–30min idle-safe band; `.unref()` in headless.)
- **Cursor is opt-in-flavored but on by default per the user's decision**, implemented behind the same seam
  and failing soft. Because reading browser cookies is fragile/permission-gated, the cursor module tries, in
  order: Cursor IDE `state.vscdb` → browser cookie stores → give up with `status:"unavailable"`,
  `reason:"Cursor usage needs a signed-in Cursor app/browser session"`. No crash, no prompt storm.
- **Keychain read for the main Claude account** is done via `Bun.spawn(["security","find-generic-password",
  …])` (matches how agetor already shells out), cached in-process, and gated so a **denied** prompt sets a
  cooldown (no re-prompting every poll) — mirrors CodexBar's consent model.
- **Snapshot persistence.** `harness_usage` table stores the latest JSON snapshot per harness so the topbar
  shows last-known values instantly on boot (before the first poll completes) and across restarts.

## 4. Work breakdown — implementation tasks

**Wave A — foundations (shared contract + storage; other waves depend on these).**
- **A1 — Shared types & constants.** Owns `src/shared/types.ts` (append only): add `HarnessQuota`,
  `QuotaMeter`, `QuotaStatus`, `QuotaSource`; add `AppEvent` variant `{ type:"harness_usage",
  quota: HarnessQuota, ts:number }`; add constants `USAGE_POLL_SWEEP_MS`, `USAGE_MIN_REFRESH_MS`,
  `USAGE_WARN_PERCENT=70`, `USAGE_CRIT_PERCENT=90`. Acceptance: typecheck green; no existing symbol renamed.
- **A2 — Migration + db module.** Owns `src/bun/migrations/042_harness_usage.sql`,
  `src/bun/migrations/index.ts` (append one entry — never reorder), and a new `harnessUsage` submodule in
  `src/bun/db.ts` (`get(id)`, `getAll()`, `upsert(snapshot)` over a `harness_usage(harness_id PRIMARY KEY,
  snapshot_json TEXT, updated_at INTEGER)` table). Acceptance: `migrate.test.ts`-style idempotency; upsert
  round-trips a snapshot.

**Wave B — providers + poller (each file-disjoint; all depend on A).**
- **B1 — Credential/config resolver + claude provider.** Owns `src/bun/usage/creds.ts` (pure-ish helpers:
  resolve claude config dir + creds path with fresh/legacy fallback; keychain read w/ cooldown; codex
  CODEX_HOME resolution) and `src/bun/usage/claude-usage.ts` (API fetch + `.claude.json` cache fallback,
  parser split into a pure `parseClaudeUsage(json)` for testing). Acceptance: pure parser maps a fixture
  OAuth response and a fixture `cachedUsageUtilization` to identical `QuotaMeter[]`.
- **B2 — Codex provider.** Owns `src/bun/usage/codex-usage.ts` (auth.json → `wham/usage`; fallback newest
  sessions JSONL `token_count.rate_limits`; pure `parseCodexUsage`). Acceptance: pure parser maps a fixture
  `wham/usage` body and a fixture JSONL `rate_limits` to `QuotaMeter[]`; missing rate_limits ⇒ empty/`unavailable`.
- **B3 — Cursor provider.** Owns `src/bun/usage/cursor-usage.ts` (cookie discovery best-effort →
  `usage-summary`/`auth.me`; pure `parseCursorUsage`). Acceptance: pure parser maps a fixture
  `usage-summary`; no cookie ⇒ `status:"unavailable"` with reason, never throws.
- **B4 — Poller + registry.** Owns `src/bun/usage/poller.ts` (registry mapping kind→provider; `pollAllUsage()`
  fan-out over enabled harnesses with in-flight guard + `Bun.sleep(0)` yields, per-harness cadence floor,
  upsert snapshot, `broadcastAppEvent`; `refreshOne(harnessId, {force})`). Depends on B1–B3 exports but owns
  a separate file (registry imports them). Acceptance: with fake providers, `pollAllUsage` upserts + broadcasts
  once per enabled harness and no-ops fresh ones.

**Wave C — wiring (depends on A + B).**
- **C1 — Server routes + SSE.** Owns the new route block in `src/bun/server.ts`: `GET /usage` (all snapshots),
  `POST /harnesses/:id/usage/refresh` (force `refreshOne`, return fresh snapshot). Both `authed`. Acceptance:
  routes return typed JSON; refresh triggers a provider call (faked in test).
- **C2 — Boot wiring.** Owns the poller timer wiring in `src/bun/index.ts` (post-boot `setTimeout` +
  `setInterval`) and `src/bun/headless.ts` (same, `.unref()`'d). Acceptance: timers registered; headless copy
  unref'd. *(C1/C2 touch different files → same wave.)*

**Wave D — webview (depends on C for the route contract; A for types).**
- **D1 — api.ts client + pure lib.** Owns `src/mainview/lib/usage.ts` (`warnTier`, `worstMeter`,
  `formatResetsIn`, `meterBarWidth`, dynamic meter labeling) + `src/mainview/lib/usage.test.ts`, and the
  additions to `src/mainview/lib/api.ts` (`getAllUsage()`, `refreshHarnessUsage(id)`, `harness_usage` handling
  in `subscribeAppEvents`). Acceptance: lib tests pass (band boundaries at 70/90, worst-meter selection,
  reset formatting).
- **D2 — Components + topbar integration.** Owns new `src/mainview/components/usage/UsageMeter.tsx` (mini-bar)
  and `UsagePopover.tsx`, plus the chip-strip edit in `src/mainview/App.tsx:756-777` (render the meter in each
  chip, wire the click popover, hold usage state + SSE/poll updates). Acceptance: chip shows a colored mini-bar;
  clicking opens the popover with all meters + reset times + Refresh; uncovered harnesses show only the dot.
  *(D2 depends on D1's exports; D1 and D2 are separate waves since D2 imports D1 — see waves below.)*

## 5. Work breakdown — test tasks

- **T1 (unit, bun).** Provider parser tests: `src/bun/usage/claude-usage.test.ts`,
  `codex-usage.test.ts`, `cursor-usage.test.ts` — pure `parse*` over checked-in fixture JSON (redacted,
  synthetic values). Covers API shape, cache-fallback shape, and the "no data / unavailable" path.
- **T2 (unit, bun).** `src/bun/usage/poller.test.ts` — fake provider registry; asserts fan-out, freshness
  skip, force-refresh, snapshot upsert, and broadcast count. Uses `mkdtemp` `AGETOR_DATA_DIR`.
- **T3 (unit, webview).** `src/mainview/lib/usage.test.ts` (authored in D1) — band thresholds, worst-meter,
  formatting.
- **T4 (e2e).** `e2e/usage-tracker.spec.ts` — worker-scoped backend seeded (via a fake usage source or a
  pre-inserted `harness_usage` snapshot) so the topbar renders a known meter; assert the mini-bar element,
  warn color class at a >90% meter, and that the popover opens with the expected meter rows. Follows
  `theme.spec.ts`/`font-size.spec.ts` shape. **E2E applies** (topbar is a user-visible flow, app runs locally
  via the existing headless harness).

## 6. Execution waves

1. **Wave A** (A1, A2) — parallel, 2 agents. Barrier.
2. **Wave B** (B1, B2, B3, B4) — parallel, file-disjoint. B4 imports B1–B3 but owns its own file; since all
   four are authored against the A-contract and B4 only *imports* (doesn't edit) B1–B3, they can run together —
   **but to be safe against B4 referencing not-yet-written exports, split: B-wave-1 = {B1,B2,B3} parallel;
   B-wave-2 = {B4}.** Barrier after each.
3. **Wave C** (C1, C2) — parallel, file-disjoint. Barrier.
4. **Wave D-1** (D1) — single agent (lib + api). Barrier.
5. **Wave D-2** (D2) — single agent (components + App.tsx integration).
6. **Test waves** interleave: T1 can start after B-wave-1; T2 after B-wave-2; T3 is part of D1; T4 after D-2.
   Per the `/implement` pipeline, tests are authored in Phase 6 after code review (Phase 5) of the impl diff.

## 7. Blast radius & risks

- **`src/shared/types.ts` and `src/mainview/App.tsx` are the two shared-edit hot files.** Only A1 touches
  types.ts and only D2 touches App.tsx — never in the same wave, so no collision.
- **Undocumented endpoints** (Anthropic/OpenAI) may change or 401 (scope) — mitigated by file fallback +
  fail-soft + a visible `source: cache|api|scrape` and staleness label.
- **Keychain prompt** (main Claude account) — one-time; denial sets a cooldown so no prompt storm. Aliased
  accounts read a plain `.credentials.json` (no prompt).
- **Cursor browser-cookie reads** are the riskiest/most fragile task (encrypted Chrome cookies, FDA-gated
  Safari store) — scoped as best-effort, `unavailable` on failure; never blocks the poller or other providers.
- **Headless idle-shutdown**: poller timer `.unref()`'d — usage polling stops when the daemon idle-shuts,
  which is acceptable (no UI attached to update).
- **Migration discipline**: new table only; never touch `harnesses` shape. Append to the migrations array,
  never reorder/edit an applied file.
- **Rollback**: feature is additive (new table, new routes, new components). Reverting the branch removes it
  cleanly; the `harness_usage` table is inert if unused.

## 8. Open questions / assumptions

- **[assumption]** "Account" = a `Harness` row (confirmed — no separate accounts entity). Meters are rendered
  dynamically per provider rather than a fixed session/weekly/routines/total/auto/api list (the user's list
  was illustrative; we show whatever each provider actually reports).
- **[assumption]** Claude alias creds live at `<home>/.credentials.json`; if an alias instead keeps creds in
  the Keychain, its API path falls back to the `.claude.json` cache automatically — verified at implementation
  time against the real alias homes, no plan change either way.
- **[assumption]** Poller default cadence 10 min with a per-provider floor; force-refresh via popover button.
  Tunable constant, not a hard commitment.
- **[deferred]** Burn-rate/pace projection, dollar-cost accounting, gemini/grok live data, and a CLI
  `guard`-style quota gate are out of v1 (seam left for all).
- **[risk, accepted by user]** Cursor coverage depends on an invasive browser/IDE-cookie import that may not
  work on every setup; it degrades to "no data" rather than failing the feature.
