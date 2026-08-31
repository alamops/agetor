# Plan — `@` file references: autocomplete, in-field highlighting, worktree-aware path expansion

| Field | Value |
| --- | --- |
| Date | 2026-08-28 |
| Source | `/implement` request (owner, this conversation): "@ key autocomplete + file referencing; highlight only valid files for the project+branch in the prompt field, the message input and the git-integration new-task modals; on send, convert `@filename` to the real path — the worktree's file when the task runs in a worktree" |
| Config | AGENTS_CONFIG.yml (balanced, v1 schema — investigate/implement/tests: sonnet, review: opus, test-running: haiku, planning: self) |
| Flags | none |
| Gates | grilled + approved by owner (4-question grill answered 2026-08-28; plan approval below) |
| Branch | `feature/reference-files-in-the-from-the-selected` (already checked out; not the default branch) |
| Base SHA | `795a5ef` — merge of `fix/remove-from-issue-field-of-new-task` (12 commits incl. its follow-up: RunPanel on PromptComposer, TaskTypePicker, fake-pick e2e seam) onto main `36b46ff`; tree was clean |

## 1. Objective & success criteria

Typing `@` in any prompt composer opens a fuzzy file picker scoped to the task's project **as it will exist for the agent** (its branch / pinned base ref, or the live worktree). Picking an entry inserts an `@repo/relative/path` token. Tokens that name a real file or directory in that scope are **highlighted inside the textarea itself**; anything else (`@github` extension mentions, typos, files not on that branch) stays plain text. When the prompt or message is sent, every valid token is replaced **in place** by the absolute path the agent can open — the **worktree** file when the task runs in a worktree, else the workdir file.

Done means:
1. `@` popover works in all four composers: RunPanel message input, New Task prompt, "Work on this with Agetor" (issue) dialog, "Resolve with Agetor" (PR conflicts) dialog.
2. Highlighting reflects validity against the right listing per surface (see §3.4) and updates as the user types / after a pick / after a project or branch change.
3. Sending from the RunPanel (typed, backlog tray, diff composer, ask-card free text, CLI `agetor send`) and starting a task (`POST /tasks/:id/start`, incl. `agetor add … --start`) both deliver absolute paths to the agent; `task.prompt`, drafts and backlog items keep the `@tokens`.
4. Worktree tasks resolve to `<dataDir>/worktrees/<task-id>/<rel>`; isolation=none tasks resolve to `<workdir>/<rel>`. A re-run after the source repo moved still resolves against the task's own worktree.
5. Unit + endpoint + orchestrator tests green; a Playwright spec drives the real UI (popover, Tab-descend, highlight, send → absolute path in the transcript).

## 2. Context & constraints (grounded)

- **Template**: `SlashAutocomplete.tsx` — `findActiveQuery` slice detection (`/` only after BOF/whitespace, no whitespace in the query), caret synced on native `keyup/click/focus`, edge-anchored popover (`placement: above|below`), native `keydown` listener that `preventDefault()`s ↑/↓/Enter/Tab/Escape so the parent's `onKeyDown` bails on `e.defaultPrevented` (RunPanel Enter-to-send contract, `RunPanel.tsx:3149-3172`). On the sibling branch it additionally carries `data-popover-open=""`, `data-popover-keys="escape-only"`, `data-testid="slash-autocomplete[-row]"`, and the `dismissedSlice` Escape fix (`4b676f0`).
- **Caret rules** (peer knowledge 7213fd0d, 17e11f2a): programmatic inserts call `setSelectionRange` **before** `focus()`; a textarea never scrolls to a programmatically set caret — set `scrollTop` too. `lib/textarea-insert.ts` has `spliceAtSelection/readCaret/restoreCaret`.
- **`@name` is already the extension-mention syntax** (`commands.ts:336,362,471,526`, `AvailableExtension.insert = "@" + name`) inserted by `ExtensionPicker`. Non-file tokens must be left untouched on send and unhighlighted.
- **No file-listing route exists.** Seams: `git ls-files --others --exclude-standard -z` (`worktree.ts:969`), `isSafeRelPath` (`worktree.ts:1053-1061`, the client-input traversal guard), `/open-path`'s `relative + taskId → path.resolve(worktreePath ?? workdir, rel)` (`server.ts:3939-3948`). `commands.ts:194-214` explicitly reserves `git ls-tree` for "list at a branch without a worktree".
- **The worktree does not exist at create time** (`createTask` inserts `worktreePath: null`, `orchestrator.ts:3627`); `prepareWorkdir` materializes it inside `startTask` (`orchestrator.ts:935`) and the agent cwd is the **worktree root** (`worktree.ts:906 cwd: wt`; worktrees are based off the repo root, `worktree.ts:312`). Launch prompt is assembled at `orchestrator.ts:995` (`appendReferences(task.prompt, task.references)`) → echoed as a `user` event → `spawnAgentOrFail`.
- **Follow-ups**: every send funnels through `sendInput(runId, line)` (`orchestrator.ts:2172-2248`), which loads `task`, restores a missing worktree via `prepareWorkdir`, then dispatches per kind; each kind re-derives `cwd = task.worktreePath ?? task.workdir`. `/runs/:id/input` body is `{ line }` (`server.ts:4795-4809`). Ask-card free text (`server.ts:4265`) and the CLI (`lifecycle.ts:77`) hit the same choke point.
- **Gemini argv cap**: `promptByteOverage(kind, prompt)` (`shared/prompt-limits.ts`, 4096 B) is pre-checked client-side on the *raw* text; expansion lengthens the prompt, so the server must re-check post-expansion.
- **Highlighting inside `<textarea>`**: CSS Custom Highlight API cannot target textarea contents (open spec gap w3c/csswg-drafts#9971); the established technique is a mirror/backdrop layer. No overlay precedent exists in this app; `ui/textarea.tsx` is a plain shadcn wrapper, no autosize.
- **Tokens**: semantic `--info` exists in both themes (`index.css:42,98`); `bg-popover` is undefined (use `bg-card`/`border-border`).
- **Tests**: `bun test` runs every `src/**/*.test.ts` in one process — set `AGETOR_DATA_DIR` at file top; endpoint tests take a unique port (4593 is free; 4600+ is e2e). Fake claude driver echoes the spawned prompt on `stdout` (`orchestrator.test.ts:69-99`). Playwright: `bun node_modules/@playwright/test/cli.js test …` (never `bunx`), per-worker headless backend with `AGETOR_CLAUDE_DRIVER=fake`, real temp git repos (`e2e/issue-task.spec.ts` `initRepo`/`registerProject`), one Playwright run at a time.
- **Sibling branch `fix/remove-from-issue-field-of-new-task`** (7 commits, owner-approved, unpushed): `PromptComposer.tsx` (label row + ExtensionPicker, Textarea + SlashAutocomplete in a `relative` wrapper, ReferencesPicker) consumed by NewTaskForm / CreateTaskFromIssueDialog / ResolveConflictsDialog; `WorktreeOptions.tsx` (`useWorktreeOptions` → `isolate`, `baseRef`); `dialog.tsx` Escape/Tab yield to `[data-popover-open]`; test ids `prompt-textarea`, `issue-task-dialog`, `resolve-conflicts-dialog`, `worktree-options[-locked]`. `git merge-tree --write-tree main <branch>` is conflict-free. **Its follow-up (commits `2d2ce22`…`b99b74a`, merged here) migrated RunPanel's send box onto `PromptComposer` as well** (layout slots, `placement`, `textareaClassName`/`textareaTestId`, `onKeyDown` pass-through, hoisted capability hooks) and added `AGETOR_FAKE_PICK_REFS_DIR` + `backend.plantPicks()` for e2e — so `@` is wired once in `PromptComposer` and every caller only supplies a `fileScope`.

No spikes were run: nothing load-bearing survived the reading. Residual risk (§7): overlay pixel alignment in WKWebView is verified by Playwright in Chromium and by the owner's dev-build smoke test.

## 3. Approach & key decisions

### 3.1 Token grammar (owner decision)
- Trigger: `@` at BOF or after whitespace (same guard as `/`; `user@host` never triggers).
- Bare form `@src/bun/db.ts` — run of non-whitespace; trailing sentence punctuation `.,;:!?` and closing `)]}>'"` are excluded from the token (so `see @README.md.` works).
- Quoted form `@"docs/my file.md"` — for paths containing whitespace (or `"`-free otherwise); the picker emits it automatically.
- Directories end with `/` (`@src/bun/`), matching `formatReferences`' trailing-slash convention.
- Paths are **cwd-relative for the agent**: repo-root-relative for worktree tasks (cwd = worktree root) and workdir-relative for isolation=none tasks (cwd = workdir). The listing route below produces exactly that shape per mode.

### 3.2 Conversion = server-side, in place, plain absolute path (owner decision)
`@src/x.ts` → `/Users/…/.agetor/worktrees/<id>/src/x.ts` (dirs keep the trailing `/`). Done at the two choke points that know the cwd — `startTask` (right after `prepareWorkdir`, before the run-row transaction) and `sendInput` (after the worktree restore, before the per-kind dispatch) — so the webview, backlog tray, diff composer, ask-card answers and the CLI all get it with no client changes. Only tokens that resolve to an existing path under the cwd are replaced (`isSafeRelPath` + `existsSync`; a trailing-slash token must be a directory); everything else stays verbatim. Stored `task.prompt`, drafts and backlog keep tokens; the echoed `user` bubble shows the expanded text (accepted by owner). No `@` prefix survives (a pasted `@` could pop claude's native picker mid-paste). `startTask` re-checks `promptByteOverage` on the expanded prompt and returns `{ error }` before inserting a run row.

### 3.3 Listing source per surface (owner decision: files/dirs only, highlight only listed paths)
`GET /files/index?dir=<abs>&ref=<ref?>` → `{ files: string[], truncated: boolean }` (cap `MAX_PROJECT_FILES = 20000`, NUL-split, sorted):
- `ref` given → `git -C dir ls-tree -r --name-only --full-tree -z <ref>` (tracked files at that ref, root-relative — the shape a not-yet-created worktree will have). If `<ref>` doesn't resolve, retry `refs/remotes/origin/<ref>` (PR head branches may only exist as remote-tracking refs); still failing → `{ error }` 400.
- no `ref` → `git -C dir ls-files -z --cached --others --exclude-standard` minus `git ls-files -z --deleted` (live tree incl. untracked-not-ignored, cwd-relative).
Client scope (`fileScope: { dir, ref? }`):
| Surface | scope |
| --- | --- |
| RunPanel | `worktreePath ? {dir: worktreePath} : isolation==="worktree" ? {dir: workdir, ref: baseRef ?? "HEAD"} : {dir: workdir}` |
| NewTaskForm | `workdir ? {dir: workdir, ref: isolate ? (baseRef.trim() || "HEAD") : null}` |
| Issue dialog | `{dir: context.path, ref: wt.isolate ? (wt.baseRef || "HEAD") : null}` |
| Resolve-conflicts dialog | `{dir: context.path, ref: context.headRef}` (locked worktree on the PR head) |
Directories are derived client-side from path prefixes. Highlight validity = token path ∈ (files ∪ derived dirs). The listing is fetched on scope change and refreshed on textarea focus; keystrokes filter client-side (pure fuzzy scorer, no dependency). No `native` dependency → works in headless/CLI/e2e.

### 3.4 Popover (owner decision: Tab descends, Enter commits)
`AtFileAutocomplete` is a sibling of `SlashAutocomplete` (same caret sync, edge anchoring, native keydown + `preventDefault`, `dismissedSlice` Escape, `data-popover-open` + `data-popover-keys="escape-only"`, `data-testid="at-file-autocomplete[-row]"`). Rows: icon (`iconForRef`), path with the matched chars emphasized, dirs with trailing `/`. **Enter/click** commit the row as `@path ` / `@"path" ` (+ trailing space). **Tab** on a directory row rewrites the query to `@dir/` and keeps the popover open (caret stays inside the slice, so the slice re-derives and the list narrows); Tab on a file row behaves like Enter. Escape dismisses (does not move the caret). ↑/↓ wrap; `data-idx` scroll-into-view. A `/` typed inside an `@` slice never opens the slash menu (its `/`-after-whitespace guard already excludes it) — add a unit test pinning that.

### 3.5 Highlighting = backdrop marks behind the real textarea
`AtHighlightBackdrop` renders an `aria-hidden` `absolute inset-0 pointer-events-none overflow-hidden` div *behind* the textarea (the textarea gets `relative bg-transparent`, which it already is). It mirrors the textarea's text with `white-space: pre-wrap; word-break: break-word; color: transparent`, copies `font*`, `letter-spacing`, `line-height`, `padding`, `border-width`, `text-indent`, `tab-size` from `getComputedStyle(textarea)` (ResizeObserver + on value change), appends a `​` sentinel after a trailing newline, and syncs `scrollTop/scrollLeft` on the textarea's `scroll` event. Valid tokens render as `<mark class="rounded-sm bg-info/20 text-transparent">` — the **visible text stays native** (no `text-transparent`/caret-color tricks on the textarea; a metric mismatch can only misplace a highlight box, never the text). Placeholder, selection and caret are untouched. Pure segmenting (`computeAtHighlights`) is unit-tested; the DOM layer is exercised by Playwright.

### 3.6 Alternatives rejected
- Client-side expansion (webview knows `worktreePath`): impossible for the launch prompt (no worktree at create time) and would leave the CLI/ask-card paths inconsistent.
- Appending expanded files to the `Referenced files/folders:` block as well: duplicates the path in every message; owner chose inline only.
- `contenteditable` or the CSS Highlight API for highlighting: the former rewires paste/drop/`textarea-insert.ts`; the latter cannot reach textarea contents.
- A fuzzy-match dependency (`fuzzysort`, `fuse.js`, `cmdk`): none present in the repo; a ~60-line scorer (continuous-match + `/`/word-boundary bonus, jump penalty — the `command-score` scheme `cmdk` vendors) is enough.
- Server-side per-keystroke search: one listing fetch + client filtering matches the `/` menu's props-in/pure-filter shape and avoids a subprocess per keystroke.

## 4. Work breakdown — implementation tasks

All tasks: match surrounding conventions (semantic tokens only, `@/` alias, no new deps), keep pure logic in DOM-free modules with `bun:test` coverage, and never `git stash`/checkout files you don't own. Every brief carries `export PATH="$HOME/.bun/bin:$PATH"`.

**Wave 1 — pure foundations (3 agents, disjoint, no cross-dependency)**

- **T1 `src/shared/at-refs.ts` (+ `src/shared/at-refs.test.ts`)** — pure, no runtime imports. Exports:
  - `interface AtToken { start: number; end: number; raw: string; path: string; quoted: boolean; isDirectory: boolean }`
  - `findAtTokens(text: string): AtToken[]` — grammar §3.1.
  - `formatAtToken(path: string): string` — `@path` or `@"path"` when it contains whitespace.
  - `findActiveAtQuery(text: string, caret: number): { start: number; end: number; query: string; quoted: boolean } | null` — `@` after BOF/whitespace up to the caret; bare form stops at whitespace; quoted-in-progress form (`@"partial na`) allows spaces until a closing `"`.
  - `expandAtTokens(text: string, resolve: (path: string, isDirectory: boolean) => string | null): string` — replaces resolved tokens in place, right-to-left, leaves others verbatim.
  - `AT_TOKEN_MAX_LEN = 4096`.
  - Acceptance: tests for BOF/whitespace guard, `user@host`, trailing punctuation, quoted spaces, dirs, `@github` left alone by a resolver returning null, overlapping/adjacent tokens, CRLF text, `findActiveAtQuery` incl. the `/`-inside-`@` case with `SlashAutocomplete`'s `findActiveQuery` logic replicated in the test (pin that `@src/` never yields a slash query).
- **T2 `src/bun/project-files.ts` (+ `src/bun/project-files.test.ts`)** — `listProjectFiles({ dir, ref }: { dir: string; ref?: string | null }): Promise<{ files: string[]; truncated: boolean } | { error: string }>` per §3.3 (own `git()` spawn helper mirroring `worktree.ts:33`, timeout, NUL split, dedupe, sort, cap), and `resolveAtPath(cwd: string, relPath: string, isDirectory: boolean): string | null` (strip trailing `/`, `isSafeRelPath` from `worktree.ts`, `path.resolve`, `existsSync` + `statSync` directory check for `isDirectory`, re-append `/` for dirs, reject when the resolved path escapes `cwd` after `realpath`). Tests on a `mkdtemp` git repo (`worktree.test.ts` `makeRepo` pattern): tracked/untracked/ignored/deleted files, `ref` mode at a second commit, `origin/<ref>` fallback, bad ref → error, truncation, `resolveAtPath` on `..`, absolute, missing, dir-vs-file mismatch.
- **T3 `src/mainview/lib/at-file-filter.ts` (+ `.test.ts`)** — pure: `interface FileEntry { path: string; isDirectory: boolean }`; `buildFileEntries(files: string[]): FileEntry[]` (derive every directory prefix once, dirs carry trailing `/`); `fuzzyPathScore(query, path): number | null`; `filterFileEntries(entries, query, limit = 50): FileEntry[]` (empty query → shallowest entries first; `/`-anchored prefix matches rank above subsequence matches; stable ties); `descendInto(dirPath): string` (the `@dir/` query Tab produces). Tests: ranking sanity (`db.ts` beats `dbx/foo.ts`; `s/b/d` subsequence hits `src/bun/db.ts`), dir derivation, limits.

**Wave 2 — wiring the halves (2 agents, disjoint)**

- **T4 server integration** — owns `src/bun/server.ts`, `src/bun/orchestrator.ts`, `src/bun/project-files.ts` (additions only), `src/bun/project-files-endpoint.test.ts` (new, port **4593**), `src/bun/orchestrator-at-refs.test.ts` (new). Adds `expandAtReferences(text, cwd)` to `project-files.ts` (= `expandAtTokens(text, (p, d) => resolveAtPath(cwd, p, d))`); route `GET /files/index` (authed, `dir` must be absolute, `ref` optional, `{ error }` → 400, no `native`); `startTask`: expand right after `prepareWorkdir` succeeds, build `promptWithRefs` from the expanded text, `promptByteOverage(harness.kind, promptWithRefs)` → `{ error: "prompt is N bytes over <kind>'s M-byte launch limit after expanding @ references" }` before the transaction; `sendInput`: expand `line` against `task.worktreePath ?? task.workdir` once, after the worktree-restore branch, before dispatch (one place — not per kind). Tests: endpoint (live + ref modes, 400s), orchestrator (worktree task with `@README.md` → fake-driver stdout contains `<worktreePath>/README.md`; isolation=none → `<workdir>/README.md`; `@nope.txt` and `@github` untouched; follow-up via `sendInput` on the fake driver; gemini overage rejected before a run row exists).
- **T5 webview primitives** — owns `src/mainview/components/kanban/AtFileAutocomplete.tsx` (new), `src/mainview/components/kanban/AtHighlightBackdrop.tsx` (new), `src/mainview/lib/at-highlight.ts` (+ `.test.ts`, new: `computeAtHighlights(text, isValid): Array<{ text: string; mark: boolean }>`), `src/mainview/lib/use-project-files.ts` (new hook: `useProjectFiles(scope?: FileScope)` → `{ entries: FileEntry[]; validPaths: Set<string>; truncated; refresh() }`, module-level cache keyed `dir\0ref`, refetch on scope change and on `refresh()`), and `src/mainview/lib/api.ts` (add `listProjectFiles({ dir, ref })` → `GET /files/index`, mirroring `listAgentCapabilities`'s query shape). Props: `AtFileAutocomplete { entries, value, onChange, textareaRef, placement? }`, `AtHighlightBackdrop { textareaRef, value, validPaths, className? }`. Behavior per §3.4/§3.5; insert path = `spliceAtSelection`-style replacement of the slice with `formatAtToken(path) + " "`, caret set via `setSelectionRange` then `focus()` then `scrollTop` (peer gotchas), then `setCaret`. Not wired anywhere yet.

**Wave 3 — surfaces + docs (3 agents, disjoint)**

- **T6 PromptComposer + form/dialog callers** — owns `PromptComposer.tsx`, `NewTaskForm.tsx`, `CreateTaskFromIssueDialog.tsx`, `ResolveConflictsDialog.tsx`, and the e2e locator lines in `e2e/issue-task.spec.ts` / `e2e/resolve-conflicts.spec.ts` that would break from the placeholder change. Adds `fileScope?: FileScope` prop; inside the existing `relative` textarea wrapper renders `<AtHighlightBackdrop>` first, then the `Textarea` (add `relative bg-transparent` to its class), then `SlashAutocomplete` + `AtFileAutocomplete` (same `placement`); calls the listing `refresh()` on textarea focus alongside `reload`. Callers pass scopes per §3.3 (NewTaskForm from `workdir`/`wt.isolate`/`wt.baseRef`; issue dialog from `wt`; resolve dialog from `context.headRef`). Default placeholder becomes "What should the agent do? Type / for commands, @ for files." — switch any `getByPlaceholder` e2e locator for it to `getByTestId("prompt-textarea")`.
- **T7 RunPanel caller** — owns `RunPanel.tsx` only: compute `fileScope` from `task` (§3.3) and pass it to the `<PromptComposer>` it already renders; update the three "Type / for commands." placeholders to "… Type / for commands, @ for files." Nothing else (the popover/backdrop come from T6's PromptComposer change).
- **T8 docs** — owns `CLAUDE.md` (new numbered paragraph 12 in *Orchestration flow*, after the sibling's 11: grammar, listing modes, where expansion runs and why, highlight technique, the `@name` extension-mention carve-out, test ids) and `README.md` if it documents the composer/file references (grep first; add one sentence, otherwise leave it).

## 5. Work breakdown — test tasks

Unit/integration tests ship inside T1–T5 (each task owns its `.test.ts`). Phase 6 adds:
- **TT1 `e2e/at-file-autocomplete.spec.ts`** (new): temp git repo with `README.md`, `src/app.ts`, `docs/my notes.md`; register project; New Task form: type `@REA` → `at-file-autocomplete-row` visible → Enter → value `@README.md `; type `@sr` → Tab on `src/` row → value contains `@src/` and popover still open → Enter → `@src/app.ts `; `@"docs/my notes.md"` inserted for the spaced file; backdrop `<mark>` count equals valid tokens and drops to 0 after editing the token to `@nope.md`; Escape closes only the popover; create + start (fake driver, isolation worktree) → transcript contains `<dataDir>/worktrees/<id>/README.md`; RunPanel composer: `@` popover opens above, send → user bubble shows the absolute path; issue dialog (GitHub stub, `issue-task.spec.ts` helpers) → popover works inside the dialog and Escape leaves the dialog open.
- **TT2 unit gaps** found in review (if any) — same owners' test files.

**E2E applies** (UI → API → git → agent prompt crosses three boundaries). Run recipe: `export PATH="$HOME/.bun/bin:$PATH"`; `bun node_modules/@playwright/test/cli.js test e2e/at-file-autocomplete.spec.ts --reporter=list` (Playwright boots Vite on 5173 and per-worker headless backends on 4600+; fake claude driver + stub `fx`; no credentials). One Playwright run at a time; kill leaked `bun src/bun/headless.ts` on 4600+ first.

## 6. Execution waves

| Wave | Tasks | Barrier |
| --- | --- | --- |
| 0 (orchestrator) | `git merge --no-ff fix/remove-from-issue-field-of-new-task`; record Base SHA; commit plan | typecheck + `bun test` baseline green on the merged tree |
| 1 | T1, T2, T3 | typecheck; new unit tests green; commit `wave 1` |
| 2 | T4, T5 | typecheck; endpoint + orchestrator tests green; commit `wave 2` |
| 3 | T6, T7, T8 | typecheck; full `bun test`; commit `wave 3` |
| review | opus, `code-review` skill rubric | must-fix list → Phase 8 |
| tests | TT1 (+TT2) | full `bun test` + the new Playwright spec + `issue-task`/`resolve-conflicts` specs |

## 7. Blast radius & risks

- `startTask`/`sendInput` are on every agent kind's path — expansion is a pure string pass over text that contains `@`; text without `@` short-circuits (`findAtTokens` returns `[]`). Regression guard: existing orchestrator tests + the new ones.
- `POST /files/index` spawns git per call; the client caches per scope and only refetches on focus/scope change. Capped at 20k entries; `truncated` surfaces as "showing first 20,000 files" in the popover footer. A token valid on disk but past the cap is unhighlighted yet still expanded on send (documented).
- Placeholder copy change touches e2e locators (T6 owns the fix). `getByPlaceholder` uses elsewhere are grepped in T6.
- Overlay alignment: mirrored computed styles + Chromium e2e; WKWebView differences (font smoothing) only shift highlight boxes, never text. Owner smoke-tests in `~/.agetor-dev` (`bun run dev:hmr`).
- `@`-mention ambiguity: `@github` never resolves to a file unless a file literally named `github` sits at the cwd root — accepted edge.
- Rollback: feature is additive; reverting the three waves restores prior behavior (no migration, no schema change).

## 8. Open questions / assumptions

Owner-decided (grill): base on the sibling branch; inline plain absolute path, server-side; quoted spaces + dir trailing slash + Tab-descend; files/dirs only, highlight only listed paths.
Assumptions logged (routine, reversible):
1. Highlight style `bg-info/20` rounded box behind native text (no text recolor).
2. Popover is edge-anchored like `/` (not caret-anchored).
3. Expanded text is what the `user` transcript bubble shows.
4. Listing refresh cadence: on scope change + textarea focus (no polling).
5. Backlog inline editor and the DiffDialog composer get server-side expansion but no popover/highlight (no composer machinery there today).
6. The CLI needs no change; `agetor send "@src/x.ts"` expands server-side. `--ref` semantics unchanged.
7. The sibling branch is merged with `--no-ff` (its commits ride along until its own PR lands; PR diff shrinks afterwards).

## 10. Outcome (2026-08-28)

- **Commits** (branch `feature/reference-files-in-the-from-the-selected`, base `795a5ef` = merge of `fix/remove-from-issue-field-of-new-task`): `44ab83e` plan · `4b74b89` wave 1 · `db5c326` wave 2 · `d505dfd` wave 3 · `e4faa41` budget pre-check carve-out · `c3f9b4c` e2e spec · `a6980ca` review fixes. Not pushed.
- **Deviation from §4:** the sibling branch's own follow-up (merged in wave 0) had already moved RunPanel's send box onto `PromptComposer`, so T7 shrank to "pass a `fileScope`" — the `@` layer is wired once, in `PromptComposer`.
- **Review** (opus, `code-review` skill): 3 major / 11 minor / 7 nit — all 21 applied in `a6980ca` (+ the wave-2 regression T4 caught in the full suite: the budget pre-check must not intercept prompts already over the cap, `e4faa41`).
- **Verification:** `bun run typecheck` clean; `bun test` 4059 pass / 3 skip / 0 fail (205 files; baseline on the merged tree was 3934); Playwright `at-file-autocomplete` 9/9, `issue-task` 6/6, `resolve-conflicts` 1/1, `quote` 1/1 (17/17).
- **Open:** owner smoke test of the highlight backdrop in the dev build (`bun run dev:hmr`, `~/.agetor-dev`) — Chromium-verified, WKWebView metrics not machine-verified. Two documented validity divergences (gitignored paths and paths past the 20k cap are expanded on send but not highlighted).

## 11. Follow-up (2026-08-31)

- Closed the "unresolved tokens fail silently" gap: `PromptComposer` now shows an inline `text-warning` line (`at-unresolved-warning`) while the draft holds `@` tokens that match no project file — listing verdict first, known `@name` extension mentions exempt, and for live scopes a 300 ms-debounced `POST /refs/resolve` stat rescues gitignored-but-present paths (which send-time expansion WILL resolve); suppressed while the listing is loading/failed/empty/truncated; advisory only, send behavior unchanged. Helpers `unresolvedAtTokens`/`isSafeClientRelPath` in `lib/at-highlight.ts` (+7 unit tests), e2e scenario 7 (spec now 10/10). Typecheck clean; `bun test src/mainview` 930/0.

## 12. Follow-up (2026-08-31): CLI parity

- Server truth source: `expandAtReferencesDetailed` (project-files.ts); `startTask` + `sendInput` results carry additive `unresolvedRefs?: string[]` (raw tokens left verbatim).
- `agetor send` / `agetor add --start`: yellow stderr warning filtered against `@name` extension mentions (agent-discovery, fail-open); `add` pre-validates a non-start prompt via `GET /files/index`; `--issue` restricts warnings to user-typed `--prompt` tokens (empty restriction when none — the composed thread quotes third-party @mentions). `--json`: raw `unresolvedRefs` on send; filtered line in `add`'s `warnings`.
- TUI Dashboard composer: `@` autocomplete (`tui/at-complete.ts`: RunPanel-parity `fileScopeForTask`, top-5 suggestions, Tab/Enter accept, dir descend incl. spaced-dir quoted form, ↑/↓, Esc dismiss-then-cancel), listing cached per pinned task; post-send `⚠ N @ refs won't resolve` status.
- Shared moves: `at-file-filter.ts` → `src/shared/`; `isListedPath`/`unresolvedAtTokens` → `src/shared/at-refs.ts` (re-exported from `lib/at-highlight.ts`).
- Review (opus, code-review skill) on the CLI-parity commit: 1 high / 4 medium / 5 low, all applied — memoized TUI suggestions (50 ms/render at the 20k cap under the 12 fps spinner), scope-keyed TUI listing cache, dismissed-popover reopen, discovery-filtered ⚠ status + `s`-start warning, `--prompt-file`/wizard captured as the user-typed prompt for `restrictTo`, live-scope on-disk rescue + empty-listing guard in `add`'s pre-check, `fileScopeForTask` reuse, shared `discoveredExtensionNames`, `agetor start` warns, webview `sendRunInput` type synced.

## 13. Follow-up (2026-08-31): run-settle listing refresh

- `PromptComposer` gains `fileScopeRefreshToken?: unknown` — a change fires `projectFiles.refresh()` (ref-compared, never on mount). RunPanel passes `task.column`, so any run-settle/start transition re-lists the tree without blur/refocus; the TUI Dashboard's per-scope cache stores the column it was fetched under and refetches on mismatch (stale entries stay visible during the refetch). e2e: new RunPanel scenario proves a file written into the worktree after the focus-refetch appears in the open popover after a column change, with no focus events in between.

## 14. Follow-up (2026-08-31): monorepo fallback past the 20k cap

- `GET /files/index?q&limit`: full-listing ranked search (shared scorer, 250k q-mode scan cap, 3 s-TTL single-flight cache pruned+capped at 4 scopes, dir stat on hit); no-q mode sorts the full list before the 20k cap (fixes an untracked-then-tracked ordering hazard).
- Truncated composers: popover falls back to server search (≥2-char queries, 150 ms debounce, request-failure = keep local rows); PromptComposer verifies ≤8 unlisted tokens via q-mode → highlight union + proven-missing-only warnings (unproven never warns); TUI `remoteSearch` and `agetor add`'s pre-check mirror the contract.
- Review (opus, code-review skill): 4 high / 3 medium / 7 low — all applied (blank-query O(n) path + client gate, server single-flight, null-failure semantics, cache prune/cap, client search-cache TTL+limit key+refresh clear, active-row reset on row identity, footer reword, no-q sort-before-cap, TTL test seam, add.ts past-cap parity).
- e2e: `at-file-truncated.spec.ts` — 20,050-file fixture (~2 s build), target past the cap: fallback popover + footer, past-cap highlight, proven-missing warning, below-cap regression; 15/15 with the main spec.
