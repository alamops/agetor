# Plan — Branch-scoped skills / commands / MCP discovery for the prompt composers

| Field | Value |
| --- | --- |
| Date | 2026-09-14 |
| Source | `/implement` request (owner, this conversation): "fix agetor not using the selected branch as origin for available skills/plugins in the autocomplete for the New Task" |
| Config | AGENTS_CONFIG.yml (balanced, v1 schema — investigate/implement/tests: sonnet, review: opus, test-running: haiku, planning: self) |
| Flags | none |
| Gates | grilled + approved by owner (4-question grill answered 2026-09-14; plan approval below) |
| Branch | `fix/current-branch-skills-autocomplete` (already checked out; not the default branch) |
| Base SHA | `fe65199` (release v0.1.8); tree was clean |

## 1. Objective & success criteria

The `/` slash autocomplete and the Extensions picker (MCP · Skills · Plugins) in every prompt composer list the **project-level** entries the agent will actually see in its working tree:

- New Task form, Isolate ON, "Branch from" = `feature/x` → project skills/commands/`.mcp.json`/plugin-enablement read from the committed tree of `feature/x` (not from whatever is checked out in the source repo).
- Isolate ON, "Branch from" blank → read from the pinned `HEAD` commit (uncommitted/untracked entries on disk are NOT offered — matches the `@` file scope and the worktree the agent gets).
- Isolate OFF → live disk of the workdir, as today.
- RunPanel: once the worktree exists, read the live worktree (the agent's real cwd); before that, the same ref rule as the form (existing-branch tasks use `task.branch`, else `baseRef ?? HEAD`).
- Create-from-issue dialog: same rule as the form. Resolve-conflicts dialog: the PR head ref.
- Unknown ref / not a git repo → no project-level rows; user-level, plugin and builtin rows still show. No error UI.
- User-level entries (`~/.claude`, harness home, codex home), installed plugin records and the machine-local `~/.claude.json` per-project MCP block are unchanged — they are not tracked files.

Done means: unit tests on the git-backed reader and on `commands.ts` pass, the Playwright spec proves the New Task flow end to end, `bun run typecheck` is green, and CLAUDE.md documents the scope rule.

## 2. Context & constraints (Phase 1 findings)

- **The `branch` param already flows end to end but is ignored.** `api.listAgentCapabilities` (`src/mainview/lib/api.ts:1160`) → `GET /agent-discovery?agent&workdir&branch` (`src/bun/server.ts:3383`) → `listAgentCapabilities` → `listAvailableCommands` (`src/bun/commands.ts:215`), whose doc comment states "Branch is accepted but not used to swap filesystem views … wired through so a future enhancement can git-ls-tree without breaking the API shape." This run is that enhancement.
- **Project-level disk reads today** (all rooted at `repoRoot(workdir) ?? workdir`):
  - claude-code: `.claude/commands/**/*.md` (nested folders → `parent:child`), `.claude/skills/<name>/SKILL.md`, `.mcp.json` (`mcpServers`), `.claude/settings.json` + `.claude/settings.local.json` (`enabledPlugins`, via `readEnabledPlugins` at `commands.ts:405`).
  - codex: `.codex/prompts/**/*.md`, `.codex/skills/<name>/SKILL.md`, `.codex/config.toml` (`[mcp_servers.x]` headers).
  - cursor / gemini: no project discovery (documented gaps) — untouched.
- **Stays on disk (not tracked files):** user roots (`harnessHome` / `~/.claude` / codex home), `plugins/installed_plugins.json` + each plugin's `installPath` (`.claude-plugin/plugin.json`, `.mcp.json`, plugin commands/skills), user `settings.json`, and `~/.claude.json` (`mcpServers` + `projects[root|workdir].mcpServers` — machine-local, keyed by the cwd claude ran in).
- **Client scope rule already exists for `@` files** — `FileScope = { dir, ref? }` (`src/mainview/lib/use-project-files.ts:16`): NewTaskForm (`NewTaskForm.tsx:232`) `ref = isolate ? (baseRef || "HEAD") : null`; CreateTaskFromIssueDialog (`:92`) same, gated on `open`; ResolveConflictsDialog (`:53`) `{dir: context.path, ref: context.headRef}`; RunPanel (`RunPanel.tsx:2870`) `worktreePath ? {dir: worktreePath} : isolation === "worktree" ? {dir: workdir, ref: branchSource === "existing" && branch ? branch : baseRef ?? "HEAD"} : {dir: workdir}`.
- **Client drift today:** NewTaskForm passes `branch={wt.baseRef}` even with Isolate OFF (`:591`); the issue dialog `branch={wt.baseRef || undefined}` (`:305`); RunPanel hoists `useAgentCapabilities(task.agent, task.workdir, task.branch)` (`:2852`) — the agetor branch against the SOURCE repo, and its `fileScope` memo is declared *after* that call (`:2870`).
- **Git reading precedent** — `rawListing` in `src/bun/project-files.ts:157`: `git ls-tree -r --name-only --full-tree -z <ref>`, retried once against `refs/remotes/origin/<ref>` when the ref has no `refs/`/`origin/` prefix, and a leading-`-` ref rejected as "unknown ref". Both `project-files.ts` and `worktree.ts` keep a private `git(args, cwd)` `Bun.spawn` helper by house rule ("local duplicate … rather than a shared git utils module"); `project-files.ts`'s variant returns stdout untrimmed for `-z` output.
- **`repoRoot`** (`worktree.ts:317`) is memoized per dir; `git ls-tree --full-tree` paths are root-relative, so pathspecs `.claude .codex .mcp.json` resolve at the root regardless of a subdir workdir.
- **Consumers of the endpoint:** the webview (`PromptComposer.useAgentCapabilities`, hoisted in RunPanel) AND two CLI callers of `api-client.agentDiscovery` that the first-pass grep missed (it searched the route string, not the client method): `src/cli/commands/discovery.ts` (`agetor commands <task>`, passed `worktreePath ?? workdir` + `task.branch`) and `src/cli/at-warn.ts` `discoveredExtensionNames` (passed `workdir` + `task.branch`; feeds the `@`-ref warning in `send`/`start`/`add` and the TUI). Both surfaced in the Phase 5 review as a high finding and are fixed in Phase 8 via the shared scope rule. `listAvailableCommands` is called directly only by `commands.test.ts`.
- **Test conventions:** `commands.test.ts` sets `AGETOR_DATA_DIR` before importing, uses `mkdtemp` project dirs (never git repos today) and `harnessHome` temp dirs. `worktree.test.ts` has a `git(args, cwd)` helper for fixture repos. e2e: `e2e/at-file-autocomplete.spec.ts` `initRepo()` (git init on `main`, commits, untracked file), `registerProject`, the New Task panel; `e2e/issue-task.spec.ts:592` drives the BranchPicker (`getByTitle(BRANCH_PICKER_TITLE)` → `getByPlaceholder("Search branches…")` → click the row in `[data-popover-open]`) and the slash menu (`slash-autocomplete` / `slash-autocomplete-row`, **click the exact row** — user-level discovery reads the real `~/.claude`, so row order is environment-dependent). Extension picker ids: `extension-picker-trigger`, `extension-picker-search`, `extension-picker-row`. Worktree ids: `worktree-options`, `isolate-toggle`.
- **Runnability:** `bun run typecheck`, `bun test <file>`, e2e via `bun node_modules/@playwright/test/cli.js test <spec>` (one Playwright run at a time). `AGETOR_DATA_DIR` must be a temp dir for any test importing `db.ts`/`orchestrator.ts`.
- **Spikes:** none needed — `git ls-tree` with pathspecs and `git cat-file --batch` are standard plumbing already exercised by `project-files.ts`/`worktree.ts` (`git show <sha>:<path>`); the plan changes on no unresolved assumption.

## 3. Approach & key decisions

1. **Virtualize the project tree behind a tiny `ProjectTree` interface** (`{ list(relDir): {name, isDir}[]; read(relFile): string | null }`) in a new `src/bun/ref-tree.ts`, with two implementations: `diskProjectTree(root)` (today's `readdirSync`/`statSync`/`readFileSync` behavior) and `refProjectTree(files: Map<relPath, content>)` built from one `git ls-tree -r --name-only --full-tree -z <ref> -- .claude .codex .mcp.json` plus one `git cat-file --batch` (stdin `<ref>:<path>` per interesting file) — two spawns per discovery regardless of entry count. `discoverCommands`/`discoverSkills`/`readEnabledPlugins`/`.mcp.json`/`config.toml` reads go through the tree; user-level and plugin reads keep using `diskProjectTree(absDir)` so their behavior is byte-identical. *Reasoning-based decision; mirrors the `@` listing's ref mode.*
2. **Resolve the tree once in `listAgentCapabilities`** (`resolveProjectTree(opts, root)`): `root == null` → `null`; `branch` set → `refProjectTree` (unknown ref / not a repo / git failure → an **empty** tree: no project rows, per the owner's answer); else `diskProjectTree(root)`. Threaded into `listAvailableCommands` and `discoverMcpAndPluginExtensions` via the existing optional-second-argument pattern (`activePlugins` becomes part of a `ctx` object), so direct callers (tests) still get a self-contained resolve.
3. **Ref handling mirrors `project-files.ts`:** leading `-` rejected; retry `refs/remotes/origin/<ref>` once; `--full-tree` root-relative paths. The route keeps the `branch` query name (CLI client compatibility) — semantics are "a git ref".
4. **One scope on the client.** `useAgentCapabilities(agent, scope: FileScope | null, opts)` replaces `(agent, workdir, branch)`; `PromptComposer` derives it from its existing `fileScope` prop and the `branch` prop is deleted. All four consumers therefore share the exact rule the `@` popover already follows — no second derivation to drift. RunPanel moves its `fileScope` memo above the hoisted hook call. *Owner decision (grill Q2).*
5. **Not a cache candidate.** The BranchPicker is a select (value changes on pick, not per keystroke); RunPanel refetches only on scope changes. Two git spawns per change is fine.
6. **Alternatives rejected:** (a) `git show <ref>:<path>` per file — N spawns; (b) a temporary checkout/worktree — heavy, writes to the user's repo; (c) fall back to disk on unknown ref — dishonest about what the worktree will contain (owner chose "user + builtin + plugins only").

## 4. Work breakdown — implementation tasks

| ID | Goal | Owns (exclusive within its wave) | Depends on | Acceptance |
| --- | --- | --- | --- | --- |
| T1 | Git-ref project tree + wire discovery through it | `src/bun/ref-tree.ts` (new), `src/bun/commands.ts`, `src/bun/server.ts` (route: `.trim()` the `branch` param only) | — | `bun test src/bun/commands.test.ts` still green; `listAgentCapabilities({branch})` returns project rows from the ref, none from disk; unknown ref → user/plugin/builtin rows only; disk mode byte-identical to today; `commands.ts`'s stale doc comment replaced. |
| T2 | Client: capabilities keyed on `fileScope` | `src/mainview/components/kanban/PromptComposer.tsx`, `NewTaskForm.tsx`, `CreateTaskFromIssueDialog.tsx`, `ResolveConflictsDialog.tsx`, `RunPanel.tsx` | — (API shape unchanged) | `bun run typecheck` green; `branch` prop gone; hook deps are primitives (`scope?.dir`, `scope?.ref`); RunPanel's `fileScope` memo precedes the hoisted call; no consumer passes `branch`. |
| T3 | Docs | `CLAUDE.md`, this plan's Branch/Base rows | T1, T2 | CLAUDE.md item 11 (shared composition modules) gains the capability-scope rule; commands.ts doc comment updated in T1. Orchestrator-owned. |

## 5. Work breakdown — test tasks

| ID | Layer | Covers | Owns |
| --- | --- | --- | --- |
| U1 | unit | `ref-tree.ts`: ls-tree pathspec listing, `cat-file --batch` content (multi-line, UTF-8, empty file), origin-only ref fallback, leading-dash ref, unknown ref, non-repo dir; `commands.ts`: skill/command/`.mcp.json`/`enabledPlugins`/codex prompts+`config.toml` visible at a side branch and hidden at `main`; untracked disk skill hidden with a ref, visible without; unknown ref keeps user + builtin rows; nested command namespaces at a ref | `src/bun/ref-tree.test.ts` (new), `src/bun/commands.test.ts` |
| E1 | e2e | New Task form: (a) Isolate ON + blank base → neither the untracked disk skill nor the side-branch skill is offered in `/` menu or Extensions picker; (b) pick the side branch → its skill and command rows appear; (c) Isolate OFF → untracked disk skill appears, side-branch rows gone | `e2e/branch-scoped-capabilities.spec.ts` (new) |

**E2E applies** — the flow is UI → HTTP → git, exactly the wiring a unit test can't prove. Run recipe: `bun node_modules/@playwright/test/cli.js test e2e/branch-scoped-capabilities.spec.ts` (fixtures boot the headless backend + Vite; no external services). Fixture repo mirrors `at-file-autocomplete.spec.ts`'s `initRepo`: `main` with a committed `README.md`; branch `feature/skills` committing `.claude/skills/e2e-branch-only/SKILL.md` + `.claude/commands/e2e-branch-cmd.md`; back on `main`, an **untracked** `.claude/skills/e2e-untracked/SKILL.md`. Rows are matched by exact text, never by index.

## 6. Execution waves

- **Wave 1 (parallel):** T1 (server) ‖ T2 (client). Disjoint files; the HTTP contract is unchanged so neither blocks the other. Checkpoint: `bun run typecheck` + `bun test src/bun/commands.test.ts`; commit.
- **Wave 2 (orchestrator):** T3 docs; commit.
- **Phase 5:** review `fe65199..HEAD`.
- **Wave 3 (parallel):** U1 ‖ E1. Disjoint files. Commit.
- **Phase 7:** `bun run typecheck`, `bun test src/bun/ref-tree.test.ts src/bun/commands.test.ts`, then the e2e spec.

## 7. Blast radius & risks

- `discoverCommands`/`discoverSkills` signatures change (internal, non-exported) — user-level and plugin callers must be moved to `diskProjectTree` so their output stays byte-identical; U1's existing tests pin that.
- `useAgentCapabilities`'s signature changes; RunPanel is the only external caller (hoisted). The `branch` prop removal touches four consumers — all in T2.
- A ref that exists only on `origin/` (PR head in the resolve-conflicts dialog) — covered by the retry.
- Performance: two git spawns per scope change; a subdir workdir still resolves to the root via `repoRoot`.
- Behavior change users will notice: with Isolate ON, an uncommitted skill no longer shows until committed (owner-approved; it also isn't in the worktree).
- No migrations, no persisted data, no API shape change. Rollback = revert.

## 8. Open questions / assumptions

- Owner-confirmed (grill 2026-09-14): HEAD-commit reads for a blank base ref; all four composers unified on `fileScope`; unknown ref / non-git workdir → no project rows (note: for a non-git workdir with Isolate ON the agent actually runs in the dir itself, so its on-disk `.claude/` would be usable — accepted as-is per the owner's answer, and consistent with the `@` listing, which also can't list a non-git dir with a ref).
- Assumption: `git cat-file --batch` is available on every git the app supports (it has been since git 1.5) — reasoning, not spike.
- ~~Assumption: no CLI/TUI surface consumes `/agent-discovery`~~ — WRONG, caught in review: `agetor commands` and `discoveredExtensionNames` do. Resolved by promoting the TUI's `fileScopeForTask` to `src/shared/file-scope.ts` as the single scope rule for the webview, TUI and CLI (Phase 8, F2).

## 9. Completeness ledger

| Candidate remainder | Disposition |
| --- | --- |
| Server honors the ref for claude-code project entries | **in this run** — T1 |
| Same for codex project entries (`.codex/prompts`, `.codex/skills`, `.codex/config.toml`) | **in this run** — T1 |
| `.mcp.json` and `enabledPlugins` (`.claude/settings.json`) at the ref | **in this run** — T1 |
| New Task form passes the base ref only when isolated | **in this run** — T2 |
| Create-from-issue dialog, resolve-conflicts dialog, RunPanel scopes | **in this run** — T2 (owner: all four) |
| RunPanel reads the live worktree once it exists | **in this run** — T2 |
| Stale "branch accepted but not used" doc comment + CLAUDE.md | **in this run** — T1 / T3 |
| Unit + e2e coverage | **in this run** — U1 / E1 |
| Re-fetch capabilities when a run settles (`fileScopeRefreshToken` parity, agent writes a skill mid-run) | **out of scope** — a different ticket: capabilities have never refetched on run settle or focus (only saved prompts do); that gap is pre-existing and not created by this change. |
| cursor/gemini project discovery | **out of scope** — pre-existing documented gaps, independent of the ref |
| Discovery cache keyed on (root, ref) | **out of scope** — no measured need (select-driven changes) |
| `cat-file --batch` desync on a filename containing `\n`; unhandled stdin promise; child leak on throw; 30 s → 8 s git budget; `/agent-discovery` workdir precheck; dead `resolveProjectTree` param; stale e2e comments; PromptComposer `workdir` prop now dead | **in this run** — F1 / F2 / F3 (review findings) |
| CLI callers of `/agent-discovery` (`agetor commands`, `discoveredExtensionNames`) on the same scope rule | **in this run** — F2 (review finding; the original "no CLI caller" row was wrong) |
