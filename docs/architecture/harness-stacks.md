# Harness account stacks

A **harness stack** is an ordered group of two or more accounts of the **same
harness kind** (Claude Code or Codex). Position 0 is the **primary**; the rest
are **backups**. When the account a task is running on hits its provider limit,
the task continues on the next account with the same conversation, tools, MCP
servers, skills, commands, plugins and settings. A visible divider appears
between the task's messages and the execution keeps going — the card never
leaves `running`.

Stacks are machine-local and opt-in. There is **no global flag**: with no
stack, every path below is inert, and deleting the stack is the rollback.

Plan and decisions: `docs/plans/harness-account-stacks.md` (binding),
`docs/plans/harness-account-stacks-grill.md` (owner decisions),
`docs/plans/harness-account-stacks-codex-spike.md` (T00 evidence).

## Model

| Table / column | Purpose |
| --- | --- |
| `harness_stacks` | `id`, `label`, `kind` (`claude-code`/`codex`), `mirror_mode` (`full`/`safe`), timestamps. |
| `harness_stack_members` | `(stack_id, harness_id, position)`. `UNIQUE(harness_id)` enforces **one stack per account**; `UNIQUE(stack_id, position)` keeps the order unique. |
| `harness_limit_state` | Account-global cooldown: `harness_id`, reason, source, message, `exhausted_until_ms`. Deliberately has **no FK** and survives a stack delete — a limit is a fact about the account. |
| `harness_session_handoffs` | `(task_id, harness_id, column_name)` → copied session id + `copied_paths_json` (the cleanup allowlist). The one exception to per-account session scoping. |
| `tasks.harness_state` | `TaskHarnessState` JSON: `stackId`, `position`, `count`, `tried[]`, `pendingSwap`, `allExhausted`, `lastMove`. Server-managed (targeted UPDATE, no `updated_at`, skipped by the generic PATCH clause). |

A task's stack is **derived** from `Task.agent` (`harnessStacks.resolveForTask`):
the account's CURRENT membership wins, so editing an account into another stack
moves its tasks' failover there; the recorded `harnessState.stackId` is only the
fallback while an account removed from every stack still resolves (marked
`orphaned`) until the next move. No `Task`, `AgentProfile`, pipeline or bundle
field references a stack, so profiles and pipelines inherit the stack
automatically and bundles stay portable.

A stack with fewer than two members is **inert** (plan assumption 6): the
editor and `validateInput` require at least one member but allow saving the
shell before backups are added, and selection, failover, automatic retries and
the Claude pane limit signal all require a real backup. A task on such a stack
behaves exactly like a lone account.

## Selection: one lap, then wrap

`pickNextMember` (`src/shared/harness-stack.ts`) walks **forward** from the
current account and wraps once. A member is skipped — and **not** marked tried —
when it is:

- already in `tried` (it ended a run in a limit this lap);
- disabled;
- cooling (`harness_limit_state` still in force);
- quota-exhausted by a fresh, unscoped `HarnessQuota` snapshot
  (`harnessQuotaLooksExhausted`; stale/missing fails open);
- unusable for the task's model/CLI (not installed, login evidence `false`,
  known model catalog excludes the model, cached CLI below the model floor).

A successful or cancelled terminal turn resets the lap; a manual Run also resets
it and forces a cooling account. The walk returns `next`, `all-exhausted`
(something is limit-blocked and a reset can help) or `none-usable` (only a
manual fix can help). A **complete lap** — every member already in `tried` —
is `all-exhausted` even when a cooldown has already expired: every one of
those accounts ended a run in a limit, so the retry restarts a fresh lap (with
its earliest reset when one is still known, otherwise the backoff). This is
the two-account sequential-limit path; it must never fall through to
`none-usable`, which arms no timer and blocks forever.

## Limits: conservative by design

`classifyHarnessLimitSignal` (`src/shared/harness-limits.ts`) accepts only
provider quota, HTTP 429 and 402/insufficient credits. Explicit negatives:
5xx/529/`overloaded`, network/timeouts, 401/403/auth, `model_not_found` and
"not supported/available". A false swap would burn a backup and can duplicate
work, so the classifier is a table-tested allowlist, not a heuristic on "error".

Writers:

- **Claude pane** — on a stack task **with a backup** (two or more members),
  `scrapeOnce` emits one `harness-limit:` status for the live usage-limit
  notice, then resolves the turn. The detector anchors the phrase at the start
  of a rendered row (after indentation and an optional status glyph) and
  requires the provider's auto-continue wording (`continuing automatically` /
  `continuing shortly` / `esc to cancel`) in the same window, so ordinary
  transcript prose — even a single row such as "the usage limit resets at
  8am" — is not a signal. Only the bottom twelve non-blank rows (the live hint
  slot above the input box) are searched, so a notice quoted in the scrollback
  or echoed in a tool result cannot settle a healthy turn. The detection window
  (up to three wrapped rows) is also what is stored, so a reset time that wraps
  keeps its parsed instant. A per-turn latch prevents re-emitting while the
  notice stays on screen. A lone account (no stack, or a 0/1-member stack) is
  inert: the notice is not carded and Claude's own auto-continue keeps the turn
  in flight, exactly as before stacks existed (plan §2.2).
- **Claude API error** — the existing synthetic `api error:` line remains; the
  orchestrator's chunk handler classifies 429/402 as a backstop, gated on that
  sentinel. Arbitrary status prose (a compaction/background summary, an account
  label that merely contains "rate limit", …) is never classified, so a healthy
  turn cannot be mistaken for a limit and swapped. When that API error *is* a
  provider limit on a stack with a backup, the swap owns the settlement: the
  card stays `running` and no `api-error` block (or its sticky retry toast/OS
  notification) is painted before the successor starts.
- **Codex** — `turn.failed` / top-level `error` text is classified before it is
  written as stderr.
- **Fake drivers** — `__agetor_fake_claude_limit__`,
  `__agetor_fake_claude_limit_clean__`, `__agetor_fake_claude_limit_pane__`
  (the pane-sourced variant used by the passthrough session-drop test),
  `__agetor_fake_codex_limit__` (and the `AGETOR_FAKE_*_LIMIT` env twins) drive
  the e2e/unit paths.

The cooldown is account-global: `harnessStacks.setLimitState`. Its expiry is the
provider reset when the driver parsed one, else 60 s for a rate limit and 10 min
for quota/credits. A provider reset replaces the stored expiry even when it is
earlier; a fallback (signal with no reset time) never shortens a still-active
later provider reset. A successful turn clears it. A manual Run/message forces a
cooling account **for that task only** and never deletes the account-global
cooldown: another task may still be probing an account the provider has not
reset, so only a successful turn or the reset clears it.

## Settlement and the swap

`attachDoneHandler` checks `ActiveRun.limitHit` before normal settlement. On a
stack task it hands everything to `handleHarnessLimitSettlement`
(`src/bun/orchestrator.ts`):

1. The task's start claim is taken before any await (no competing turn).
2. The current account is marked tried and cooled.
3. Pending interaction cards are cancelled; the limited session is dropped; any
   running background agents are orphaned with a status line naming them.
4. `planNextMember` picks the successor.
5. `pendingSwap` is persisted before the mirror/transfer starts (crash
   safety); the earlier teardown awaits are idempotent.
6. `mirrorForSwap(stack, toHarnessId)` (a thin `mirrorStack` wrapper with the
   destination account) mirrors config; a mirror failure is a warning, never a
   block.
7. The continuation gate decides:
   - **any tool call in this run, a recorded handoff, or an earlier run on this
     account with a provider session** → copy the provider session (Claude
     transcript + sidecars, or Codex rollout), record the handoff, spawn with
     `--resume`/`exec resume` and the hidden continuation prompt. The third
     clause is the follow-up case: a user's earlier turns produced the
     session, a later follow-up hits the limit before its own first tool call,
     and the whole conversation must still move. A same-account retry in this
     branch resumes the existing session in place (no copy).
   - **the task's first turn on the account with no tool call** → resend the
     request on a fresh session (the clean-retry branch), avoiding a duplicate
     provider user message. The text is rebuilt by
     `composeCleanRetryText(runs.mainUserTexts(oldRunId))`: each main-stream
     user row is reduced to delivered text (the live echo and claude's
     XML/`<pasted_content>` JSONL twin of one send collapse to the same
     value), a predecessor's hidden continuation wrapper is unwrapped, and a
     REPL follow-up folded into the turn is replayed after the original prompt
     in order. A sequential-turn harness (Codex) keeps only the first row,
     because its live-turn follow-ups are queued as separate turns. Its
     divider says "Restarting the request on this account." — it never claims
     a transferred conversation that does not exist.
   A present-but-unreadable session is a hard block (`harness-swap-failed`), not
   a silent fresh start.
8. The old run is recorded `failed` with `run-status.reason: "harness-swap"`
   (the failure toast/notification is suppressed); the task stays `running`.
9. `spawnSwapContinuation` inserts the new run (`origin: "harness-swap"`, the
   explicit session id), writes the **visible divider as the run's first status
   event**, emits the `harness-swap` global event, and spawns.
10. `pendingSwap` is cleared once the successor registered.

If no member can run, the old run is recorded failed and the task moves to
`blocked` with `harness-exhausted` (limit-blocked) or `harness-swap-failed`
(manual fix needed). `planExhausted` persists `allExhausted` and arms a timer at
the earliest reset, or 10 minutes when unknown, clamped to `[10 s, 24 h]`, with
at most 3 **started retries**. The initial exhaustion and a timer re-arm that
found nothing usable do not spend an attempt; a retry run that returns to
exhausted does. A manual Run resets the cap. When every member is unusable for
a non-limit reason, no timer is armed.

A retry in flight is persisted (`allExhausted.inFlight` with
`nextAttemptAt: 0`) before its spawn, so a crash, a spawn failure or the retry
run failing for a **non-limit** reason can never strand the task: boot re-arms
an interrupted attempt without spending one, a spawn failure spends one (so a
permanently broken destination reaches the visible cap) and a non-limit settle
ends the failover loop and leaves the normal visible failure. `inFlight` stays
true for the **whole life of the successor run** — it is the only marker the
normal settle reads to end the loop — and is cleared only when that run
succeeds/cancels or by the next `planExhausted`. A hard block clears the marker
and leaves the task blocked for a manual fix. A retry run that is still live
after boot (re-attached) keeps its `inFlight` marker, so its own settle stays
armed to end the loop; only a dead/orphaned attempt is re-armed or ended by
boot. An **unexpected throw** out of the retry handler (before a successor run
is live) is recovered in place: the in-flight marker is cleared, the attempt is
spent like a handled spawn failure, and the normal backoff is re-armed — a
persisted `inFlight` with `nextAttemptAt: 0` and no timer would otherwise leave
the card on "Retrying…" until the next boot.

A limit with no swap target — the stack was deleted mid-run, the task was
archived, or the stack has fewer than two members — hands the run back to the
**normal** settle. It is recorded failed exactly like a lone account's failure
and takes the same column, checkout note and queued-follow-up drain; it never
arms an `allExhausted` retry. A **pane** limit (`source: "claude-pane"`) is the
exception to "leave the session alone": it leaves Claude's REPL parked on the
notice, so the passthrough drops that session before the normal settle. An
API-error or Codex limit does not pause a reusable session and is left as-is.
A message typed after the run then starts a clean turn instead of landing in a
REPL waiting for a limit nobody will continue.

The swap spawn window honours user control exactly like `startTaskInner`: a Stop
recorded against the claim is adopted onto the successor, and a Stop, delete,
replace, force-archive or stack delete that lands while the spawn is in flight
kills the successor, records it `cancelled` and returns the card to `ready`.
A Stop that lands even earlier — after the old run's handler dropped its handle
but before `pendingSwap` is persisted — is recorded on the task's swap window
and aborts the settlement before any mirror/transfer/spawn; the blocked
all-exhausted branch honours it too, so no retry is armed.
The post-transfer step also re-reads the task, so an archive/stack delete during
the mirror/transfer can never resurrect a swap and spawn onto an archived task.

## The continuation prompt

The transfer branch sends exactly:

```
<harness-stack-continuation>
Continue the task from where it stopped. The previous account reached its usage limit; no work was lost. Do not repeat completed steps, re-read files you already changed, or ask the user to confirm. Pick up the next action.
</harness-stack-continuation>
```

The clean-retry branch wraps the user's own reconstructed text in the same tag
(the body is the user's words, not a continuation instruction). Its source is
`composeCleanRetryText(runs.mainUserTexts(oldRunId))` — normalized, de-duplicated
and unwrapped — so a second consecutive clean retry strips the previous wrapper
before wrapping again; nesting would stop the value being recognised and leak
the hidden prompt as a visible bubble.

`isHarnessStackContinuation` hides only a value that is exactly the wrapper —
checked after `normalizeDeliveredUserText`, because claude's JSONL twin of the
pasted prompt is `<pasted_content>`-wrapped. Every renderer (RunPanel, CLI
`logs`, TUI, message history, event search) skips it. A user message that
merely mentions the tag stays visible. It contains no product name.

## Mirror: config only, never login

`src/shared/harness-mirror.ts` is the single allowlist; `src/bun/harness-mirror.ts`
implements it. Source is always position 0. Both sides resolve their config
root through `claudeConfigDirFor` / `codexHomeFor`, which honour the harness's
own env map (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`) exactly like `harnessEnv` does
— the env override wins over the home-derived path, so the mirror and a session
transfer target the directory the CLI really reads.

- **Claude**: merge `settings.json` (primary scalars win, arrays union with the
  primary first, objects deep-merge) and only the `mcpServers` /
  `enabledPlugins` keys of `.claude.json`; copy the user-level instruction
  files (`CLAUDE.md`, `output-styles/`), `skills/`, `commands/`, `agents/`,
  the installed plugin payload (`plugins/cache/`), the marketplaces and
  `plugins/data/`. The two plugin registries
  (`plugins/installed_plugins.json`, `plugins/known_marketplaces.json`) are
  merged with every absolute path under the primary's config root rewritten to
  the destination root, so a backup loads its own payload copy rather than
  silently reading the primary's directory. `installed_plugins.json` arrays
  hold one record per install identity — a `user`/`local` scope and, for a
  project install, its `projectPath` — so they merge **by scope +
  `projectPath`** (the primary wins on an identity it defines; a plugin's
  several project records and the backup's own project records survive)
  instead of a plain union that would install one plugin twice or a scope-only
  key that would silently drop the other projects.
- **Codex**: section-preserving text merge of `config.toml` (the primary's
  top-level scalars replace by key while backup-only keys are appended,
  `[mcp_servers.*]`, `[profiles.*]`; backup-only sections kept), validated with
  `Bun.TOML.parse`; copy `AGENTS.md` (the user-level instruction file),
  `prompts/`, `skills/`, `plugins/` including the installed payload cache
  (never the derived `store/`/catalog caches or the transient
  `.remote-plugin-install-staging/`).
- **Never copied**: `.credentials.json`, `auth.json`, session stores,
  transcripts, `thread_history_*.sqlite`, `state_*.sqlite`, session/log
  caches, logs, `mcp-oauth-locks/`, the primary's `[projects.*]` trust entries,
  and any `.git` directory/file at any depth (a marketplace clone's
  `.git/config` can hold a remote URL with an embedded token).
- **Provider login and cloud credential env keys** (`ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`, `AWS_SECRET_ACCESS_KEY`, `AWS_BEARER_TOKEN_BEDROCK`,
  `AZURE_OPENAI_API_KEY`, `GOOGLE_APPLICATION_CREDENTIALS`,
  `ANTHROPIC_CUSTOM_HEADERS`, …) are stripped from the primary's merged
  `settings.json`; a backup's own key survives. The rule is **shape-based**:
  any `_`-separated `TOKEN`/`SECRET`/`PASSWORD`/`KEY`/`CREDENTIAL`/
  `AUTHORIZATION` segment matches whatever the vendor (`OPENROUTER_API_KEY`,
  `GITHUB_TOKEN`, `AWS_WEB_IDENTITY_TOKEN_FILE`), plus the vendor-prefix
  markers for names whose credential shape is not a whole segment. A
  non-credential setting (`*_BASE_URL`, `*_MODEL`, `*_MAX_TOKENS`,
  `AWS_REGION`, project ids) still mirrors. Login-selecting cloud settings
  (`AWS_PROFILE`, `AWS_DEFAULT_PROFILE`, `AWS_ROLE_ARN`, the AWS config/
  credentials file pointers) are stripped too: they name the identity Bedrock
  would assume. The process environment is not modified (a warning names the
  first kind-relevant credential it sees, cloud keys included).
- **Login-selecting `settings.json` keys** (`apiKeyHelper`,
  `forceLoginOrgUUID`, `awsCredentialExport`, `awsAuthRefresh`) are treated the
  same way: never imported from the primary, and a backup's own value survives.
- **Codex MCP sign-in** is not copied (OAuth store, security review deviation);
  when the primary defines `[mcp_servers.*]` the mirror warns that the backup
  may need to sign in once.
- **Safe mirror** skips `hooks` and `permissions` and never rewrites a backup's
  existing values.

All reads are no-follow/regular-file; every write is atomic and 0600; symlinks,
FIFOs and oversize trees are skipped with a warning. A **source** path is also
refused when any component between the trusted account root and the leaf is a
symlink, not just the leaf: a linked intermediate folder (`plugins/` → outside
the account) would otherwise make the target's regular file look like the
account's own. Directory copy is **additive**: the source tree is merged over
the destination, so a backup's own skills/plugins/prompts are never deleted,
and each file is written atomically. A destination path that would traverse a
symlink is refused. Copy caps: 64 MB and 5,000 entries per user-config tree,
and a larger bounded 512 MB / 25,000 entries for the plugin payload trees (a
marketplace install is naturally much bigger); the walk yields every ~20 ms and
every individual read/write is chunked (1 MiB) and asynchronous, so one large
transcript cannot freeze the shared Bun main thread. `copyTreeCooperative`
reports whether a cap truncated the tree: if a plugin payload copy was
incomplete, the mirror leaves that account's plugin registry untouched and
warns, so a rewritten registry can never point at payload files that were never
copied.

Codex MCP OAuth: the binary's default store is `auto`; no stable standalone
filename exists for `file` mode. Per the T00 deviation, tokens are **not**
copied and the swap warns that MCP sign-in may need repeating on the backup.

## Codex `CODEX_HOME`

The T00 spike proved `CODEX_HOME` alone isolates login (`auth.json`), config,
MCP servers, sessions and writes on codex-cli 0.166.0. `harnessEnv` therefore
emits only `CODEX_HOME=<home>/.codex`; `HOME` stays the user's real home. A
harness's own env map may pin `CODEX_HOME` instead — it wins over the
home-derived path (same precedence in `harnessEnv`), and `codexHomeFor`, the
mirror and the rollout transfer all use it. The rollout adapter copies the
rollout to the same relative path under the destination `CODEX_HOME` and, when
a `thread_history_*.sqlite` already exists, runs `codex migrate-rollouts
--apply` (30 s timeout, `coreSpawn`) once; a failure is a warning and a failed
resume blocks the swap visibly.

## Crash safety and boot

- A persisted `pendingSwap` is completed if its successor already exists and is
  live, or left alone if it already settled (its visible outcome is
  authoritative); otherwise the task is visibly blocked with
  `harness-swap-failed` — a blind second spawn could duplicate work.
- `allExhausted.nextAttemptAt` is re-armed on boot.
- Expired cooldowns are filtered out of read payloads and pruned on boot and on
  every cooldown write; a GET never writes.
- `reconcileHarnessFailover()` runs after `reconcileOrphans()` in `index.ts` and
  `headless.ts`.

## Cleanup

- **Delete** clears failover state and cancels timers first, then removes the
  copied session files at the very end — immediately before the task row (and
  its handoff rows) is deleted. Every step in between can throw (the pipeline
  cascade, the worktree teardown, the issue snapshot removal); a failed delete
  leaves the task row alive, so its copied conversation must still be there to
  resume. A recorded path is removed only when every component below the
  account root is a real, non-symlink path: a symlinked parent inside an
  agent-writable home must never redirect a cleanup outside the account.
- **Archive** clears failover state and keeps the copies so an unarchive can
  resume; the archived-history retention pass removes them after the threshold.
- **Harness delete** captures the copied session files it owns as a handoff
  destination while the row can still resolve the root, deletes the row
  (whose built-in/in-use guard is atomic with it — a refused 409 leaves the
  live task's copied transcript untouched), then removes the captured files.
  Its membership row cascades away, so the surviving stack ranks are re-packed
  to `0..n-1`; the API also derives `position` from the surviving order, so a
  pre-fix database with a gap still reads contiguously.
- **Stack delete** clears every task state that names it and cancels each
  affected all-exhausted retry timer; cooldowns stay account-scoped.

## Manual paths

- `prepareTaskHarness({ manual: true })` runs before a Run/message: a cooling
  account is forced; an account removed/disabled/logged out moves to the next
  usable one and transfers the conversation. A live run is left alone (the
  message queues).
- `PATCH /tasks/:id` with an `agent` inside the same stack is refused while a
  run is live (409 "stop the run before switching accounts"); an outside-stack
  switch keeps the old kill/reset behavior.
- A same-stack manual switch is AWAITED by the PATCH route and holds the task's
  start claim for the whole transcript copy (`accountSwitchTaskIds` plus
  `startingTaskIds`). A Run during the copy is refused ("switching accounts —
  try again in a moment") and a message is declined for the same reason: the old
  REPL is about to be dropped and a fresh session would be displaced by the
  handoff. The intent is persisted as `harnessState.pendingSwap.manual` **before**
  the task row changes accounts, so a crash between the row update and the
  transcript copy is completed by the boot reconcile (the transcript is still on
  the source account) or visibly reported — never silently lost. The move
  records `lastMove.reason = "manual-switch"`, so the task header says "Switched
  to … — continuing this conversation" rather than claiming the previous
  account left or was unavailable. The move is recorded even when the task has
  no provider session to copy (nothing ran on the old account yet), matching
  the boot reconcile instead of silently clearing the state.
- A same-stack manual switch transfers and keeps queued follow-ups; outside the
  stack the old fresh-start behavior applies.
- A message typed during a swap or an all-exhausted retry window is held
  (`swapWindowTaskIds`) and drained in order onto the run that actually
  executes it, after the successor settles. The drain's own send is the
  message's only `user` bubble — the window does not write one on the displaced
  run (that duplicated it). Stop/archive/delete re-stashes it to the backlog.

## Surfaces

- **API**: `GET/POST /harness-stacks`, `GET/PATCH/DELETE /harness-stacks/:id`;
  `GET /harnesses` carries `stacks` and `limitStates`; `GET /tasks` carries
  `harnessState`. Create/edit run the config mirror inline when the change is
  mirror-relevant, so those handlers call `server.timeout(req, 0)` — a large
  plugin payload on a slow volume must not hit Bun's 255 s idle cap after the
  stack row is already saved.
- **CLI**: `agetor harness stack ls|create|show|edit|rm` (listed in
  `agetor harness --help`); stack column in `harness ls`; `· 2/3` in `ls`;
  `stack:` / `failover:` lines in `show`; the formatted notice in `logs`; TUI
  toast + notice, and the active account with its position (`<label> · 2/3`)
  in the task header. A stored harness label can carry control characters (the
  route keeps it as typed), so every terminal renderer escapes status text —
  a switch/continue line cannot repaint the log.
- **Webview**: Settings → Stacks editor; Harnesses chips (position + cooling);
  New Task/TaskCard badges (a not-yet-run task derives its `n/m` from the
  account's stack membership); RunPanel account line, countdown banner with a
  **Run now** action (forces a cooling account and resets the attempt cap) and
  the swap divider.
- **Notifications**: `harness-swap` is a quiet kind; `blocked` with a stack
  reason reads "Stack out of quota" / "No usable backup account". The old run's
  failed settle is silent for both `harness-swap` and `harness-exhausted`.
- **Pipelines**: a step's `run-status` with `reason: "harness-swap"` or
  `"harness-exhausted"` is non-terminal; the successor's settle is the step's
  outcome, and the retry's `running`/settle events clear the step block. A
  harness-stack successor (`origin: "harness-swap"`) is the same execution, not
  a user turn: it never resumes a stopped step. A pipeline Stop counts a step
  waiting on an armed stack retry as something it can stop and cancels the
  timer, so nothing fires after the Stop.
- **Bundles**: stacks are machine-local and are not exported.

## Known limitations

- A mirrored marketplace clone loses its `.git` metadata: the repository can
  carry a remote URL with an embedded access token, so it is never copied. The
  plugin payload still works; a git-based marketplace update on a backup
  re-clones instead of fast-forwarding.
- A stack deleted mid-turn (or an inert 0/1-member stack) takes the
  **lone-account** path on purpose: the limit is recorded as a normal run
  failure, the card returns to `ready`, and a status line explains that there
  is no failover. Nothing is hidden — `agetor show`/`logs` still carry the
  failed run and the message — but the card does not block, because a lone
  account has never blocked on a quota notice (Claude's own auto-continue keeps
  the turn alive). Re-create/re-enable the stack before the next Run to resume
  failover.
- A Claude **built-in** account shares the OS keychain, so a logout of that
  account cannot be detected at pre-flight and cannot be isolated from the
  others. Stack pre-flight login evidence reads an account's own config
  directory (`~/.claude*` / `CLAUDE_CONFIG_DIR`): `.credentials.json`, the
  credential in its `settings.json` `env` or `harness.env` map, or an
  `apiKeyHelper`-style login. A Bedrock/Vertex/custom-provider setup (or a
  custom endpoint) fails **open** — it is never reported as logged out — in
  any of those scopes, including a **process-level** selector that every spawn
  inherits; a Codex `config.toml` that is present but unreadable fails open the
  same way. Such an account still cannot be verified, so use accounts with
  their own config directory for a train.

## Risks

- A mid-turn resume may repeat a tool whose result was lost. Accepted by the
  owner; the continuation prompt says not to repeat completed steps.
- A false limit classifier burns a backup. The negative table is the mitigation.
- A backup with a lower plan/model cannot run the task's model; selection skips
  a known-excluding catalog and an unknown catalog fails open.
- A profile-bound task's frozen snapshot still names the original account while
  `task.agent` moves. Same-kind stacks keep the prompt kind and model valid.
- Mirror/copy latency makes the swap gap seconds; the task stays `running` and
  the copy is cooperative.
