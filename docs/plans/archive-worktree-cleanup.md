# Plan — Worktree cleanup on archive, with restorable AI session

| Field | Value |
| --- | --- |
| Date | 2026-07-13 |
| Source | /implement task: "Once archiving a task, we must also cleanup the associated worktree but keeping the AI history for restoration of the session later if the user decides to send a message to an archived task or if they decide to unarchive that." |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | feature/cleaning-up-worktrees |
| Base SHA | 5ec712ab5ea8cfae618170fec7f4db99748d30b9 |
| Mode | **Autonomous** — grill + plan-approval gates bypassed; all assumptions logged in §8 |

## 1. Objective & success criteria

When a task is archived, its git worktree directory is removed from disk (reclaiming space and reducing `~/.agetor/worktrees/` clutter), while everything needed to resume the agent conversation is preserved. The session is restored — worktree re-materialized on the same branch at the same path, conversation resumed via `claude --resume <sessionId>` / `codex exec resume <thread_id>` — when the user unarchives the task or sends a message to it.

Success criteria:
- `archiveTask` removes the worktree dir but **keeps the branch**, `task.worktreePath`/`branch`/`baseRef` in the DB, all `runs`/`run_events` rows (incl. `claude_session_id`/`codex_session_id`), and claude's external JSONL history.
- `unarchiveTask` re-materializes the worktree (best-effort) so the card is immediately usable.
- Sending a message to an archived task auto-unarchives it, restores the worktree, and resumes the prior conversation.
- A dirty worktree (uncommitted changes) is **not** removed on archive — no silent data loss.
- `bun run typecheck` green; `bun test` green.

## 2. Context & constraints (from investigation)

- `archiveTask` (`orchestrator.ts:1729`) today: done-column only, kills tmux sessions (`dropSession`/`dropCodexSession`), fire-and-forgets `killTerminalsForTask`, **keeps the worktree** (doc comment says so explicitly).
- `removeWorktree` (`worktree.ts:756`) is delete-only: `git worktree remove --force` **plus `git branch -D`** — unusable for archive as-is (would destroy the work). Owned-prefix `rmSync` fallback for paths under `dataDir/worktrees/`.
- `prepareWorkdir` (`worktree.ts:536`) already has the exact restore mechanic: when `task.worktreePath` is recorded but the dir is gone and the branch exists, it re-attaches via `git worktree add <wt> <branch>` (no reset — prior commits preserved). Path is deterministic: `dataDir/worktrees/<task-id>`. Tested at `worktree.test.ts:154-174` and `:316-345`.
- Claude AI history = `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` — encoded from the **cwd path string** (`claude-tmux.ts:302,1555`), stored outside the worktree. Deleting the worktree never touches it, but `task.worktreePath` must stay **non-null and verbatim** in the DB or the JSONL lookup (`/runs/:id/rebuild-events`, resume) resolves the wrong encoded path. Also the PATCH workdir-lock (`server.ts:2962`) keys off `worktreePath !== null`.
- Codex history = thread id in `runs.codex_session_id`, replayed via `codex exec resume <thread_id>`; not cwd-encoded.
- **Gap:** `spawnResumedSession` (`orchestrator.ts:1490`) and `spawnCodexTurnNow` (`orchestrator.ts:1196`) compute `cwd = task.worktreePath ?? task.workdir` with no existence check and never call `prepareWorkdir` — spawning into a missing dir fails (30s boot-timeout at best).
- `sendInput` (`orchestrator.ts:1134`) is sync; its only production callers are async route handlers (`server.ts:3419`, `:3618`). `archiveTask`/`unarchiveTask` callers: `server.ts:3054`, `:3063`. Going async is safe.
- Diff/git-status/open-path routes already degrade gracefully when the dir is missing (`worktree.ts:63,91,681`; `server.ts:3198,3248`). `createTerminal` already calls `prepareWorkdir` (rematerializes).
- UI: archived RunPanel replaces the composer with a static "Unarchive it to send messages" notice (`RunPanel.tsx:1307-1310`); backlog tray renders `readOnly`. Archive/Unarchive buttons at `TaskCard.tsx:182-191`, `RunPanel.tsx:1173-1182`.
- Tests: `orchestrator.test.ts` (top-level mkdtemp `AGETOR_DATA_DIR`, fake driver env, per-test dynamic imports, manual row cleanup); `worktree.test.ts` (`makeRepo()`/`fakeTask()` helpers, real temp git repos). Existing archive tests only cover `isolation: "none"`.
- Latest migration: `026` — **this plan needs no migration** (no schema change).

## 3. Approach & key decisions

1. **New `detachWorktree(task)` in `worktree.ts`** — branch-preserving teardown: `git worktree remove --force` + `prune` + owned-prefix `rmSync` fallback, **no `git branch -D`**. Idempotent (no-op when dir already absent). Skips removal when the worktree has uncommitted changes (returns `{ removed: false, reason: "dirty" }`) — `--force` would permanently destroy uncommitted work. Never throws.
2. **Keep `task.worktreePath` non-null across archive** — required by the JSONL path encoding, the PATCH workdir-lock, and `prepareWorkdir`'s re-attach key. State "dir missing on disk" is detected via `existsSync`, matching existing patterns. No new column, no migration.
3. **Restore = `prepareWorkdir`** — its existing re-attach path is exactly "same absolute path, same branch". Triggers:
   - `unarchiveTask` → eager best-effort re-materialize (failure logged to console, does not block unarchive; next send/start/terminal retries lazily).
   - `sendInput` → auto-unarchive if archived, then restore the worktree if `worktreePath` set but dir missing, then dispatch as today. Hard failure (e.g. branch deleted by user, or checked out elsewhere) returns `{ delivered: false, reason }`.
   - `startTask` → already calls `prepareWorkdir`; add auto-unarchive so a started archived task can't become a hidden moving card.
4. **Ordering in `archiveTask`**: stamp `archivedAt` → drop tmux sessions → **await** `killTerminalsForTask` (a live shell cwd'd in the worktree blocks `git worktree remove`; mirrors `deleteTask`'s ordering) → await `detachWorktree`. `archiveTask` becomes async.
5. **`sendInput` (and `archiveTask`/`unarchiveTask`) become async** — awaited at the 4 server.ts call sites. HTTP CLI unaffected.
6. **UI**: archived RunPanel shows the normal composer (same `canSend`/`resumableRunId` capability rules as an idle task) with an inline hint that sending will unarchive the task and restore its worktree. Backlog tray stays `readOnly` while archived (server freezes backlog mutations; unchanged).

Alternatives considered: (a) new `worktreeRemovedAt` column — rejected, `existsSync` is the established pattern and no consumer needs the distinction; (b) restore at the server-route layer — rejected, orchestrator owns process side effects in this codebase; (c) sync git rematerialization to keep `sendInput` sync — rejected, duplicates `prepareWorkdir` logic and the async ripple is contained.

## 4. Work breakdown — implementation tasks

| ID | Goal | Files owned | Deps | Acceptance |
| --- | --- | --- | --- | --- |
| T1 | Backend: `detachWorktree`; async `archiveTask` with detach; eager-restore `unarchiveTask`; auto-unarchive + lazy-restore in `sendInput`; auto-unarchive in `startTask`; await at server call sites; update stale doc comments | `src/bun/worktree.ts`, `src/bun/orchestrator.ts`, `src/bun/server.ts` | — | typecheck green; behavior per §3 |
| T2 | Frontend: unlock composer on archived tasks with unarchive-on-send hint; keep backlog tray readOnly | `src/mainview/components/RunPanel.tsx` | — | typecheck green; archived task shows enabled composer + hint |

## 5. Work breakdown — test tasks

| ID | Goal | Files owned | Covers |
| --- | --- | --- | --- |
| T3 | `detachWorktree` unit tests: removes dir + keeps branch/commits; dirty worktree skipped; idempotent on missing dir; `prepareWorkdir` re-attach after detach round-trip | `src/bun/worktree.test.ts` | T1 (worktree.ts) |
| T4 | Orchestrator archive-lifecycle tests: archive removes worktree dir, keeps branch + runs rows + session ids; unarchive re-materializes; `sendInput` on archived task auto-unarchives (fake driver); startTask auto-unarchives | `src/bun/orchestrator.test.ts` | T1 (orchestrator.ts) |

## 6. Execution waves

- **Wave 1 (parallel):** T1, T2 — disjoint file sets. Barrier: typecheck + commit.
- **Review** (Phase 5, opus) on `git diff 5ec712a...HEAD`.
- **Wave 2 (parallel):** T3, T4 — disjoint test files. Barrier: `bun test` + typecheck.
- **Phase 7:** run `bun test` + `bun run typecheck` (haiku background agent).

## 7. Blast radius & risks

- `archiveTask`/`unarchiveTask`/`sendInput` signature change (sync → async): callers are server routes + tests only; CLI talks HTTP. Tests referencing these must be updated to await.
- `git worktree remove --force` on a dirty tree destroys uncommitted work → mitigated by the dirty-skip.
- Branch checked out elsewhere / deleted by user before restore → `prepareWorkdir` re-attach is a hard error; surfaced as `sendInput` failure reason / console warning on unarchive. Acceptable.
- Archived tasks created **before** this change already have live worktrees — unaffected (archive-time detach only fires on newly-archived tasks; old ones behave as today).
- `RunPanel` "Open"/"Diff" buttons on archived tasks: `/open-path` 404s cleanly and diff returns a friendly note when the dir is missing (pre-existing degradation). Not changing them.
- Dogfooding hazard: this very session runs inside `~/.agetor/worktrees/…` — tests must keep using temp repos + temp `AGETOR_DATA_DIR` (existing convention) so they never touch real worktrees.

## 8. Open questions / assumptions (autonomous mode — decisions taken without owner input)

1. **Message-to-archived-task auto-unarchives** (server-side in `sendInput`) rather than requiring an explicit unarchive first. UI hints at this before sending.
2. **Dirty worktrees are kept** on archive (removal skipped) rather than force-removed or auto-committed. Archive still succeeds.
3. **Unarchive eagerly restores** the worktree, best-effort; failures don't block unarchive.
4. **No confirmation dialog added** for archive — the operation is now reversible-by-design (branch + history kept).
5. **No new DB column** to distinguish "removed by archive" from "never created"/"manually deleted" — `existsSync` state is sufficient for all current consumers.
6. **Backlog stays frozen** on archived tasks (existing server guard untouched); only the composer gains send-with-unarchive.
7. Claude `--resume` is assumed to work when the worktree is re-created at the identical absolute path (deterministic `dataDir/worktrees/<task-id>`), matching how agetor already derives JSONL paths from the cwd string.
