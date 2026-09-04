# Plan — Add Gemini 3.8 Flash; retire the shut-down gemini default

| Field | Value |
| --- | --- |
| Date | 2026-09-02 |
| Source | /implement — "Gemini 3.8 Flash in the gemini harness integration, which was just released" |
| Config | AGENTS_CONFIG.yml (balanced: investigate/implement/tests sonnet, review opus, test-run haiku, planning self) |
| Flags | none |
| Gates | grilled by owner (3 questions, all answered, 2026-09-02) + plan approved by owner 2026-09-03, conditional on re-confirming the 3 Pro shutdown (re-confirmed: model page banner "deprecated and has been shut down March 9, 2026") |
| Branch | feature/gemini-3-8-flash (agetor task branch, already checked out) |
| Base SHA | 3a771b3f94988af1a1dfb9a6bf2dcff74a093cb2 (release v0.1.5; tree clean) |

## 1. Objective & success criteria

1. `gemini-3.8-flash` is selectable for gemini tasks and launches as `gemini -m gemini-3.8-flash …`
   (verbatim passthrough); its effort picker stays collapsed (the CLI has no thinking flag).
2. The gemini default moves from the shut-down `gemini-3-pro-preview` to `gemini-3.1-pro-preview`
   (Google's stated successor); the dead row leaves the picker; migration 049 rewrites tasks still
   pinned to the dead id.
3. Cursor gains `gemini-3.8-flash` and `gemini-3.7-flash` specs (low/medium/high) — closing the
   "when Cursor ships it" deferral from `docs/plans/add-gemini-3-7-flash.md` §8 A2.
4. fx gains a catalog-gated `google/gemini-3.8-flash` row.
5. `bun run typecheck` and `bun test` green; every stale fixture/doc naming the dead id updated.

## 2. Context & constraints (grounded)

Web + spike evidence (all 2026-09-02):
- **`gemini-3.8-flash` is GA today** — Gemini API changelog entry dated 2026-09-02; models table lists it
  "New Stable"; thinking `low|medium|high`, `minimal` returns an error. Intro pricing $0.75/$3.75 per MTok.
- **"Gemini 3.8 Flash Cyber"** is restricted to Google's Fairwind Program; no public model id → not curated.
- **`gemini-3-pro-preview` is shut down** — deprecations page: released 2025-11-18, shutdown 2026-03-09,
  replacement `gemini-3.1-pro-preview` (Preview, no shutdown date). Re-confirmed 2026-09-03 on the model's own
  page (banner: "Gemini 3 Pro Preview is deprecated and has been shut down March 9, 2026"). Public reports say
  Google now points the old id at 3.1 Pro preview server-side, so a pinned task may still run via that alias —
  the migration makes the stored id honest rather than rescuing a hard failure. `gemini-3.7-flash` (2026-08-13),
  `gemini-3.5-flash`, `gemini-2.5-pro`, `gemini-2.5-flash` all still active.
- **Spike — published gemini CLI 0.58.0** (scratchpad `npm install @google/gemini-cli@latest`, isolated HOME):
  `--help` exposes no thinking/effort flag; `resolveModel()` maps only the `auto|pro|flash|flash-lite`
  aliases and forwards any other `-m` string unchanged (main source + released bundle: zero references to
  `gemini-3.7-flash`/`gemini-3.8-flash`, no "invalid model" error strings). A live `-m` probe is
  **inconclusive** without credentials — the auth check runs before any model handling (bogus and real ids
  fail identically). The CLI's own `pro` alias resolves to `gemini-3.1-pro-preview` when the account has it.
- **Cursor** — live `cursor-agent models`: `gemini-3.8-flash-{low,medium,high}`,
  `gemini-3.7-flash-{low,medium,high}`; no `minimal` (3.6 has one), no bare id, no `-fast`, no Max.
- **fx** — `fx models --json` lists `google/gemini-3.8-flash` and `google/gemini-3.7-flash`, but
  `fx status --json` reports `auth_expired: true` → that is the unauthenticated catalog; signed-in presence
  on a standard account is unverified → `catalogOnly: true` is the correct gating.
- **User data** — neither `~/.agetor/agetor.sqlite` nor `~/.agetor-dev/agetor.sqlite` has a gemini task
  (gemini harness `enabled=0` in both), so the migration is a no-op locally; it exists for other installs.

Local sync points (verified in this tree):
- `src/shared/types.ts` — `DEFAULT_MODEL.gemini` (~1308, comment "verified 2026-08-06" is stale),
  `MODEL_EFFORT_SUPPORT.gemini` (~1820), `AGENT_OPTIONS.gemini.models` (~1975, tier-ordered comment),
  `CURSOR_MODEL_SPECS` (~1362; `gemini-3.6-flash` entry ~1580 is the shape to mirror; picker + effort
  map + `cursorModelArg` all derive from it), `AGENT_OPTIONS.fx.models` catalogOnly block +
  `MODEL_EFFORT_SUPPORT.fx` (key parity enforced by `types.test.ts:118`).
- `src/bun/agents.ts` — gemini `-m` passthrough, `opts.effort` ignored; cursor `--model cursorModelArg(...)`.
  **No change.**
- `src/shared/model-options.ts` rule 6 — a selected id absent from the list is appended as an `unlisted`
  row for every kind, so a task still pinned to a removed id stays representable in the picker.
- Migration precedents: `015_default_model_effort.sql` / `034_task_fast.sql` (`UPDATE tasks SET model …`);
  runner `src/bun/migrate.ts`; index `src/bun/migrations/index.ts` (text imports, append-only);
  per-migration test precedent `migrate.test.ts:127` (in-memory DB + DDL + exec SQL + assert).
- Tests naming the dead id: `agents.test.ts:83,791,816,868`, `gemini-tmux.test.ts:210`,
  `orchestrator-fx.test.ts:495`. `types.test.ts:108` enforces DEFAULT_MODEL ∈ picker; `:154` pins
  "exactly the five" fx catalogOnly ids (becomes six). `effort-support.test.ts:161-172` cursor picker
  order (`cursor-grok-4.6` first — unaffected).
- Docs: `CLAUDE.md` fx paragraph enumerates the five catalogOnly ids (must become six). README has no
  gemini model list. No `src/cli`/`src/mainview` copy names a gemini model.
- Runnability: `export PATH="$HOME/.bun/bin:$PATH"`; `node_modules` installed (`bun install --frozen-lockfile`
  ran clean); `bun run typecheck`; `bun test` (single file: `bun test src/bun/agents.test.ts`).

## 3. Approach & key decisions

- **Default → `gemini-3.1-pro-preview`** (owner decision). Same flagship-Pro tier, Google's named successor,
  what the CLI's `pro` alias resolves to. Still not the `auto` alias (the existing spike note stands: auto
  routes across pro/flash-lite). 3.8 Flash was offered and declined as default.
- **Remove the dead row; migration 049 rewrites pinned tasks** (owner decision — data-mutating, explicitly
  approved). SQL: `UPDATE tasks SET model = 'gemini-3.1-pro-preview' WHERE model = 'gemini-3-pro-preview';`
  **without** the 015/034 harness-kind join: the literal is unique to gemini's catalog (cursor uses
  `gemini-3.1-pro`, fx uses `google/…`), so the join would add nothing except skipping orphaned-harness rows.
  No `updated_at` bump (matches 015/034). Reviewer to confirm the no-join choice.
- **Gemini picker order** stays "Pro tier first, Flash tier second, newest first within tier":
  3.1 Pro (recommended default) → 2.5 Pro → **3.8 Flash** → 3.7 Flash → 3.5 Flash → 2.5 Flash. Sibling
  hints re-tiered per the supersession convention (3.7 becomes "prior Flash generation").
- **Effort entries `[]`** for the new gemini row — CLI 0.58.0 has no thinking flag (spike, not assumption).
- **Cursor specs** mirror `gemini-3.6-flash` minus `minimal`; placed directly above `gemini-3.6-flash` so the
  derived picker lists Gemini newest-first. `cursorModelArg` composes `gemini-3.8-flash-<effort>`; default
  effort `high` resolves to `gemini-3.8-flash-high`.
- **fx row** `google/gemini-3.8-flash` with `catalogOnly: true` and the premium-tier hint, inserted after
  `google/gemini-3.1-pro-preview` in the catalogOnly block; `MODEL_EFFORT_SUPPORT.fx` gets the matching
  `[]` key; the block comment records the 2026-09-02 expired-login catalog observation.
- **No `agents.ts` change** — passthrough contracts are already tested.

## 4. Work breakdown — implementation (Phase 4, one wave)

| ID | Goal | Owns (exclusively) | Acceptance |
| --- | --- | --- | --- |
| IMPL-1 | Catalog edits | `src/shared/types.ts` | `DEFAULT_MODEL.gemini = "gemini-3.1-pro-preview"` with rewritten comment (shutdown fact, successor, auto-alias note kept); `gemini-3-pro-preview` removed from `AGENT_OPTIONS.gemini.models` and `MODEL_EFFORT_SUPPORT.gemini`; `gemini-3.8-flash` added to both in the newest-Flash slot with the hints above; `CURSOR_MODEL_SPECS["gemini-3.8-flash"]` and `["gemini-3.7-flash"]` (label/hint/effortIds high,medium,low; no minimal/fast/max) above `gemini-3.6-flash` with a verification comment; fx catalogOnly row + effort key + comment update. Nothing else in the file. |
| IMPL-2 | Migration + docs | `src/bun/migrations/049_retire_gemini_3_pro_preview.sql`, `src/bun/migrations/index.ts`, `CLAUDE.md` | New SQL file with rationale comment and the single UPDATE; index entry `{ id: "049_retire_gemini_3_pro_preview", sql: m049 }` appended (text import, same style); CLAUDE.md fx sentence "plus five premium rows … (`claude-opus-5`, `claude-sonnet-5`, `gpt-5.5`, `gemini-3.1-pro-preview`, `kimi-k3`)" → six incl. `gemini-3.8-flash`. |
| IMPL-3 | Sync existing assertions/fixtures | `src/bun/agents.test.ts`, `src/shared/types.test.ts`, `src/bun/gemini-tmux.test.ts`, `src/bun/orchestrator-fx.test.ts` | `geminiDefaults.model` and the three expected `-m gemini-3-pro-preview` argv literals → `gemini-3.1-pro-preview`; `gemini-tmux.test.ts:210` and `orchestrator-fx.test.ts:495` literals likewise; `types.test.ts:154` test renamed/extended to "exactly the six …" incl. `google/gemini-3.8-flash`. **No new tests here** — only what IMPL-1 makes stale. |

Wave-1 files are pairwise disjoint. Checkpoint: `bun run typecheck && bun test` green → commit
`wave 1: gemini 3.8 flash + retire 3-pro-preview default (types, migration 049, fixture sync)`.

## 5. Work breakdown — test tasks (Phase 6, one wave)

| ID | Covers | Owns | Acceptance |
| --- | --- | --- | --- |
| TEST-1 | IMPL-1 argv + effort surfaces | `src/bun/agents.test.ts`, `src/bun/effort-support.test.ts` | agents: `gemini-3.8-flash` emitted verbatim via `-m` (mirror the 3.7 test); cursor `gemini-3.8-flash` + effort `medium` → `--model gemini-3.8-flash-medium`, and with defaults → `-high`. effort-support: gemini `gemini-3.8-flash` → `[]`; cursor `gemini-3.8-flash` and `gemini-3.7-flash` → exactly `["high","medium","low"]` (no `minimal`). |
| TEST-2 | Catalog invariants + migration | `src/shared/types.test.ts`, `src/bun/migrate.test.ts` | types: `DEFAULT_MODEL.gemini === "gemini-3.1-pro-preview"` and it is the first gemini row; gemini picker contains `gemini-3.8-flash` and not `gemini-3-pro-preview`; `MODEL_EFFORT_SUPPORT.gemini` keys ⇔ gemini picker ids (both directions, mirroring the fx test at :118); cursor picker lists `gemini-3.8-flash` before `gemini-3.7-flash` before `gemini-3.6-flash`. migrate: 049 rewrites a gemini task pinned to `gemini-3-pro-preview` (and one on an additional `gemini-2` harness) to `gemini-3.1-pro-preview`, leaves `gemini-3.7-flash` / cursor `gemini-3.1-pro` / fx `google/gemini-3.1-pro-preview` rows untouched, and is idempotent — in-memory DB per the 024 precedent. |

**E2e: not applicable.** Registry additions plus a one-statement data migration, all exercised by unit tests;
no new user flow, route, or UI surface. The existing `e2e/fx-models.spec.ts` is generic over catalogOnly rows.

## 6. Execution waves

1. Phase 4 wave 1: IMPL-1 ∥ IMPL-2 ∥ IMPL-3 (sonnet, `general-purpose`) → typecheck + test → commit
   (landed as c73798a; checkpoint: typecheck clean, 4001 pass / 3 skip / 0 fail).
2. Phase 5: review (opus) of `git diff 3a771b3...HEAD`, briefed to load the `code-review` skill and fall
   back to the built-in rubric if unavailable, reporting which it used → triage.
3. Phase 6 wave 2: TEST-1 ∥ TEST-2 (sonnet) → commit. Run **concurrently with Phase 5** — the review is
   read-only and scoped to the committed diff, the test agents write only test files, so no collision.
4. Phase 7: haiku runs `bun run typecheck && bun test` → report.
5. Phase 8: fix agents only if review must-fixes or failures exist → re-run.
   **Outcome:** wave 2 landed as 57bde99 (4016 pass / 3 skip / 0 fail). Opus review (via the `code-review`
   skill): 0 must-fix, 1 should-fix, 4 low — "approve with should-fixes"; it also executed 049 through the real
   runner and confirmed the no-join form (015's separate orphan catch-all is the precedent showing the join is
   the weaker form). Wave 3 (fixes, file-disjoint): FIX-1 = 049 gains a `DELETE FROM preferences WHERE key =
   'lastModel:gemini' AND value = 'gemini-3-pro-preview'` (049 is unreleased and applied to no durable DB —
   prod at 048, dev at 045 — so an in-place edit is safe), migrate.test extended, two comment nits in
   types.ts; FIX-2 = `agetor add` validates the stored pref against curated ∪ discovered via an exported
   `resolveInitialModel` helper (mirrors the webview pickers) and applies the UI's cursor covered-id filter,
   with unit tests. Then Phase 7 re-run.
   **Final:** wave 3 landed as dae3b2f. Phase 7 (haiku) on dae3b2f: typecheck clean; `bun test` 4023 pass /
   3 skip / 0 fail across 202 files (235 s); the five touched suites 223 pass / 0 fail. Phase 8 loop closed
   in one round. Branch not pushed — owner's call.

## 7. Blast radius & risks

- `DEFAULT_MODEL.gemini` seeds NewTaskForm, `createTask`'s `input.model ?? DEFAULT_MODEL[kind]`, the CLI
  `agetor add` default, and the launch dialogs — all generic; a new gemini task now launches 3.1 Pro preview.
- Removing a picker row never strands a stored id (model-options rule 6) — and 049 rewrites it anyway.
- 049 touches user rows on other installs; the old value is unrunnable, the new value is Google's successor;
  local DBs have zero affected rows. Roll back = a follow-up migration (values are known constants).
- `gemini-3.1-pro-preview` is itself a Preview id that Google may retire later — same class of risk as today,
  mitigated by the recorded knowledge entry (check the deprecations page on every catalog edit).
- Users on a gemini backend that does not accept `gemini-3.8-flash` yet get Google's model error at run
  time — the pre-existing verbatim-passthrough risk class, accepted for 3.7 Flash.
- Cursor: if Cursor ever adds a `minimal`/`-fast` tier, `cursorModelIdCoveredByCatalog` keeps treating
  unknown variants as passthrough — nothing breaks, the toggle just isn't offered.

## 8. Open questions / assumptions

- **A1 (unverified live)** — `gemini -m gemini-3.8-flash` works end-to-end against the owner's gemini login.
  Source-level evidence says the CLI forwards the id; a live run needs credentials this machine lacks
  (`~/.gemini` absent). Owner can verify post-merge by enabling the gemini harness and running one task.
- **A2** — `google/gemini-3.8-flash` may or may not be in a standard fx account's catalog; `catalogOnly`
  makes both outcomes correct (offered only when discovered).
- **A3** — Cursor's 3.7/3.8 Flash "high" variant is the unsuffixed-label tier, same convention as 3.6
  (Cursor's own listing labels 3.8's as "Gemini 3.8 Flash High"; cosmetic only).

## 9. Completeness ledger

| Candidate remainder | Disposition |
| --- | --- |
| gemini picker + effort map row for 3.8 Flash | **in this run** — IMPL-1 |
| Dead gemini default (`gemini-3-pro-preview` shut down 2026-03-09) | **in this run** — IMPL-1 (default swap, row removal, comment) |
| Tasks already pinned to the dead id (existing data) | **in this run** — IMPL-2 migration 049 (owner-approved data rewrite) |
| Test fixtures still naming the dead id (agents / gemini-tmux / orchestrator-fx tests) | **in this run** — IMPL-3 |
| `types.test.ts` "exactly five catalogOnly" assertion | **in this run** — IMPL-3 |
| `CLAUDE.md` fx paragraph counting five catalogOnly ids | **in this run** — IMPL-2 |
| Cursor `gemini-3.8-flash` + `gemini-3.7-flash` (3.7 plan's A2 deferral, now shipped by Cursor) | **in this run** — IMPL-1 (owner swept in) |
| fx `google/gemini-3.8-flash` catalogOnly row | **in this run** — IMPL-1 (owner swept in) |
| New coverage for all of the above | **in this run** — TEST-1, TEST-2 |
| Stale `preferences.lastModel:gemini` still holding the dead id after 049 (review should-fix) | **in this run** — FIX-1 (049 second statement) |
| `agetor add` seeding its picker from an unvalidated pref, re-offering a retired id (review should-fix) | **in this run** — FIX-2 (`resolveInitialModel`, mirrors NewTaskForm/TaskLaunchPickers) |
| CLI cursor picker listing the new specs' six `-low/-medium/-high` variants alongside the base rows (review low; created for these ids by this change) | **in this run** — FIX-2 (same covered-id filter the three UI pickers use) |
| Comment accuracy: fx "5 catalogOnly" dated note, cursor "verified" block folding in the label convention (review low) | **in this run** — FIX-1 |
| `createTask` storing `effort: "high"` for an unlisted gemini/fx id where a listed one stores `null` (review low) | **out of scope** — pre-existing for every unlisted gemini/fx id, not introduced here (the retired id is unreachable from any picker after 049 and `buildCommand` ignores effort for both kinds); the durable fix is a kind-level rule in `createTask` + the PATCH guard, an orchestrator-wide semantic change that deserves its own review |
| fx rows for `google/gemini-3.7-flash` / 3.6 / 3.5 Flash | **out of scope** — fx curated list is deliberately short; discovered-only ids already append via `mergeModelOptions`; owner asked for 3.8 only |
| gemini picker rows for `gemini-3.1-flash-lite`, `gemini-3.6-flash`, `gemini-3-flash` | **out of scope** — curated list is newest-per-tier; typed ids pass through; nobody asked |
| Gemini 3.8 Flash Cyber | **in this run** — owner widened scope 2026-09-03 (see §10); row `gemini-3.8-flash-cyber` under 3.8 Flash with a Fairwind-gate hint |
| Gemini thinking-level knob for the gemini harness | **out of scope** — CLI 0.58.0 exposes no flag; nothing to wire |
| README roadmap line still listing "Gemini CLI" as future | **out of scope** — pre-existing stale line unrelated to this change (different ticket) |
| `docs/plans/add-gemini-3-7-flash.md` says the default stays 3-pro-preview | **out of scope** — dated historical artifact, superseded by this plan |

No owner-deferred rows.

## 10. Addendum (2026-09-03) — Gemini 3.8 Flash Cyber

Owner asked, after the 3.8 Flash delivery landed, to also offer the Fairwind-Program-gated Cyber variant.

- **Evidence gathered:** Google's Cyber page, the Fairwind Program page, the launch post, the Gemini API models
  docs (no page — 404), the DeepMind model-card index (no Cyber card), the Enterprise Agent Platform model list
  (21 ids, none Cyber), the CodeMender docs (newest model listed is 3.7 Flash) and the launch-day Hacker News
  thread all refer to the model only by name. Access is delivered as a managed model on the Enterprise Agent
  Platform to vetted defenders (governments, critical-infrastructure operators, core platforms). Cursor
  (`cursor-agent models`) and fx (`fx models --json`) expose no Cyber id → gemini harness only.
- **Owner decision (grill, one question):** use `gemini-3.8-flash-cyber`, following Google's own suffix
  convention (`gemini-3.1-flash-lite`, `gemini-3-pro-image`) and OpenAI's `gpt-5.6-cyber` precedent; the
  owner asked for a web confirmation pass, which found no published code either way. The row's hint and a
  code comment state that the id is convention-based pending a published code; agetor passes it through
  verbatim, so a grant that names it differently needs only the literal changed.
- **Change:** `AGENT_OPTIONS.gemini.models` gains the row directly under `gemini-3.8-flash` (a variant of the
  newest Flash, not a new tier — unlike GPT-5.6 Cyber, which the owner asked to put on top of Sol);
  `MODEL_EFFORT_SUPPORT.gemini["gemini-3.8-flash-cyber"] = []`; default unchanged; no migration, no CLI, no
  README/CLAUDE.md enumeration to update. Tests: verbatim `-m` argv, empty effort surface, exact tier order,
  and a placement + Fairwind-hint assertion.
- **Process note:** applied inline by the orchestrator (a four-line mirror of the reviewed 3.8 row) rather
  than through the sonnet implementation runner; no separate opus review pass was run for this addendum.
- **Open:** A4 — the model code is unconfirmed; first Fairwind-approved run will confirm or correct it.

## 11. Post-review fixes (2026-09-03, `/code-review` on the branch — 0 must-fix, 5 low, all applied)

- **049 normalizes suffixed Cursor Gemini Flash variants** — six kind-joined `UPDATE`s map
  `gemini-3.{8,7}-flash-{high,medium,low}` on cursor-kind tasks to base id + effort (the shape `cursorModelArg`
  re-composes into the same argv), so a task that picked a variant as a discovered-only row before the specs
  existed no longer renders as a "not in this account's catalog" unlisted row with a collapsed effort dropdown.
  Mirrors 034's `claude-opus-4.8` normalization. 049 was still unreleased (prod DB at 048, dev at 045).
- **`resolveInitialModel` mirrors rule 7** — takes `loggedIn` and ignores a logged-out harness's discovered
  catalog, so a discovered-only pref can't be pre-selected as an unlisted row the merge just declared
  unavailable. The webview pickers remain stricter (curated-only validation); the CLI keeps a valid
  discovered-only fx pref on a logged-in harness, which is the more useful of the two for account-scoped
  catalogs.
- Comment accuracy: the gemini CLI `pro`-alias claim is now conditional on 3.1 preview access; the fx
  `DEFAULT_MODEL` comment and the e2e spec comment count six catalog-gated rows; `EXCLUDED_FX_OPTION_LABELS`
  gains "Gemini 3.8 Flash" so the e2e asserts the new gated row stays hidden under the stub catalog.
- Cyber hint now names the recovery path for a differently-named grant (`agetor add --model <code>`).
