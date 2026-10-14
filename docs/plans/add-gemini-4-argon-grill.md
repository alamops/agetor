# Grill — Add Gemini 4 Argon (gemini, antigravity, cursor, fx) + antigravity effort fix + deprecated-row prune

| Field | Value |
| --- | --- |
| Date | 2026-10-14 |
| Source | `docs/plans/add-gemini-4-argon-investigation.md` (pipeline step 1), plus re-checks made during this grill (below) |
| Mode | interactive, answered by the owner (three structured passes, 12 questions, all answered) |
| Flags | none |

## Re-checks made during the grill (2026-10-14)

- Gemini CLI npm tags are unchanged since the investigation: `latest` 0.64.0, `nightly`/`staging-tmp` 0.65.0-nightly.20261014.g42c518220, `preview` 0.65.0-preview.0. google-gemini/gemini-cli PR #29737 (Argon registration) is still **open**. The author's description says the model "stays listed for every auth method", that backends without it answer model-not-found, that it's served from the `global` location only, and that the chat alias extends `chat-base-3` (thinkingLevel HIGH).
- No public source names the `agy` id for Argon. Web search for `agy models` + `gemini-4-argon` found nothing.
- `cursor-agent models` (live, logged in) still lists `gemini-3.7-flash-{low,medium,high}`, `gemini-3.6-flash-{minimal,low,medium,high}`, `gemini-3.5-flash`, `gemini-3.1-pro` and `gemini-3-flash`, next to `gemini-4-argon-{low,medium,high}`. Cursor is **not** dropping the Flash generations Google deprecated.
- `src/bun/orchestrator.ts` passes the stored `task.effort` straight into `buildCommand` at every spawn site (L1671, 3685, 3886, 4070, 4236, 4594, 5757). `src/bun/agents.ts:707-709` emits `--effort <effort>` whenever it is set. So emptying `MODEL_EFFORT_SUPPORT.antigravity` alone would **not** stop `--effort` on tasks that already have one saved.
- `supportedEfforts` (`src/shared/types.ts:3101-3129`) falls back to `DEFAULT_MODEL`'s set for an id the table doesn't know. `defaultEffortFor` (`orchestrator.ts:5919-5923`) then picks `DEFAULT_EFFORT.antigravity = "high"`. Today, any antigravity id that only discovery found (e.g. an Argon id `agy models` lists) launches with `--effort high`.
- Migration `061_antigravity_harness.sql` deliberately seeds the built-in antigravity row **enabled** (`enabled = 1`, with a comment saying so). Codex, cursor, gemini and fx are all seeded `0`.

## Decisions

| # | Topic | Question | Answer | Source |
| --- | --- | --- | --- | --- |
| D1 | Gemini default | Make `gemini-4-argon` `DEFAULT_MODEL.gemini`? | **No.** `gemini-3.1-pro-preview` stays the default and keeps its "Recommended default" hint. Argon goes in as the top row. Revisit the default once Gemini CLI registers Argon. | owner |
| D2 | Gemini CLI gating | Ship the gemini row now as passthrough, or wait for a CLI release with PR #29737? | **Ship now, no `MODEL_MIN_CLI_VERSION.gemini` floor.** It runs at the API-default `medium` thinking until a CLI release registers it, then gets `high` with no change on our side. A floor would block runs that work today. | owner (precedent: 3.7/3.8 Flash passthrough) |
| D3 | Antigravity rows | How should the antigravity side ship? | **Three curated rows on Antigravity's naming pattern:** `gemini-4-argon-high`, `-medium`, `-low`. The hint says the id follows Antigravity's naming (unconfirmed) and needs AI Ultra or eligible Enterprise (same approach as the `gemini-3.8-flash-cyber` row). Discovery still shows whatever `agy models` really lists. | owner |
| D4 | Antigravity row shape (contradiction raised) | LuminaBench (unofficial, 2026-10-10, before GA) says agy shows Argon as one entry with its own effort and context-size settings. Keep 3 suffixed rows, or one bare row + `--effort`? | **Keep 3 suffixed rows.** All 18 agy ids we know carry the effort in the id, the cortexkit registry agrees, and the report is unofficial and from before GA. | owner |
| D5 | Live verification | What can you use to try Argon live before merge? | **Nothing. Ship unverified.** Tests are the only check; the owner tries it after merge. Cursor's ids are the only ones confirmed live (`cursor-agent models`). | owner |
| D6 | Antigravity effort bug (existing) | Every antigravity row allows `max,xhigh,high,medium,low`, and `--effort` goes on top of the id's own effort suffix. How far should this change go? | **Fix all 21 antigravity rows** (18 existing + 3 Argon): `MODEL_EFFORT_SUPPORT.antigravity[id] = []` for every row. The effort lives in the id only. | owner |
| D7 | Saved antigravity efforts | Saved `effort` values on antigravity tasks and profiles still reach `--effort`. How should they be handled? | **Both.** (a) A migration sets `effort` to NULL on antigravity-kind `tasks` and `agent_profiles`. (b) The antigravity command builder (`agents.ts` antigravity branch) **never emits `--effort`** again. This overrides the confirm-list default 7 wording that kept the `--effort` code. | owner |
| D8 | Prune deprecated rows | Remove upstream-deprecated `gemini-3.7-flash` / `gemini-3.5-flash` in this change? | **Yes, in this change.** Remove them from `AGENT_OPTIONS.gemini.models` and `MODEL_EFFORT_SUPPORT.gemini`. Also remove `gemini-3.7-flash-{high,medium,low}` from the antigravity catalog and effort table. A 049-style migration rewrites pinned data. | owner |
| D9 | Prune successor | Where do pinned `gemini-3.5-flash` rows go (Google routes it to 3.6, which isn't a gemini picker row)? | **`gemini-3.8-flash`**, the same successor as `gemini-3.7-flash`. Antigravity `gemini-3.7-flash-<effort>` → `gemini-3.8-flash-<effort>` (same suffix). No new 3.6 row. | owner |
| D10 | Antigravity docs gap (existing) | CLAUDE.md has no antigravity section and the README says "Five harnesses". Close it now? | **Yes, in this change.** See confirm-list default 9 below. | owner |
| C1 | Gemini picker | Placement, hint, effort set | `gemini-4-argon` / "Gemini 4 Argon" is the **first** gemini row, above 3.1 Pro preview. The hint says it's the newest flagship, needs AI Ultra or a paid API key (not the API free tier or the AI Pro plan), and runs at Google's default (medium) thinking until Gemini CLI registers it. 3.1 Pro preview keeps "Recommended default". `gemini-2.5-pro`/`gemini-2.5-flash` stay. `MODEL_EFFORT_SUPPORT.gemini["gemini-4-argon"] = []`. | owner (confirmed default 1) |
| C2 | Antigravity catalog | Placement and default | The three Argon rows go at the **top** of `AGENT_OPTIONS.antigravity.models`. `DEFAULT_MODEL.antigravity` stays `gemini-3.8-flash-high`, since Argon is Ultra-only in Antigravity. | owner (confirmed default 2) |
| C3 | Cursor | Spec + migration | Add `CURSOR_MODEL_SPECS["gemini-4-argon"]`: label "Gemini 4 Argon", effort ids high/medium/low, default `high` (unsuffixed label → high), no minimal/fast/Max Mode, placed above 3.8 Flash. **Migration 064** normalizes `tasks.model`, `agent_profiles.model` and `preferences.lastModel:cursor` from `gemini-4-argon-<effort>` to base + effort (template `062_normalize_cursor_haiku_5_5.sql`). Frozen `tasks.agent_profile` / `tasks.pipeline_run` snapshots are not touched. `DEFAULT_MODEL.cursor` stays `grok-4.7`. Cursor's 3.7/3.6 Flash specs **stay**, because Cursor still lists them live. | owner (confirmed default 3); live `cursor-agent models` |
| C4 | fx | Row + counts | Catalog-gated row `google/gemini-4-argon` / "Gemini 4 Argon", `MODEL_EFFORT_SUPPORT.fx["google/gemini-4-argon"] = ["high","medium","low","auto"]` (Gateway `reasoning_options` low/medium/high + fx's `auto`). The fx default doesn't change. "nineteen" becomes "twenty" catalog-gated rows in `types.test.ts:303` (explicit list), the comments at `types.ts:~2226`/`~3389`, and CLAUDE.md's fx paragraph. `e2e/fx-models.spec.ts` `EXCLUDED_FX_OPTION_LABELS` gains "Gemini 4 Argon" (and its `:59` comment count). | owner (confirmed default 4) |
| C5 | Non-goals | — | Out of scope: the agy context-size setting (256K/512K/900K) — no field and no confirmed flag. No invented `gemini-4-pro`/`-flash`/`-cyber` ids. No Codex or Claude Code change. | owner (confirmed default 5) |
| C6 | Tests | — | Update the exact-list checks (`types.test.ts` gemini tier order, fx catalog-gated list, effort-key parity), and add argv, effort and migration tests (064, the prune/effort migration). **No new e2e spec** (same as earlier model plans); the only e2e edit is the fx exclusion list. | owner (confirmed default 6) |
| C7 | Antigravity effort details | — | All antigravity effort sets are `[]`, so the picker collapses for antigravity. `DEFAULT_EFFORT.antigravity` stays but goes unused (same as `DEFAULT_EFFORT.gemini`). Per D7 the builder never emits `--effort`. | owner (confirmed default 7, as amended by D7) |
| C8 | Prune details | — | The gemini picker drops `gemini-3.7-flash` and `gemini-3.5-flash`; the antigravity picker drops `gemini-3.7-flash-{high,medium,low}`. The migration (numbered after 064) rewrites `tasks.model`, `agent_profiles.model`, and the `lastModel:gemini` / `lastModel:antigravity` preferences. Frozen snapshots aren't touched. Cursor keeps its Flash entries (C3). fx isn't affected (it has no 3.7/3.5 rows). | owner (confirmed default 8) |
| C9 | Docs | — | CLAUDE.md gets an **antigravity bullet** under "Agent command shape": tmux-hosted one-shot `agy -p … --output-format stream-json` per turn, resume via `--conversation <id>`, effort in the model id (no `--effort`, per D6/D7), `agy models` discovery appending discovered-only ids, Argon Ultra/Enterprise-only, install `brew install --cask antigravity-cli` / `agy update`, built-in row seeded **enabled** by 061. The README says "Six harnesses" and gains an Antigravity row (default Gemini 3.8 Flash (High)). The README gemini default cell stays Gemini 3.1 Pro (preview) (D1). | owner (confirmed default 9) |

## Completeness dispositions

| Item | Disposition | Owner or reason |
| --- | --- | --- |
| Gemini `gemini-4-argon` row + effort key | in this change | D2, C1 |
| Antigravity `gemini-4-argon-{high,medium,low}` rows | in this change | D3, D4, C2 |
| Cursor `CURSOR_MODEL_SPECS["gemini-4-argon"]` + migration 064 (variant → base + effort, incl. `lastModel:cursor` and agent profiles) | in this change | C3 |
| fx catalog-gated `google/gemini-4-argon` row, count retargets, e2e exclusion label | in this change | C4 |
| Antigravity effort table: all 21 rows → `[]` | in this change | D6 (owner swept in an existing bug) |
| Saved antigravity efforts on tasks + agent profiles → NULL (migration), and builder stops emitting `--effort` | in this change | D7 |
| Migrations must match antigravity/gemini rows by **harness kind** (join `harnesses.kind`), not the literal harness id, so additional-account harnesses are covered | in this change | repo convention (049 covered an additional `gemini-2` harness; investigation §5 `harnesses.kind`) |
| Prune `gemini-3.7-flash` + `gemini-3.5-flash` (gemini) and `gemini-3.7-flash-*` (antigravity), with a data migration → 3.8 Flash | in this change | D8, D9 |
| Antigravity docs gap (CLAUDE.md bullet, README "Six harnesses" + row) | in this change | D10, C9 |
| CLAUDE.md fx "nineteen" → "twenty" | in this change | C4 |
| Make Argon the gemini default / README gemini default cell | out of scope | D1. Owner keeps 3.1 Pro; revisit once the CLI registers Argon |
| `MODEL_MIN_CLI_VERSION.gemini` floor for Argon | out of scope | D2. A floor would block passthrough runs that work |
| Cursor 3.7/3.6/3.5 Flash entries | out of scope | Cursor still lists them live (re-check above); nothing deprecated on that harness |
| Antigravity `gemini-3.6-flash-*` and `gemini-3.1-pro-*` rows, gemini 2.5 rows, `gemini-3.8-flash-cyber` | out of scope | not deprecated upstream; owner confirmed 2.5 Pro stays (C1) |
| agy context-size setting (256K/512K/900K) | out of scope | C5. No field, no confirmed flag |
| Gemini 4 sibling ids (pro/flash/cyber) | out of scope | C5. Google publishes none |
| Flip Antigravity's built-in seed to disabled | out of scope | 061 enables it deliberately; docs describe it as-is (C9) |
| Live smoke of gemini / agy / fx Argon | out of scope | D5. Owner ships unverified and checks after merge |
| `docs/plans/add-gemini-3-8-flash.md` / `add-gemini-3-7-flash.md` still describe 3.7/3.5 rows | out of scope | old plans record what was true then; don't rewrite them |

No owner-deferred items.

## Assumptions still open

- **A1 — Gemini CLI passthrough works for an entitled account.** `gemini -m gemini-4-argon` on 0.64.0 reaches the backend unchanged (spike-proven in the bundle). It has not run end-to-end (no credentials on this machine, D5). If it's wrong, the row fails at launch with model-not-found, and the fix is a hint/floor change, not a reshape.
- **A2 — The agy id is `gemini-4-argon-{high,medium,low}`.** It follows the pattern (D3/D4) and is unconfirmed. If it's wrong, the three curated rows fail at `agy` launch, discovery still shows the real ids, and the fix is changing three literals plus their effort keys.
- **A3 — `agy` treats the effort suffix in the id as authoritative** and needs no `--effort`. If agy **requires** `--effort` for a model that doesn't encode effort in its id, D7's builder change removes the only way to send it. Today no curated row needs it; a future bare-id row would need the builder change undone.
- **A4 — Rewriting pinned 3.7/3.5 Flash data to 3.8 Flash is acceptable** even though Google itself routes 3.5 to 3.6 (D9). It's an upgrade for those users, and their task/profile/preference values change on migrate.
- **A5 — Migration numbering and grouping are the planner's call.** 064 = Cursor Argon normalization (fixed by precedent). The prune and the antigravity effort clear may share one migration or use two (one purpose per migration preferred). Each must be idempotent and leave frozen snapshots untouched.
- **A6 — Saved antigravity efforts on frozen profile snapshots / pipeline snapshots are harmless** after D7, because the builder ignores effort for antigravity. They are deliberately not rewritten (062 rule).
- **A7 — Vertex AI users** need the `global` location for Argon (`us-central1` 404s, per the PR author). agetor doesn't set a location; this isn't handled and isn't mentioned in the hint unless the planner finds a cheap place for it.
