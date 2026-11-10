# Grill — Add Fable 5.2 to the supported harnesses

| Field | Value |
| --- | --- |
| Date | 2026-11-09 |
| Source | Pipeline task title — *"Add Fable 5.2 to the supported harnesses — Claude Code, primarily"* — plus `docs/plans/add-fable-5-2-investigation.md` |
| Mode | interactive via decision form, answered by the owner in 2 rounds |
| Answers | `docs/plans/add-fable-5-2-grill/round-1/answers.json`, `docs/plans/add-fable-5-2-grill/round-2/answers.json` |
| Flags | none |
| Spec | no external spec; the task title and the investigation brief are the contract |

Both one-way-door questions (Cursor migration 084 and the Fable 5.1 variant backfill) were answered by the owner in round 1. Nothing is unratified.

> Merge note (2026-11-09): main's harness-stacks migrations took 084/085, so this plan's Cursor migration shipped as **086**. Decisions and owner answers below are unchanged.

## Decisions

| # | Topic | Question | Answer | Source | Confidence |
| --- | --- | --- | --- | --- | --- |
| 1 | Harness scope | Which harnesses get a curated Fable 5.2 row? | **Claude Code + Cursor + fx (`catalogOnly`)**. | owner (`round-1/answers.json#harness-scope`; accepted recommendation) | High |
| 2 | Mythos 5.2 | Add the org-gated twin, or leave the Mythos block at 5.1/5? | **Add `mythos-5.2`**, Claude Code only. | owner (`round-1/answers.json#mythos-5-2`; overrode the leave-out recommendation) | Owner call |
| 3 | Default model | Keep Opus 5.5 or make Fable 5.2 the default? | **Keep `opus-5.5`**. Fable 5.2 remains one click away at 2× the usage. | owner (`round-1/answers.json#default-model`; accepted recommendation) | High |
| 4 | Picker order | Where does Fable 5.2 sit? | **Keep family grouping**: Mythos 5.2, Mythos 5.1, Mythos 5, Fable 5.2, Fable 5.1, Fable 5, Opus 5.5… | owner (`round-1/answers.json#picker-order`; accepted recommendation) + decision 2 | High |
| 5 | Fable hint copy | How should the Fable hints change? | **`family-standard`**: add Fable 5.2 with the current Fable wording; demote 5.1 to "Prior Fable release" and 5 to "Earlier Fable release"; leave every multiplier as-is. | owner (`round-1/answers.json#hint-copy`; overrode `family-corrected`) | Owner call |
| 6 | Mythos hint copy | How should the Mythos block read now that 5.2 is added? | **Mirror the Fable pattern**: 5.2 gets the twin sentence; 5.1 becomes "Prior Mythos release — Fable 5.1's twin…"; 5 unchanged. | owner (`round-2/answers.json#mythos-copy`; accepted recommendation) | High |
| 7 | Cursor migration 084 | Include the normalization migration? | **Include 084**: five plain 5.2 variants → base id + effort + `speed='off'`, kind-joined, idempotent. | owner (`round-1/answers.json#cursor-migration`; accepted recommendation; one-way door answered) | High |
| 8 | Fable 5.1 Cursor backfill | Fold the pre-existing 5.1 gap into 084? | **Include the five plain 5.1 variants** in 084; leave `-thinking-*` untouched. | owner (`round-1/answers.json#cursor-backfill-51`; accepted recommendation; one-way door answered) | High |
| 9 | fx row | What shape? | **`anthropic/claude-fable-5.2`**, label "Claude Fable 5.2", generic premium hint, `catalogOnly: true`, effort `[max, xhigh, high, medium, low, auto]`; update 26→27 catalogOnly / 42→43 curated counts and the fx e2e exclusion list; **no new positive e2e test**. | owner (`round-1/answers.json#fx-row`; accepted recommendation) | High |
| 10 | Cursor spec | What shape? | **One `CURSOR_MODEL_SPECS['claude-fable-5-2']`** with the five plain effort ids, `supportsMaxMode: true`, no `fastEfforts`, no `-thinking-*` ids; **no live Cursor spawn probe**. | owner (`round-1/answers.json#cursor-spec`; accepted recommendation) | High |
| 11 | Claude Code CLI floor | Add a minimum CLI version? | **No `MODEL_MIN_CLI_VERSION['claude-code']` entry**; an older CLI fails at spawn on the unknown id. | owner (`round-1/answers.json#cli-floor`; accepted recommendation) | High |
| 12 | Other harnesses | Copilot / Antigravity / OpenCode? | **No rows now**; record the Copilot follow-up in the completeness ledger. | owner (`round-1/answers.json#other-harnesses`; accepted recommendation) | High |
| 13 | Verification | What is the acceptance bar? | **`bun run typecheck`; targeted `types` / `agents` / `effort-support` / `claude-local-setting` / `migrate` / `orchestrator-paste-withheld`; `e2e/fx-models.spec.ts`; then full `bun test`** (re-run known flaky tmux tests once). | owner (`round-1/answers.json#verification`; accepted recommendation) | High |
| 14 | Definition of done | Any extra acceptance check outside the repo's model tables? | **None** — the listed scope is the definition of done. | owner (`round-2/answers.json#other-requirements-clarified`; accepted recommendation) | High |
| 15 | Pipeline config | Does `AGENTS_CONFIG.yml` need a version bump? | **No** — the `fable` alias resolves to 5.2 inside the installed CLI; a pipeline that wants a fixed version can pin `claude-fable-5-2` explicitly. | evidence (`docs/plans/add-fable-5-2-investigation.md` §1.7; `AGENTS_CONFIG.yml:7`) | Proven |
| 16 | OpenCode | Curated row? | **No** — OpenCode is catalog-scoped and already lists `opencode/claude-fable-5-2` through discovery. | evidence (`docs/plans/add-fable-5-2-investigation.md` §1.3) | Proven |

## Exact copy (owner-chosen)

Claude Code picker order and hints:

1. **Mythos 5.2** — `Fable 5.2's twin — same capability and cost; requires approved-org (Project Glasswing) access. Uses 2x the usage of Opus.`
2. **Mythos 5.1** — `Prior Mythos release — Fable 5.1's twin; same capability and cost; requires approved-org (Project Glasswing) access. Uses 2x the usage of Opus.`
3. **Mythos 5** — unchanged: `Prior Mythos release — Fable 5's twin; requires approved-org (Project Glasswing) access. Uses 2x the usage of Opus.`
4. **Fable 5.2** — `Most capable widely released model — above Opus. Uses 2x the usage of Opus.`
5. **Fable 5.1** — `Prior Fable release — above Opus. Uses 2x the usage of Opus.`
6. **Fable 5** — `Earlier Fable release — above Opus. Uses 2x the usage of Opus.`
7. **Opus 5.5** — unchanged; still the default.

The owner consciously chose to leave the multipliers as they are. Fable 5.1 and Mythos 5.1 are $10/$50 — 2.5× Opus 5.5's $4/$20, though still 2× Opus 5's $5/$25 — so their "2x" hints remain historical rather than current. This is a recorded owner decision, not a silent deferral.

## Completeness dispositions

| Item | Disposition | Owner or reason |
| --- | --- | --- |
| Claude Code: `fable-5.2` + `mythos-5.2` curated rows, `CLAUDE_MODEL_FLAG`, effort/mode maps, picker-family supersession, tests | In this change | owner (`round-1#harness-scope`, `#mythos-5-2`; `round-2#mythos-copy`) |
| Cursor: `claude-fable-5-2` spec, migration 084, Fable 5.1 plain-variant backfill, tests | In this change | owner (`round-1#harness-scope`, `#cursor-migration`, `#cursor-backfill-51`) |
| fx: `anthropic/claude-fable-5.2` catalogOnly row, effort entry, 26→27 / 42→43 counts, e2e exclusion list | In this change | owner (`round-1#harness-scope`, `#fx-row`) |
| Copilot Fable 5.2 | Out of scope — different ticket | Copilot CLI 1.0.108 has no Fable 5.2; follow up when its changelog names it. Owner chose the ledger (`round-1#other-harnesses`). |
| Antigravity Fable 5.2 | Out of scope — different ticket | The 1.5.1 binary carries no `claude-fable*` id; the harness has never carried Fable. |
| OpenCode Fable 5.2 | No work — already covered by discovery | `opencode models` lists `opencode/claude-fable-5-2`; OpenCode is catalog-scoped and has only its pinned default row. |
| Codex / Gemini | Not applicable | They run non-Anthropic model catalogs. |
| Existing `fable-5` / `fable-5.1` Claude Code tasks | No migration | `task.model` is a free string; both ids remain valid CLI models. 227 + 84 tasks keep launching their stored models. |
| Fable 5.1 / Mythos 5.1 "2x" multiplier correction | Out of scope — owner declined the copy correction | owner (`round-1#hint-copy` chose `family-standard`); the stale multiplier is recorded above, not silently deferred. |
| README default-model row | No change | Default stays Opus 5.5 (`round-1#default-model`). |
| `AGENTS_CONFIG.yml` / pipeline alias | No change | The `fable` alias resolves to 5.2 inside the CLI; no agetor config pins a version. |
| `CLAUDE.md` | No change | It contains no Fable-specific text. |
| `docs/architecture/harness-claude-code.md` superseded list | In this change | Add `fable-5.1` to the superseded ids; the "every Mythos id" wording stays true. |
| `docs/architecture/harness-fx.md` counts/ordinals | In this change | Re-count from the file: catalogOnly 26→27, curated 42→43, effort-advertising 40→41; refresh the dated history. |
| `docs/architecture/harness-copilot.md` | No change | No Fable 5.2 row or floor. |
| `docs/architecture/harness-cursor.md` | No change | It has no model list or count to update. |
| `e2e/fx-models.spec.ts` | In this change | Add "Claude Fable 5.2" to `EXCLUDED_FX_OPTION_LABELS`, re-count the "eighteen of the twenty-six" prose; the existing positive Fable 5.1 test stays; no new positive 5.2 test (owner `#fx-row`). |
| `e2e/agent-profiles-launch.spec.ts` | No change | The default stays Opus 5.5. |
| `src/bun/agent-discovery.test.ts` fx fixtures | No change | Historical probe fixtures, not a live catalog mirror. |
| `src/shared/types.test.ts` fx counts / effort table / catalogOnly list | In this change | Add `anthropic/claude-fable-5.2`; 42→43, 26→27, 40→41. |
| `src/bun/migrate.test.ts` | In this change | 083 → 084 becomes the last registered migration; add an 084 test cloning 076's shape. |
| `src/bun/agents.test.ts`, `effort-support.test.ts`, `claude-local-setting.test.ts`, `orchestrator-paste-withheld.test.ts` | In this change | BuildCommand, picker family, effort, display-name/parse, and the "target not offered" fixture move from `fable-5.1` to `fable-5.2`. |
| `MODEL_MIN_CLI_VERSION` | Explicit non-change | No Claude Code entry; an older CLI fails at spawn (`round-1#cli-floor`). |
| No live Cursor spawn probe | Explicit non-change | `supportsMaxMode` is inferred from the "1M" labels; if rejected, one flag/test changes (`#cursor-spec`). |
| Full `bun test` + typecheck + fx e2e | In this change (acceptance) | `round-1#verification`. |

## Assumptions still open

- **A1 — Cursor max mode works for Fable 5.2.** Every 5.2 label contains "1M", and Fable 5.1's spec has `supportsMaxMode: true`; no live `claude-fable-5-2[context=1m,effort=…]` spawn probe was run. If rejected, the fix is one flag/test assertion.
- **A2 — Claude 2.1.321's bare `/model` Fable row resolves to Fable 5.2.** Proven indirectly by the alias table (`fable.default = claude-fable-5-2`), `latest_per_family`, and the changelog; not smoked through the live picker. If the row still resolves to 5.1, the orchestrator's stdout sync self-corrects the row and breadcrumbs.
- **A3 — fx's effort set is `[max, xhigh, high, medium, low, auto]`.** From the public Gateway's `reasoning_options` plus fx's always-present `auto`; not ACP-probed. The driver validates at runtime and degrades to a status breadcrumb, never a failed turn.
- **A4 — Copilot will add Fable 5.2 in a later CLI release.** Today's 1.0.108 has no mention; if GitHub ships it silently server-side before a changelog entry, agetor will still only see it if the installed CLI's model list contains it (Copilot is not catalog-scoped). Re-check at that point.
- **A5 — No Claude Code CLI floor.** An older CLI fails at spawn on the unknown id; this is the accepted signal, not a pre-flight check.
- **A6 — The Cursor catalog measured 2026-11-09 (279 rows) may change before implementation.** Re-run `cursor-agent models` at implementation time; if the five plain ids or the "1M" labels changed, adjust the spec and migration.
- **A7 — The ids, price and effort are from Claude Code 2.1.321 on 2026-11-09.** If a later CLI renames `claude-fable-5-2` / `claude-mythos-5-2`, `CLAUDE_MODEL_FLAG` and the effort tables move with it.
- **A8 — Migration 084 is one-way.** It is additive/normalizing and data-clean on this machine (zero stored variant rows), but other users may have rows; rollback is a new migration, not a down-migration.
- **A9 — The `fable` pipeline alias is a CLI alias, not an agetor version pin.** Pipelines that need a fixed version should pin `claude-fable-5-2` explicitly.
- **A10 — The fx row is invisible on the owner's signed-in account.** Its catalog has zero `anthropic/*` ids; the row appears only for accounts whose discovered catalog contains it. It is still correct for those accounts.

## Next

`write-plan` — the plan should read this record, the investigation brief, and the two answer files. It must include the Fable 5.2 + Mythos 5.2 Claude Code work, the Cursor spec + 084 migration (including the 5.1 backfill), the fx `catalogOnly` row and counts, the tests, the docs, and the Copilot ledger entry.
