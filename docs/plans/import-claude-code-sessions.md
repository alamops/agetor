# Plan — Import Claude Code sessions started outside Agetor

| Field | Value |
| --- | --- |
| Date | 2026-10-16 |
| Source | Investigation and the 2026-10-15 grill (D1–D8) in worktree `74d9f0f2-84bf-4823-9972-f6cdfa797665`. This worktree's `docs/plans/import-claude-code-sessions-grill.md` (2026-10-16) locks G1–G3 and supersedes the D7 `default` → `null` mode row. |
| Flags | none |
| Gates | grilled (D1–D8 unchanged, G1–G3 locked). This plan is the Implementing step's contract. |
| Branch | feature/import-claude-code-sessions-2 |
| Base SHA | b2cacb1ce07dc14f09f0a3f21674f257c45bf3f3 |

## 1. Objective & success criteria

A person who has used Claude Code outside Agetor can see those sessions, pick the ones to bring in, and continue each one from Agetor. The next message resumes the same Claude session id, in the same folder, with the transcript already in the task.

Done means:

- An "Import Claude Code sessions…" dialog (header and the Projects picker) and `agetor sessions ls|import` list external sessions, newest first, and import the ones the user picks.
- A session that is still open in a terminal cannot be imported. The row says to close it first (background sessions say `claude stop <id>`), and a Re-check updates the row. The same check runs again at commit time.
- Each import creates an in-place task (`isolation: "none"`, `workdir` = the session's `cwd`) in `review`, bound to that session id, with the whole transcript persisted into `run_events`. The first message goes through the existing resume path. Run / `agetor start` is refused.
- Restarting Agetor in the middle of a later turn does not settle that turn on a historical `end_turn`, and does not replay historical subagents as running rows.
- A launch scan toasts only about sessions it has not offered before, and Settings → General can turn that scan off.
- Archive and delete of an imported task do not remove the user's branches or the transcript.
- Claude's permission mode `default`, a transcript with no permission-mode line, and any unrecognized mode string are stored as `ask`. The first message resumes through the existing path, which passes `--permission-mode default`.
- A session whose folder Claude would hash (the plain encoding is longer than 200 characters, and `encodeProjectPath` does not yet reproduce the on-disk directory name) stays in the list with Import disabled and the reason "Folder path is too long to import yet". Every other session still imports. No guessed hash.

## 2. Context & constraints

Grounded on this tree (latest migration is `067_retention_swept_tasks.sql`). Line numbers are this worktree, not the spike branch.

**Resume already adopts an id.** `sendInput` → `sendClaudeTurn` → `spawnResumedSession` (`src/bun/orchestrator.ts` around 5976–6121) reads `findLastClaudeSessionId` (6130–6137) and spawns `claude --resume` in `task.worktreePath ?? task.workdir`. A seed run with `status: "succeeded"` and `claudeSessionId` set is enough for the next message. `startTask` does not resume: it always inserts a fresh run with `claudeSessionId: null` (`orchestrator.ts` 1717–1735). `POST /tasks/:id/start` maps every `{ error }` to **400** (`server.ts` 5282–5285). A 409 has to be a dedicated branch, the way the pipeline-step guard just above it is.

**The transcript is found only from the task cwd.** `jsonlPathFor` (`claude-tmux.ts` 3325–3336) is `<configDir>/projects/<encodeProjectPath(cwd)>/<sid>.jsonl`. When `configDir` is null it uses `homedir()/.claude` and ignores `CLAUDE_CONFIG_DIR`. `effectiveClaudeConfigDir` (`harness-discovery.ts` 31–36) does honor that env var. `encodeProjectPath` (`claude-tmux.ts` 506–508) replaces every non-alphanumeric with `-` and does **not** apply Claude's over-200-character rule (investigation §1.1: cut to 200, then `-` and a hash). The hash algorithm is not verified. Do not guess it. Until a captured `(input path → directory name)` vector makes `encodeProjectPath` reproduce that directory, G2 keeps those sessions listed and refuses Import (see §3).

**Resume already passes `--permission-mode`.** `buildCommand` (`agents.ts` 540–547) does `opts.mode ?? defaultModeFor(kind)` and, except for `bypass`, always pushes `--permission-mode` plus `toClaudeModeString(mode)`. `toClaudeModeString("ask")` is `"default"` (`claude-tmux.ts` 452–457). `defaultModeFor("claude-code")` is `"auto"` (`types.ts` 3498, `types.test.ts`). Storing `null` would resume as `auto`. The comment just above the push (`agents.ts` 528–532) says `ask` emits nothing; the code below it does not. Follow the code. G1 stores `ask` and adds no new resume flag.

**Persisting uuids is not, by itself, restart-safe.** On boot, `reattachSession` (`orchestrator.ts` 849–857, `claude-tmux.ts` 8588–8661) re-tails from offset 0 with `runs.seenLineUuidsForTask` (task-wide, `db.ts` 2946). A dedup hit still **stages** `end_turn` (`claude-tmux.ts` 4506–4514), and the next line confirms it (`4438–4442`) and calls `onEndOfTurn` (`popEndOfTurn` 3440–3447). The comment on `ReattachOptions.seenLineUuids` (`8559–8564`) says that dedup does not fire `onEndOfTurn`; the dispatcher does. That staging is intentional for "persisted the line, crashed before the run status update" — pinned by `claude-tmux.test.ts` ("already-seen end_turn still fires onEndOfTurn" and "already-seen end_turn is staged and fires on next non-continuation line"). Imported history uuids live on the seed run, so a later reattach of a **different** running run would treat the first historical `end_turn` as that crash case and settle the live turn early. The first resume itself is safe: `resumeJsonlOffset` (`claude-tmux.ts` 3391–3396) parks at EOF.

**Subagents.** The watcher treats every `agent-*.jsonl` not already in `subagents` as new and `running` (`claude-subagents.ts` `discover` ~2255). Rows that already exist are rehydrated with `replayFloor` = the file size at attach (`2094–2126`) and keep their stored status. Status values are `running | completed | failed | cancelled | orphaned` (`types.ts` 4705–4710) — the grill's "succeeded" means **`completed`**. Transcripts live at `<dirname(jsonl)>/<sessionId>/subagents/agent-<id>.jsonl` (`claude-subagents.ts` 1849). `insertIfAbsent` (`db.ts` 3162) is idempotent. `runs.appendEvent` (`db.ts` 2900) returns null on the `(run_id, line_uuid)` dedup and accepts `subagentId`. `seenLineUuidsForSubagent` is task-scoped, so events persisted on the seed run are seen by a later run.

**In-place tasks already skip branch teardown.** `teardownBranchesForTask` returns an empty plan when `isolation !== "worktree"` (`orchestrator.ts` 6936–6939). `removeWorktree` returns early with no `worktreePath`.

**Ownership signals.** `runs.claude_session_id` exists (migration 009) and is **not indexed**. Registry files carry `tmux: "agetor-<12>:…"`; `claude agents --json` does not. Prod, dev, and test share `~/.claude`. A cwd under `<dataDir>/worktrees/` is ours; an `isolation: "none"` Agetor task in the user's repo is not, so the cwd test is not enough on its own.

**Precedents to mirror, not reinvent.** Bundle import's plan / `--dry-run` / `--yes` (`src/cli/commands/bundle.ts`). Projects picker footer next to "Clone repository…" (`ProjectPicker.tsx` 116–146). App-event toasts via `broadcastAppEvent` (`quit-guard.ts`) and `api.subscribeAppEvents` (`App.tsx` 1119). Preferences are an opaque string KV (`db.ts` 1403, `PUT /preferences/:key` at `server.ts` 3602). Cooperative yielding is the `createSeedJob` pattern in `claude-subagents.ts` (20 ms slices, `setImmediate`). `rebuildEventsFromJsonl` (`claude-tmux.ts` 4678–4698) is synchronous and fires a staged `end_turn` at EOF of whatever text it was given — chunking a file across calls would persist fake "turn complete" banners. `claudeModelIdFromArg` (`agents.ts` 200) maps a Claude model flag back to an Agetor id. `toClaudeModeString` (`claude-tmux.ts` 452) maps Agetor → Claude; the reverse mapping is specified in D7 and is not that function's inverse.

**Main thread.** Boot, the list route, and the history backfill must yield. `claude agents --json` was measured at ~1.6 s (investigation §1.1) and must not run on a request's critical path. The Bun main thread is shared.

**Tests must not read the developer's `~/.claude`.** The scanner takes injectable `{ homeDir, env }` the way `harness-discovery.ts` does, and listing live sessions goes through a stub. `AGETOR_CLAUDE_BIN=/bin/echo` is what the rest of the suite uses; the lister must not shell out unless the test passed a stub.

## 3. Approach & key decisions

Follow the grill. The shape below is what makes those decisions implementable without two writers on one transcript and without a restart replay.

**D1 — Refuse a live session (owner).** The list shows a Live badge and a disabled Import control reading "Close it in your terminal first", plus Re-check. Background sessions (`kind: "background"` or a registry `kind` of `bg` / `daemon`) get the same refusal with the hint `claude stop <id>`. No fork, no signal to the user's process. Liveness is the union of a cached `claude agents --json` (env `CLAUDE_CONFIG_DIR=<dir>`, binary from `AGETOR_CLAUDE_BIN` when set) and `<dir>/sessions/<pid>.json`, keeping a record only when `process.kill(pid, 0)` succeeds and `procStart` matches `ps -o lstart=` interpreted in UTC. Agents-listed sessions count as live even without a registry file. A registry file whose pid is dead does not. The `tmux` field is read from the registry only, to drop our own sessions. The list GET never awaits the probe: it serves the last cache, or `liveness: "unknown"` when that config dir has no cache yet, and Import stays disabled until liveness is known. Re-check and the import commit await a fresh probe. Commit re-checks and refuses a session that became live after the list was drawn.

**D2 — Run in place (owner).** `isolation: "none"`, `workdir` byte-identical to the transcript's `cwd`. No worktree, no Agetor branch. Delete and archive stay on the existing empty-teardown path. One test pins that.

**D3 — Stay on the session's branch; never checkout silently (owner).** Record the last `gitBranch` on the task. The list and the task details show "session was on `X`, folder is on `Y`" when `git status` of `cwd` says otherwise. Import is not blocked. **Switch to `X`** calls `git checkout` of that recorded name only when `git status --porcelain` is empty, and returns the reason when it is not. The branch name comes from a fresh read of the transcript, not from the client body. It must pass `git check-ref-format --branch`. A non-repo cwd has no switch action.

**D4 — Live and past, newest first, user picks (owner).** Scan every `projects/**/*.jsonl` under each config dir Claude's retention still has. Sort by the last line's `timestamp`, else file mtime, descending. Row fields: title, folder, branch, model, last activity, message count (count of `type:"user"` plus `type:"assistant"` lines), Live badge. Multi-select. Hidden before they are offered:

- session id already in `runs.claude_session_id`;
- cwd under `<dataDir>/worktrees/` for this data dir and for every sibling `~/.agetor` and `~/.agetor-*` directory that contains `agetor.sqlite` (injectable; tests pass an explicit list);
- registry `tmux` matching `agetor-` + 12 hex chars;
- a session superseded by a continuation line (see §8 — best-effort keys);
- transcripts with no `user` line;
- cwd under `os.tmpdir()` whose path contains an `agetor` segment or `/worktrees/` (our test sessions, not every `/tmp` project).

**D5 — On demand and once after boot (owner).** Dialog from a header button (next to Worktrees, `App.tsx` ~2280) and from the ProjectPicker footer under "Clone repository…". CLI verb `sessions` (`ls` | `import <id>…`), because `import` and `resume` are taken. `--dry-run`, `--yes`, `--json`. Without `--yes` or `--dry-run`, an interactive terminal confirms the way bundle import does; a non-TTY refuses. After `reconcileOrphans` (`index.ts` 162), one cooperative background scan. It toasts "N Claude Code sessions found outside Agetor — Review" only for importable ids not in the seen-set, then adds those ids to the set (offered, not imported). Preference `claudeSessions.launchScan` is `"1"` by default and `"0"` turns the scan off. Preference `claudeSessions.seenIds` is a JSON array of session ids. Both go through the existing preferences KV. The seen-set write is capped: store at most the newest 2 000 ids.

**D6 — Persist the whole transcript (owner → delegated).** One seed run: `origin: "imported"`, `status: "succeeded"`, `claudeSessionId` = the session id, `agent` = the matched harness id, `tasks.runId` pointing at it, column `review`. History is written with each line's `line_uuid` through one new cooperative wrapper around the same mapper as `rebuildEventsFromJsonl` (pinned signature in T3). The task stays `importedClaude.status: "importing"` until that job finishes, and both Start and Send are refused meanwhile, so a crash cannot resume against a half-persisted uuid set. Boot resumes an unfinished job. Subagent files are imported the same way onto that seed run (`appendEvent` with `subagentId`), and the `subagents` row is inserted **`completed`** with `endedAt` set **before** the replay, so the watcher rehydrates it settled with the floor at the current file size.

**D7 — What the task looks like (owner → delegated).**

| Field | Value |
| --- | --- |
| Title | Last `aiTitle` on an `ai-title` line, else the first human `user` text, trimmed, capped at 200 characters. |
| Prompt | That first human text, capped at 100 KB. Display only. The full text is in `run_events`. |
| Column | `review` |
| Harness | The claude-code harness whose `effectiveClaudeConfigDir` equals the transcript's config dir. |
| Model | `claudeModelIdFromArg` of the last assistant `message.model`, else the harness default. |
| Mode | `auto`→`auto`, `bypassPermissions`→`bypass`, `acceptEdits`→`acceptEdits`, `plan`→`plan`. Claude `default`, a missing line, and any unrecognized string → `ask` (G1). Never `null`. |
| Effort | `defaultEffortFor` for that kind and model. |
| Project | `projects.upsert(cwd, basename(cwd))`. |
| Provenance | Server-managed `tasks.imported_claude` JSON. Not patchable. Skipped by `tasks.update`. |

G1 supersedes the 2026-10-15 grill's literal `default` → `null`. `null` would resume as `auto`, because `defaultModeFor("claude-code")` is the first `AGENT_OPTIONS` mode and `buildCommand` substitutes it. Storing `ask` is what makes the existing resume pass `--permission-mode default`. The import does not add a flag of its own.

**G2 — long folder, no guessed hash.** Claude cuts an encoded project directory at 200 characters and appends `-` plus a hash (investigation §1.1; a 207-character directory ending in `-epaaob` was observed, and the input path was not recorded). `plainEncodedProjectPath` is the substitution both sides already share: every `[^a-zA-Z0-9]` becomes `-`. When that string is longer than 200 characters and `encode(cwd)` does not equal the directory name that actually holds the JSONL, the row stays visible, `importable` is false, and `blockedReason` is `"long-path"`. The dialog, the CLI, and the commit all say `Folder path is too long to import yet` and write no task. Other sessions import. T3 may change `encodeProjectPath` only after a real `(cwd → directory name)` vector proves the hash. A correct encoder makes `encode(cwd)` equal that directory name, and the same predicate then returns false with no second edit to the scanner. If T3 cannot derive the hash, it leaves `encodeProjectPath` byte-identical and says so; the disable stays. Do not hold the rest of the feature, and do not import a long-cwd session that the lookup cannot find.

**Start is refused** with `code: "imported-session"` and the message `imported Claude session — send a message to continue`. `startTask` returns that before any mutation. `POST /tasks/:id/start` maps that code to **409**. The card, the context menu, and the run panel do not offer Run. Send uses the existing resume path once `status` is `"ready"`. While `"importing"`, `sendInput` returns `{ delivered: false, reason: "still importing this session's history" }` (the send route already answers that as HTTP 200). While `"failed"`, Send is refused with the stored reason and the dialog/task can retry the backfill.

**D8 — No harness for that config dir (owner).** The row reads "Account `<dir>` isn't set up in Agetor — Add it to import" and reuses the existing one-click add from harness discovery. After the add, the list refreshes and the row becomes importable. Config dirs scanned: every claude-code harness's `effectiveClaudeConfigDir`, the default `~/.claude`, and the `~/.claude*` / `CLAUDE_CONFIG_DIR` dirs `discoverClaudeAccounts` already finds. A dir with no logged-in account is still scanned for transcripts; the add affordance is only shown when discovery already knows the account.

**Restart-safety rule (derived, required).** Add optional `currentRunLineUuids?: Set<string>` on the session state `reattachSession` builds.

- Emission dedup stays task-wide (`seenLineUuids`).
- A dedup-hit `end_turn` is staged only when `currentRunLineUuids` is **undefined** (today's tests and any caller that does not pass it) **or** the uuid is in the set.
- `reattachSession` always sets the set from a new `runs.seenLineUuidsForRun(runId)`, where `runId` is `tasks.get(taskId).runId` (the running row). Imported uuids live on the seed run, so they dedup and do not stage. An `end_turn` persisted on the running run itself still stages, which keeps the crash-before-status-update tests' behavior for that run.

**Provenance shape** (pinned so later tasks do not invent a second one):

```ts
interface ImportedClaudeSession {
  sessionId: string;
  gitBranch: string | null;
  importedAt: number;
  configDir: string;
  status: "importing" | "ready" | "failed";
  /** Bytes of the main JSONL already persisted. A restart resumes from here. */
  backfillOffset: number;
  error: string | null;
}
```

Column `imported_claude TEXT`. `Run.origin` gains `"imported"`. `AppEvent` gains:

```ts
| { type: "claude_sessions_found"; count: number; ts: number }
| { type: "claude_session_import"; taskId: string; status: "ready" | "failed"; ts: number }
```

**List DTO** (pinned): `GET /claude-sessions` returns `{ sessions: ClaudeSessionCandidate[] }` where each candidate has `sessionId`, `configDir`, `cwd`, `title`, `gitBranch`, `liveBranch`, `branchMismatch`, `model`, `lastActivity`, `messageCount`, `liveness: "live" | "idle" | "unknown"`, `liveHint: string | null`, `importable`, `blockedReason: "long-path" | "live" | "no-harness" | null`, `harnessId: string | null`. `importable` is true only when `blockedReason` is null and `liveness` is `"idle"`. Precedence when several apply: `long-path`, then `live`, then `no-harness`. `liveness` is still set when the reason is `long-path`, so the Live badge can show beside the disabled control. The scanner module owns this struct. Do not also put it in `types.ts` during wave 1 (that file is T1's). T6, T8, and the CLI client match this union field for field.

**Pinned helpers** (T2, in `src/shared/claude-session-meta.ts`; the shared module does not import `claude-tmux.ts`):

```ts
export function plainEncodedProjectPath(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/** True when Claude would hash this cwd and `encode` does not reproduce the directory that holds the JSONL. */
export function claudeProjectDirUnresolved(
  cwd: string,
  dirName: string,
  encode: (cwd: string) => string,
): boolean {
  if (plainEncodedProjectPath(cwd).length <= 200) return false;
  return encode(cwd) !== dirName;
}

export function agetorModeForClaudePermission(
  mode: string | null,
): "auto" | "bypass" | "acceptEdits" | "plan" | "ask" {
  switch (mode) {
    case "auto": return "auto";
    case "bypassPermissions": return "bypass";
    case "acceptEdits": return "acceptEdits";
    case "plan": return "plan";
    default: return "ask";
  }
}
```

`dirName` is the basename of the `projects/<dir>` that contains the JSONL. `encode` defaults to `encodeProjectPath` at the scanner and at commit; tests inject it. A cwd of 200 characters or fewer is never `long-path`, even if the directory name disagrees.

**Routes** (all authed):

- `GET /claude-sessions` — disk scan plus cached liveness. Does not spawn `claude`.
- `POST /claude-sessions/recheck` — awaits a fresh probe, returns the same list.
- `POST /claude-sessions/import` — `{ ids: string[] }`. Re-checks liveness per id. Returns `{ results: { id, taskId?, error? }[] }` once the task and seed run exist. The backfill continues after the response. Unknown id, already imported, live, `liveness: "unknown"`, no harness, or `long-path` → that result's `error` (the long-path error is exactly `Folder path is too long to import yet`), and no row.
- `POST /claude-sessions/checkout` — `{ sessionId }`. Switch-to-branch from D3.
- `POST /tasks/:id/claude-session/retry` — re-runs the backfill when `status` is `"failed"`.

`POST /tasks` does not grow an import field. A client cannot bind an arbitrary session id through the generic create route.

## 4. Work breakdown — implementation tasks

| ID | Goal | Owned files | Depends on | Acceptance |
| --- | --- | --- | --- | --- |
| T1 | Schema, types, and the DB helpers every later task calls. | `src/bun/migrations/068_imported_claude_session.sql`, `src/bun/migrations/index.ts`, `src/bun/db.ts`, `src/shared/types.ts` | — | Migration adds `tasks.imported_claude TEXT` and a partial index `runs_claude_session_id_idx` on `runs(claude_session_id) WHERE claude_session_id IS NOT NULL`. If 068 is already taken at execution time, renumber and keep the old id as an alias, the way 064–066 did. `toTask` parses the JSON (bad JSON → null, not a throw). `tasks.insert` writes null. `tasks.update`'s SET clause skips the column. `tasks.setImportedClaude(id, value \| null)` is the only writer and does not bump `updated_at`. `ALLOWED_PATCH_FIELDS` is not touched (the field is absent, so it stays unpatchable). `runs.seenLineUuidsForRun(runId)` returns that run's line uuids and uses the existing `(run_id, line_uuid)` index. `runs.claudeSessionIds()` returns the set of non-null ids (one query, for the ownership filter). `Run.origin` includes `"imported"`. `Task.importedClaude` is the interface in §3. `AppEvent` has the two variants in §3. Preference key constants `CLAUDE_SESSIONS_LAUNCH_SCAN_PREF = "claudeSessions.launchScan"` and `CLAUDE_SESSIONS_SEEN_IDS_PREF = "claudeSessions.seenIds"` live in `types.ts`. |
| T2 | Pure scanner and transcript metadata. No DB, no `claude` spawn except through the injected lister. | `src/shared/claude-session-meta.ts`, `src/bun/claude-session-scan.ts` | — | Exports the three helpers in §3 with those exact signatures. `readClaudeSessionMeta(jsonlText)` returns title, first human prompt, last `gitBranch`, last assistant model string, last permission mode (raw string or null), message count, last timestamp, and `continuedIn: string \| null`. Missing fields are null, never a throw. `scanClaudeSessions(opts)` walks the config dirs from §3 D8 under `opts.homeDir` / `opts.env`, reads `cwd` from the JSONL (never from the folder name), applies the D4 hide rules from `opts.ownedSessionIds`, `opts.worktreeRoots`, and `opts.env`, and attaches liveness from `opts.listLive` plus `opts.readRegistry`. Default `listLive` is **not** used by unit tests. `opts.encodePath` defaults to `encodeProjectPath` and is what `claudeProjectDirUnresolved` receives, together with the JSONL's parent directory name. A true result sets `blockedReason: "long-path"` and `importable: false` ahead of live and no-harness. Sort is last-activity descending. A session with no harness in `opts.harnesses` is returned with `blockedReason: "no-harness"` only when the path is resolvable. |
| T3 | Driver fixes the import depends on: path lookup, cooperative rebuild, restart-safe `end_turn`. | `src/bun/claude-tmux.ts` | T1 | `encodeProjectPath` keeps today's output for encoded names of 200 characters or fewer (existing tests stay green). For longer names it applies Claude's rule **only after** a captured `(input path → directory name)` vector is in the test; if the algorithm cannot be derived from the installed `claude` binary or from an existing over-long `projects/` directory, leave `encodeProjectPath` unchanged, say so in the task handoff, and do not invent a hash. Do not edit the scanner: G2's predicate turns false on its own once `encode(cwd)` equals the on-disk directory name. `jsonlPathFor(cwd, sid, null)` resolves the config dir with `effectiveClaudeConfigDir(null)` (same `CLAUDE_CONFIG_DIR` then `~/.claude` rule). Import `effectiveClaudeConfigDir` from `harness-discovery.ts`; if that import cycles, inline those three lines and comment that they must match. New export `rebuildEventsFromJsonlCooperative(text, onChunk, opts?: { sliceMs?: number })`: same staging as `rebuildEventsFromJsonl`, including the single EOF fire, but awaits `setImmediate` at least every 20 ms so a large file does not hold the main thread. Add optional `currentRunLineUuids?: Set<string>` on the session state `makeSessionState` builds. `reattachSession` sets it from `runs.seenLineUuidsForRun` of `tasks.get(taskId)?.runId`, inside `claude-tmux.ts`, and does not edit `orchestrator.ts`. A null `runId` sets an empty set, not `undefined`. The dedup-hit `end_turn` stage (4506–4514) runs only when that set is undefined or contains the uuid. Callers that omit the set keep today's behavior. Rewrite the `ReattachOptions.seenLineUuids` comment (8559–8564) so it describes this gate; the old sentence says dedup never fires `onEndOfTurn`. |
| T4 | Commit an import, backfill history, seed subagents, switch branch, resume a crashed backfill. | `src/bun/claude-session-import.ts` | T1, T2, T3 | `importClaudeSessions(ids, opts?)` re-reads liveness, refuses live / unknown / no-harness / already-imported / `long-path` ids with no row written. The long-path error is exactly `Folder path is too long to import yet`. `opts.encodePath` defaults to `encodeProjectPath` and is passed to `claudeProjectDirUnresolved` with the JSONL parent directory name. `projects.upsert`s the cwd, calls the existing `createTask` with `isolation: "none"` and the D7 fields, including `mode: agetorModeForClaudePermission(lastRawMode)` so `default`, missing, and unknown are stored as `"ask"` and never omitted (omitting stores null, which resumes as `auto`). Inserts the seed run (`origin: "imported"`, `succeeded`, `claudeSessionId`, `endedAt` set), points `tasks.runId` at it, sets column `review`, and sets `importedClaude.status` to `"importing"`. The backfill job then calls `rebuildEventsFromJsonlCooperative` with an `onChunk` that `runs.appendEvent`s using the line uuid, updates `backfillOffset`, and on success sets `"ready"` and broadcasts `claude_session_import`. On throw it sets `"failed"` and `error`. Slices yield. Each slice re-reads the task and stops if it was deleted. Subagent `agent-*.jsonl` files are inserted `completed` first, then replayed with `subagentId`. `checkoutSessionBranch(sessionId)` implements D3. `resumeIncompleteImports()` continues any `"importing"` row from `backfillOffset`. `retryImport(taskId)` restarts a `"failed"` backfill. |
| T5 | Start and Send honor an imported task. | `src/bun/orchestrator.ts` | T1 | `startTask` / `startTaskInner`, before any run row or column change, returns `{ error: "imported Claude session — send a message to continue", code: "imported-session" }` when `task.importedClaude` is non-null. `sendInput`, before the worktree restore and the per-kind dispatch, returns `{ delivered: false, reason: "still importing this session's history" }` when status is `"importing"`, and `{ delivered: false, reason }` from `importedClaude.error` when status is `"failed"`. `"ready"` is unchanged and still reaches `spawnResumedSession`. |
| T6 | HTTP API. | `src/bun/server.ts` | T2, T4, T5 | The five routes in §3, all `authed`. `POST /tasks/:id/start` maps `code === "imported-session"` to 409 and leaves every other start error at 400. Import of a live id is 200 with that id's `error` set (partial success of a multi-id body), not a failed whole request. A body that is not `{ ids: string[] }` is 400. |
| T7 | Launch scan after boot. | `src/bun/index.ts`, `src/bun/claude-session-launch.ts` | T1, T2, T4 | `startClaudeSessionLaunchScan()` returns immediately. The work runs after `reconcileOrphans` (place it next to the idle-reaper `setTimeout` in `index.ts`, not before reconcile). It no-ops when the preference is `"0"`. It calls `resumeIncompleteImports`, then scans, drops ids already in `claudeSessions.seenIds`, and if any importable ids remain broadcasts `claude_sessions_found` and appends them to the seen-set (capped at 2 000, dropping the oldest). A scan throw is logged and does not crash boot. |
| T8 | Import dialog and the webview API client. | `src/mainview/components/kanban/ImportClaudeSessionsDialog.tsx`, `src/mainview/lib/api.ts` | T1, T6 | Dialog lists candidates with the D4 columns, Live badge, branch-mismatch warning, disabled Import plus the D1 copy, Re-check, multi-select, and the D8 add-harness action (existing harness-add call). A `long-path` row stays visible, Import is disabled, and the reason reads `Folder path is too long to import yet`. Importing rows show "Importing history…". `liveness: "unknown"` disables Import. Branch mismatch does not. Switch to `X` calls the checkout route and shows the refusal inline. `api.ts` gains the list, recheck, import, checkout, and retry methods and nothing else. The client type's `blockedReason` union matches §3. |
| T9 | Open the dialog from the two entry points, and toast the launch scan. | `src/mainview/App.tsx`, `src/mainview/components/kanban/ProjectPicker.tsx` | T8 | Header button beside Worktrees, `aria-label` "Import Claude Code sessions". ProjectPicker footer button under "Clone repository…", dialog rendered as a sibling of the popover the way `CloneProjectDialog` is (the footer unmounts when a dialog takes focus). `subscribeAppEvents` on `claude_sessions_found` toasts "N Claude Code sessions found outside Agetor — Review" and Review opens the dialog. `claude_session_import` refreshes tasks. |
| T10 | Settings → General toggle. | `src/mainview/components/settings/SettingsDialog.tsx` | T1 | General section gains "Look for Claude Code sessions on launch", default on when the preference is missing. Writes `claudeSessions.launchScan` as `"1"` or `"0"` through the existing preferences API. |
| T11 | Imported tasks do not offer Run, and they show the branch warning. | `src/mainview/components/kanban/RunPanel.tsx`, `src/mainview/components/kanban/TaskCard.tsx`, `src/mainview/lib/task-context-menu.ts` | T1 | When `task.importedClaude` is set: TaskCard does not show Run (Open stays); `buildTaskContextMenu` does not add `start`; RunPanel has no Run and shows the D3 warning when `gitBranch` is set, plus "Importing history…" or the failure text with a retry. The origin badge treats `"imported"` the way it treats `"continuation"` (same chip site, label "Imported"). Send stays available only when status is `"ready"`; the existing `canSend` path is how a ready imported task continues. |
| T12 | CLI. | `src/cli/commands/sessions.ts`, `src/cli/index.ts`, `src/cli/usage.ts`, `src/cli/api-client.ts`, `src/cli/commands/show.ts` | T6 | `agetor sessions` with no subcommand is `ls`. `ls` prints the list, including a long-path row as not importable with `Folder path is too long to import yet`; `--json` prints the DTO. `import <id>…` confirms like bundle import unless `--yes` or `--dry-run`. `--dry-run` prints what would be created and writes nothing. A live id or a long-path id is a per-id error, not a crash of the batch. `agetor show` prints `imported: <sessionId> (on <branch>, <status>)` when the field is set. `agetor start` on an imported task prints the 409 message and exits non-zero. |
| T13 | Document the new path where the lifecycle is described. | `CLAUDE.md` | T4, T5 | One short subsection under the orchestration flow: import creates an in-place task and a succeeded seed run, Start is refused, Send resumes, live sessions are refused, history is persisted before Send is allowed. Do not rewrite the surrounding sections. |

## 5. Work breakdown — test tasks

| ID | Layer | Covers | Owned files | Acceptance |
| --- | --- | --- | --- | --- |
| T1t | unit | T1 | `src/bun/imported-claude-schema.test.ts` | Round-trips `setImportedClaude`. A generic `tasks.update` does not clear it. Bad JSON reads back as null. `seenLineUuidsForRun` returns only that run's uuids, and `EXPLAIN QUERY PLAN` uses the claude-session index for `claudeSessionIds` (same style as `db-run-events-plans.test.ts`). `AGETOR_DATA_DIR` is set at module top, before importing `db.ts`. |
| T2t | unit | T2 | `src/shared/claude-session-meta.test.ts`, `src/bun/claude-session-scan.test.ts` | Fixtures cover title fallback, model, empty transcript, `continued-in` when the key is present, missing keys. `agetorModeForClaudePermission` maps `auto`, `bypassPermissions`, `acceptEdits`, and `plan` as in §3, and maps `default`, null, and `"nope"` to `"ask"`. `claudeProjectDirUnresolved` is false when the plain encoding is 200 characters or fewer, and when `encode` returns `dirName` for a longer cwd. It is true when the plain encoding is longer than 200 and `encode` returns that plain string while `dirName` is something else. The scanner hides owned ids, worktree cwds, `agetor-` tmux names, temp agetor cwds, and empty transcripts; keeps a normal external cwd; marks live and no-harness; does not call a real `claude`. A planted JSONL whose `cwd` plain-encodes past 200 characters, sitting in a short directory name, is listed with `blockedReason: "long-path"` when `encodePath` is the plain substitution, and is importable for that gate when the injected `encodePath` returns the directory name. Sort is newest first. These cases inject `encodePath`. They do not call the real `encodeProjectPath` on a long cwd, so they stay green whether or not T3 derives the hash. |
| T3t | unit | T3 | `src/bun/claude-tmux.test.ts` | Existing `encodeProjectPath` cases still pass. One new case locks the captured over-200 vector **if** T3 derived the algorithm, and that case also expects `claudeProjectDirUnresolved(capturedCwd, capturedDirName, encodeProjectPath)` to be false; otherwise that case is absent and the handoff says so. `jsonlPathFor(..., null)` honors an injected `CLAUDE_CONFIG_DIR` and still uses `~/.claude` when it is unset. A new dispatch case: task-wide seen set contains a historical `end_turn`, `currentRunLineUuids` does not, and the next line does **not** fire `onEndOfTurn`. The existing "already-seen end_turn still fires" cases stay, because they omit `currentRunLineUuids`. One case: uuid is in `currentRunLineUuids` and still fires. `rebuildEventsFromJsonlCooperative` yields (a slice hook or a long input that returns to the event loop) and emits the same chunks as the sync function, including a single trailing turn-complete. |
| T4t | unit | T4 | `src/bun/claude-session-import.test.ts` | Imports a planted JSONL under a temp config dir into `isolation: "none"`, seed run `origin: "imported"` / `succeeded` / matching `claudeSessionId`, column `review`, project upserted. The task's `mode` is `"ask"` when the last permission-mode line is `default`, when that line is absent, and when it is `"nope"`; it is `"plan"` when the line is `plan`. Events exist with those line uuids. A live stub refuses and writes no task. A cwd whose plain encoding exceeds 200 characters, with the default plain `encodePath` injected and a parent directory name that does not match it, refuses with `Folder path is too long to import yet` and writes no task. The same cwd with an injected `encodePath` that returns the parent directory name is not refused for that reason. A second import of the same id is an error. A subagent file becomes a `completed` row plus events on the seed run. Dirty `git status` refuses checkout and does not change the branch; a clean repo checks out the recorded branch. Deleting the task mid-backfill does not throw. `resumeIncompleteImports` finishes a row left at `"importing"`. `teardownBranchesForTask` on the imported task returns no branches. |
| T5t | unit | T5 | `src/bun/orchestrator-imported-session.test.ts` | `startTask` on an imported task returns `code: "imported-session"` and does not insert a run. `sendInput` while `"importing"` and `"failed"` returns `delivered: false` and does not spawn. After flipping status to `"ready"` (and with the fake claude driver), `sendInput` creates a new run that inherits `claudeSessionId` and emits the `resuming claude session` status line (same assertion shape as `session-reaper.test.ts`). Module-top env: `AGETOR_DATA_DIR`, `AGETOR_CLAUDE_DRIVER=fake`, `AGETOR_CLAUDE_BIN=/bin/echo`, `AGETOR_TMUX_BIN=/bin/echo`, and the task is `isolation: "none"`. |
| T6t | integration | T6 | `src/bun/server-claude-sessions.test.ts` | Against a temp home and a stub lister: GET lists a planted session and does not require `claude` on PATH. POST import returns a task id, and that task's `mode` is `"ask"` when the planted transcript has no permission-mode line. POST import of a live id returns that id's error and no task. POST start on the imported task is 409 with the D7 message. A normal task's start error is still 400. Checkout of a clean temp repo switches branches; a dirty one returns the error and stays put. The planted cwd's plain encoding stays within 200 characters, so this file does not depend on whether T3 derived the hash. |
| T7t | unit | T7 | `src/bun/claude-session-launch.test.ts` | With the preference missing, a scan that finds one new id broadcasts `claude_sessions_found` and writes the seen-set. A second scan of the same id does not broadcast. Preference `"0"` does not scan. `resumeIncompleteImports` is invoked. |
| T11t | unit | T11 | `src/mainview/lib/task-context-menu.test.ts` | An imported task's menu has Open and does not have Run, including when the card would otherwise be in the Run branch (`!archived && !awaiting && !active && !openable` is not sufficient once `importedClaude` is set). A non-imported task is unchanged. |
| T12t | unit | T12 | `src/cli/sessions.test.ts`, `src/cli/commands/show.test.ts` | Flag parsing: `ls`, `import` with `--dry-run` / `--yes` / `--json`, unknown flags are a usage error. `--dry-run` does not POST the commit. A mock list row with `blockedReason: "long-path"` prints `Folder path is too long to import yet` and is not offered as importable. A mock import result whose `error` is that sentence prints it and, for a single-id import, exits non-zero. `show` prints the imported line. The HTTP client methods hit the paths in §3 (mock transport, same style as `api-client.test.ts`). |
| T13t | e2e | T8, T9, T10, T11, T6 | `e2e/import-claude-sessions.spec.ts` | See the run recipe. The spec plants a config dir via `backendEnv`, opens the dialog from the header, sees the row, imports it, sees the task in Review with history rendered from persisted events, and asserts the card has no Run button. A second scenario plants a registry file whose pid is the test process and asserts Import is disabled with the close-it-first copy. A third opens Settings → General and turns the launch scan off, then asserts the preference readback. |

E2e applies. The change crosses the webview, the API, and the filesystem, and the app already runs under Playwright.

Run recipe:

- Unit and integration: `bun test <file>` from the repo root. Typecheck: `bun run typecheck`. Full unit suite at a wave barrier: `bun test`.
- E2e: `bun node_modules/@playwright/test/cli.js test e2e/import-claude-sessions.spec.ts`.
- The harness is `e2e/fixtures.ts` (`freshBackend`, per-worker headless core). Pass `test.use({ backendEnv })` with `HOME` pointed at a temp directory that contains `.claude/projects/<encoded>/<sid>.jsonl` and, for the live case, `.claude/sessions/<pid>.json`. Do not point `HOME` at the developer. The lister stub must be reachable from the headless core: `backendEnv` sets a test-only env var the default `listLive` honors by reading a JSON file (add that hook in T2's default lister — a file path in `AGETOR_CLAUDE_AGENTS_JSON`, unset in production) so the e2e does not spawn `claude`.
- No Git host token and no real Claude account. The planted transcript is a few JSONL lines with `cwd`, `gitBranch`, a `user` line, and an assistant line with a `uuid` and `message.model`. The planted `cwd` plain-encodes to 200 characters or fewer. Long-path is covered by T2t and T4t with an injected encoder, not by this spec.
- Restart the core after `src/bun` changes. Dogfood only against a dev data dir, never `~/.agetor`.

## 6. Execution waves

Each wave's tasks own disjoint files. The barrier after each wave is `bun run typecheck` and `bun test` green before the next wave starts.

**Wave 1 — foundations, parallel.** T1, T1t, T2, T2t. Nothing here changes runtime behavior of existing tasks. T2 codes against the DTO field names in §3, not against T1's types file (the scanner returns its own struct; T6 maps it). No shared file.

**Wave 2 — driver, commit, guards, parallel.** T3, T3t, T4, T4t, T5, T5t.

- T3 owns `claude-tmux.ts`. T3t owns `claude-tmux.test.ts`. T4 calls `rebuildEventsFromJsonlCooperative`, `agetorModeForClaudePermission`, `claudeProjectDirUnresolved`, and `runs.seenLineUuidsForRun` by the signatures in T1, T2, and T3; it does not edit those files. `currentRunLineUuids` is filled inside `reattachSession`, so T5 does not touch the reattach call.
- T5 owns `orchestrator.ts` only. T4 calls the already-exported `createTask` and does not edit `orchestrator.ts`.
- Existing `end_turn` tests stay green because the new set is optional. T2t and T4t inject `encodePath`, so they stay green whether or not T3 derived the hash. The barrier is green either way; T3's handoff must say which of the two outcomes landed.

**Wave 3 — API and boot, parallel.** T6, T6t, T7, T7t. `server.ts` and `index.ts` are different files. T7 also owns the new `claude-session-launch.ts`; T6 does not.

**Wave 4 — UI, parallel.** T8 (`ImportClaudeSessionsDialog.tsx`, `api.ts`), T9 (`App.tsx`, `ProjectPicker.tsx`), T10 (`SettingsDialog.tsx`), T11 (`RunPanel.tsx`, `TaskCard.tsx`, `task-context-menu.ts`), T11t (`task-context-menu.test.ts`). The dialog's props are whatever T8 exports; T9 only mounts it. No file is owned twice.

**Wave 5 — CLI.** T12, T12t. Sequential within the wave is fine; they own different files and can run together.

**Wave 6 — e2e and the CLAUDE.md paragraph, parallel.** T13, T13t, and the e2e spec. T13 owns `CLAUDE.md`. T13t owns `e2e/import-claude-sessions.spec.ts`.

No red barrier is planned. Wave 2 is the one that changes driver behavior, and it preserves the old behavior when `currentRunLineUuids` is omitted, so existing tests do not go red while T3t adds cases.

## 7. Blast radius & risks

- **Two writers.** Importing a live session, or importing one Agetor is already tailing, interleaves two branches into one JSONL (investigation §2). The live check at list time and again at commit, plus the ownership filter, is the mitigation. A session that goes live after commit and before the user's first Send is not re-checked; Send resumes it. That window is accepted (D1's check is at import, not at every Send).
- **Restart replay.** T3's `currentRunLineUuids` rule is the mitigation. Shipping T4 without T3 would persist history and then settle the next turn early. They are the same wave; do not reorder T4 ahead of T3.
- **Subagent hold.** Inserting `completed` before the replay is the mitigation. Inserting `running`, or inserting nothing, holds the card on the first resume (investigation §1.3.3).
- **Main-thread stall.** The synchronous `rebuildEventsFromJsonl` must not be called on a full transcript. Only the cooperative wrapper. The launch scan and the list GET must not await `claude agents`.
- **`encodeProjectPath` callers.** Every JSONL lookup uses it (`jsonlPathFor` and its tests in `claude-tmux.test.ts` ~32–68). Names ≤ 200 characters must stay byte-identical. A wrong hash sends long-cwd resumes to "JSONL never appeared" after 30 s. G2 refuses Import while `encode(cwd)` does not equal the on-disk directory name, which is what keeps a wrong or missing hash from creating that task. A hash that later matches the directory name clears the disable without a scanner edit.
- **`jsonlPathFor(null)`.** Built-in harness resumes, rebuilds, and reattach all pass `harness?.home ?? null`. Honoring `CLAUDE_CONFIG_DIR` changes where those look when that env var is set and the harness home is null. That is the bugfix. Tests that assert the `~/.claude` path must unset the variable.
- **Start status code.** Only the imported-session code becomes 409. A drive-by change that maps every `startTask` error to 409 would break clients that treat 400 as a validation failure.
- **User's repo.** The first Send still runs `ensureInstalledForCwd`, which merges Agetor hook entries into `<cwd>/.claude/settings.local.json` for a non-owned cwd. That already happens for every in-place task. This plan does not change it (D7).
- **Trust dialog.** Assumed not to appear on resume in the original cwd (investigation §3.1). If a dogfood resume stalls on the trust prompt, that is a follow-up, not part of this plan: the boot poller ignores the trust dialog on resume today (`claude-tmux.ts` ~8360).
- **Rollback.** The migration is additive. Reverting the code leaves a nullable column and an index in place; old binaries ignore unknown JSON. Imported tasks already in the DB would lose the Start refusal and could be re-run if the new code is rolled back. Do not delete the column in a rollback.
- **No feature flag.** The Settings toggle only disables the launch toast. The dialog and CLI stay available. That matches D5.

## 8. Open questions / assumptions

Proceeding on these. G1 and G2 were locked when the confirmation questions were skipped. They are restated so an implementer who also reads the 2026-10-15 grill does not follow its `default` → `null` row or ship a guessed hash.

1. **G1 — store `ask`.** Claude `default`, a missing permission-mode line, and any unrecognized mode string are stored as `ask`. Resume uses the existing `buildCommand` path (`agents.ts` 540–547): `--permission-mode` plus `toClaudeModeString("ask")`, which is `"default"`. Do not store `null`. `null` resumes as `auto` via `defaultModeFor("claude-code")`. This supersedes the 2026-10-15 D7 row. One mapping can still be flipped to `null` if imported sessions should resume hands-off. Until that flip, implement `ask`.
2. **G2 — disable Import, do not guess the hash.** Investigation saw a 207-character directory ending in `-epaaob` and did not record the input path or the algorithm. A cwd whose plain encoding is longer than 200 characters stays listed with Import disabled (`blockedReason: "long-path"`, copy `Folder path is too long to import yet`) while `encodeProjectPath` does not reproduce the on-disk directory name. T3 derives the hash from the installed `claude` binary or an existing over-long `projects/` directory before changing `encodeProjectPath`. If it cannot, the function stays byte-identical, the handoff says so, and those rows stay disabled. Other sessions import. Do not hold the feature. One product choice can still be flipped to import-anyway. Until that flip, disable Import.
3. **`ai-title`, `permission-mode`, and `continued-in` line shapes are best-effort.** Observed on Claude Code 2.1.300–2.1.301; the format is officially unstable. The meta parser reads `aiTitle`, `permissionMode`, `gitBranch`, `message.model`, and any of `continuedIn` / `continued-in` / `continuedSessionId` when present. Absent keys fall back (title → first prompt, mode → `ask` per G1, no continuation hide). A fixture from a real line should replace the synthetic one when someone has a sample; do not block the wave on that.
4. **`claude agents --json` keeps listing interactive sessions.** If a future CLI stops, the registry plus pid/`procStart` is the fallback already in T2. A config dir whose probe fails stays `liveness: "unknown"` and cannot be imported until Re-check succeeds.
5. **Resume in the original cwd does not show a trust dialog.** If dogfood shows one, handling it is out of this plan (§7).
6. **Seen-set means "we toasted this id", not "we imported it".** Dismissing the toast does not nag again. New ids still toast. The cap is 2 000 ids.
7. **Send is not re-checked for liveness.** D1's check is at import commit only.
8. **Migration id 068** is free on this tree (067 is the latest). Execution renumbers if another branch takes 068 first.

## 9. Completeness ledger

| Item | Disposition | Task ID / reason / who deferred |
| --- | --- | --- |
| Persist full transcript with line uuids, cooperatively | In this run | T3 (wrapper), T4 (job) |
| Historical `end_turn` must not settle a later run | In this run | T3, T3t |
| Subagents born `completed` with events persisted | In this run | T4, T4t. G3. Status value is `completed`, not the 2026-10-15 grill's word "succeeded". |
| Map Claude `default`, missing, and unknown permission modes to `ask` | In this run | T2 (`agetorModeForClaudePermission`), T4 (stored on the task). G1. Resume flag is the existing `buildCommand` path. |
| Refuse Start (409) and hide Run | In this run | T5, T6, T11, T11t, T12 |
| Refuse Send while importing or failed; boot resumes the job | In this run | T4, T5, T7 |
| Live refusal, Re-check, commit-time re-check, background `claude stop` hint | In this run | T2, T4, T6, T8, T13t |
| In-place, no branch teardown | In this run | T4; existing `teardownBranchesForTask` (pinned by T4t) |
| Branch mismatch warning and explicit checkout | In this run | T4, T6, T8, T11 |
| Hide our own sessions (DB id, worktree cwd, `agetor-` tmux, temp test cwds, empty, continued-in) | In this run | T2 |
| Index `runs.claude_session_id` | In this run | T1 |
| `jsonlPathFor(null)` honors `CLAUDE_CONFIG_DIR` | In this run | T3 |
| `encodeProjectPath` over-200 rule | In this run | T3 derives it from a real vector or leaves the function unchanged and says so. No guessed hash. |
| Disable Import when the plain encoding exceeds 200 characters and `encode` does not match the on-disk directory | In this run | T2, T4, T8, T12. G2. The row stays listed. Other sessions import. |
| Dialog, header, Projects footer, Settings toggle, launch toast, seen-set | In this run | T7–T11 |
| CLI `agetor sessions` and `show` line | In this run | T12 |
| Upsert the cwd as a project | In this run | T4 |
| `origin: "imported"` badge | In this run | T1, T11 |
| Harness add when the config dir is unknown | In this run | T2, T8 (reuses existing add) |
| `ensureInstalledForCwd` merge into the user's `.claude/settings.local.json` | In this run, unchanged | Already runs for every in-place task. D7 accepts it. No new task. |
| Fork (`--fork-session`) as an alternative to closing the terminal | Out of scope | D1 chose refuse. A fork needs its own offset handling (investigation §2). |
| Killing or signaling the user's Claude process | Out of scope | D1. Conflicts with "only kill sessions this DB owns". |
| Import into a fresh worktree | Out of scope | D2. Cross-cwd resume writes the original project dir (investigation §2). |
| Re-check liveness on every Send | Out of scope | D1 is an import-time check. A later Send of a session the user reopened is a different ticket. |
| Trust-dialog handling on resume | Out of scope | Assumption §8.5. The poller does not handle it on resume today. |
| TUI `sessions` screen | Out of scope | Grill named the dialog and the CLI. The TUI can call the same routes later. |
| Backfill of sessions Agetor already ran | Out of scope | Nothing to migrate. The scanner only offers sessions the DB does not already have. |
| Changing `rebuildEventsFromJsonl` (sync) callers | Out of scope | The rebuild route stays display-only and still drops `lineUuid` (`server.ts` ~7011). Import uses the new cooperative wrapper. |
| Claude Desktop / VS Code entrypoints as a separate filter | Out of scope | They are normal transcripts under the config dir. D4 lists them. No special case. |
| `/clear` rotating the session id under a live pid | Out of scope | Investigation §2. We import the id on disk at commit time. A later `/clear` outside Agetor is the same class of problem as any external resume. |
| Docs other than the one CLAUDE.md subsection | In this run | T13. Older plans (`non-blocking-session-restore`, continuation adoption) describe the current tailer and stay accurate. |
