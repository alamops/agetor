# Investigation — JSON export/import for Agents and Pipelines

| Field | Value |
| --- | --- |
| Date | 2026-10-01 |
| Change | Define one formatted, versioned JSON file that exports/imports standalone Agents (agent profiles) and/or whole Pipelines, carrying each Agent's harness id **plus its base harness kind** so a machine without that additional-account harness can still import. Informs the format, the import resolution rules, and which surfaces (CLI / app / API) get it. |
| Agents | Inline (this pipeline step forbids subagents): codebase, git history, web, 1 spike |
| Flags | none |
| Slug | `agents-pipelines-import-export` |

## 1. What we know

### 1.1 What exists today

- **Pipelines have a CLI-only export/import.** `agetor pipeline export <ref> [--out f] [--force]` and `agetor pipeline import <file|-> [--name n]` — `src/cli/commands/pipeline.ts:70-135`. The webview has no export or import of anything (no `<input type="file">`, no download code anywhere under `src/mainview`).
- **The exported file is a bare `PipelineInput`** (`name`, `description`, `graph`, `maxSteps`) with two additive hints per step: `profileName` and `subagents.profileNames` (`withProfileHints`, `pipeline.ts:606-626`). No envelope, no format name, no version, no Agent settings, no harness information.
- **Import matches Agents by name only** (`resolveImportProfiles`, `pipeline.ts:636-675`). An id that exists locally is kept; a missing id is remapped to the single local Agent with the hinted name (case-insensitive, trimmed); otherwise the dangling id is kept and a warning printed. The server never validates profile ids on `POST /pipelines`, so the run only fails at Run time (`buildSnapshot`, `src/bun/pipeline-runner.ts:427-456`).
- **Agents (agent profiles) have no export/import at all.** `agetor profile` is `ls | show | add | edit | rm` (`src/cli/commands/agent-profile.ts:10-123`). `profile show --json` prints the raw row, which carries only the harness **id**, not its kind.
- **README documents the by-name limitation** as current behavior (`README.md:140`, `README.md:177`), added by PR #251 the day before this task. Those paragraphs become wrong once Agent settings travel in the file.

### 1.2 Data shapes

- `AgentProfile` — `src/shared/types.ts:364-389`: `id` (per-DB `randomUUID()`), `name` (unique on `lower(trim(name))`), `harness` (harness **id**), `model`, `effort|null`, `mode|null`, `fast`, `maxMode`, `instructions` (≤20,000), `skills[]` (≤50 × ≤100 chars), timestamps, server-derived `taskCount`. Limits: `AGENT_PROFILE_LIMITS`, `src/shared/agent-profile.ts:24-29`.
- `Harness` — `types.ts:296-345`: `id` (slug, `/^[a-z0-9][a-z0-9_-]*$/`, `src/bun/db.ts:1421`), `kind` (`AgentKind` = `claude-code | codex | cursor | gemini | fx`, `types.ts:284`), `label`, `isBuiltin`, `home`, `bin`, `env`, `enabled`. For a built-in the id **equals** the kind.
- An additional-account harness is a user-created row with a user-chosen id. Curated templates suggest `claude-2`, `codex-2`, … (`HARNESS_TEMPLATES`, `types.ts:946-1006`); the id is free text. The owner has two such harnesses on their machine (both kind `claude-code`); their real ids must never appear in code, tests, fixtures or docs — use synthetic ids like `secondary-claude-code` or `claude-2`. "secondary-claude-code" in the task is an example id, not a built-in.
- `AgentProfileSnapshot` (`types.ts:397-411`) is the existing precedent for carrying harness identity alongside a profile: `harness` + `harnessKind` + `harnessLabel`. `snapshotFromProfile` builds it (`agent-profile.ts:187-207`).
- `Pipeline` / `PipelineGraph` / `PipelineStep` / `PipelineEdge` — `types.ts:423-501`. A step references Agents by DB id in `agentProfileId` and `subagents.profileIds`. Limits: `PIPELINE_LIMITS`, `types.ts:709-750`.
- `validatePipelineGraph` (`src/shared/pipeline.ts:322-516`) rebuilds every step/edge object from known keys, so unknown keys are dropped, and it accepts **any** non-empty string ≤128 chars as `agentProfileId`.

### 1.3 Server behavior that the import must respect

- `POST /agent-profiles` resolves the harness with `harnesses.getByIdOrKind` and answers **400 `unknown harness "<id>"`** when the id is neither a row nor a built-in kind (`src/bun/server.ts:3752-3757`). That is exactly what an imported Agent bound to `secondary-claude-code` hits on a machine without it.
- `harnesses.getByIdOrKind` (`db.ts:1460-1485`) falls back to a synthetic built-in only for the five hard-coded kinds.
- Name clashes: `agentProfiles.insert` throws `AgentProfileNameError` → 409 (`db.ts:1863-1888`); `pipelines.insert` throws `PipelineNameError` → 409 (`db.ts:2117-2140`).
- The db layer has no FK from `agent_profiles.harness_id` to `harnesses` — only the route validates it.
- A disabled harness still resolves; the refusal happens at start (`src/bun/orchestrator.ts:1413-1417`).
- `GET /info` returns the app version from `package.json` (`server.ts:3285-3288`; currently `1.0.0`) — available for file metadata.
- No migration is needed for an export/import feature: every field already exists. Latest migration is `060`.

### 1.4 Surfaces and native capabilities

- App list surfaces where buttons would live: Settings → Agents (`src/mainview/components/settings/AgentProfilesSection.tsx`), Settings → Pipelines (`PipelinesSection.tsx`), the Pipelines page (`src/mainview/components/pipelines/PipelinesPage.tsx`, which already has Edit / Duplicate / Delete per row and a `duplicateName` helper at `:185-196`).
- The TUI has no Agent or Pipeline management surface (no references under `src/cli/tui`).
- **Electrobun has no save dialog.** Repo pins `electrobun ^1.18.1`; latest on npm is `2.0.2`. Its `Utils` exposes `openFileDialog` (with `allowedFileTypes`, comma-separated, e.g. `"json"`), clipboard read/write, `showItemInFolder`, but the official docs state "None of the native SDKs currently exposes a save dialog." (https://framework.blackboard.sh/electrobun/apis/utils)
- `ApiNative.openFileDialog` (`server.ts:782-788`) does not currently pass `allowedFileTypes`. `POST /refs/pick` is the existing route that opens the native panel, with the `AGETOR_FAKE_PICK_REFS_DIR` test seam (`server.ts:5235-5283`) and 501 in headless.
- The webview already copies to the clipboard with `navigator.clipboard.writeText` (`src/mainview/App.tsx:1769`).

### 1.5 Prior art (web)

- n8n workflow export keeps credential **references** (id + name) and never the secrets; the importer re-binds credentials on the target instance. n8n imports ids verbatim, which overwrites same-id rows — a known footgun to avoid. (https://docs.n8n.io/hosting/cli-commands/, https://docs.n8n.io/courses/level-one/chapter-6/)
- Common practice for portable config files: a self-describing envelope with a format name and a schema version, validated on both export and import; secrets and machine-specific paths excluded; references by name rather than internal id.

## 2. What we proved

| Question | Verdict | Evidence (command → output) | Versions | Artifact |
| --- | --- | --- | --- | --- |
| Does today's pipeline export carry any harness or Agent settings? | **No** | `machine-a.ts` → step keys `id,name,instructions,agentProfileId,position,subagents,transition,join,profileName`; `contains harness info? false`; `contains model/instructions? false false` | bun 1.3.10, worktree @ 28a126d | `<scratchpad>/spikes/portable-import/` |
| What happens importing that file on a machine with no matching Agents? | Imports with dangling ids, warnings only | `machine-b.ts` → `remapped: 0 warnings: 2`; "agent profile … ("Secondary Worker") isn't defined on this machine" | same | same |
| Can an Agent bound to an additional-account harness be created where that harness is missing? | **No** (route 400) | `harnesses.getByIdOrKind("secondary-claude-code")` → `null` | same | same |
| Does falling back to the base kind resolve? | **Yes** | `getByIdOrKind("claude-code")` → `claude-code claude-code builtin: true enabled: true` | same | same |
| Is the fallback harness always usable on a fresh install? | **No** | built-ins on a fresh DB: `claude-code, codex(disabled), cursor(disabled), gemini(disabled), fx(disabled)` | same | same |
| Can the file use symbolic Agent references instead of DB uuids? | **Yes** | `validatePipelineGraph` accepts `agentProfileId: "agent:secondary-worker"`; unknown keys dropped: `true` | same | same |
| Does a kind from a newer build resolve? | **No** | `getByIdOrKind("grok")` → `null` (the owner's prod DB already has a `grok` kind from an unmerged branch) | same | same |
| Is the baseline suite green before any change? | **Yes** | `bun test` on pipeline CLI + agent-profile + shared pipeline tests → `379 pass, 0 fail` (after `bun install --frozen-lockfile`) | same | — |

Existing tests pin the **legacy** export shape (`cmdPipeline export: no --out prints PipelineInput JSON to stdout`, `src/cli/commands/pipeline.test.ts:498`). Changing the default export shape will fail them on purpose; they must be rewritten, and a legacy-file import test kept.

## 3. What we're assuming

- **"Formatted JSON" means a defined, versioned, pretty-printed file format** (2-space indent), not only whitespace formatting. If wrong: the envelope/version work shrinks to pretty-printing the current shape.
- **"Original harness" means the base built-in harness kind** the additional-account harness wraps (`claude-code` for `secondary-claude-code`). If wrong (e.g. it means "the harness the Agent had before a later edit"), nothing in the DB records that and the requirement cannot be met as stated.
- **A pipeline export embeds the full definition of every Agent it references** (step Agents and delegation Agents), so the file is self-contained. If wrong: the file stays name-only and the import keeps today's silent same-name risk.
- **Harness configuration (`home`, `bin`, `env`) never travels.** `env` can hold API keys, `home` is a machine path, and an imported `bin` would be a code-execution vector. Only `id`, `kind`, `label` are exported. If the owner wants harnesses recreated on import, that is a separate, security-sensitive feature.
- **Ids are never imported.** Every imported Agent and Pipeline gets a fresh id; step/edge ids inside a graph are kept (they are graph-local). If wrong, same-id overwrite semantics would need designing.
- **No DB migration is required.** If the owner wants provenance stored (e.g. "imported from", original harness id kept on the row for later re-binding), a new column is needed.
- **Legacy pipeline files stay importable.** They are distinguishable by having top-level `name` + `graph` and no format marker.
- Whether an `<a download>`/Blob download works inside the packaged WKWebView was **not verified** (Electrobun fires `download-*` webview events, destination unconfirmed). In-app export should not depend on it.

## 4. What we must ask the owner

1. **Surfaces.** CLI only, or CLI **and** the app (Settings → Agents, Settings → Pipelines, Pipelines page)? Today only the CLI has pipeline import/export and the app has none. The app has no save dialog available, which shapes Q2.
2. **In-app file handling, if the app is in scope.** Export options that work today: pick a destination folder with the existing native open panel and write `<name>.json` there; write to `~/Downloads` and reveal in Finder; copy JSON to the clipboard. Import options: native open panel filtered to `.json`; paste JSON; drag a file onto the list. Which ones?
3. **Missing-harness policy on import.** When the file says `harness: secondary-claude-code, kind: claude-code` and that id is absent: fall back to the built-in `claude-code` automatically with a warning, or let the importer choose among local harnesses of that kind (they may have their own second account under another id)? CLI needs a non-interactive default either way.
4. **Same id, different kind.** If a local harness has the same id but another kind, the proposal is to treat it as missing and fall back to the file's kind. Confirm.
5. **Fallback lands on a disabled or not-installed harness** (fresh installs enable only `claude-code`). Import anyway with a warning, or refuse?
6. **Unknown kind** (file from a newer build, e.g. `grok`). Skip that Agent with an error, fail the whole import, or import bound to a harness the user picks?
7. **Agent name collision.** Names are unique. When an imported Agent's name already exists locally: reuse the local one (today's pipeline behavior, silent settings drift), reuse only if settings are identical and otherwise import under a new name such as `Name (imported)`, overwrite the local one, or skip? Should the CLI get a flag to choose?
8. **Pipeline name collision.** Today it is a 409 and `--name` is the escape. Keep that, or auto-suffix like Duplicate does?
9. **File granularity.** One file type that can hold several Agents and several Pipelines (a bundle), or strictly one Agent per file and one Pipeline (plus its Agents) per file? Should "export all" exist?
10. **Atomicity and preview.** Should import be all-or-nothing and show a preview of what it will create / reuse / fall back on before writing? That points to a server-side import route with a dry-run mode instead of the CLI's current client-side sequence of REST calls.
11. **Backward compatibility of `agetor pipeline export`.** Switch its default output to the new format (legacy files still importable), or keep the old shape behind the default and add the new one under a flag?
12. **File vocabulary and name.** The UI says "Agent", the CLI says "profile". Should the file use `agents`? Preferred file extension/name convention (`<name>.agetor.json`?) and whether to publish a JSON Schema (`$schema`) for it.
13. **What else an Agent export should say about portability.** Skills are not validated anywhere today; should import warn when a skill named in the file isn't discoverable locally? Same question for a model id the local harness doesn't list.
14. **Provenance.** Should an imported Agent remember the original harness id so it can be re-bound automatically once the user later creates that harness? This is the only item that would need a migration.

## 5. Completeness inventory

- **Callers / code that changes**
  - `src/cli/commands/pipeline.ts:70-135` (export/import cases), `:271-296` (flag parsers), `:590-743` (`withProfileHints`, `resolveImportProfiles`, `parsePipelineFile`, `extractProfileHints`) — become the legacy reader or move to shared.
  - `src/cli/commands/agent-profile.ts:10-123` — new `export` / `import` subcommands; unknown-subcommand message at `:121`.
  - `src/cli/index.ts:59-61` (help text), `:192-196` (dispatch); `src/cli/usage.ts:166-234` (`profile`, `pipeline`, `pipeline export`, `pipeline import` topics; new `profile export` / `profile import` topics).
  - `src/cli/api-client.ts:344-421` and `src/mainview/lib/api.ts:521-548` — client methods if server routes are added.
  - `src/bun/server.ts` — optional new export/import routes next to `/agent-profiles` (`:3734`) and `/pipelines` (`:3915`); `ApiNative.openFileDialog` (`:782`) and `src/bun/index.ts:341` if a `.json` filter is wanted; `src/bun/test-native.ts:13`.
  - `src/bun/db.ts` — `agentProfiles.insert` (`:1863`), `pipelines.insert` (`:2117`), `harnesses.getByIdOrKind` (`:1460`); a transaction wrapper if import is atomic.
  - Webview: `AgentProfilesSection.tsx`, `PipelinesSection.tsx`, `PipelinesPage.tsx`, possibly `PipelineEditor.tsx` header and `SettingsDialog.tsx` props; `src/mainview/lib/agent-profiles.ts`, `src/mainview/lib/pipelines.ts` hooks need a refresh after import.
- **Propagation surface**
  - A new shared, zero-runtime-import module under `src/shared/` for the format: types, builder, parser/validator, resolver (house pattern: `issue-task.ts`, `clone-input.ts`, `at-refs.ts`).
  - `src/shared/types.ts` for the file types; `AGENT_PROFILE_LIMITS` and `PIPELINE_LIMITS` reused for validation; `AGENT_OPTIONS` keys as the known-kind set.
  - Fixtures: `src/cli/test-fixtures.ts`; e2e `fixtures.ts` fake-pick seam if the app imports through the native panel.
- **Existing data to backfill:** none. No schema change is implied unless Q14 is answered yes.
- **Docs / config / examples describing current behavior**
  - `README.md:140` (Portable bullet), `:177` (names only matter on import), `:220-222` (CLI summary lines).
  - `CLAUDE.md` item 15 (Agents, CLI parity paragraph) and item 19 (Pipelines, CLI parity paragraph: `export` writes `profileName` hints, `import` remaps by unique name).
  - `docs/plans/pipelines.md:24`, `:67` (D14), `:211`; `docs/plans/agent-profiles.md`.
  - Fleet knowledge entry "agetor pipeline import matches Agents by NAME only" needs updating after the change.
- **Tests that pin current behavior:** `src/cli/commands/pipeline.test.ts:498-812` (export/import/hints), `src/cli/commands/agent-profile.test.ts`, `src/cli/usage.test.ts`, `src/cli/agent-profile-daemon.test.ts`, `e2e/agent-profiles-*.spec.ts`, `e2e/pipelines-editor.spec.ts`.
- **What the change would orphan:** the `profileName` / `subagents.profileNames` hint format as the *written* shape (kept only as a legacy read path); the README's "by name only" guidance.

## 6. Runnability

- **Start locally:** `bun run dev:hmr` (Vite + Electrobun, data dir `~/.agetor-dev`, port 4318). Main-process changes need a restart of `bun run dev`. A fresh worktree needs `bun install` first (done in this worktree with `--frozen-lockfile`; tree is clean). Shell needs `export PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH"`.
- **Tests:** `bun run typecheck`; `bun test` (single file: `bun test src/cli/commands/pipeline.test.ts`). Tests that import `db.ts` must set `AGETOR_DATA_DIR` to a temp dir before import.
- **E2E harness:** Playwright, `bun node_modules/@playwright/test/cli.js test e2e/<spec> --reporter=list` (not `bunx`). One headless backend per worker; no native bridge, so native-panel routes return 501 unless a fake seam such as `AGETOR_FAKE_PICK_REFS_DIR` is used. Run only one Playwright process at a time on this machine.
- **CLI smoke caveat:** the CLI talks to whichever core is already listening, so a manual `agetor … import` from a worktree can write into the owner's real `~/.agetor`. Smoke only with a fresh `--data-dir` / dev data dir.

## 7. Risks & blast radius

- **Untrusted input.** An imported file is third-party content. Agent `instructions` and step `instructions` are injected into agent prompts, so a shared file is a prompt-injection carrier; a preview before import mitigates. Validation must reuse the existing caps, reject control characters, cap file size, and never accept `home` / `bin` / `env`.
- **Silent wrong-Agent binding.** Today's by-name remap can bind a step to a same-named local Agent with different settings. Embedding Agent definitions fixes it only if Q7 is answered with something other than "always reuse".
- **Partial imports.** A client-side sequence (create Agents, then the Pipeline) can leave orphan Agents if a later call fails. Server-side transaction avoids it.
- **Fallback to a disabled or logged-out harness** produces an Agent that imports cleanly and fails at first Run. Needs a visible warning at import time.
- **Version skew.** Files from newer builds may carry unknown kinds, models, modes, efforts. Models/modes/efforts already pass through verbatim; kinds do not.
- **Vocabulary.** CLI "profile" vs UI "Agent" must stay consistent with `docs/plans/task-details-agent-row.md`.
- **Electrobun gap.** No save dialog in 1.18.1 or 2.0.2; an in-app export must use a workaround, and e2e needs a seam for any native panel.
- **Rollback.** Additive feature with no schema change (unless Q14); reverting the code is sufficient. Files written in the new format would not be readable by an older build.
