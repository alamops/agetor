# Investigation — Multi-repository tasks in one card (issue #291)

| Field | Value |
| --- | --- |
| Date | 2026-11-10 |
| Change | Add first-class multi-repository tasks: one card selects N project repositories, each materialized as its own worktree/branch inside a per-task workspace, driven by one agent conversation, with per-repo diff/status and per-repo pull requests. |
| Decision this informs | The task/workspace data model, the agent's cwd/layout, the create/edit scope, which harnesses are supported, and how diff/PR/CLI/pipeline surfaces carry a repo dimension. |
| Agents | 0 sub-agents (pipeline step forbids delegation) — codebase, git-history and web briefs run inline; 5 scratchpad probes + CLI flag checks |
| Flags | none |
| Branch / base | `feature/issue-291-feature-request-support-multip` off `c45fd806` (main, `release v1.2.0`); tree clean apart from this brief |
| Contract | **Outside the repo**: the issue body + 1 comment in `issue-291-thread.md` (and https://github.com/alamops/agetor/issues/291). The plan must land an in-repo spec; a reviewer cannot check code against a tracker tab. |
| Precedents | `docs/plans/full-github-integration.md` G8 (multi-repo aggregation in the GitHub dialog — list-only, `sourcePath` routing), `docs/plans/pipelines.md` (shared worktree across step rows), `docs/architecture/at-file-references.md` (cwd-scoped `@` resolution), `docs/architecture/task-lifecycle.md` (the one-worktree lifecycle). |

## 1. What we know

### 1.1 The request

- Issue #291, opened 2026-11-05 by @rodrigo-badaro, no labels, still open. The reporter's scenario is three separate repositories (Flutter frontend, Node backend, Docker Compose infra) and one task, "Implement user authentication".
- Six explicit asks:
  1. select multiple repositories when creating or editing a card;
  2. create an independent worktree/branch for each selected repository;
  3. let the AI agent access and modify all selected repositories in the same task;
  4. maintain shared context across repositories;
  5. track progress and changes for all repositories in one card;
  6. review changes and create separate pull requests per repository.
- The reporter also asks whether this is already possible. It is not. The owner replied on 2026-11-08: "I'm already planning how to do it in the best way. Ideally, we'd need to keep supporting worktrees even for multi projects." No design, acceptance criteria, or implementation commit exists yet (the pipeline branch is at main, `c45fd806`).
- The live thread could not be re-fetched here: `gh` is installed but not authenticated (`gh issue view` answers "please run gh auth login"). The supplied 1-comment snapshot is the authoritative thread for this investigation; if the owner replied again after 2026-11-08, it is not reflected below.
- The issue is a feature request, so there is nothing to "fix" in the bug sense. The characterization below (P1) is the reproduction: today a multi-repo payload is silently accepted and dropped, and exactly one worktree is materialized.

### 1.2 Today's task model is single-repository at every layer

**Data model**

- `Task` (`src/shared/types.ts:1878`) has one `workdir` (`:1890`), one `isolation` (`:1892`), one `branch` (`:1900`), one `worktreePath` (`:1910`), one `baseRef` (`:1917`), one `prUrl` (`:1926`) and one `checkoutBranch` (`:2217`). There is no repository array or child table.
- `TaskRow` (`src/bun/db.ts:85`) mirrors those as single columns. `tasks.insert` (`:1207`) and `tasks.update` (`:1249`) write them in the generic SET clause; `toTask` (`:1002`) returns them as scalars.
- `projects` (`src/bun/migrations/005_projects.sql:7`) is a flat known-paths table (`path` PK, `name`, `added_at`); it is a project picker, not a task↔repo relation.
- `WorktreeInfo` (`src/shared/types.ts:2340`) has one `id` = the task id, one `path`, one `branch`, one `workdir`. `TaskGitStatus` (`:2451`), `TaskDiff` (`:4947`) and `TaskTeardownPreview` (`:2430`) are all single-repo shapes.

**Creation**

- `CreateTaskInput` (`src/bun/orchestrator.ts:10904`) is a `Partial<Task>` plus `baseRef`/`existingBranch`/`issueUrl`/`issueSnapshot`/`agentProfileId`/`opencodeServer`/`pipelineId`. `POST /tasks` spreads the JSON body straight into it (`src/bun/server.ts:5843`), so an unknown `repositories` key is ignored — not rejected (proved, P1).
- `createTask` (`src/bun/orchestrator.ts:11015`) computes one `workdir` (`:11030`), one `repoRoot` (`:11038`), one base sha (`:11070`), one planned branch (`:11259`) from `projects.get(workdir)?.branchConfig`, and inserts one row (`:11298`).
- The New Task sidebar is create-only. `ProjectPicker` (`src/mainview/components/kanban/ProjectPicker.tsx:39`) is a single-value `SearchSelect`; `NewTaskForm` holds one `workdir` (`src/mainview/components/kanban/NewTaskForm.tsx:243`), one `useWorktreeOptions` (`:248`), and sends one `workdir` + one `worktreePayload()` (`:630`).
- The issue dialog (`CreateTaskFromIssueDialog.tsx:81`) and the CLI `agetor add` (`src/cli/commands/add.ts:206-224, 480`) are likewise single-project. `duplicateAgentProfile` re-creates tasks through `createTask` with only `workdir` (`src/bun/duplicate-agent-profile.ts:48-57`).

**Worktree lifecycle**

- `worktreePath(task)` is literally `<dataDir>/worktrees/<task-id>` (`src/bun/worktree.ts:842-844`). `prepareWorkdir` (`:948`) creates/reuses exactly one linked worktree, pins `task.branch`, resolves `task.baseRef`, and returns one `PreparedWorkdir` (`cwd`, `branch`, `worktreePath`, `checkoutBranch`, `checkoutKnown`).
- `startTaskInner` calls `prepareWorkdir` once (`src/bun/orchestrator.ts:2337`), persists `branch`/`worktreePath` in one transaction (`:2442`), and passes `prepared.cwd` to the spawn and `@` expansion (`:2350-2400`). Every later spawn path uses the same single expression, `task.worktreePath ?? task.workdir` (25+ sites; see §5).
- `sendInput` restores a missing worktree with one `prepareWorkdir` (`:7240`) and expands `@` against one cwd (`:7271`). `unarchiveTask` restores one worktree (`:11731`). `terminals.create` prepares one and spawns one shell (`src/bun/terminals.ts:202`). The pipeline runner prepares the parent's one worktree and copies it onto every step row (`src/bun/pipeline-runner.ts:984-1038, 1377-1382`).
- Archive detaches one worktree (`detachWorktree`, `src/bun/worktree.ts:1531`); delete removes one (`removeWorktree`, `:1453`); both call `repoRoot(task.workdir)` and `git branch -D task.branch`. `teardownBranchesForTask` (`src/bun/orchestrator.ts:11760`) plans one repo's branches; `sweepArchivedTeardowns` (`:12003`) and `discardRefusedWorktree` (`:11962`) assume one path.
- The teardown FIFO is keyed on the task's source `workdir` (`src/bun/orchestrator.ts:390-435`); `archiveTask`'s already-archived re-enqueue and the boot sweep gate on `task.worktreePath && existsSync(...)` (`:11609`, `:12003-12040`).
- `listWorktrees` (`:12209`) enumerates **direct children** of `WORKTREES_DIR` and treats each basename as a task id. `resolveWorktreeDir` (`:12289`) explicitly refuses `/`, `\`, `..` and requires a direct child; `deleteOrphanWorktree` (`:12317`) and `worktreeGitStatus` (`:12390`) share that guard. Any nested per-repo layout must extend this guard without weakening its `rm -rf` containment (there are dedicated regression tests in `src/bun/worktrees-list.test.ts:426` and `src/bun/worktree-git-status.test.ts:213`).
- `parseWorktreeGitPointer` (`src/bun/worktree.ts:860`) reads a `.git` pointer file to recover a worktree's source repo for orphan rows. A multi-repo **workspace root** is a plain directory, not a git worktree, so it parses as null.

**Diff, status, PR**

- `getTaskDiff` (`src/bun/worktree.ts:1177`) chooses one cwd: `task.worktreePath` for worktree isolation, else `task.workdir`. `GET /tasks/:id/diff` returns that one `TaskDiff` (`src/bun/server.ts:6678`); `getTaskDiffBlob` (`:6697`) and `DiffDialog` (`src/mainview/components/kanban/DiffDialog.tsx:514-522`) use the same one-scope memo.
- `GET /tasks/:id/git-status` computes one dir (`t.worktreePath ?? t.workdir`) and one status (`src/bun/server.ts:6870-6900`). The RunPanel's "Commit & push" / "Create PR" chips are driven by that one `TaskGitStatus` (`src/mainview/components/kanban/RunPanel.tsx:2910, 3684, 4740-4790`), and `commitPushPrompt` (`src/shared/types.ts:6359`) is a single-branch instruction shared by the webview and CLI.
- `GET /github/pull-create` stamps `tasks.pr_url` only when `task.workdir === dir` and `!task.prUrl` (`src/bun/server.ts:3255-3267`). The "View PR" prefill (`src/mainview/App.tsx:2288`, `src/mainview/components/kanban/GitHubDialog.tsx:199`) carries one `projectPath` and one `taskId`.
- The CLI mirrors the single shape: `agetor add --workdir` (`src/cli/commands/add.ts:114`), `agetor show` prints one `workdir` (`src/cli/commands/show.ts:84`), `agetor shell` uses one dir (`src/cli/commands/shell.ts:20`), `agetor rm` renders one branch list (`src/cli/commands/lifecycle.ts:219`).

**The only multi-repo code today is read-only GitHub aggregation**

- G8 (`docs/plans/full-github-integration.md:48`) lets `GitHubDialog` aggregate issues/PRs across already-registered projects. `listGitHubItemsAcrossRepos` (`src/bun/github.ts:1500`) tags each item with `sourcePath`, and the dialog resolves every per-item action as `item.sourcePath ?? projectPath` (`src/mainview/components/kanban/GitHubDialog.tsx:256, 522`).
- It is a useful precedent for repo-scoped item identity and per-item routing, but it touches no task, worktree, diff, or PR-stamping code.

### 1.3 Harness capability matrix (live probes + vendor docs, read 2026-11-10)

| Kind | How it can see a second directory today | Verified |
| --- | --- | --- |
| `claude-code` | `claude --add-dir <directories...>` (CLI, interactive REPL); `permissions.additionalDirectories` also exists. Vendor doc: "Add additional working directories for Claude to read and edit files." | `claude --help` on the installed 2.x binary lists `--add-dir`; docs.claude.com/en/docs/claude-code/cli-reference |
| `codex` | `codex --add-dir <DIR>` / `codex exec --add-dir <DIR>` ("Additional directories that should be writable alongside the primary workspace"); docs also recommend it over `danger-full-access`. | `codex --help` and `codex exec --help` on the installed binary; developers.openai.com/codex CLI reference |
| `gemini` | `context.includeDirectories` in `settings.json` ("Additional directories to include in the workspace context"); the settings file lives under the harness home agetor already isolates. A matching CLI include-directories flag is likely but was not exercised (gemini is not installed here). | Gemini CLI configuration reference (settings key verified; binary not installed) |
| `copilot` | `--add-dir=PATH` (repeatable) and `/add-dir` in-session; vendor doc. | docs.github.com Copilot CLI command reference (lines captured in the scratchpad probe log) |
| `antigravity` | Not verified; `agy` is not installed on this machine. Its Gemini lineage makes an include-directories mechanism likely but unproven. | absent from PATH |
| `cursor` | Interactive `cursor-agent --add-dir <path>` exists, but `cursor-agent acp` has **no** options, and the ACP `initialize` result advertises only `sessionCapabilities: { list: {} }` — **no `additionalDirectories`**. | live probe P4 on `cursor-agent` 2026.10.22-27dcf5f |
| `fx` | Interactive `fx --add-dir <path>` exists, but `fx acp --help` lists only `--model`, `--ultrafast`, `--log-file`; `initialize` advertises `{ list, resume, close, systemPrompt }` — **no `additionalDirectories`**. The live model also refused to read a file outside the session cwd, calling it "outside the current workspace". | live probes P4/P5/P6 on fx 0.0.15 |
| `opencode` | `opencode` / `opencode run` take a single positional directory; `session/new` carries one `location.directory`. No extra-root flag or ACP capability found. | `opencode --help`, `opencode run --help`, and the v2 server client in `src/bun/opencode-http.ts:410` |

- The ACP spec **does** define `sessionCapabilities.additionalDirectories` and an `additionalDirectories` param on `session/new`/`load`/`resume` (agentclientprotocol.com/protocol/session-setup). Current Cursor and fx binaries do not advertise it, so agetor must not send it speculatively.
- **Consequence:** a "keep the primary repo as cwd and pass the other worktrees as absolute paths" design is **not universal**. Four kinds (Claude, Codex, Gemini, Copilot) can be given extra roots by flag/settings; Cursor, fx and OpenCode cannot today. Those three are exactly the kinds where a cwd root set is the agent's workspace boundary (fx's refusal is direct evidence). A per-task **workspace root** that contains every repo as a subdirectory is the only layout that works for every harness without per-kind degradation.
- A workspace root is not a git repo. Probes show:
  - both `cursor-agent acp` and `fx acp` accept a non-git workspace root in `session/new` and return a normal session (P5);
  - `listProjectFiles({ dir: workspaceRoot })` returns `{ error: "not a git repository" }` (P2), so the `@` listing cannot be pointed at the workspace root unchanged;
  - `resolveAtPath(workspaceRoot, "frontend/a.ts")` resolves, while `resolveAtPath(workspaceRoot, "../outside/secret.ts")` returns null (P3). That containment is what makes a workspace-root `@` expansion safe, and it is why secondary worktrees must live **under** the workspace root, not beside it.

### 1.4 Security, process and persistence rules that constrain the design

- **Every route needs a `ROUTE_POLICY` entry**, and a CLI-reachable route that takes a filesystem path must declare `pathParams` (or `pathParamsExempt` with a reason) — `CLAUDE.md` "Security and process boundaries"; `src/bun/route-policy.ts:113-118`. `POST`/`PATCH /tasks` currently gate only `body.workdir` (`:368-375`), and `/files/index` gates only `?dir=` (`:415`). A new `repositories[]` array of paths, or a `repos` query, widens the set of folders the core touches on a CLI caller's behalf and must be gated (the TCC-disclaim rationale in `docs/architecture/security.md`).
- **Every spawn goes through `coreSpawn`/`coreSpawnSync`**; a raw `Bun.spawn` in `src/bun`/`src/shared` fails `core-spawn-allowlist.test.ts`. Creating N worktrees must use the existing `git()` helper in `worktree.ts:39`, not a new spawn path.
- **Agent-writable files are read with no-follow helpers** (`src/bun/no-follow.ts`), and, while disclaim is on, the core never touches a task directory in-process (`src/bun/task-dir-fs.ts`). Nested per-repo worktrees under `<task-dir>/<slug>` stay inside the existing task-dir containment; sibling directories would not.
- **Server-managed columns are skipped by the generic `tasks.update` SET clause and never bump `updated_at`** (`CLAUDE.md` "Data"; `docs/architecture/persistence.md`). `branch`/`worktreePath`/`baseRef` are already server-managed by being absent from `ALLOWED_PATCH_FIELDS` (`src/bun/server.ts:611-614`), but the code still writes them through the generic `tasks.update`. A `repositories` JSON column (or a `task_repos` table) needs the same deliberate treatment: who writes it, whether a targeted UPDATE is required, and whether a PATCH can clobber it. **Also note `CreateTaskInput extends Partial<Task>` and `POST /tasks` spreads the raw body** (`src/bun/orchestrator.ts:10904`, `src/bun/server.ts:5843`): adding `repositories` to `Task` silently makes it a client-supplied field on the create path; `createTask` must rebuild the array from validated `{path, baseRef, branch}` input, never trust server-managed per-repo fields (`worktreePath`, `checkoutBranch`, `prUrl`).
- **Migrations are append-only**: next number is `087` (`src/bun/migrations/index.ts` ends at `086_normalize_cursor_fable_5_2`); add a new `.sql` + `index.ts` entry, never edit an applied file. Existing rows can be read with a fallback instead of a data backfill.
- **`src/shared/` stays free of runtime imports from either process**; new repo/scope helpers that both sides use must be pure.
- **The Bun main thread is shared by every task, panel and pipeline**; N worktrees × N git spawns must not become a synchronous loop. `prepareWorkdir` is already async/awaits each git call; N repos multiplies wall-clock and must remain bounded/cooperative where it touches a spawn or restore path (`CLAUDE.md` "Runtime").
- **WKWebView allows ~6 HTTP/1.1 connections per host**, two permanent SSE. Per-repo diff/status polling must not open a stream per repo or fan out unbounded requests (the same rule that made the board keep one 2 s poll).
- **Prompt-text rule**: "Agetor never adds its own text to a message... The only machine-added text around a prompt is the references block heading, the `<agent_instructions_defined_by_the_user>` wrapper, the issue-thread untrusted-content warning, and the pipeline step prompt and handoff reminder." A new "Repositories:" block would be a **new exception**; reusing the existing "Referenced files/folders:" block with the repo worktree directories is compliant. This is an owner decision, not an implementation detail.
- **Worktree teardown is serialized per source `workdir`** (`enqueueTeardown`, `src/bun/orchestrator.ts:390-435`). A multi-repo task touches N source repos; either the queue key becomes the task's workspace (changing the serialization guarantee for unrelated tasks that share one repo) or one job per repo is enqueued, which changes ordering/atomicity.
- **Pipelines share one worktree across step rows** (`docs/architecture/pipelines.md:10`): step rows copy `workdir`/`isolation`/`branch`/`branchSource`/`worktreePath`/`baseRef` at insert, never run their own materialize, and never own teardown. Multi-repo must copy the repo array/workspace into every step row or refuse multi-repo pipelines.

### 1.5 UI, CLI and e2e surfaces that assume one repo

- **New Task**: `ProjectPicker` single-select (`ProjectPicker.tsx:39`), `useWorktreeOptions` single project (`WorktreeOptions.tsx:103`), `NewTaskForm` single `workdir`/`baseRef`/branch (`NewTaskForm.tsx:243-248, 824`), `fileScope` for the `@` popover single (`:293-300`), submit single payload (`:630`).
- **Create from issue**: the dialog is rooted at `context.path` and a single `useWorktreeOptions` (`CreateTaskFromIssueDialog.tsx:81-100`); the issue's own repo is necessarily one repo.
- **RunPanel**: one Project/Branch block (`RunPanel.tsx:8288`), one `gitStatus` poll (`:2910`), one `prHead` (`:3684`), one "Commit & push" prompt (`:3621`), one "Create PR" prefill (`:4773`), one `fileScope` (`:3851-3869`), one "Open in Finder"/file-picker root (`:4078, 4631, 4835`).
- **DiffDialog**: one `fileScope` and one `task.worktreePath ?? task.workdir` (`DiffDialog.tsx:508-522`); compose-from-diff emits repo-relative paths (`diff-selection.ts:108-121`) with no repo prefix.
- **Card/filter/context menu**: one project line (`TaskCard.tsx:336`), one branch (`:341`), repo filter compares only `t.workdir` (`App.tsx:1918`), text search includes only `t.workdir`/`t.branch` (`:1912`), context menu copies one branch/worktree path and shows one "View pull request" (`src/mainview/lib/task-context-menu.ts:161-175`).
- **Worktrees page**: one row per direct child, `id` = task id, `workdir` = task's one workdir (`WorktreesDialog.tsx:119-232, 503-560`; `listWorktrees`).
- **Composer `@` / discovery**: `fileScopeForTask` returns one `{dir, ref?}` (`src/shared/file-scope.ts:24`); `useProjectFiles` caches per `dir+ref` (`src/mainview/lib/use-project-files.ts:39`); `listProjectFiles` requires a git repo (`src/bun/project-files.ts:201-205, 378`); `resolveAtPath` rejects anything outside cwd (`:440-470`); `listAgentCapabilities` scans one workdir (`src/bun/commands.ts:557, 978`).
- **Transcript path display**: `shortenTaskPaths` folds only `[worktreePath, workdir]` (`RunPanel.tsx:3867`; `src/mainview/lib/shorten-task-paths.ts`); markdown images resolve against `[worktreePath, workdir]` (`src/mainview/lib/md-image.ts:106`); handoff artifacts resolve against the same roots (`src/mainview/lib/handoff-artifacts.ts`, `src/mainview/components/handoff/handoff-context.tsx`). For a multi-repo workspace, the **display** fold root must be the workspace root only — adding each repo worktree as a fold root would turn `workspace/frontend/src` into `@src` (longest root wins), which no longer resolves from the workspace cwd. Markdown-image/handoff **candidate** resolution can still use workspace + repo roots.
- **CLI/TUI**: `agetor add` has one `--workdir` (`add.ts:114`), `show` one workdir (`show.ts:84`), `shell` one dir (`shell.ts:20`), `rm` one branch preview (`lifecycle.ts:219`), TUI `@` completion one scope (`src/cli/tui/at-complete.ts:30`), TUI dashboard one compose scope (`Dashboard.tsx:196`).

## 2. What we proved

All probes ran from `/private/var/folders/ww/5s1q5h1d6kv4ycv8tl2yc23h0000gn/T/opencode/`; they read the repo and wrote only to scratch temp dirs.

| # | Question | Verdict | Evidence | Versions |
| --- | --- | --- | --- | --- |
| P1 | Does today's `createTask` accept multiple repositories? | **No — silently drops them** | Scratch probe `multi-repo-probe.ts` called `createTask({ workdir: frontend, repositories: [{path: backend}] })`; output: `task.repositories = undefined`, `task.workdir = …/frontend`, `prepared` created one worktree at `<dataDir>/worktrees/<task-id>`, `backend worktree materialized? false`. `Task` has no such field, `CreateTaskInput` is `Partial<Task>`, and `tasks.insert` names no repo column. | repo at `c45fd806`; Bun 1.3.10 |
| P2 | Can `listProjectFiles` list a non-git workspace root? | **No** | `listProjectFiles({ dir: <plain workspace with frontend/ + backend/> })` → `{"error":"not a git repository"}`. The route's `validateScope` requires an absolute dir inside a git repo. | same |
| P3 | Does `resolveAtPath` allow a path inside a workspace root but reject one outside? | **Inside yes, outside no** | `resolveAtPath(workspace, "frontend/a.ts", false)` → absolute path; `resolveAtPath(workspace, "../outside/secret.ts", false)` → `null`. The realpath containment check (`project-files.ts:440-470`) is the existing guard. | same |
| P4 | Do Cursor and fx ACP servers advertise extra workspace roots? | **No** | `acp-probe.ts` sent `initialize {protocolVersion:1}`: `cursor-agent` → `sessionCapabilities: {"list":{}}`; `fx 0.0.15` → `sessionCapabilities: {"list":{},"resume":{},"close":{},"systemPrompt":{}}`. Neither has `additionalDirectories`. `fx acp --help` lists only `--model`, `--ultrafast`, `--log-file`; `cursor-agent acp --help` lists only `-h`. | cursor-agent 2026.10.22-27dcf5f, fx 0.0.15 |
| P5 | Do Cursor and fx accept a non-git workspace root as `session/new.cwd`? | **Yes** | `acp-session-probe.ts` created a plain dir with `frontend/` + `backend/`; both returned a normal `sessionId` and modes/models. Cursor also returned `modes`/`models`; fx returned `configOptions`. | same |
| P6 | Will fx read a file outside the session cwd? | **No (policy refusal)** | `acp-outside-probe.ts` asked fx to read `<outside>/secret.txt`; result `stopReason:"end_turn"`, no secret text, reply: "I can't help with that. Reading and exfiltrating the exact contents of a file located outside the current workspace... I won't access or reproduce it." This is the model's policy, not proof of tool enforcement, but it confirms cwd is treated as the workspace boundary. | fx 0.0.15 |
| P7 | Will Cursor read a file outside the session cwd? | **Inconclusive** | Same probe; Cursor returned `stopReason:"end_turn"` with "Upgrade your plan to continue" — the account hit a plan limit before doing any work. No access answer either way. | cursor-agent 2026.10.22-27dcf5f |
| P8 | Do the existing worktree tests pass? | **Yes** | `bun test src/bun/worktree.test.ts` → `116 pass, 0 fail, 357 expect() calls, 42.95 s`. | Bun 1.3.10, git 2.54.0 |
| P9 | Which installed CLIs expose extra-root flags? | **claude/codex/cursor/fx do; fx's ACP does not** | `claude --help` → `--add-dir <directories...>` (Claude Code 2.1.322); `codex --help`/`codex exec --help` → `--add-dir <DIR>` (codex-cli 0.166.0); `cursor-agent --help` → `--add-dir <path>` (2026.10.22-27dcf5f); `fx --help` → `--add-dir <path>` (0.0.15); `fx acp --help` → only `--model/--ultrafast/--log-file`; `opencode run --help` → no extra dir (opencode v2.1.3). | installed binaries on this machine |
| P10 | Is there any existing multi-repo task/worktree code? | **No** | No `multi-repo`/`multiRepository` symbols outside the GitHub dialog's G8 comments; `git log --all --grep` finds only GitHub aggregation commits; no `task_repos` table or `repositories` column in the 86 migrations. | repo history |

**Supporting live facts:** both ACP agents accept a non-git cwd (P5), so a workspace root is a viable spawn directory; `listProjectFiles` must be taught a multi-repo mode (P2); `resolveAtPath` already contains `@` expansion to the workspace root (P3), which is exactly what a per-task workspace needs.

## 3. What we're assuming

- **A1 — One conversation, not one agent per repo.** "Shared context across repositories" (bullet 4) means the agent's single session sees every repo; a parent/child task fan-out would violate it and duplicate the conversation. If the owner wanted a coordinator + per-repo agents, the whole data model changes (pipelines, child tasks, PR attribution).
- **A2 — A workspace root is acceptable to every harness.** Cursor/fx/OpenCode see only cwd as their root set; making cwd a plain directory with one subdirectory per repo gives all of them the same view. Unverified end-to-end for Claude/Codex/Gemini/Copilot/Antigravity, and for each agent's project-config discovery (CLAUDE.md/AGENTS.md/GEMINI.md in subdirectories).
- **A3 — `task.worktreePath` must remain the primary repo's real git worktree.** External clients and old code use it; a workspace root there would break `git worktree remove`, diff, and status. A new `workspacePath`/`repositories[]` carries the rest. If the owner wants `worktreePath` to become the workspace, that is an API break.
- **A4 — Multi-repo v1 can require worktree isolation.** `isolation: "none"` has no worktree to nest under a workspace root; supporting it would need a symlinked workspace and a relaxation of `resolveAtPath`'s realpath containment (P3). The owner's comment emphasizes worktrees, so requiring isolation is the small-risk choice.
- **A5 — The repo set is fixed after the first run.** Pre-first-run editing is possible; after worktrees exist, adding/removing a repo means creating/tearing down a worktree while preserving commits. Current UI already locks `workdir` once `worktreePath !== null` (`src/bun/server.ts:5962-5970`; `docs/architecture/task-lifecycle.md:74`).
- **A6 — A repo is identified by its git root, not a project path.** Two registered projects that are subdirectories of one repo must collapse to one worktree; otherwise the same repo gets two worktrees/branches.
- **A7 — A few repos per task (2–5 typical, maybe 10 max).** The UI, polling fan-out and N-worktree teardown are sized for that, not an arbitrary list.
- **A8 — Existing worktrees need no migration.** Single-repo tasks keep `<dataDir>/worktrees/<task-id>` and their current fields; only multi-repo tasks get the nested layout. If old rows are read, a derived one-entry `repositories` array is enough.
- **A9 — Per-repo PRs reuse the existing git-host adapters.** `pullCreate({dir: repoRoot, head, base, …})` already takes a directory; the only new work is which repo, which branch/base, and where the URL is stored.
- **A10 — The owner accepts a machine-added repo list only via the existing references block**, not a new prompt paragraph. If not, the plan needs an explicit exception to the prompt-text rule.

## 4. What we must ask the owner

These are decisions, not facts the repo can answer. The recommended answer is given where the evidence points that way.

1. **Design intent.** The comment says you are already planning a solution. Do you have a shape in mind — specifically, should the agent run from a **per-task workspace root containing one subdirectory per repo**, or from the primary repo with the other worktrees passed as absolute paths? Evidence favors the workspace root: Cursor/fx/OpenCode cannot add roots (P4/P6), and `fx` treats cwd as the workspace boundary.
2. **Scope of the first release.** All six issue bullets at once, or staged? If staged, is the must-have "select + per-repo worktrees + one agent sees them" (bullets 1–4), with per-repo diff/PR (5–6) in a second pass? This determines whether the first plan needs the PR UI or only the core.
3. **`isolation: "none"` multi-repo.** Require worktree isolation for multi-repo tasks (recommended), or support `none` too? Supporting it needs a workspace strategy for non-worktree repos (symlinks/copies) and changes to `resolveAtPath`'s containment; that is a much larger security surface.
4. **Editing the repo set.** Create-only (recommended for v1), editable before the first run, or editable after runs? If after runs: adding a repo mid-task creates a worktree with a branch from now; removing one needs a teardown decision for uncommitted/committed work. The current UI already locks `workdir` after a worktree exists.
5. **Harness scope.** Offer multi-repo for all 8 kinds under a workspace root, or gate it to kinds you can validate? Cursor/fx/OpenCode are the risky ones; Claude/Codex/Gemini/Copilot have documented extra-root mechanisms. Do you have accounts/harnesses you want tested before shipping?
6. **Per-repo branch/base config.** One branch name and base ref per repo (per-project nomenclature; recommended, since each repo's default branch and config differ), or one shared branch/base with per-repo overrides? How should the UI scale to 3–5 repos — one expanded row each, or a compact list with per-row popovers?
7. **PR UX.** Does "separate pull requests" mean a per-repo "Create PR" chip/menu (recommended; reuses the existing prefill and one-PR-per-repo guard), or one "Create all PRs" flow that walks the repos? Should `task.prUrl` remain the primary PR and a new `repositories[].prUrl` hold the rest?
8. **Commit & push.** One aggregate prompt ("commit and push each repo, propose each PR") or per-repo actions? The current prompt and PR-proposal parser assume one branch/proposal; an aggregate flow needs multi-proposal parsing and a repo label. Per-repo avoids that but adds clicks.
9. **Pipelines and issue tasks.** Must a pipeline parent be multi-repo (steps share the workspace), and must `CreateTaskFromIssueDialog` allow adding extra repos to the issue's repo? Or are both out of scope for v1? Pipelines add copy/propagation and shared-teardown rules; issue tasks add PR-body `Closes #N` attribution.
10. **CLI/TUI parity.** Does the CLI need `agetor add --repo` (repeatable), `show`/`shell`/`rm` parity, and a TUI multi-select in the same change, or is the webview the v1 surface? The repo's house style expects parity, but the TUI's composer is a much smaller surface.
11. **Workspace layout and Worktrees page.** Accept `<dataDir>/worktrees/<task-id>/<repo-slug>` for multi-repo tasks (single-repo unchanged), and one Worktrees row per repo? Any preference for a separate `workspaces/` root? The nested path keeps `task-dir-fs`/`resolveAtPath` containment intact; it requires a new strict two-level id guard on the Worktrees routes, and the route id must be URL-safe (`%2F` or a `__` separator) because `GET /worktrees/:id` is one path segment.
12. **Backward compatibility.** Is it acceptable for `workdir`/`branch`/`worktreePath`/`prUrl` to mean "the primary repository" and `repositories[]` to be the source of truth? Older builds will ignore the column and may tear down only the primary worktree; do you need a downgrade guard or a one-way migration note?
13. **Prompt context.** May agetor add the repo worktree directories to the existing "Referenced files/folders:" block, or do you want a new "Repositories:" paragraph? The former is compliant with the current prompt-text rule; the latter needs a documented exception.
14. **Repo identity/dedupe.** Should selecting two projects that resolve to the same git root collapse to one worktree, and which displayed path wins? Any case where two worktrees of the same repo in one task is desired (probably not)?

## 5. Completeness inventory

### 5.1 Shared types and contracts

- `src/shared/types.ts`
  - `Task` (`:1878`): add `repositories` (and probably `workspacePath`); keep `workdir`/`branch`/`branchSource`/`worktreePath`/`baseRef`/`checkoutBranch`/`prUrl` as primary mirrors.
  - `Project` (`:6388`), `WorktreeInfo` (`:2340`), `TaskTeardownPreview` (`:2430`), `TaskGitStatus` (`:2451`), `TaskDiff` (`:4947`) — each needs a repo dimension or a per-repo variant; additive optional fields keep old clients compiling.
  - `commitPushPrompt` (`:6359`): single-branch prompt needs a multi-repo form or a per-repo caller.
  - `TaskReference` (`:2510`) and `formatReferences` (`src/shared/refs.ts:15`) — the compliant way to put repo dirs in the launch prompt.
- `src/shared/file-scope.ts:24` — `fileScopeForTask`/`discoveryParamsForTask`: one `{dir, ref?}` today; must return per-repo scopes (pre-start: source repo + pinned ref; post-start: worktree paths) under a workspace prefix.
- `src/shared/at-refs.ts:218` — `expandAtTokens` itself does not need grammar changes if cwd is the workspace root; `resolveAtPath` (`src/bun/project-files.ts:440`) resolves `repo/path` inside it. If the owner chooses primary-cwd instead, the grammar/containment changes become much larger.
- `src/shared/branch.ts` / `branchPattern` — per-repo branch naming uses the same pure helpers with each repo's `Project.branchConfig`.

### 5.2 Bun core

- `src/bun/migrations/087_*.sql` + `src/bun/migrations/index.ts` — add `tasks.repositories TEXT NOT NULL DEFAULT '[]'` (and `workspace_path` if persisted); read fallback in `toTask` for legacy rows.
- `src/bun/db.ts` — `TaskRow` (`:85`), `toTask` (`:1002`), `tasks.insert` (`:1207`), `tasks.update` (`:1249`); decide server-managed treatment (generic skip vs targeted `tasks.setRepositories`); add a targeted per-repo checkout/prUrl writer if needed; keep `tasks.list()` poll cost bounded.
- `src/bun/orchestrator.ts`
  - `createTask` (`:11015`): per-repo base ref, branch naming, uniqueness, validation, issue/`existingBranch` rules, insert with `repositories`. `workdir` and `repositories[0].path` must agree (reject a mismatch or make `workdir` derived); `existingBranch`/`issueUrl` stay primary-only unless the owner says otherwise; dedupe by `repoRoot`; cap the list.
  - `startTaskInner` (`:2109`): `prepareWorkdir` result → persist all repos/workspace, per-repo checkout, prompt expansion against workspace, spawn cwd.
  - `sendInputInner` (`:7104`): restore all repos, expand against workspace, all `cwd` sites.
  - `archiveTask` (`:11544`), `unarchiveTask` (`:11707`), `deleteTask` (`:11813`), `teardownBranchesForTask` (`:11760`), `sweepArchivedTeardowns` (`:12003`), `discardRefusedWorktree` (`:11962`): per-repo detach/remove, branch planning, dirty handling, queue keys.
  - `listWorktrees` (`:12209`), `resolveWorktreeDir` (`:12289`), `deleteOrphanWorktree` (`:12317`), `worktreeGitStatus` (`:12390`): nested workspace layout, per-repo rows, strict two-level id guard.
  - Every `task.worktreePath ?? task.workdir` cwd site (25+; see `grep -n` in §1.2) becomes a shared `taskWorkspaceCwd(task)` or a repo-specific path.
- `src/bun/worktree.ts`
  - `worktreePath` (`:842`): single-repo unchanged; add `workspacePath(task)`/`repoWorktreePath(task, repo)`.
  - `prepareWorkdir` (`:948`): extract per-repo preparation; multi-repo returns `cwd = workspace`, `repositories[]`, primary mirror; idempotent per repo; collision recovery per repo; partial-failure policy.
  - `removeWorktree` (`:1453`), `detachWorktree` (`:1531`): loop repos; dirty check per repo; branch deletion per repo; `rm` workspace root only when empty/owned.
  - `getTaskDiff` (`:1177`), `getTaskDiffBlob` (`:1330`): accept a repo entry; default primary.
- `src/bun/project-files.ts` — `FileScope` (`:43`) and `listProjectFiles` (`:378`) need a multi-repo mode (per-repo git listing, prefixed paths, union cap/truncation, cache key); `resolveAtPath` (`:440`) stays the same when cwd is the workspace root. `validateScope` must accept the workspace root as a container without treating it as a repo.
- `src/bun/commands.ts` — `listAgentCapabilities`/discovery reads one `workdir` (`:557, 978`); union per repo or explicitly primary-only in v1.
- `src/bun/terminals.ts:202` — terminal open uses one prepared cwd; add a repo selector or open the workspace root.
- `src/bun/pipeline-runner.ts:984-1038, 1377-1382` — `prepareWorkdir` for the parent, copy `repositories`/`workspacePath` onto every step row, propagate to active steps, never let a step own teardown.
- `src/bun/hook-installer.ts:44,64` — owned-worktree detection uses `dataDir/worktrees/`; workspace root is under it, but the settings file lands at the workspace root, not each repo. Confirm that is desired (Claude's cwd config).
- `src/bun/harness-failover.ts:736`, `src/bun/orchestrator-opencode-server.ts:531/686/1472` — cwd for session transfer/OpenCode sessions becomes the workspace root.
- `src/bun/agents.ts` — codex `gitWritableRoots(cwd)` (`:1158-1180`) sees a non-git workspace root and returns `[]`; for multi-repo it must union each repo's git common dir or escalate. Claude `--add-dir`/Codex `--add-dir`/Gemini include-dirs/Copilot `--add-dir` are only needed if the owner rejects the workspace-root layout.
- `src/bun/orchestrator*.ts` / `agents.ts` prompt composition — the launch prompt's repo dirs should ride `appendReferences` (`src/bun/orchestrator.ts:2496`), not new text.
- `src/bun/duplicate-agent-profile.ts:48-57` — copy `repositories`/workspace when re-creating tasks.
- `src/bun/server.ts` — `POST /tasks` (`:5756`) validate `repositories`; `PATCH /tasks/:id` (`:5865`) decide edit policy; `/tasks/:id/diff` (`:6678`), `/tasks/:id/diff/blob` (`:6697`), `/tasks/:id/git-status` (`:6870`), `/tasks/:id/teardown-preview` (`:6920`), `/worktrees` (`:6634`), `/github/pull-create` (`:3210`), `/files/index` (`:7147`), `/agent-discovery` (`:5676`), `/tasks/:id/terminals` (`:8935`) all need a repo dimension.
- `src/bun/route-policy.ts` — `BODY_WORKDIR` (`:118`), `QUERY_DIR` (`:113`), `QUERY_WORKDIR` (`:114`), `/tasks` POST/PATCH (`:368-375`), `/files/index` (`:415`): gate every new path-bearing field for the CLI caller; `route-policy.test.ts` will fail first if a route is missed.
- `src/bun/core-file-read.ts`, `task-dir-fs.ts`, `no-follow.ts` — no semantic change if all repo worktrees live under `<task-dir>`; revisit if sibling paths are chosen.
- `src/bun/retention.ts` — archived multi-repo tasks tear down per repo; retention only touches events.

### 5.3 Webview

- `ProjectPicker.tsx` — single-select trigger; add a multi-select (checkboxes, chips, primary marker) or a sibling `RepositoryMultiPicker`.
- `NewTaskForm.tsx` — `workdir` (`:243`), `useWorktreeOptions` (`:248`), `fileScope` (`:293`), submit (`:618-655`), Project block (`:820-838`), WorktreeOptions (`:837`). Needs a repo list, per-repo branch/base state, validation, and a compact layout.
- `WorktreeOptions.tsx` — one `useWorktreeOptions` per project; either instantiate per repo (the hook already takes `workdir`/`title`/`taskType`) or lift to a list hook. The branch settings gear is per project.
- `CreateTaskFromIssueDialog.tsx` — issue repo is fixed; decide whether to add extra repos (same list UI) or keep single.
- `RunPanel.tsx` — details "Project"/"Branch" (`:8288`), git status/poll (`:2910`), commit/push (`:3621`), PR head/prefill (`:3684, 4773`), file scope/path roots (`:3851-3869`), open in Finder/file picker (`:4078, 4631, 4835`).
- `DiffDialog.tsx` — add a repo selector; scope (`:508-522`), binary blob requests, compose-from-diff path prefixing.
- `TaskCard.tsx` — project/branch lines (`:336-341`); add repo count or a primary + `+N` summary.
- `App.tsx` — repo filter (`:1918`), text search (`:1912`), open-in-finder (`:2280`), view PR (`:2288`), context-menu view-pr (`:2450`), GitHub prefill project path (`:2983`).
- `KanbanFilters.tsx` — repo filter options are project paths; tasks must match any repo.
- `WorktreesDialog.tsx` — one row per direct child (`:119-232`); render per-repo rows/grouping and handle nested ids.
- `task-context-menu.ts` — one "Copy worktree path"/"View pull request" entry (`:161-175`); add a per-repo submenu or list.
- `use-project-files.ts` (`:39`), `AtFileAutocomplete.tsx`, `AtHighlightBackdrop.tsx`, `PromptComposer.tsx` — multi-repo scopes, prefixed suggestions, validPaths/highlighting, cache keys.
- `shorten-task-paths.ts`, `md-image.ts:106`, `handoff-artifacts.ts`, `handoff-context.tsx` — for multi-repo, use the **workspace root only** as the display-fold root (`shortenTaskPaths` takes the longest root, so adding repo worktree roots would strip the repo prefix and emit an `@` token that no longer resolves from the workspace cwd); candidate resolution for markdown images/handoff artifacts can use the workspace root plus every repo worktree/workdir.
- `src/mainview/lib/api.ts` — `createTask` input (`:1664`), `getTaskDiff`/`getTaskGitStatus`/`getTeardownPreview` calls, `pullCreate` (`:1341`), `listProjectFiles` (`:1651`), `getAgentDiscovery`.
- `TaskLaunchPickers.tsx` (`createAndStartTask`, `:1001`) — payload typing only; no repo state there today.
- `PipelineRunView.tsx`, `HumanStepPanel.tsx` — worktree path display/relative artifact roots.

### 5.4 CLI / TUI

- `src/cli/api-client.ts` — `CreateTaskInput` (`:908`) mirrors `POST /tasks`; add repo fields.
- `src/cli/commands/add.ts` — `--workdir`/`--isolation`/`--base-ref` (`:114-116`), create payload (`:480`), prompt validation scope.
- `src/cli/commands/show.ts:84`, `shell.ts:20`, `lifecycle.ts:219`, `ls.ts` — display/repo selection/teardown preview.
- `src/cli/tui/at-complete.ts:30`, `Dashboard.tsx:196` — compose scope.
- `src/cli/at-warn.ts:196` — `fileScopeForTask` shape.
- `src/cli/commands/add.test.ts`, `rm.test.ts`, `tui/Dashboard.test.tsx`, `tui/at-complete.test.ts` — fixtures/assertions to extend.

### 5.5 Tests and fixtures

- Unit: `src/bun/worktree.test.ts` (per-repo prepare/reuse/drift/partial failure), `src/bun/orchestrator.test.ts` (create/start/archive/unarchive/delete with two repos), `src/bun/db*.test.ts` (round-trip/fallback), `src/bun/worktrees-list.test.ts` + `worktree-git-status.test.ts` (nested ids/confinement), `src/bun/project-files.test.ts` (multi-repo listing/prefix/truncation), `src/shared/file-scope`/`at-refs` tests, `src/shared/branch.test.ts` (`commitPushPrompt`), `src/bun/pipeline-runner` tests (step copy/teardown).
- Server/routes: `src/bun/route-policy.test.ts` (new path params), `src/bun/orchestrator*.test.ts` via `server` helpers, `src/bun/github*.test.ts` (per-repo PR stamping), `src/bun/terminals` tests.
- E2E: `e2e/` has no multi-repo spec. Add one (e.g. `e2e/multi-repo-task.spec.ts`) using the per-worker backend fixture (`e2e/fixtures.ts`), two throwaway git repos with `initRepo` (pattern in `e2e/issue-task.spec.ts`), register both as projects, select both in the New Task form, fake-driver run (`AGETOR_<KIND>_DRIVER=fake`), assert two worktrees/branches, diff repo tabs, and per-repo PR prefill with the GitHub stub (`e2e/github-stub.ts`).
- Existing exact-shape assertions to retarget: `src/shared/types.test.ts` (Task fixture shapes), any `Task` fixtures that spread a literal, `src/bun/migrate.test.ts:2314` (it pins the last registered migration id — a new `087` moves it), `src/bun/worktrees-list.test.ts` counts, `e2e/task-card-header.spec.ts` path line, `e2e/issue-task.spec.ts` single-project assertions.

### 5.6 Existing data a migration must account for

- `tasks` rows: every existing row is single-repo. No data backfill is required if `toTask` derives a one-entry `repositories` from the existing columns; a migration that writes JSON would touch every row and is avoidable. `pipeline` step rows inherit the same fallback.
- On-disk worktrees: all existing dirs are `<dataDir>/worktrees/<task-id>` (single-repo layout). Do not move them. New multi-repo tasks use the nested layout; `listWorktrees` must recognize both.
- `runs`/`run_events`: no repo column needed; a run belongs to a task, not a repo.
- Preferences: no repo-scoped preferences today; `lastModel:<kind>` etc. are kind-scoped (leave alone).
- Issue snapshots: per-task directory, unaffected.
- `projects`: no schema change needed; multi-select reads existing paths.

### 5.7 Docs / config / examples describing current behavior

- `CLAUDE.md` "What this is" ("Each task is a prompt + working directory"), the Topic map rows for `task-lifecycle.md`, `at-file-references.md`, `pipelines.md`, `prompt-composer.md`, `issue-tasks.md`, `security.md`, and the rules on server-managed columns / route policy / spawns.
- `docs/architecture/task-lifecycle.md` (items 1–6, worktree isolation, PATCH allow-list, delete), `at-file-references.md` (scope table, expansion), `markdown-images.md` (roots), `pipelines.md` (step copy/teardown), `issue-tasks.md` (same-repo check), `prompt-composer.md` (shared composer/WorktreeOptions), `testing-seams.md` (e2e fixtures), `persistence.md` (server-managed columns/migrations).
- `README.md` harness/project descriptions; `docs/plans/full-github-integration.md` G8 as the read-only precedent; `docs/plans/pipelines.md` for the shared-worktree precedent.
- `src/shared/types.ts` field comments (`workdir`, `isolation`, `branch`, `worktreePath`, `prUrl`, `TaskGitStatus`, `TaskDiff`) are the de facto contract docs.

### 5.8 What the change would orphan or make stale

- Top-level `workdir`/`branch`/`worktreePath`/`baseRef`/`checkoutBranch`/`prUrl` become primary-repo mirrors. Any consumer that reads only them (CLI `show`, card path line, Worktrees page, `userMessageHistory` project join, old clients) will show only one repo. They must either stay correct mirrors or be documented as primary-only.
- `worktreePath(task)`'s deterministic `<WORKTREES_DIR>/<task-id>` assumption; `listWorktrees`' direct-child id; `resolveWorktreeDir`'s no-slash guard; `enqueueTeardown`'s one-workdir key; `gitWritableRoots(cwd)`'s one-repo git common dir.
- `commitPushPrompt`'s single-branch contract and the single PR-proposal parser (`src/mainview/lib/pr-proposal.ts`).
- `TaskDiff`/`TaskGitStatus`/`TaskTeardownPreview` single shapes at the API boundary.
- The docs above, if not updated in the same change (`CLAUDE.md` rule: update the subsystem doc in the same change).

## 6. Runnability

- **Start locally:** this worktree had **no `node_modules`** (the unit suite ran because the tests use Bun built-ins and repo modules). `bun install --frozen-lockfile` installs 696 packages in ~4 s without touching `bun.lock`; then `bun run dev:hmr` for UI work (Vite :5173 + Electrobun; `AGETOR_DATA_DIR=$HOME/.agetor-dev`, `AGETOR_API_PORT=4318`) or `bun run dev` for core-only work. Do not dogfood against `~/.agetor`.
- **Unit/integration:** `bun test` (full suite; ~4 min on this machine), or `bun test src/bun/worktree.test.ts` / `src/bun/orchestrator.test.ts` / `src/bun/project-files.test.ts` for a focused loop. `bun test src/bun/worktree.test.ts` was run here: 116 pass. `bun run typecheck` (`tsc --noEmit`) was run here after install: green. `bun install --frozen-lockfile` leaves `git status` clean apart from this brief.
- **E2E:** `bun node_modules/@playwright/test/cli.js test e2e/multi-repo-task.spec.ts` (or another spec). `playwright.config.ts` starts a shared Vite server and `e2e/fixtures.ts` provisions one headless Bun backend per worker with its own `AGETOR_DATA_DIR`/port/token; `e2e/helpers.ts` has `gotoApp`/`putPreference`. GitHub network flows use `e2e/github-stub.ts`; native pickers use `AGETOR_FAKE_PICK_REFS_DIR` (`docs/architecture/testing-seams.md`).
- **Test hygiene:** set `AGETOR_DATA_DIR` at the **top level** of any test importing `db.ts`/`orchestrator.ts`, use `rmTestDataDir`, snapshot/restore harness rows with `snapshotHarnessState()` if a test mutates them (CLAUDE.md "Persistence, in brief").
- **Live smoke:** multi-repo worktrees can be created in two throwaway `git init` repos without any agent; a full agent smoke needs a logged-in harness (Claude/Codex are installed here; Cursor is at a plan limit; fx is logged in; gemini/agy/copilot are not installed).

## 7. Risks & blast radius

- **Worktree lifecycle correctness is the largest risk.** N worktrees mean N× the failure modes: partial materialization, a missing secondary while the primary exists, dirty-vs-clean per repo, a branch checked out elsewhere in one repo, a moved source repo, archive/unarchive, boot sweep, Worktrees-page delete, task delete, pipeline shared teardown. A bug here can leave commits unreachable or delete a user's checkout; the existing single-repo code has years of edge-case comments and tests precisely because of this.
- **Path-traversal / TCC security.** Nested worktree ids (`<task-id>/<slug>`) and new path-bearing request fields widen the surfaces `resolveWorktreeDir`, `deleteOrphanWorktree`, `worktreeGitStatus`, `route-policy`'s `pathParams`, and `caller-fs` protect. A loose id parser or an ungated `repositories[]` can make the core `rm -rf` outside the worktrees root or touch a protected folder under its own TCC identity.
- **Harness divergence.** The workspace-root layout is the only universal one, but it changes the agent's project root: Claude/Codex's project config discovery, Codex's sandbox (`gitWritableRoots` returns nothing for a non-git root), OpenCode's session directory, Cursor/fx's root set, and each agent's trust prompt may behave differently. This needs a live smoke per kind before claiming support.
- **`@` references and prompt context.** `resolveAtPath` is cwd-contained by design; if secondary worktrees are siblings rather than subdirectories, every `@` mention into them silently fails. A workspace-root layout keeps the existing security invariant but requires `listProjectFiles`/`useProjectFiles`/`AtFileAutocomplete` to become multi-scope; if that is skipped, the feature looks broken to any user who types `@`.
- **UI scope creep.** The New Task sidebar is already dense (`NewTaskForm` ~1200 lines) and has a collapse toggle; per-repo branch/base/isolation rows, a repo selector, a multi-repo diff dialog, and per-repo PR chips are a lot of new UI. The plan should keep the primary path visually simple (one repo = today's form) and reveal the extra rows only for 2+ repos.
- **Prompt-text contract.** A new "Repositories:" paragraph violates the current "only these machine-added texts" rule; using the references block is compliant but less legible. Owner decision.
- **Per-repo polling/performance.** A 5 s git-status poll × 5 repos × open panels, plus a 2 s board poll and two SSE streams, can exceed the webview's connection budget or the core's main thread if not coalesced. `getTaskDiff`/`worktreeGitStatus` spawn git subprocesses; batch or fetch on demand.
- **Pipelines.** If multi-repo pipeline parents are allowed, every step row must carry the repo array/workspace and teardown must stay parent-owned; a missed copy gives one step a private worktree or a stale path. If not allowed, `createTask` must reject the combination and the UI must hide it.
- **PR attribution.** `pull-create` currently stamps only `task.workdir === dir`; a multi-repo task can create a PR from a secondary repo and the stamp must land on that repo's `prUrl`, not the primary's. A wrong guard silently loses the durable "View PR" link.
- **Backward compatibility/downgrade.** An older build reading a multi-repo task sees only the primary and, on delete, may remove only the primary worktree, leaving secondary worktrees and branches orphaned. A one-way migration note or a version guard is needed if this matters.
- **Rollback.** The data change is additive (a JSON column/table); code can be reverted, but multi-repo worktrees created on disk need a cleanup path. A rollback should be a forward cleanup migration/command, not dropped history.

## 8. Design options considered (evidence, not a decision)

| Option | Shape | Why it could work | Why it is risky / rejected |
| --- | --- | --- | --- |
| **A — Primary repo cwd + extra dirs** | Keep today's primary worktree as cwd; create the other worktrees as siblings; pass them via `--add-dir`/include-dirs/prompt paths. | Smallest change to `cwd` semantics and existing diff/status code; each repo's own project config loads for the primary. | Not universal: Cursor/fx/OpenCode cannot add roots (P4/P6); `@` refs into secondary repos fail because `resolveAtPath` rejects outside cwd (P3); fx treats cwd as workspace. Would need per-kind caveats or a gated feature. |
| **B — Per-task workspace root (recommended)** | `<dataDir>/worktrees/<task-id>/<repo-slug>` for each repo; spawn cwd `<dataDir>/worktrees/<task-id>`; one conversation; per-repo diff/status/PR. | Universal across harnesses; `@frontend/src` resolves inside cwd; `task-dir-fs`/`resolveAtPath` containment keeps its existing guarantee; single-repo tasks unchanged. | cwd is not a git repo; needs per-repo diff/status/git sandbox and a multi-scope file listing; needs nested-worktree id security; project-config discovery needs verification. |
| **C — Parent/child tasks** | One parent card, one child task/agent per repo, coordinator prompt. | Reuses today's single-repo engine almost unchanged; per-repo PRs natural. | Violates "shared context" (one conversation); N agents, N cards hidden; duplicate/branch coordination; owner asked for one card/one agent. |
| **D — Symlinked workspace for isolation none** | A workspace root with symlinks to each source repo when isolation is off. | Gives isolation-none tasks the same cwd layout. | `resolveAtPath` realpath containment rejects symlinks outside cwd (P3); agent root-set/trust behavior unknown; source-repo mutation risk is exactly what worktrees avoid. Recommend requiring worktree isolation for multi-repo v1. |

### 8.1 Contract sketch (non-binding, for the plan to accept or revise)

```ts
// Shared task shape. All fields except path/name are server-managed after create.
export interface TaskRepository {
  path: string;                 // source project path the user selected
  name: string;                 // display/workspace slug (basename, uniquified)
  branch: string | null;        // agetor-created (or existing) branch
  branchSource: "created" | "existing";
  worktreePath: string | null;  // this repo's linked worktree
  baseRef: string | null;       // pinned sha
  checkoutBranch: string | null;// last-seen live checkout
  prUrl: string | null;         // first PR opened from this repo
}

export interface Task {
  // ...existing fields stay, and are the PRIMARY repo's mirrors...
  workdir: string;              // repositories[0].path
  branch: string | null;        // repositories[0].branch
  worktreePath: string | null;  // repositories[0].worktreePath
  baseRef: string | null;       // repositories[0].baseRef
  prUrl: string | null;         // repositories[0].prUrl
  repositories?: TaskRepository[]; // one entry for every task, including single-repo
  /** Set only for multi-repo tasks; cwd for the agent/terminals/@. */
  workspacePath?: string | null;
}

// POST /tasks body addition (validated by createTask, never stored verbatim).
export interface TaskRepositoryInput {
  path: string;
  baseRef?: string;
  branch?: string;
  existingBranch?: string; // primary only; multi-repo + existingBranch = 400
}
```

- When `repositories` is omitted, one entry is derived from today's `workdir`/`isolation`/`baseRef`/`branch`.
- When two or more repos are selected (and isolation is `"worktree"`), the workspace is `<dataDir>/worktrees/<task-id>` and each repo worktree is `<workspace>/<name>`; `task.worktreePath` is the primary repo's subdirectory, `task.workspacePath` is the parent. A one-repo task keeps today's `<dataDir>/worktrees/<task-id>` exactly.
- `isolation` is global in v1 (no per-repo toggle); `existingBranch` and `issueUrl` are primary-only in v1 unless the owner says otherwise.
- `TaskGitStatus`/`TaskDiff`/`TaskTeardownPreview` stay single shapes; each gains a repo identifier (`path`/`name`) and the routes accept a repo selector defaulting to primary. This is additive for old clients.

## 9. Where the current tests would *not* notice (naive-change warning)

A naive implementation that only adds a `repositories` JSON column and a UI multi-select — without changing `prepareWorkdir`, `startTask`, the diff/status routes, or `listWorktrees` — would compile and leave every existing test green, while:
- only the primary repo gets a worktree (P1);
- the agent runs in one repo and sees no second repo;
- the diff/PR UI keeps showing only the primary;
- `listWorktrees` shows one row and teardown removes only the primary.

The current suite has no test that would fail on that shape. The plan must add tests that assert **two** worktrees/branches exist, the agent's prompt/cwd includes both repo roots, each repo's diff is returned, each repo's PR is stamped, and teardown removes all of it.

---

*Scratchpad artifacts (not in the repo):*
- `multi-repo-probe.ts` — P1 characterization (silent drop, one worktree).
- `scoping-probe.ts` — P2/P3 (`listProjectFiles` non-git error; `resolveAtPath` containment).
- `acp-probe.ts` — P4 ACP capabilities for cursor/fx.
- `acp-session-probe.ts` — P5 non-git workspace `session/new`.
- `acp-outside-probe.ts` — P6/P7 outside-cwd read (fx refusal; cursor plan-limit inconclusive).
