# Grill — JSON export/import for Agents and Pipelines

| Field | Value |
| --- | --- |
| Date | 2026-10-01 |
| Source | Pipeline goal ("formatted JSON to export/import standalone Agents and/or entire Pipelines; keep the additional-account harness and its original harness") + `docs/plans/agents-pipelines-import-export-investigation.md` |
| Mode | interactive, answered by the owner (4 structured passes + a confirm-or-override list) |
| Flags | none |
| Slug | `agents-pipelines-import-export` |

## Settled by evidence (not asked)

- Today's `agetor pipeline export` writes a bare `PipelineInput` with `profileName` hints; no Agent settings, no harness info (`src/cli/commands/pipeline.ts:70-135`, spike).
- `POST /agent-profiles` 400s on a harness id that isn't a local row or one of the five built-in kinds (`server.ts:3752-3757`, `db.ts:1460-1485`); falling back to the kind resolves because a built-in's id equals its kind (spike).
- Fresh installs enable only `claude-code`; a disabled harness resolves but fails at Run (`orchestrator.ts:1413-1417`).
- `validatePipelineGraph` accepts any ≤128-char string as `agentProfileId` and drops unknown keys, so the file can use symbolic Agent refs (spike).
- Electrobun (pinned 1.18.1, latest 2.0.2) has no save dialog — only `openFileDialog`, clipboard, `showItemInFolder`.
- No migration is needed for the decided scope (provenance declined, D14).

## Decisions

| # | Topic | Question | Answer | Source |
| --- | --- | --- | --- | --- |
| D1 | Scope | Which surfaces? | **CLI and app.** CLI commands for Agents and Pipelines, plus Export/Import in Settings → Agents, Settings → Pipelines and the Pipelines page. | owner |
| D2 | Format | What can one file hold? | **One bundle format, any selection**: any number of Agents and Pipelines. Export one Agent, one Pipeline (with its Agents), a multi-select, or everything ("Export all"). | owner |
| D3 | Harness | File's harness id (e.g. `secondary-claude-code`, kind `claude-code`) is absent locally | **Fall back to the built-in harness of the same kind, with a warning.** The app preview lets the user pick any local harness **of that kind** instead; the CLI takes `--harness-map <fileId>=<localId>` (repeatable). | owner (free-text answer, confirmed via default #1) |
| D3a | Hygiene | Real harness/account ids from the owner's machine | **Never in code, tests, fixtures, docs or commit messages.** Only synthetic ids (`secondary-claude-code`, `claude-2`, …). The owner's own ids were examples, not requirements. | owner |
| D4 | Business rule | Imported Agent's name already exists (case-insensitive) | **Always rename**: import as "Name (imported)", "Name (imported 2)", … Never reuse, overwrite or skip a local Agent. Only clashing names are renamed. | owner |
| D4a | Business rule | Pushback: always-rename duplicates every Agent on a re-import of the same file | **Keep always rename** — owner accepts duplicates (they can be deleted afterwards). Exact-match reuse was offered and declined. | owner |
| D5 | Atomicity | How does import commit? | **Preview, then all-or-nothing.** Server import route with a dry run: the preview shows what will be created/renamed, which harness each Agent lands on, warnings, and the instructions; Confirm writes everything in one DB transaction. CLI: `--dry-run`. | owner |
| D6 | App export | Which export actions (no save dialog exists)? | **All three**: Save to `~/Downloads` and reveal in Finder; Copy JSON to clipboard; Pick a folder (native Open panel in folder mode) and write the file there. | owner |
| D7 | App import | Which ways in? | **All three**: Choose file (Open panel filtered to `.json`); Paste JSON (dialog with a text area); drag a `.json` file onto the Agents/Pipelines list. | owner |
| D8 | Business rule | Imported Pipeline's name already exists | **Rename like Agents** ("Name (imported)", …). CLI `--name` still overrides for a single pipeline. Today's 409 goes away for import. | owner |
| D9 | Harness | Fallback harness is disabled / not installed / logged out | **Warn, and offer to enable it**: the preview shows a warning plus an "Enable harness" toggle that enables a *disabled* harness as part of the import. Not-installed and logged-out only warn. The Agent always imports. CLI: warns; `--enable-harnesses` enables disabled fallback harnesses during import. | owner + default #11 |
| D10 | Version skew | Agent uses a harness **kind** this build doesn't know (e.g. a future `grok`) | **Pick a replacement**: the preview marks the Agent unresolved and the user re-binds it to **any** local harness; its model/mode/effort/fast/maxMode reset to that harness's defaults. Import can't proceed until every unresolved Agent is re-bound. CLI: error unless `--harness-map` covers it. | owner |
| D11 | Contract | Existing `agetor pipeline export` default | **Switch to the new bundle format.** Import still reads legacy files. Older builds can't read new files (accepted). | owner |
| D12 | CLI | Command shape | **Top-level + noun aliases**: `agetor export [--agent <ref>]… [--pipeline <ref>]… [--all] [--out <file>\|-] [--force]` and `agetor import <file\|-> [--dry-run] [--harness-map from=to]… [--name <n>] [--enable-harnesses]`. `agetor pipeline export/import` and a new `agetor profile export/import` remain as shortcuts producing/reading the same bundle. | owner |
| D13 | Data | Remember the file's original harness on the imported Agent? | **No — file only, no migration.** Once imported, the Agent is bound to the chosen local harness; re-export records that harness. | owner |
| D14 | Validation | Check models and skills on import? | **Warn, never block**: flag a model the target harness's discovered catalog doesn't list, and skills not discoverable at user level. The Agent still imports verbatim. | owner |
| D15 | Acceptance | E2E coverage | **App + CLI flows**: Playwright for export (Save to Downloads via a test-dir seam, Copy JSON, Pick a folder via the fake-pick seam), import (Choose file via `AGETOR_FAKE_PICK_REFS_DIR`, Paste, Drag), and the preview (harness fallback, enable-harness, rename, unknown-kind re-bind). CLI round-trip tests against a temp daemon/data dir. | owner |

### Confirmed defaults (owner: "Confirm all")

| # | Default |
| --- | --- |
| C1 | Fallback + picker per D3; only synthetic harness/account names anywhere in the repo (D3a). |
| C2 | Each exported Agent carries `harness: { id, kind, label }` — `kind` is the original built-in harness. Harness `home` / `bin` / `env` are **never** exported (secrets, machine paths, `bin` is a code-exec vector). |
| C3 | Local harness with the file's id **and** same kind → bind directly, no warning. Same id, different kind → treat as missing, fall back by the file's kind. Labels are never used for matching. |
| C4 | Ids are never imported — every Agent/Pipeline gets a fresh id; step/edge ids inside a graph are kept (graph-local). |
| C5 | A Pipeline export embeds every Agent it references (step Agents + delegation `subagents` Agents); an Agent used by several items appears once per bundle. A step whose Agent was deleted exports with no Agent and an export-time warning. |
| C6 | Envelope `{"format":"agetor-bundle","version":1,"exportedAt","agetorVersion","agents":[…],"pipelines":[…]}`, 2-space indent. File name `<name>.agetor.json` for a single item, `agetor-export-<date>.agetor.json` for several. Key is `agents` (UI term). No published JSON Schema file. |
| C7 | Import validation: 2 MB file cap; every `AGENT_PROFILE_LIMITS` / `PIPELINE_LIMITS` cap enforced; control characters rejected; unknown keys ignored; `version > 1` refused with "update agetor to import this file". |
| C8 | Legacy pipeline files (bare `PipelineInput` + `profileName` hints) still import through the same preview, keeping today's match-by-name behavior for Agents, labelled "legacy file". |
| C9 | Rename suffix " (imported)", " (imported 2)", … truncated to the name limit; the preview lets the user edit any target name before confirming. |
| C10 | The preview shows each Agent's and each step's instructions (collapsed) under a "this file is third-party content" note (prompt-injection carrier). |
| C11 | CLI non-interactive defaults: same-kind built-in fallback; `--harness-map` overrides; unknown kind with no mapping → error; disabled fallback → warning, `--enable-harnesses` enables it. |
| C12 | Never overwrite: Save to Downloads and Pick a folder number the file name on collision (`name (2).agetor.json`); CLI `--out` keeps refusing an existing file unless `--force`. |
| C13 | App placement: per-row Export on Settings → Agents, Settings → Pipelines and the Pipelines page; multi-select + "Export all" on each list; Import on each list accepts any bundle, and the preview shows everything it will create. |
| C14 | Out of scope: TUI; importing/recreating harness definitions; provenance storage (D13). |
| C15 | Docs updated in this change: `README.md` (:140, :177, :220-222), `CLAUDE.md` items 15 and 19, `docs/plans/pipelines.md`, `docs/plans/agent-profiles.md`, CLI usage topics (`src/cli/usage.ts`), and the fleet knowledge entry "agetor pipeline import matches Agents by NAME only". |

## Completeness dispositions

| Item | Disposition | Owner or reason |
| --- | --- | --- |
| Shared zero-runtime-import format module (types, builder, parser/validator, harness resolver) under `src/shared/` | in this change | needed by server, CLI and webview |
| Server export + import (dry-run + transactional commit) routes, harness-enable-during-import | in this change | D5, D9 |
| `agetor export` / `agetor import` + `profile export/import` + rewritten `pipeline export/import` | in this change | D11, D12 |
| CLI help/usage topics, `src/cli/index.ts` dispatch/help | in this change | D12 |
| App: Export (Downloads / Copy / Pick folder) and Import (Choose file / Paste / Drag) + preview dialog on all three list surfaces, multi-select + Export all | in this change | D1, D6, D7, C13 |
| `ApiNative.openFileDialog` `.json` filter + `test-native.ts`, Downloads test-dir seam | in this change | D7, D15 |
| Legacy pipeline-file read path | in this change | C8 |
| Model/skill discoverability warnings | in this change | D14 |
| Rewrite tests pinning the legacy export shape (`src/cli/commands/pipeline.test.ts:498-812`) + keep a legacy-import test | in this change | D11 |
| Playwright spec(s) + CLI round-trip tests | in this change | D15 |
| README / CLAUDE.md / plan docs / usage text / fleet knowledge entry | in this change | C15 |
| Scrub real harness ids from the investigation brief | in this change (done during this grill) | D3a |
| TUI export/import | out of scope | TUI has no Agent/Pipeline management surface at all — a different feature |
| Importing/recreating harness definitions (`home`/`bin`/`env`) | out of scope | security-sensitive separate feature (secrets, code-exec via `bin`) |
| Provenance column / later auto re-bind | out of scope | owner declined (D13) |
| Published JSON Schema file | out of scope | owner confirmed C6 |

## Assumptions still open

- **"Formatted JSON" = a defined, versioned, pretty-printed format** — implicitly confirmed by D2/C6; if the owner meant whitespace only, the envelope work is wasted but harmless.
- **"Original harness" = the base built-in kind** — implicitly confirmed by D3/C2; nothing in the DB records an Agent's earlier harness, so any other reading can't be met.
- **`<a download>`/Blob inside the packaged WKWebView is unverified** — D6 avoids depending on it (Downloads and Pick-a-folder are server-side writes; Copy uses `navigator.clipboard`). If the planner wants a Blob path, it must be tested in the real app first.
- **Reveal in Finder and the native Open panel are unavailable headless** (501). The planner must define what Save to Downloads does headless (likely: write succeeds, reveal skipped) and keep e2e on the existing seams.
- **Drag-a-file import** relies on the webview receiving `file://` URIs (the existing `refs/resolve` drop path); `capture-refs.ts` drops `/tmp` and `/var/folders`, so e2e fixtures must live outside temp dirs.
- **Exact-equality of "identical"** no longer matters (D4a), so no settings-diff rule is needed.
