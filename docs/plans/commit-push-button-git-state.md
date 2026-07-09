# Plan — Commit & Push button driven by git state (not run status)

| Field | Value |
| --- | --- |
| Date | 2026-07-09 |
| Source | agetor task: "Commit and Push button isn't appearing anymore with bg tasks support" |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | agetor/cb537f024347-commit-and-push-button-isn-t-appearing |
| Base SHA | 3d9811b6f87e00121ee100119fa82c3ec3b86332 (tree clean) |
| Mode | **Autonomous** — grill + plan-approval gates bypassed (headless agetor run, owner unreachable); all assumptions logged in §8 |

## 1. Objective & success criteria

The "Commit & push" chip in the RunPanel composer must appear whenever the task's
working tree actually has something to commit **or** commits to push — regardless of
run/turn status — because background agents (and long multi-turn runs) now make
changes while the latest run is still `running`.

Done means:
- Chip shows when `git status --porcelain` is non-empty (staged/unstaged/untracked), OR
  the branch has commits ahead (unpushed), even mid-turn.
- Chip hidden when tree is clean and nothing is ahead, or git state is unknowable.
- CLI `agetor commit` no longer refuses tasks whose column is `running` (broken
  invariant from #92 — a "held" task has a succeeded run but stays in `running`).
- typecheck green, `bun test` green, new units covered by tests.

## 2. Context & constraints (investigation findings)

- Button render: `RunPanel.tsx:1062` — `latestRun?.status === "succeeded" && hasChanges && !sending`
  inside a `canSend && (...)` wrapper, inside the `activeStream === "main"` composer branch.
- `hasChanges` poll effect (`RunPanel.tsx:~687`) bails unless `latestRun?.status === "succeeded"`
  — the git check never even runs mid-turn. **This is the regression surface**: bg-agent
  support means runs stay `running` for long stretches (follow-ups fold into one run;
  #92 holds tasks in `running` while subagents work).
- Backend: `GET /tasks/:id/git-status` (`server.ts:~1206`) → `hasUncommittedChanges(dir)`
  (`worktree.ts:60`, `git status --porcelain`; null → `{hasChanges:false, ignored:true}`).
  **No ahead/unpushed signal exists** (BranchInfo ahead/behind in `listBranches` is
  upstream-tracking for the branch picker, unrelated).
- `sendCommitPush` sends `COMMIT_PUSH_PROMPT` via `api.sendRunInput(resumableRunId, …)` —
  mid-turn this folds into the active run (paste-follow-up), which is acceptable and
  now desired.
- CLI: `src/cli/commands/commit.ts` throws on `task.column === "running"` with a comment
  claiming this "matches the webview" — false after #92 and after this change.
- Git history: condition unchanged since introduction (`727548a`); #81 added the
  activeStream composer gate (keep it — commit is task-level, main-tab-only is correct);
  #92 (`a9e1434`) broke the column⇔run-idle invariant without touching RunPanel.
- Test conventions: no DOM harness — RunPanel logic must be extracted to `src/mainview/lib/*.ts`
  for unit tests (pattern: `subagent-tabs.ts`). Bun git helpers tested with real temp
  repos in `worktree.test.ts`. Route-level git-status test exists in `src/cli/manage.test.ts`.

## 3. Approach & key decisions

- **New backend signal `ahead`** in the git-status response:
  `{ hasChanges: boolean; ahead: number; ignored: boolean }` (additive — old clients fine).
  `ahead` = commits that would be pushed:
  1. upstream configured → `git rev-list --count @{u}..HEAD`
  2. no upstream but task.baseRef pinned → `git rev-list --count <baseRef>..HEAD`
     (branch never pushed → everything is unpushed)
  3. neither → `0` (unknown; `hasChanges` still governs — do NOT poison `ignored`,
     which stays keyed to `hasUncommittedChanges === null` exactly as today).
- **Visibility**: replace the run-status gate with pure git-state:
  `canSend && shouldOfferCommitPush(status) && !sending`, where
  `shouldOfferCommitPush({hasChanges, ahead, ignored}) = !ignored && (hasChanges || ahead > 0)`
  lives in a new pure module `src/mainview/lib/commit-push.ts`.
- **Polling**: decouple from run status — poll every 5s while the panel is mounted
  (sequential non-overlapping loop, deps `[task.id]` only; per RunPanel gotchas, never
  dep on poll-rebuilt task objects). Keep chip main-stream-only via existing composer gate.
- **CLI**: drop the `task.column === "running"` guard (mid-turn commit is now a
  supported flow, matching the webview); update comment; surface `ahead` in `commitNote`
  ("push only" note now genuinely reachable).
- Rejected: reusing `getTaskDiff` (heavy full-diff parse, wrong tool for a 5s poll);
  keying on task.column (same broken proxy that bit the CLI).

## 4. Work breakdown — implementation tasks (Wave 1, all file-disjoint)

- **T1 backend** — owns `src/bun/worktree.ts`, `src/bun/server.ts`.
  Add `getAheadCount(dir, baseRef)` helper + extend `/tasks/:id/git-status` to
  `{hasChanges, ahead, ignored}` per §3. Acceptance: route returns ahead per the
  3-tier rule; comment updated.
- **T2 frontend** — owns `src/mainview/lib/api.ts`, `src/mainview/lib/commit-push.ts` (new),
  `src/mainview/components/kanban/RunPanel.tsx`.
  Update client type; add pure helper; rewire poll effect + chip condition per §3.
- **T3 CLI** — owns `src/cli/commands/commit.ts`, `src/cli/api-client.ts`.
  Remove column guard; type + note updates per §3.

## 5. Work breakdown — test tasks (Wave 2)

- **T4** — owns `src/bun/worktree.test.ts`: `getAheadCount` (no-upstream+baseRef → N;
  with upstream → post-push 0, post-commit 1; missing dir/non-repo → null; neither → 0).
- **T5** — owns `src/mainview/lib/commit-push.test.ts` (new) + `src/cli/manage.test.ts`
  (extend route test with `ahead` assertions) + CLI commit-note test if present.

## 6. Execution waves

Wave 1: T1 ∥ T2 ∥ T3 → typecheck + commit. Phase 5 review. Wave 2: T4 ∥ T5 → full
`bun test` + typecheck → fixes if needed → commit.

## 7. Blast radius & risks

- `/tasks/:id/git-status` consumers: RunPanel poll, CLI `getGitStatus`/`commitNote` —
  both updated here; additive field so no other breakage.
- Chip now visible mid-turn: clicking sends the prompt into the in-flight run
  (folds via paste-follow-up) — existing supported path; run stays single-slot.
- `ahead` via baseRef on a pushed branch would over-count — mitigated by preferring
  `@{u}` when upstream exists.
- Perf: one extra `git rev-list --count` per 5s poll per open panel — negligible.

## 8. Open questions / assumptions (autonomous mode)

- A1: "commits ahead" interpreted as *unpushed* work (upstream-first, baseRef fallback) —
  matches the button's purpose (there is something to commit or push).
- A2: chip stays main-stream-only (`activeStream === "main"`); commit is task-level.
- A3: mid-turn commit sends are allowed in both webview and CLI (guard removed) —
  this is precisely the "bg agents making changes" flow the user asked to support.
- A4: `ignored` semantics unchanged (unknown git state hides the chip).
