# Plan — JSON export/import for Agents and Pipelines ("agetor bundle")

| Field | Value |
| --- | --- |
| Date | 2026-10-01 |
| Source | Pipeline goal + `docs/plans/agents-pipelines-import-export-investigation.md` + `docs/plans/agents-pipelines-import-export-grill.md` (D1–D15, C1–C15) |
| Flags | none |
| Gates | grilled + approved by owner (2026-10-01; the owner also confirmed planner decisions A1–A3 in §8) |
| Branch | `feature/import-and-export-agents-and-pipelines-f` (already cut) |
| Base SHA | `28a126d` |

## 1. Objective & success criteria

Ship one versioned, pretty-printed JSON file format (`agetor-bundle`, version 1) that carries any selection of
Agents (agent profiles) and Pipelines, plus export and import on the CLI and in the app.

Done means:

1. An Agent exports with `harness: { id, kind, label }`. An Agent bound to an additional-account harness
   (e.g. `secondary-claude-code`, kind `claude-code`) imports on a machine without that harness by falling back
   to the built-in harness of the same kind, with a warning (D3, C2, C3).
2. A Pipeline export embeds every Agent it references (step Agents and delegation Agents), once per file (C5).
3. Import is preview-then-commit: a server-side dry run shows what will be created, renamed and bound; the
   commit is one DB transaction — all or nothing (D5).
4. CLI: `agetor export`, `agetor import`, plus `profile export|import` and `pipeline export|import` shortcuts
   over the same bundle (D11, D12). Legacy pipeline files still import (C8).
5. App: per-row Export, multi-select, Export all and Import on Settings → Agents, Settings → Pipelines and the
   Pipelines page; export via Save to Downloads / Copy JSON / Choose folder; import via Choose file / Paste /
   drag (D1, D6, D7, C13).
6. `bun run typecheck` is green; the new unit, endpoint, CLI round-trip and Playwright tests pass; the tests
   that pinned the legacy export shape are rewritten, and a legacy-import test is kept.
7. No real harness or account id from the owner's machine appears in code, tests, fixtures, docs or commit
   messages — synthetic ids only (`secondary-claude-code`, `claude-2`, …) (D3a).

## 2. Context & constraints

Grounded in the worktree at `28a126d`. Full findings and spike evidence are in the investigation brief; the
anchors below are the ones the tasks build on.

**What exists**

- CLI-only pipeline export/import, client-side: `src/cli/commands/pipeline.ts:70-135`; flag parsers `:274-296`;
  hint writer/reader and legacy parser `:597-743` (`withProfileHints`, `resolveImportProfiles`,
  `parsePipelineFile`, `extractProfileHints`). Only `pipeline.ts` and `pipeline.test.ts` import these.
- `agetor profile` has `ls|show|add|edit|rm` only: `src/cli/commands/agent-profile.ts:10-124`.
- CLI entry and help: `src/cli/index.ts:59-61` (help), `:192-197` (dispatch); `src/cli/usage.ts:166-171`,
  `:204-234`, `:279-290`. Client methods: `src/cli/api-client.ts:369-422`.
- Routes: `POST /agent-profiles` validates the harness with `harnesses.getByIdOrKind` and 400s on an unknown id
  (`src/bun/server.ts:3752-3757`); `POST /pipelines` (`:3915-3962`); body validators `parseSkillsBody`
  (`:564-580`), `parsePipelineName/Description/MaxSteps` (`:642-705`); `PATCH /harnesses/:id` enable +
  `refreshHarnessModels` (`:3583-3591`); `/info` (`:3285-3288`).
- DB: `harnesses` (`src/bun/db.ts:1439-1577`; `getByIdOrKind` `:1460`, `setEnabled` `:1569`), `agentProfiles`
  (`:1839-1959`, `insert` `:1863`), `pipelines` (`:2097-2180`, `insert` `:2117`). All writes are plain `db.run`,
  so they join an enclosing `db.transaction` (precedents: `src/bun/orchestrator.ts:1581`, `src/bun/migrate.ts:112`).
  No FK from `agent_profiles.harness_id` to `harnesses`.
- Shared: `AgentProfile` (`src/shared/types.ts:364-389`), `Harness` (`:296`), `AgentKind` (`:284`),
  pipeline types (`:423-501`), `PIPELINE_LIMITS` (`:709-750`), `DEFAULT_MODEL` (`:2179`), `AGENT_OPTIONS`
  (`:3177`); `AGENT_PROFILE_LIMITS` and `normalizeSkillName` (`src/shared/agent-profile.ts:25-45`);
  `validatePipelineGraph` (`src/shared/pipeline.ts:322-516`) drops unknown keys and accepts any ≤128-char string
  as `agentProfileId`; `PIPELINE_CONTROL_CHAR_RE` (`:271`).
- Native bridge: `ApiNative.openFileDialog` (`src/bun/server.ts:782-788`) has no file-type filter;
  `src/bun/index.ts:341` passes its options straight to Electrobun's `Utils.openFileDialog`, which accepts
  `allowedFileTypes` (`node_modules/electrobun/dist/api/bun/core/Utils.ts:162-184`). `revealPath` exists
  (`server.ts:797`, `/reveal-path` `:5170-5202`). Headless has no native bridge (`startApiServer()` with no deps,
  `src/bun/headless.ts:213`). `/refs/pick` and its `AGETOR_FAKE_PICK_REFS_DIR` seam: `server.ts:5235-5283`.
  Server `idleTimeout` is 255 s (`:887`); long routes opt out with `server.timeout(req, 0)`.
- Harness status and catalogs: `checkAllHarnesses` (`src/bun/agent-status.ts:536`), `HarnessStatus`
  (`types.ts:817`), `getHarnessDiscoveredModels` (`src/bun/agent-discovery.ts:774`), `listAgentCapabilities`
  (`src/bun/commands.ts:733`).
- App surfaces: `src/mainview/components/settings/AgentProfilesSection.tsx:42-128`,
  `settings/PipelinesSection.tsx:25-145`, `pipelines/PipelinesPage.tsx:21-196`; mounted from
  `SettingsDialog.tsx:673`/`:703` and `App.tsx:2229`. List hooks share module caches:
  `src/mainview/lib/agent-profiles.ts:63`, `src/mainview/lib/pipelines.ts:67`. Webview API:
  `src/mainview/lib/api.ts:521-549`. Dialogs stack and only the topmost reacts to Escape
  (`src/mainview/components/ui/dialog.tsx:79-108`).
- Dropped non-image files reach the webview as readable `File` objects without a path — the existing drop
  ladder byte-uploads them (`src/mainview/lib/capture-refs.ts:260`, rung 3).
- Tests: endpoint tests boot `startApiServer()` on a unique port with `AGETOR_DATA_DIR` set before importing
  `db.ts` (`src/bun/pipelines-endpoint.test.ts:1-40`); CLI-against-real-server pattern in
  `src/cli/agent-profile-daemon.test.ts:1-70`. Ports 4594–4596 are free. Legacy-shape tests:
  `src/cli/commands/pipeline.test.ts:498-812`. E2E seams: `e2e/fixtures.ts:279-280`, `:359-361`, `:533`.

**Proved by spike (investigation §2, bun 1.3.10)**

- Today's export has no harness or Agent settings; an import on a machine without matching Agents leaves
  dangling ids.
- `harnesses.getByIdOrKind("secondary-claude-code")` → `null`; `getByIdOrKind("claude-code")` resolves.
- A fresh install enables only `claude-code`.
- `validatePipelineGraph` accepts symbolic Agent references.

**Constraints**

- Electrobun has no save dialog (1.18.1 pinned; 2.0.2 neither). Blob download inside the packaged WKWebView is
  unverified, so nothing depends on it.
- WKWebView allows about six connections per host and two are permanent SSE channels: no new SSE channel, and
  the app must not hold more than one bundle request open at a time.
- `src/shared/*` stays free of runtime imports from `src/bun` and `src/mainview`.
- No migration (D13).

## 3. Approach & key decisions

Decisions marked **[owner]** come from the grill; **[evidence]** rest on code or a spike; **[reasoning]** are
planner calls.

### K1. One server-owned path; CLI and app are thin clients [owner D5 + reasoning]

Format, validation and import planning are pure functions in `src/shared/`. The server gathers local state,
runs the planner, and commits in one transaction. Rejected: the CLI's current client-side sequence of REST
calls (partial imports, no atomicity); a webview Blob download (unverified in WKWebView).

### K2. File shape [owner C2, C4, C6]

```json
{
  "format": "agetor-bundle",
  "version": 1,
  "exportedAt": "2026-10-01T20:00:00.000Z",
  "agetorVersion": "1.0.0",
  "agents": [
    {
      "key": "secondary-worker",
      "name": "Secondary Worker",
      "harness": { "id": "secondary-claude-code", "kind": "claude-code", "label": "Claude Code (secondary)" },
      "model": "claude-opus-5-5",
      "effort": "high",
      "mode": null,
      "fast": false,
      "maxMode": false,
      "instructions": "…",
      "skills": ["write-plan"]
    }
  ],
  "pipelines": [
    {
      "name": "Review pipeline",
      "description": "",
      "maxSteps": 25,
      "graph": {
        "steps": [
          {
            "id": "s1", "name": "Plan", "instructions": "…",
            "agent": "secondary-worker",
            "position": { "x": 0, "y": 0 },
            "subagents": { "agents": [], "cap": null },
            "transition": "choose", "join": "any"
          }
        ],
        "edges": [],
        "startStepId": "s1"
      }
    }
  ]
}
```

- 2-space indent, trailing newline. No DB ids, timestamps or `taskCount`. Step and edge ids are kept
  (graph-local). Harness `home`/`bin`/`env` are never written and never read.
- `harness.kind` is the "original harness" from the goal: the built-in kind the additional-account harness wraps.

### K3. Symbolic Agent references [evidence + reasoning]

A step references an Agent with `agent: <key> | null`; delegation uses `subagents.agents: <key>[]`. Keys point
at `agents[].key`, are unique within the file, and are never stored. The exporter derives a key by slugging the
Agent name (`[a-z0-9-]`, ≤64 chars), falling back to `agent-<n>` and suffixing `-2`, `-3` on a clash. The
parser maps `agent` → `agentProfileId` and `subagents.agents` → `subagents.profileIds` on the raw object, then
runs the existing `validatePipelineGraph`, then checks every referenced key exists. Rejected: reusing the
internal field name `agentProfileId` in the public file (reads as a DB id).

### K4. HTTP contract (all routes `authed`, in `src/bun/server.ts`) [reasoning]

| Route | Body | Success | Errors |
| --- | --- | --- | --- |
| `POST /bundle/export` | `{ agentIds?: string[], pipelineIds?: string[], all?: boolean }` | 200 `{ bundle, text, filename, warnings: string[], counts: { agents, pipelines } }` | 400 bad body, empty selection, unknown id (named) |
| `POST /bundle/export/save` | selection + `{ target: "downloads" \| "folder" }` | 200 `{ path, filename, revealed: boolean, warnings, counts }` or `{ cancelled: true }` | 400 as above; 501 for `folder` with no native bridge and no seam; 500 `{ error }` on a write failure |
| `POST /bundle/pick-file` | `{}` | 200 `{ text, filename }` or `{ cancelled: true }` | 400 file over 2 MB or unreadable; 501 headless without the seam |
| `POST /bundle/import/preview` | `{ text: string, options?: BundleImportOptions }` | 200 `BundleImportPlan` | 400 `{ error, code }` (too large, invalid JSON, unrecognized, unsupported version, invalid) |
| `POST /bundle/import` | same | 201 `{ agents: AgentProfile[], pipelines: Pipeline[], enabledHarnesses: string[], warnings: BundleIssue[], plan }` | 400 as preview; 409 `{ error, plan }` when the plan has blocking issues or a name raced |

- `text` in the export response is the canonical serialization, so the CLI, Copy JSON and both save targets
  write byte-identical content.
- The server never writes to or reads from a client-supplied path. Save targets are the Downloads directory
  or a folder the native panel returned; Choose file reads only what the native panel returned.
- `pick-file` and `export/save` with `target: "folder"` hold the request while a native panel is open, so both
  call `server.timeout(req, 0)`.
- Request bodies over `2 × BUNDLE_MAX_BYTES + 64 KB` are refused by `Content-Length` before reading, mirroring
  `/screenshots`.

### K5. Harness resolution, per Agent [owner D3, D9, D10, C3, C11]

Evaluated in this order by the pure planner:

| Case | Result |
| --- | --- |
| `options.agentHarness[key]` or `options.harnessMap[file.harness.id]` names a local harness; file kind is known | bind it (`mapped`) if it has the same kind; a different kind is a blocking issue `harness-kind-mismatch` |
| same, but the file kind is unknown to this build | bind it (`rebound`); `model` → `DEFAULT_MODEL[kind]`, `effort`/`mode` → `null`, `fast`/`maxMode` → `false`; warning says the settings were reset |
| override names a harness that isn't local | blocking `unknown-local-harness` |
| no override; local harness has the file's id **and** kind | bind (`exact`), no warning |
| no override; kind known; id missing or id present with another kind | bind the built-in of that kind (`fallback`) + warning naming the file harness and the fallback |
| no override; kind unknown | `unresolved`, blocking `unknown-kind` until mapped |

Target-harness status then adds warnings only: disabled (with `canEnable`), not installed, logged out. A
disabled target is enabled inside the import transaction when `options.enableHarnesses` lists it (app toggle)
or is `"all"` (CLI `--enable-harnesses`). Labels are never used for matching.

### K6. Names [owner D4, D4a, D8, C9]

- Automatic: a clashing name (case-insensitive, trimmed; against local rows and against earlier items of the
  same import) becomes `Name (imported)`, then `Name (imported 2)`, …, truncated so the whole name fits the
  80-char limit. Non-clashing names are untouched.
- Explicit: a name the user typed in the preview, or CLI `--name`, must be free. A clash is a blocking
  `name-in-use` issue on that row rather than a silent suffix. **Owner-confirmed (A1, §8).**
- `options.singleName` (CLI `--name`) renames the file's only Pipeline, or — when the file has no Pipelines —
  its only Agent; anything else is blocking `name-not-applicable`.

### K7. App export without a save dialog; headless behavior [owner D6, C12 + reasoning]

- **Save to Downloads**: the server writes into `AGETOR_DOWNLOADS_DIR` when set (test seam, env wins), else
  `~/Downloads` (created if missing), then calls `native.revealPath`. Headless: the write still succeeds and the
  response carries `revealed: false`; the app toast then shows the full path instead of "Revealed in Finder".
- **Choose folder**: native Open panel in folder mode; with `AGETOR_FAKE_PICK_REFS_DIR` set the seam directory
  is used (same seam `/refs/pick` uses). Headless without the seam → 501.
- **Copy JSON**: `navigator.clipboard.writeText(text)` in the webview, as `App.tsx:1769` already does.
- Never overwrite: files are created with the exclusive flag (`wx`); on `EEXIST` the name becomes
  `name (2).agetor.json`, `name (3)…` (up to 999).
- File name: one selected item → `<slug-of-name>.agetor.json`; several → `agetor-export-YYYY-MM-DD.agetor.json`.

### K8. App import sources [owner D7 + evidence]

- **Choose file**: `POST /bundle/pick-file` (panel filtered with `allowedFileTypes: "json"`, single selection);
  with the fake-pick seam it returns the first `*.json` file (name order) in the seam directory.
- **Paste JSON**: a textarea in the dialog.
- **Drag**: the drop handler reads the dropped `File` with `file.text()` — no path and no server round trip.
  This replaces the grill's "file:// URI" assumption: the existing drop ladder already proves dropped file
  bytes are readable in this WKWebView, and it removes the temp-dir restriction on e2e fixtures.

### K9. Export UI is a small dialog, not a popover menu [reasoning]

Export opens `ExportBundleDialog`: a summary ("2 Agents, 1 Pipeline"), export-time warnings (C5), and three
buttons. A stacked `Dialog` gets Escape/Tab handling for free; a body-portaled menu opened from inside
Settings would let Escape close Settings as well (`dialog.tsx` only yields to popovers inside its own panel).

### K10. "Export all" [owner D2 + reasoning]

"Export all" exports everything — every Agent and every Pipeline — from any of the three lists; the dialog
summary states the counts. List-scoped export is the multi-select with a select-all checkbox.
**Owner-confirmed (A2, §8).**

### K11. Validation on import [owner C7]

`parseBundleText` rejects, with a specific message: text over 2 MB (UTF-8 bytes); invalid JSON; a non-object;
a `format` other than `agetor-bundle` (unless it is a legacy pipeline file, K12); a non-integer `version`;
`version > 1` ("update agetor to import this file"); more than 500 Agents or 200 Pipelines; empty file
("nothing to import"); any field over its `AGENT_PROFILE_LIMITS` / `PIPELINE_LIMITS` cap; a non-string skill;
duplicate or missing Agent keys; a step referencing an unknown key; `maxSteps` outside 1..200. Control
characters: C0 and DEL are rejected in identifier-like fields (names, keys, harness id/kind/label, model,
effort, mode, skills); multi-line text (Agent instructions, Pipeline description, step instructions) allows
only `\t`, `\n`, `\r`. Unknown keys are ignored.

### K12. Legacy pipeline files [owner C8]

A JSON object with no `format`, a string `name` and an object `graph` is a legacy `PipelineInput`. It parses to
a `ParsedBundle` with `legacy: true`, no Agents, one Pipeline, and the per-step `profileName` hints. The
planner keeps today's rule: an id that exists locally is kept; else a unique case-insensitive name match is
used; else the id stays dangling with a warning. The preview and the CLI label it "legacy file".

### K13. Commit [owner D5 + evidence]

`commitBundleImport` gathers async state (harness status, catalogs), then inside one `db.transaction`:
re-reads names and harness rows, re-runs the planner, throws if anything is blocking, enables the chosen
harnesses, inserts Agents (collecting key → new id), rewrites each graph's keys to ids, inserts Pipelines.
Any throw rolls everything back; a name race surfaces as 409. After commit it fires
`refreshHarnessModels(id)` for each newly enabled harness, as the PATCH route does.

### K14. Model and skill warnings — warn, never block [owner D14 + reasoning]

- Model: known ids for the target harness = its discovered catalog ∪ the curated `AGENT_OPTIONS[kind].models`
  rows that are not `catalogOnly`; when the discovered catalog is empty the `catalogOnly` rows count too.
  A model outside that set gets a warning. Rebound Agents are skipped (their model was reset).
- Skills: user-level skills from `listAgentCapabilities` with no workdir, only for kinds whose discovery
  implements skills (read `src/bun/commands.ts`; today claude-code and codex). Discovery failure → no warning.

### K15. CLI surface [owner D11, D12, C11]

```
agetor export [--profile <ref>]… [--pipeline <ref>]… [--all] [--out <file|->] [--force]
agetor import <file|-> [--dry-run] [--harness-map <fileId>=<localId>]… [--name <n>] [--enable-harnesses]
agetor profile  export <ref> [--out <file|->] [--force]      agetor profile  import <file|-> [same flags]
agetor pipeline export <ref> [--out <file|->] [--force]      agetor pipeline import <file|-> [same flags]
```

- `--profile` is the documented selector flag and `--agent` is accepted as an alias.
  **Owner-confirmed (A3, §8)** (D12 wrote `--agent`, but in the CLI `--agent` means the harness).
- Refs resolve client-side with `matchAgentProfileRef` / `matchPipelineRef`; the server receives ids.
- `export` without `--out` prints to stdout; an existing `--out` file is refused before any network call
  unless `--force`. `--all` excludes `--profile`/`--pipeline`; no selector at all is a usage error.
- `import` sends the text to `POST /bundle/import` (or `/preview` with `--dry-run`). Blocking issues print one
  line each plus the `--harness-map` hint and exit 1. Warnings print in yellow; `--json` prints the raw plan or
  result. Unknown flags throw (these commands write data).
- A 404 from a `/bundle/*` route prints "the running agetor core is older than this CLI — restart or update it".
- `withProfileHints` and the CLI-side `parsePipelineFile` / `resolveImportProfiles` are removed; the legacy
  read path lives in the shared module.

### K16. Pinned interfaces (tasks in the same wave code against these)

```ts
// src/shared/bundle.ts
export const BUNDLE_FORMAT = "agetor-bundle";
export const BUNDLE_VERSION = 1;
export const BUNDLE_FILE_EXT = ".agetor.json";
export const BUNDLE_MAX_BYTES = 2 * 1024 * 1024;
export const BUNDLE_LIMITS = { agents: 500, pipelines: 200, key: 128, harnessId: 128, harnessKind: 64,
  harnessLabel: 200, model: 200, effort: 100, mode: 100 } as const;
export interface BundleHarnessRef { id: string; kind: string; label: string }
export interface BundleAgent { key: string; name: string; harness: BundleHarnessRef; model: string;
  effort: string | null; mode: string | null; fast: boolean; maxMode: boolean; instructions: string; skills: string[] }
export interface BundleStep { id: string; name: string; instructions: string; agent: string | null;
  position: { x: number; y: number }; subagents: { agents: string[]; cap: number | null };
  transition: "choose" | "all"; join: "any" | "all" }
export interface BundlePipeline { name: string; description: string; maxSteps: number;
  graph: { steps: BundleStep[]; edges: PipelineEdge[]; startStepId: string | null } }
export interface BundleFile { format: typeof BUNDLE_FORMAT; version: 1; exportedAt: string; agetorVersion: string;
  agents: BundleAgent[]; pipelines: BundlePipeline[] }
export interface BundleSelection { agentIds: string[]; pipelineIds: string[]; all: boolean }
export function buildBundle(input: { selection: BundleSelection; profiles: AgentProfile[]; pipelines: Pipeline[];
  harnesses: Pick<Harness, "id" | "kind" | "label">[]; agetorVersion: string; now: Date }):
  { ok: true; bundle: BundleFile; filename: string; warnings: string[] } | { ok: false; error: string };
export function serializeBundle(bundle: BundleFile): string;            // 2-space indent + "\n"
export function numberedFileName(filename: string, n: number): string;  // n >= 2 → "name (n).agetor.json"
export interface LegacyStepHints { profileName: string | null; subagentProfileNames: (string | null)[] }
export interface ParsedBundlePipeline { name: string; description: string; maxSteps: number | undefined;
  graph: PipelineGraph;                                   // agentProfileId / profileIds hold Agent KEYS (or legacy ids)
  legacyHints: Record<string, LegacyStepHints> | null }   // keyed by step id; null for a bundle
export interface ParsedBundle { legacy: boolean; agents: BundleAgent[]; pipelines: ParsedBundlePipeline[];
  exportedAt: string | null; agetorVersion: string | null }
export type BundleParseErrorCode = "too-large" | "invalid-json" | "unrecognized" | "unsupported-version" | "invalid";
export function parseBundleText(text: string):
  { ok: true; bundle: ParsedBundle } | { ok: false; error: string; code: BundleParseErrorCode };

// src/shared/bundle-import.ts
export interface BundleIssue { code: string; message: string }
export interface BundleLocalHarness { id: string; kind: AgentKind; label: string; isBuiltin: boolean; enabled: boolean;
  available: boolean | null; loggedIn: boolean | null; reason: string | null; installHint: string | null }
export interface BundleLocalState { harnesses: BundleLocalHarness[]; knownKinds: string[]; agentNames: string[];
  pipelineNames: string[]; profiles: { id: string; name: string }[];
  knownModels: Record<string, string[] | null>;     // by local harness id; null = can't tell, no warning
  knownSkills: Record<string, string[] | null> }    // by local harness id; null = can't tell, no warning
export interface BundleImportOptions { harnessMap?: Record<string, string>; agentHarness?: Record<string, string>;
  agentNames?: Record<string, string>; pipelineNames?: Record<string, string>;   // pipeline index as string
  singleName?: string; enableHarnesses?: string[] | "all" }
export type HarnessResolution = "exact" | "fallback" | "mapped" | "rebound" | "unresolved";
export interface PlannedAgent { key: string; sourceName: string; name: string; renamed: boolean;
  fileHarness: BundleHarnessRef; resolution: HarnessResolution; harnessId: string | null;
  harnessKind: AgentKind | null; harnessLabel: string | null; candidateHarnessIds: string[];
  model: string; effort: string | null; mode: string | null; fast: boolean; maxMode: boolean;
  instructions: string; skills: string[]; warnings: BundleIssue[]; errors: BundleIssue[] }
export interface PlannedStep { id: string; name: string; instructions: string; agentKey: string | null;
  agentName: string | null; legacy: "kept" | "remapped" | "dangling" | null }
export interface PlannedPipeline { index: number; sourceName: string; name: string; renamed: boolean;
  description: string; maxSteps: number | undefined; steps: PlannedStep[]; graph: PipelineGraph;
  warnings: BundleIssue[]; errors: BundleIssue[] }
export interface PlannedHarness { id: string; kind: AgentKind; label: string; enabled: boolean; canEnable: boolean;
  willEnable: boolean; warnings: BundleIssue[] }
export interface BundleImportPlan { legacy: boolean; agents: PlannedAgent[]; pipelines: PlannedPipeline[];
  harnesses: PlannedHarness[]; localHarnesses: BundleLocalHarness[]; warnings: BundleIssue[];
  blocking: BundleIssue[]; canImport: boolean }
export function importedName(base: string, taken: ReadonlySet<string>, limit: number): string;
export function planBundleImport(parsed: ParsedBundle, local: BundleLocalState,
  options?: BundleImportOptions): BundleImportPlan;

// src/mainview/components/bundle/index.ts
export function ExportBundleDialog(props: { open: boolean; selection: BundleSelection | null; onClose: () => void }): JSX.Element | null;
export function ImportBundleDialog(props: { open: boolean; initialText?: string | null; onClose: () => void;
  onImported?: (result: { enabledHarnesses: string[] }) => void }): JSX.Element | null;
export function BundleToolbar(props: { selectedCount: number; totalCount: number; allSelected: boolean;
  onToggleAll: () => void; onImport: () => void; onExportSelected: () => void; onExportAll: () => void }): JSX.Element;
export function useBundleFileDrop(onText: (text: string) => void):
  { dropProps: { onDragOver: React.DragEventHandler; onDragLeave: React.DragEventHandler; onDrop: React.DragEventHandler }; dragging: boolean };
```

Client method names: webview `api.exportBundle`, `api.saveBundle`, `api.pickBundleFile`,
`api.previewBundleImport`, `api.importBundle`; CLI `client.exportBundle`, `client.previewBundleImport`,
`client.importBundle`.

Test ids (kebab-case): `bundle-import-open`, `bundle-export-all`, `bundle-export-selected`, `bundle-select-all`,
`bundle-row-select`, `bundle-row-export`; `bundle-export-dialog`, `bundle-export-summary`,
`bundle-export-warning`, `bundle-export-downloads`, `bundle-export-copy`, `bundle-export-folder`;
`bundle-import-dialog`, `bundle-import-choose-file`, `bundle-import-paste`, `bundle-import-paste-preview`,
`bundle-import-error`, `bundle-import-legacy`, `bundle-import-third-party-note`, `bundle-import-agent-row`
(`data-agent-key`), `bundle-import-agent-name`, `bundle-import-agent-harness`, `bundle-import-agent-instructions`,
`bundle-import-harness-row` (`data-harness-id`), `bundle-import-harness-enable`, `bundle-import-pipeline-row`,
`bundle-import-pipeline-name`, `bundle-import-warning`, `bundle-import-blocking`, `bundle-import-confirm`.
The Pipelines page root gains `data-testid="pipelines-page"`.

## 4. Work breakdown — implementation tasks

| ID | Goal | Owned files | Depends on | Acceptance |
| --- | --- | --- | --- | --- |
| T1 | Shared format module and import planner, with their unit tests | `src/shared/bundle.ts` (new), `src/shared/bundle.test.ts` (new), `src/shared/bundle-import.ts` (new), `src/shared/bundle-import.test.ts` (new) | — | Exports exactly K16. Zero imports outside `src/shared/`. `buildBundle`: embeds each referenced Agent once; selected Agents in name order, then pipeline-referenced ones in pipeline-then-step order; a step whose Agent is gone exports `agent: null` + warning; an Agent whose harness no longer resolves is skipped + warning; unknown selected id → `{ ok: false }`. `parseBundleText` enforces K11 and K12. `planBundleImport` implements K5, K6, K12, K14 and never throws. Round trip: `parseBundleText(serializeBundle(build(x)))` reproduces Agents and graphs. `bun test src/shared/bundle.test.ts src/shared/bundle-import.test.ts` and `bun run typecheck` pass. |
| T2 | Server: export, save, pick-file, preview and transactional import; `.json` filter on the native panel; Downloads seam; endpoint tests | `src/bun/bundle.ts` (new), `src/bun/server.ts`, `src/bun/index.ts`, `src/bun/test-native.ts`, `src/bun/bundle-endpoint.test.ts` (new, port 4594) | T1 | The five K4 routes behave per K4/K7/K8/K13/K14. `ApiNative.openFileDialog` gains optional `allowedFileTypes?: string` (existing callers unchanged). `src/bun/bundle.ts` holds the logic (`exportBundleFor`, `gatherBundleLocalState`, `previewBundleImport`, `commitBundleImport`, `writeBundleFile`, `bundleDownloadsDir`); the routes stay thin. `bun test src/bun/bundle-endpoint.test.ts` passes (cases in §5 TT-B). Existing `agent-profiles-endpoint`, `pipelines-endpoint`, `refs-endpoint`, `server-reveal-path` tests still pass. |
| T3 | CLI: `export`/`import` commands, `profile`/`pipeline` shortcuts, client methods, help; legacy writers removed; unit tests rewritten | `src/cli/commands/bundle.ts` (new), `src/cli/commands/bundle.test.ts` (new), `src/cli/api-client.ts`, `src/cli/commands/pipeline.ts`, `src/cli/commands/pipeline.test.ts`, `src/cli/commands/agent-profile.ts`, `src/cli/commands/agent-profile.test.ts`, `src/cli/index.ts`, `src/cli/usage.ts`, `src/cli/usage.test.ts`, `src/cli/test-fixtures.ts` | T1 (types), K4 contract | K15 implemented. `cmdExport`/`cmdImport` exported from `commands/bundle.ts` with pure flag parsers (`parseExportFlags`, `parseImportFlags`, `parseHarnessMap`) and pure printers (`importPlanLines`, `importResultLines`). `pipeline export/import` and `profile export/import` delegate to them. `withProfileHints`, `resolveImportProfiles`, `parsePipelineFile`, `extractProfileHints`, `ProfileHints` are gone from `pipeline.ts`. Help index lines, `USAGE` blocks (`export`, `import`, `profile export`, `profile import`, rewritten `pipeline export`/`pipeline import`, updated `profile`/`pipeline` first lines) and the unknown-subcommand messages are updated. `pipeline.test.ts:498-812` is rewritten against a mocked client. `bun test src/cli/commands src/cli/usage.test.ts` passes. |
| T4 | Webview building blocks: API methods, export dialog, import dialog with preview, toolbar, drop hook | `src/mainview/lib/api.ts`, `src/mainview/lib/bundle.ts` (new), `src/mainview/lib/bundle.test.ts` (new), `src/mainview/components/bundle/ExportBundleDialog.tsx` (new), `src/mainview/components/bundle/ImportBundleDialog.tsx` (new), `src/mainview/components/bundle/BundleToolbar.tsx` (new), `src/mainview/components/bundle/useBundleFileDrop.ts` (new), `src/mainview/components/bundle/index.ts` (new) | T1 (types), K4 contract | Exports and test ids per K16. `api.importBundle` and `api.saveBundle` use `retry: false`. Export dialog: fetches the summary on open, shows warnings, three actions with success/failure toasts (K7), closes on success. Import dialog: source step (Choose file, Paste) → preview step; re-previews (debounced, stale responses dropped, one request in flight) on every option change; per-Agent name input and harness select (same-kind candidates, or all local harnesses for an unknown kind); per-harness enable switch; collapsed instructions under a "third-party content" note (C10); legacy badge; Confirm disabled while `!plan.canImport`; closing with edited options asks to discard; on success refreshes `useAgentProfiles` and `usePipelines`, toasts counts and warnings, calls `onImported`. Only semantic status tokens (`text-warning`, `bg-danger/10`, …). Pure helpers in `lib/bundle.ts` (option reducers, summary strings, `.json` file picking from a `FileList`) are unit-tested. `bun run typecheck` passes. |
| T5 | Mount export/import on the three lists | `src/mainview/components/settings/AgentProfilesSection.tsx`, `src/mainview/components/settings/PipelinesSection.tsx`, `src/mainview/components/pipelines/PipelinesPage.tsx`, `src/mainview/components/settings/SettingsDialog.tsx`, `src/mainview/App.tsx` | T4 | Each list has: `BundleToolbar` (Import, Export all, Export selected, select-all), a checkbox and an Export button per row, a drop zone that opens the import dialog with the dropped file's text (a non-`.json` or over-2 MB drop toasts an error), and one `ExportBundleDialog` + one `ImportBundleDialog` instance. Row Export on an Agent selects `{ agentIds: [id] }`; on a Pipeline `{ pipelineIds: [id] }`. Selection is cleared when a selected row disappears. The lists refresh after an import. After an import that enabled a harness, Settings → Harnesses shows it enabled without reopening Settings (thread the existing harness reload through `onImported`; that is the only reason `SettingsDialog.tsx` / `App.tsx` are owned). Existing test ids and behaviors on the three surfaces are unchanged. `bun run typecheck` passes; `e2e/agent-profiles-settings.spec.ts` and `e2e/pipelines-editor.spec.ts` still pass. |
| T6 | Docs | `README.md`, `CLAUDE.md`, `docs/plans/pipelines.md`, `docs/plans/agent-profiles.md` | T2, T3, T4 | README: the "Portable" bullet (`:140`), the "names only matter on import" paragraph (`:177`) and the CLI summary (`:220-222`) describe the bundle, the harness fallback and the new commands. CLAUDE.md: items 15 and 19 CLI-parity text updated; a new item 20 documents the bundle format, routes, resolution rules, the `AGETOR_DOWNLOADS_DIR` seam, the fake-pick reuse and the tests; the env-seam list mentions the new variable. The two older plan docs get a short dated note pointing at this plan where they describe export/import. Only synthetic harness ids appear. |

Notes for the executors:

- T2: `agentProfiles.insert` and `pipelines.insert` are called unchanged inside the transaction; do not add a
  second insert path. Keep `harnesses.getByIdOrKind`'s synthetic built-in in mind — a built-in row can be
  absent, and then it reads as enabled.
- T2: `filename` is always a slug the server derived; never join a client string into a path.
- T3: the CLI talks to whichever core is already listening. Do not smoke-test against the owner's running
  core; use the unit tests and TT-C, or a fresh `--data-dir`.
- T4/T5: `PromptComposer.tsx` contains a zero-width space, so BSD `grep` treats it as binary; use the Grep
  tool when searching `src/mainview`.
- All: no `git stash`; never touch files outside the owned list; assert the match count of any scripted edit.

## 5. Work breakdown — test tasks

| ID | Layer | Covers | Owned files | Acceptance |
| --- | --- | --- | --- | --- |
| TT-A | unit | T1 | `src/shared/bundle.test.ts`, `src/shared/bundle-import.test.ts` (written inside T1) | Build: single Agent; Pipeline embedding step + delegation Agents once; multi-select dedupe; `all`; deleted-Agent step; key slugging and clashes; file names. Parse: every K11 rejection with its code; unknown keys ignored; `harness.home/bin/env` in the file never surface; legacy file with hints. Plan: every K5 row; status warnings; `enableHarnesses` list and `"all"`; rename chain `(imported)`, `(imported 2)`, truncation at 80; clash between two items of the same file; explicit-name clash; `singleName` cases; legacy kept / remapped / ambiguous / dangling; model and skill warnings incl. `null` (no warning). |
| TT-B | integration (HTTP) | T2 | `src/bun/bundle-endpoint.test.ts` (written inside T2) | Export by ids / `all` / unknown id 400. Save to Downloads with `AGETOR_DOWNLOADS_DIR` → file content equals `text`, second save is numbered, headless `revealed: false`, with `makeTestNative` `revealed: true`. Folder target: seam directory used; no native + no seam → 501; native returning `[]` → `cancelled`. Pick-file: seam returns the first `.json`; over 2 MB → 400. Preview: fallback warning for `secondary-claude-code`; a real local `secondary-claude-code` row of kind `claude-code` binds exact; same id with another kind falls back. Import: creates Agents + Pipeline with rewritten step ids; second import renames; unknown kind → 409 with plan, then succeeds with `harnessMap` and reset settings; `enableHarnesses` flips a disabled built-in; **atomicity** — a bundle whose last Pipeline fails at insert leaves zero new Agents and the harness still disabled; legacy file import; oversized body refused; no bearer token → 401. |
| TT-C | integration (CLI ↔ real server) | T2 + T3 | `src/cli/bundle-daemon.test.ts` (new, port 4595) | In-process `startApiServer()` with a temp data dir, mocked `getClient`/output as in `agent-profile-daemon.test.ts`. Round trip: create a `secondary-claude-code` harness + Agent + Pipeline → `agetor export --all --out f` → delete all three → `agetor import f --dry-run` prints the fallback warning and creates nothing → `agetor import f` creates them bound to `claude-code` → `agetor import f` again creates `(imported)` copies. Also: `pipeline export` / `profile export` output parses as a bundle; `profile import`; `--harness-map`; unknown kind without a map exits non-zero with the hint; `--enable-harnesses`; `--name` on a single-pipeline file; legacy file via `pipeline import`; `--out` refusal without `--force`; `--json` shapes. |
| TT-D | e2e (Playwright) | T2 + T4 + T5 | `e2e/bundle-export-import.spec.ts` (new), `e2e/fixtures.ts` | Fixture adds `AGETOR_DOWNLOADS_DIR=<dataDir>/fake-downloads` and exposes `backend.downloadsDir`. Flows: (1) Settings → Agents row Export → Save to Downloads writes `<slug>.agetor.json` with `harness {id, kind, label}`; saving again writes `(2)`. (2) Copy JSON puts the same text on the clipboard. (3) Choose folder writes into `backend.fakePickDir`. (4) Pipelines page: export a Pipeline → file embeds its Agents once and steps reference keys. (5) Multi-select and Export all. (6) Import by Paste of a bundle whose harness id is absent → fallback warning → Confirm → Agent row appears bound to Claude Code; importing again shows the `(imported)` name. (7) Import by Choose file (file planted in `fakePickDir`). (8) Import by drag (dispatch a `drop` whose `DataTransfer` carries a `File`). (9) Disabled fallback harness (`codex`) → warning + enable switch → after Confirm `GET /harnesses` reports it enabled. (10) Unknown kind → Confirm disabled until re-bound → imported Agent has the default model. (11) Edit a target name; a clashing name blocks Confirm. (12) Legacy file shows the legacy badge and imports. (13) Invalid JSON and `version: 2` show `bundle-import-error`. |

E2E: **applies** — the feature has user-visible flows crossing webview → HTTP → SQLite → filesystem, and the
app runs locally under the existing Playwright harness.

Run recipe:

```bash
export PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH"
bun install                       # fresh worktree only
bun run typecheck
bun test src/shared/bundle.test.ts src/shared/bundle-import.test.ts
bun test src/bun/bundle-endpoint.test.ts
bun test src/cli/commands src/cli/usage.test.ts
bun test src/cli/bundle-daemon.test.ts
bun node_modules/@playwright/test/cli.js test e2e/bundle-export-import.spec.ts --reporter=list
bun node_modules/@playwright/test/cli.js test e2e/agent-profiles-settings.spec.ts e2e/pipelines-editor.spec.ts --reporter=list
```

- Playwright starts Vite and a per-worker headless backend with fake agent drivers (`e2e/fixtures.ts`); no
  credentials, no seed data beyond what each test creates through the API. Run one Playwright process at a
  time on this machine. Use `bun node_modules/@playwright/test/cli.js`, not `bunx`.
- Check `uptime` before `bun test src/cli`: the daemon-spawn tests stall under load 30+. Run suites serially.
- Known failures on `main` that are not this change's: two tmux-socket tests and one reconcile-cancel test.
- A full `bun test` after the last wave is the final gate, with those three reported as pre-existing.

## 6. Execution waves

| Wave | Tasks (parallel) | Barrier |
| --- | --- | --- |
| 1 | T1 (+TT-A) | `bun run typecheck`; shared tests green; commit |
| 2 | T2 (+TT-B), T3, T4 | `bun run typecheck`; `bun test src/shared src/bun/bundle-endpoint.test.ts src/cli/commands src/cli/usage.test.ts src/mainview/lib/bundle.test.ts`; existing endpoint tests named in T2; commit |
| 3 | T5, TT-C, T6 | `bun run typecheck`; `bun test src/cli/bundle-daemon.test.ts`; the two existing e2e specs named in T5; commit |
| 4 | TT-D | new e2e spec green; full `bun test`; commit |

Owned-file cross-check: no path appears twice within a wave. Wave 2's three tasks touch `src/bun/*`,
`src/cli/*` and `src/mainview/{lib,components/bundle}/*` respectively. Wave 3 touches three surfaces +
`SettingsDialog.tsx` + `App.tsx` (T5), one new CLI test file (TT-C), and docs (T6). `e2e/fixtures.ts` has one
owner (TT-D). `src/shared/types.ts`, migrations, `package.json` and lockfiles are not touched by any task.

Every barrier is expected green. Wave 2 removes the legacy export shape and rewrites the tests that pinned it
in the same task (T3), so there is no knowingly red checkpoint. T4's components are unused until wave 3, which
typecheck allows.

After wave 4 the orchestrating agent (not a subagent) updates the fleet knowledge entry "agetor pipeline import
matches Agents by NAME only" to describe the bundle behavior and records a workdone entry (C15).

## 7. Blast radius & risks

- **CLI contract change (accepted, D11).** `agetor pipeline export` output changes shape; `pipeline import
  --json` now prints an import result instead of a bare pipeline. Files written by this build are not readable
  by older builds. Legacy files stay importable.
- **Untrusted input.** A bundle is third-party content and its instructions are injected into agent prompts.
  Mitigations: strict validation (K11), the preview with a third-party note (C10), harness `home`/`bin`/`env`
  never read, no client-supplied filesystem paths (K4), body-size caps.
- **Always-rename duplicates on re-import (accepted, D4a).** The preview shows the renamed targets.
- **Harness enable is a side effect of import.** It happens only on explicit opt-in and inside the same
  transaction; the post-commit catalog refresh is fire-and-forget.
- **Preview cost.** The preview probes harness status and user-level skills. Both are already polled by the
  app; skill discovery is wrapped fail-open. If preview latency is noticeable, cache the gathered state for a
  few seconds inside `src/bun/bundle.ts` — no contract change.
- **WKWebView connection budget.** The import dialog keeps one request in flight and adds no SSE channel.
- **Native-panel routes hold a request open.** They opt out of the idle timeout; the app disables the button
  while pending.
- **Drag in the packaged app.** K8 rests on the existing drop ladder reading dropped file bytes; the e2e drop
  is synthetic. A manual drag from Finder in `bun run dev` is part of the final check (§8, A4).
- **Stacked dialogs in Settings.** Export and import dialogs open above Settings and rely on `dialog.tsx`'s
  topmost-only Escape handling; e2e flow 1 exercises it.
- **Older running core.** A new CLI against an old core gets 404 on `/bundle/*`; the CLI prints an explicit hint.
- **Rollback.** Additive, no schema change; reverting the commits is enough.
- **Sibling paths left untouched on purpose.** `POST /agent-profiles`, `POST /pipelines`, the Pipelines page's
  Duplicate, and the pipeline runner are unchanged. The TUI has no Agent/Pipeline surface.

## 8. Open questions / assumptions

Planner decisions, confirmed by the owner when approving this plan (2026-10-01):

- **A1 — an explicitly typed name that clashes is an error, not a silent suffix** (K6). Automatic names are
  still always renamed. Rejected: treating the typed name as a base and suffixing it too.
- **A2 — "Export all" exports every Agent and every Pipeline from any list** (K10); list-scoped export is
  select-all + Export selected. Rejected: "Export all" scoped to the list it sits on.
- **A3 — the CLI selector flag is `--profile`, with `--agent` accepted as an alias** (K15). D12 wrote
  `--agent`, but everywhere else in the CLI `--agent` is the harness id. Help text documents `--profile`
  and mentions the alias once. Rejected: `--agent` only, `--profile` only.

Carried assumptions (still open):

- **A4** — dropped files are readable through the File API in the packaged WKWebView (evidence: the existing
  rung-3 blob upload). Verify by hand once in `bun run dev`; if it fails, fall back to `api.dragRefs()` plus a
  server-side read restricted to the drag pasteboard's paths.
- **A5** — count caps of 500 Agents and 200 Pipelines per file are generous enough for "Export all".
- **A6** — "formatted JSON" means a defined, versioned, pretty-printed format (grill, implicitly confirmed).
- **A7** — "original harness" means the base built-in kind (grill, implicitly confirmed).
- **A8** — `--name` also renames the only Agent of an Agents-only file, so `profile import --name` is useful.

Not open: every D1–D15 and C1–C15 item is settled in the grill record.

## 9. Completeness ledger

| Item | Disposition | Task ID / reason / who deferred |
| --- | --- | --- |
| Shared format module: types, builder, parser/validator, file naming | In this run | T1 |
| Import planner: harness resolution, renames, legacy matching, warnings | In this run | T1 |
| Server export / save / pick-file / preview / transactional import routes | In this run | T2 |
| Enable a disabled harness during import + post-commit catalog refresh | In this run | T2 |
| `ApiNative.openFileDialog` `.json` filter; `test-native.ts` | In this run | T2 |
| Downloads directory seam (`AGETOR_DOWNLOADS_DIR`) and headless behavior | In this run | T2 (server), TT-D (fixture) |
| `agetor export` / `agetor import` | In this run | T3 |
| `agetor profile export|import` | In this run | T3 |
| `agetor pipeline export|import` switched to the bundle | In this run | T3 |
| CLI client methods | In this run | T3 |
| CLI help index, `USAGE` topics, unknown-subcommand messages | In this run | T3 |
| Legacy pipeline-file read path (moved to shared; CLI copy removed) | In this run | T1 (reader), T3 (removal) |
| Orphaned code: `withProfileHints`, CLI `parsePipelineFile`, `resolveImportProfiles`, `extractProfileHints` | In this run | T3 deletes them |
| Tests pinning the legacy export shape (`pipeline.test.ts:498-812`) | In this run | T3 rewrites; legacy import kept in TT-A / TT-C |
| `usage.test.ts` assertions on the `profile` / `pipeline` usage lines | In this run | T3 |
| Webview API methods | In this run | T4 |
| Export dialog (Downloads / Copy / Choose folder), never-overwrite numbering | In this run | T4 (UI), T2 (numbering) |
| Import dialog: Choose file / Paste / preview / harness picker / enable switch / name edit / third-party note / legacy badge | In this run | T4 |
| Drag-a-file import | In this run | T4 (hook), T5 (drop zones) |
| Per-row Export, multi-select, Export all, Import on Settings → Agents | In this run | T5 |
| Same on Settings → Pipelines | In this run | T5 |
| Same on the Pipelines page | In this run | T5 |
| List refresh after import; harness list refresh after an enabling import | In this run | T4 (hooks), T5 (harness reload) |
| Model and skill discoverability warnings | In this run | T1 (rule), T2 (data) |
| Unknown-kind re-bind in app and CLI | In this run | T1, T3, T4 |
| Older-core 404 hint in the CLI | In this run | T3 |
| Endpoint tests | In this run | TT-B |
| CLI round-trip tests against a temp data dir | In this run | TT-C |
| Playwright spec for app export, import and preview | In this run | TT-D |
| README (`:140`, `:177`, `:220-222`) | In this run | T6 |
| CLAUDE.md items 15 and 19, new item 20, seam note | In this run | T6 |
| `docs/plans/pipelines.md`, `docs/plans/agent-profiles.md` pointers | In this run | T6 |
| Fleet knowledge entry "pipeline import matches Agents by NAME only" | In this run | Orchestrator, after wave 4 |
| Real harness ids scrubbed from the investigation brief | Done at the grill | D3a |
| Existing rows / backfill | Not applicable | No schema change; nothing to migrate |
| TUI export/import | Out of scope | The TUI has no Agent/Pipeline management surface — a different feature (C14) |
| Importing or recreating harness definitions (`home`/`bin`/`env`) | Out of scope | Security-sensitive separate feature (C14) |
| Provenance column / automatic re-bind when the harness appears later | Out of scope | Owner declined (D13) |
| Published JSON Schema file | Out of scope | Owner confirmed (C6) |
| Blob/`<a download>` export in the webview | Out of scope | Unverified in WKWebView; D6's three actions cover export |
