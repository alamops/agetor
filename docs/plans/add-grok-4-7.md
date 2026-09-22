# Plan — Grok 4.7 for Cursor (new default) and fx

| Field | Value |
| --- | --- |
| Date | 2026-09-21 |
| Source | /implement request — "support Grok 4.7 for Cursor Harness, and possibly Vercel fx.sh if available there" (ref: https://x.ai/news/grok-4-7) |
| Config | AGENTS_CONFIG.yml (balanced) — implementation collapsed to inline execution (see §6) |
| Flags | none |
| Gates | grilled + approved by owner |
| Branch | feature/add-grok-4-7 |
| Base SHA | 11c954f5e1d10734fee5b5dc38951781dd49d0fe |

## 1. Objective & success criteria

Grok 4.7 appears in the Cursor model picker with its full effort/fast surface and is the
default for new Cursor tasks; `spacexai/grok-4.7` appears in fx pickers as a catalog-gated
row. `bun run typecheck` and the touched unit suites green.

## 2. Context & constraints (grounded)

- **Cursor — verified live** via `cursor-agent models` (CLI `2026.09.18-9a7762b`):
  `grok-4.7-low|medium|high|xhigh`, each with a `-fast` variant. Differences from 4.6:
  the ids are **not `cursor-` prefixed** (4.5/4.6 still are) and every tier carries an
  explicit label ("Grok 4.7 High", …) — there is no unsuffixed "Grok 4.7" row. Same as
  4.6: no bare id, no `max` tier, no 1M / Max-Mode variant.
- **`xhigh` is not a new effort level for agetor.** Cursor's Grok 4.6 already shipped
  `xhigh` (`src/shared/types.ts:1896`) and `EFFORT_OPTIONS` already has `xhigh`
  ("Extra High"). The x.ai post names "Grok 4.7 xHigh" only in benchmark tables. No
  `EFFORT_OPTIONS` change.
- **fx — verified live**: `fx models --json` (0.0.10, build `1210c2756ea8`, unauthenticated
  view, 246 ids) lists `spacexai/grok-4.7`. The public Gateway catalog
  (`https://ai-gateway.vercel.sh/v1/models`) reports 500K context · 500K output, released
  2026-09-21, and **no `reasoning_options`** — identical to `spacexai/grok-4.6` — so fx
  advertises no `effort` configOption for it (`MODEL_EFFORT_SUPPORT.fx` entry = `[]`).
  Not ACP-probed: `fx status --json` reads `auth: "missing"` in this session, and an
  unauthenticated `initialize` fails. The driver validates effort at runtime regardless.
- The signed-in account's catalog is unverifiable (same expired-login situation the last
  four fx passes recorded), so 4.7's presence on a standard plan is unknown.
- The Cursor picker, `MODEL_EFFORT_SUPPORT.cursor` and `--model` composition all derive
  from `CURSOR_MODEL_SPECS`; `DEFAULT_MODEL.cursor` feeds the New Task form, `createTask`'s
  backfill, `agetor add`, and the unknown-id fallback of `supportedEfforts`.
- **Corrected after review:** Cursor *does* have model discovery (`discoverCursor` /
  `parseCursorModels`, `src/bun/agent-discovery.ts`). The first draft of this plan claimed
  otherwise — a zsh glob error had voided the grep that would have found it. Consequence:
  adding the spec makes the eight `grok-4.7-*` variant ids "covered by the catalog"
  (`cursorModelIdCoveredByCatalog`), so pickers hide the discovered rows and a task/profile
  already storing one would render as an unlisted row with a collapsed effort dropdown —
  the exact case migration 049 normalized for Gemini Flash. Handled by T6.
- fx catalog drift found on the same pass: `mistral/devstral-2` (a standard curated row)
  is gone from both `fx models --json` and the public Gateway catalog. Pre-existing, not
  caused by this change — see §9.

## 3. Approach & key decisions

- **Catalog key `grok-4.7`** (the CLI's own base, no invented `cursor-` prefix), label
  "Grok 4.7", `effortIds` xhigh/high/medium/low, `fastEfforts` all four, no
  `supportsMaxMode`. First entry in `CURSOR_MODEL_SPECS`. *Measured.*
- **`DEFAULT_MODEL.cursor = "grok-4.7"`** — owner decision (grill Q1). New tasks run
  `grok-4.7-high` via `DEFAULT_EFFORT.cursor`. The 4.6 row keeps its place right after,
  with its "Recommended default" hint moved to 4.7.
- **fx row is `catalogOnly: true`** — owner decision (grill Q2); same treatment
  `google/gemini-3.8-flash` got when its signed-in presence was unverified. Placed at the
  end of the catalogOnly block. `MODEL_EFFORT_SUPPORT.fx["spacexai/grok-4.7"] = []`.
  *Rests on the Gateway catalog entry, not an ACP probe.*
- **Grok 4.6 and 4.5 stay** — owner decision (grill Q3).

## 4. Work breakdown — implementation

- **T1** (`src/shared/types.ts`): add the `grok-4.7` spec; flip `DEFAULT_MODEL.cursor`
  and refresh its comment; move the "Recommended default" hint; add the fx model row +
  effort-table entry; refresh the fx catalog-history comments (counts 28→29, 12→13,
  2026-09-21 pass).
- **T2** (`CLAUDE.md`): the fx bullet's "twelve premium rows" list and
  "16 of the 28 curated ids" count; Cursor default mention if any.

- **T6** (`src/bun/migrations/055_normalize_cursor_grok_4_7.sql` + `index.ts`; added
  after review): fold stored `grok-4.7-{xhigh,high,medium,low}[-fast]` into
  `model='grok-4.7'` + effort + fast on cursor-kind `tasks` and `agent_profiles`, and point
  a variant-valued `lastModel:cursor` pref at the base id. `fast` is written both ways so a
  stale `fast=1` on a non-fast variant can't silently move a task onto the Fast tier.
  Frozen `tasks.agent_profile` snapshots are not rewritten. Additive-safe: the recomposed
  `--model` argv is identical.
- **T7** (comments; added after review): stale present-tense fx counts in `types.ts`,
  `orchestrator.ts`; "then-curated" qualifiers in `agent-discovery.ts`, `fx-acp.ts`;
  `e2e/fx-models.spec.ts` count; Cursor hint gains the minimum-CLI caveat.

## 5. Work breakdown — tests

- **T3** (`src/bun/effort-support.test.ts`): default is `grok-4.7`; `ids[0]`; null-model
  surface; new 4.7 test (xhigh/high/medium/low, no Max Mode); `cursorModelArg` composes
  `grok-4.7-high` / `grok-4.7-xhigh-fast` / `grok-4.7-low`; 4.6 coverage retained.
- **T4** (`src/bun/agents.test.ts`, `src/bun/orchestrator-cursor.test.ts`): default
  argv → `grok-4.7-high`; `createTask` default model.
- **T5** (`src/shared/types.test.ts`): 4.7 joins `FX_NO_EFFORT_MODELS` (13) and the
  catalogOnly set (13); total 29.
- **T8** (`src/bun/migrate.test.ts`, `src/bun/effort-support.test.ts`; added after
  review): 055 behavior + idempotence on an in-memory DB (049's pattern); the "054 is
  last" pin now locates 054 by id; `cursorModelIdCoveredByCatalog` covers all eight 4.7
  variants.
- **e2e: not applicable** — constants-only change, no new UI surface (picker rows are
  data-driven). The two e2e specs naming `cursor-grok-4.6` pass it as an explicit model
  on a still-curated row, so they are unaffected.

## 6. Execution waves

Single wave, inline. Every edit is a constant or an assertion and three of the five tasks
share `types.ts` semantics; fan-out would cost more than the change.

## 7. Blast radius & risks

- New Cursor tasks (and API creates omitting `model`) get `grok-4.7`; existing rows keep
  their stored model. A user's `lastModel:cursor` pref still wins where it's consulted.
- `supportedEfforts("cursor", <unknown id>)` falls back to the default's set — unchanged in
  shape (4.6 and 4.7 share xhigh/high/medium/low).
- An older `cursor-agent` without 4.7 rejects the id at spawn — surfaced through the
  existing failed-run path; 4.6 is one click away.
- Agent profiles snapshot their own model; none reference the default.

## 8. Open questions / assumptions

- **A1:** fx offers no effort for 4.7. Source: Gateway catalog entry lacks
  `reasoning_options`. Not ACP-probed (no credentials). Runtime validation covers drift.
- **A2:** Signed-in Gateway presence of `spacexai/grok-4.7` unverified → `catalogOnly`.

## 9. Completeness ledger

| Candidate | Disposition |
| --- | --- |
| Tests pinning `cursor-grok-4.6` as the default (effort-support, agents, orchestrator-cursor) | in this run — T3/T4 |
| fx paired structures (models row ↔ effort table ↔ count-pinning tests) | in this run — T1/T5 |
| CLAUDE.md fx catalog prose (row counts, catalogOnly list) | in this run — T2 |
| e2e specs using `cursor-grok-4.6` explicitly | out of scope — still a valid curated id, not default-dependent |
| Retire Cursor Grok 4.5 (picker + `tasks.model` migration + `lastModel` pref) | owner-deferred — grill Q3 ("Keep 4.6 and 4.5") |
| Rewrite existing tasks / `lastModel:cursor` from 4.6 → 4.7 | out of scope — a stored model is the user's explicit choice; the 4.6 flip set the same precedent |
| New `xhigh` effort id | out of scope — already exists |
| Stored `grok-4.7-*` variant ids on tasks / agent profiles / `lastModel:cursor` (review finding) | in this run — T6/T8 |
| Stale fx count comments outside CLAUDE.md (review finding) | in this run — T7 |
| Legacy cursor tasks with `model IS NULL` re-resolve to `grok-4.7` on their next run | out of scope — the intended meaning of a NULL model ("use the default"), same as the 4.6 flip |
| `mistral/devstral-2` retired Gateway-side but still a curated fx row | out of scope — pre-existing drift unrelated to Grok 4.7; retiring a curated id is a three-store change (picker/effort map, `tasks.model` migration, `lastModel:fx` pref). Reported to the owner. |
