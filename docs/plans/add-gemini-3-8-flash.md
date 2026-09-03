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

1. Phase 4 wave 1: IMPL-1 ∥ IMPL-2 ∥ IMPL-3 (sonnet, `general-purpose`) → typecheck + test → commit.
2. Phase 5: review (opus) of `git diff 3a771b3...HEAD` with the built-in rubric (no `code-review` skill
   handoff needed — but it is available; see Phase 5 note) → triage.
3. Phase 6 wave 2: TEST-1 ∥ TEST-2 (sonnet) → commit.
4. Phase 7: haiku runs `bun run typecheck && bun test` → report.
5. Phase 8: fix agents only if review must-fixes or failures exist → re-run.

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
| fx rows for `google/gemini-3.7-flash` / 3.6 / 3.5 Flash | **out of scope** — fx curated list is deliberately short; discovered-only ids already append via `mergeModelOptions`; owner asked for 3.8 only |
| gemini picker rows for `gemini-3.1-flash-lite`, `gemini-3.6-flash`, `gemini-3-flash` | **out of scope** — curated list is newest-per-tier; typed ids pass through; nobody asked |
| Gemini 3.8 Flash Cyber | **out of scope** — Fairwind-gated, no public id |
| Gemini thinking-level knob for the gemini harness | **out of scope** — CLI 0.58.0 exposes no flag; nothing to wire |
| README roadmap line still listing "Gemini CLI" as future | **out of scope** — pre-existing stale line unrelated to this change (different ticket) |
| `docs/plans/add-gemini-3-7-flash.md` says the default stays 3-pro-preview | **out of scope** — dated historical artifact, superseded by this plan |

No owner-deferred rows.
