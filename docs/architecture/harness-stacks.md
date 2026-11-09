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
| `harness_stack_members` | `(stack_id, harness_id, position)`. `UNIQUE(harness_id)` enforces **one stack per account**; `UNIQUE(stack_id, position)` keeps the order unique. Cascades with its stack but has **no FK to `harnesses`** (migration 085): a `harnesses` table rebuild would otherwise cascade every membership away. `harnesses.delete` removes the account's row explicitly and re-packs the ranks. |
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
  notice, then resolves the turn. The notice is read relative to the input box
  (the last pair of `─` border rows around the `❯` row): only the hint slot —
  at most four non-blank rows directly above the box, the upward walk stopping
  at any transcript/tool gutter row (`⎿`, `│`, `|`, `>`, `⏺`, `●`, `❯`), at
  the spinner row (`✻ Thinking…`) and at a glyph-less row that continues a
  transcript entry (contiguous with a `⎿`/`⏺` row, no blank line between) — or the
  footer below it counts, and the head row may start only with indentation or
  an optional `⚠`. So a notice quoted in the scrollback, echoed in a tool
  result or typed into the input box never settles a healthy turn; with no
  input box on the pane nothing matches. Accepted wordings: `Usage limit
  reached · continuing automatically …` (and `… reached again …`), the
  standalone `Continuing automatically <when> · Esc to cancel`, `Usage limit
  reached · limit resets <t>`, the bare `Usage limit reached`, and `You've hit
  your limit · resets <t>`. The grace-window `Usage limit reached · wrapping up`
  counts only once the turn has stopped (Claude keeps working through the
  grace), and the usage-credits wrap-up never counts (credits keep the account
  working). The detection window is also what is stored, so a reset time that
  wraps keeps its parsed instant. A per-turn latch prevents re-emitting while
  the notice stays on screen. A lone account (no stack, or a 0/1-member stack) is
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
- **Codex** — only a terminal `turn.failed` emits the structured signal, from
  its own message or from the classification remembered from the last
  top-level `error`. A top-level `error` alone, an `error` item and a non-JSON
  log line never signal, and `turn.completed`/`turn.started` or any `item.*`
  event discard a remembered one (so a retried 429 never attaches to a later,
  unrelated failure). A codex that exits without `turn.completed`/`turn.failed`
  while a limit is remembered emits that limit instead of the "ended
  unexpectedly" sentinel; the orchestrator never classifies raw codex text and ignores
  a codex limit on a run that exited 0 (`limitSignalForSettle`). So a 429 that
  codex retried and recovered from — or an MCP tool error mentioning 429 — is
  never a limit. Codex 0.166 reports quota in prose: "You've hit your usage
  limit. … or try again at <date> <time>" (quota) and "Quota exceeded. Check
  your plan and billing details." (out of credits); the classifier matches that
  prose plus the snake_case codes (`usage_limit_reached`/`_exceeded`,
  `workspace_*_credits_depleted`, `rate_limit_exceeded`, …) and honours a
  structured `codex_error_info`/`error.code`/`error.type` (a known non-limit
  code is a definitive negative).
- **Reset times** — `parseClaudeResetNotice` reads the time after `resets` /
  `until` / `at` / `try again at`, date-first or time-first (`Nov 10, 3pm`,
  `Tue, Nov 10, 9:30am`, Codex's `Nov 10th, 2026 3:00 PM`, `3pm on Nov 12`,
  weekdays, `15:00`). A dated reset resolves to that date (a past one is
  null), a weekday to its next occurrence, a passed time-only reset to the next
  calendar day (DST-safe), and anything over 31 days out is null.
- **Fake drivers** — `__agetor_fake_claude_limit__`,
  `__agetor_fake_claude_limit_clean__`, `__agetor_fake_claude_limit_pane__`
  (the pane-sourced variant used by the passthrough session-drop test),
  `__agetor_fake_codex_limit__` (and the `AGETOR_FAKE_*_LIMIT` env twins) drive
  the e2e/unit paths. The fake codex limit emits the real prose ("You've hit
  your usage limit. Upgrade to Plus … or try again at 3:00 PM.") and exits 1,
  like the CLI on `turn.failed`.

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
   safety); the earlier teardown awaits are idempotent. If launches are frozen
   (the port is being handed to another core) the swap stops here: the old run
   is recorded failed with `reason: "harness-swap"`, the card stays `running`
   and the persisted intent is left for the next owner's boot.
6. The move itself is `executeStackSwap` → `moveTaskToMember`
   (`src/bun/harness-failover.ts`), the one implementation every account move
   shares (this settlement, the all-exhausted retry, the manual prepare move,
   the same-stack PATCH switch and the boot manual switch); each caller keeps
   its own failure policy. It runs `mirrorForSwap(stack, toHarnessId)` (a
   `mirrorStack` wrapper with the destination account, single-flight per
   destination), then the transfer, then commits `Task.agent` and the state;
   mirror/transfer warnings come back as status lines. A mirror failure is a
   warning, never a block.
7. The continuation gate decides:
   - **any tool call in this run, a recorded handoff, or an earlier run on this
     account with a provider session** → copy the provider session (Claude
     transcript + sidecars, or Codex rollout), record the handoff, spawn with
     `--resume`/`exec resume` and the hidden continuation prompt. The third
     clause is the follow-up case: a user's earlier turns produced the
     session, a later follow-up hits the limit before its own first tool call,
     and the whole conversation must still move. A same-account retry in this
     branch resumes the existing session in place (no copy). A Claude
     follow-up pasted into the REPL mid-turn that never reached the transcript
     (a live echo with no JSONL twin) is appended to the continuation prompt,
     so it is not lost with the dropped REPL. Whenever no started successor
     carries such follow-ups — a blocked ending (all-exhausted with a transfer
     retry or no timer, transfer failed), Stop, superseded, a frozen handoff,
     a failed or stopped spawn, or a paused REPL dropped on the passthrough
     branch — they go to the task's backlog tray with a status line; an
     all-exhausted **clean** retry replays them itself. A hard crash still
     loses them (they are in memory until the settlement ends).
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
     a transferred conversation that does not exist. A Claude clean retry whose
     text is a slash command (starts with `/`) is sent **alone** and unwrapped,
     as typed — Claude runs a command only from the start of the input, so the
     wrapper would turn it into prose; that one visible bubble is the accepted
     cost. The follow-ups folded into the limited turn are never its arguments:
     they follow as a queued hidden-continuation follow-up.
   A present-but-unreadable session is a hard block (`harness-swap-failed`), not
   a silent fresh start.
8. The old run is recorded `failed` with `run-status.reason: "harness-swap"`
   (the failure toast/notification is suppressed); the task stays `running`.
   When the settled run was itself an all-exhausted retry attempt, its
   `attempts` count is carried onto the successor (only `inFlight`/
   `nextAttemptAt` reset), so a retry that moves on to a member whose cooldown
   just expired cannot reset the three-attempt cap and loop forever.
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
a non-limit reason, no timer is armed. A spawn failure that reaches the cap
writes "Every account in this stack is out of quota — run the task manually after a reset." Messages held during the
settlement are stashed to the task's backlog as soon as it ends blocked — timer
or not — so nothing typed is kept only in memory across a countdown.

The armed timer respects the user: it is cancelled (`cancelHarnessRetryForTask`
— timer, `allExhausted` and held follow-ups, plus a status line "automatic
account retry cancelled") when the card is no longer `blocked` (a drag, `agetor
move` or any `PATCH /tasks/:id` column change off `blocked`), when the user
presses Stop on the blocked card, and on archive/delete/stack delete; the
timer itself bails the same way if it fires on a card the user moved. A fire
while a run is live or the task is held by background agents is deferred by
10 s (`deferAutoRetryNow`) rather than consumed.

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
and aborts the settlement before any mirror/transfer/spawn, recording the old
run `cancelled` (not failed; a pipeline step settles `cancelled` too); the
blocked all-exhausted branch honours it too, so no retry is armed.
A Stop during an all-exhausted retry's mirror/transfer aborts the account move
and settles like a Stop on an armed retry ("cancelled by user during the
account retry"; the card stays blocked, the account does not change), and a
Stop recorded during a retry is cleared when that retry ends, so it can never
cancel a later, unrelated failover. When a launch freeze already left the swap
for the next owner, a Stop clears `pendingSwap` and records the run
`cancelled`, so the next owner does not finish it.
The post-transfer step also re-reads the task, so an archive/stack delete during
the mirror/transfer can never resurrect a swap and spawn onto an archived task.

## The continuation prompt

The transfer branch sends exactly:

```
<harness-stack-continuation>
Continue the task from where it stopped. The previous account reached its usage limit; no work was lost. Do not repeat completed steps, re-read files you already changed, or ask the user to confirm. Pick up the next action.
</harness-stack-continuation>
```

When the limited run carried undelivered mid-turn follow-ups (see step 7), the
body continues with "The user also sent these messages before the switch; they
were not delivered yet:" followed by each message
(`composeHarnessStackContinuationPrompt(undelivered)`); with none it is exactly
the text above.

The clean-retry branch wraps the user's own reconstructed text in the same tag
(the body is the user's words, not a continuation instruction; a slash command
is the unwrapped exception above). A literal tag inside the user's text is
neutralized first (`neutralizeHarnessStackContinuationTags`, shared with the
transfer prompt), so a message that quotes the tag cannot break the wrapper. Its source is
`composeCleanRetryText(runs.mainUserTexts(oldRunId))` — normalized, de-duplicated
and unwrapped — so a second consecutive clean retry strips the previous wrapper
before wrapping again; nesting would stop the value being recognised and leak
the hidden prompt as a visible bubble.

`isHarnessStackContinuation` hides only a value that is exactly the wrapper —
checked after `normalizeDeliveredUserText`, because claude's JSONL twin of the
pasted prompt is `<pasted_content>`-wrapped. Every renderer (RunPanel, CLI
`logs`, TUI, message history, event search, the sticky user-message headers)
skips it, and the first-load anchor never lands on it. A user message that
merely mentions the tag stays visible. It contains no product name. Because a
hidden value is recognised by its text, only agetor's own swap sends may
produce one: user text that is exactly the wrapper is refused with a 400
(`HIDDEN_CONTINUATION_REFUSAL`) by `sendInput`, `createTask`, `startTask` and a
task-prompt `PATCH /tasks/:id` — otherwise a CLI-token caller could hand an
agent an instruction no transcript shows.

## Mirror: config only, never login

`src/shared/harness-mirror.ts` is the single allowlist; `src/bun/harness-mirror.ts`
implements it. Source is always position 0. Both sides resolve their config
root through `claudeConfigDirFor` / `codexHomeFor`, which honour the harness's
own env map (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`) exactly like `harnessEnv` does
— the env override wins over the home-derived path, so the mirror and a session
transfer target the directory the CLI really reads.

- **Claude**: merge `settings.json` (primary scalars win, arrays union with the
  primary first, objects deep-merge — except `hooks` and `permissions`, whose
  whole object is replaced by the primary's in full mode, so an edited hook
  does not run twice on the backup and a revoked permission does not survive
  there; a primary without the key leaves the backup's alone) and only the `mcpServers` /
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
  `Bun.TOML.parse`. The **login-bearing** keys are never imported from the
  primary — `model_provider`, `forced_login_method`,
  `forced_chatgpt_workspace_id`, `preferred_auth_method`,
  `cli_auth_credentials_store`, `mcp_oauth_credentials_store`,
  `mcp_enterprise_managed_auth`, `chatgpt_base_url`, `openai_base_url` (top
  level, dotted, inside `[profiles.*]`, as a dotted key of a `[profiles]`
  table such as `work.model_provider`, or an inline `profiles` table) and every
  `[model_providers]`/`[model_providers.*]` table, which can carry a bearer
  token or auth headers. Each assignment of a primary table is judged by its
  full key path; an inline profile table that names a login key is dropped
  whole. The backup's own values and blocks survive — its own profile login
  keys are carried into the merged table even when the primary's same-named
  profile has none — and one warning names what was skipped; copy `AGENTS.md` (the user-level instruction file),
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
  non-credential setting (`*_MODEL`, `*_MAX_TOKENS`, `AWS_REGION`) still
  mirrors. Every provider/login **selector** is never imported either — the
  switches that pick the provider or endpoint the account authenticates
  against (`CLAUDE_CODE_USE_BEDROCK`/`VERTEX`/`FOUNDRY`/…,
  `ANTHROPIC_BASE_URL`, `ANTHROPIC_BEDROCK_BASE_URL`,
  `ANTHROPIC_VERTEX_BASE_URL`, `ANTHROPIC_VERTEX_PROJECT_ID`,
  `CLAUDE_CODE_SKIP_*_AUTH`, `OPENAI_BASE_URL`, …) and the login-selecting
  cloud settings (`AWS_PROFILE`, `AWS_DEFAULT_PROFILE`, `AWS_ROLE_ARN`, the AWS
  config/credentials file pointers) — otherwise a subscription backup would
  run on the primary's cloud identity and quota. The process environment is not modified (a warning names the
  first kind-relevant credential it sees, cloud keys included).
- **Login-selecting `settings.json` keys** (`apiKeyHelper`,
  `forceLoginOrgUUID`, `awsCredentialExport`, `awsAuthRefresh`,
  `gcpAuthRefresh`, `forceLoginMethod`, `proxyAuthHelper`) are treated the
  same way, in both modes: never imported from the primary, and a backup's own
  value survives. Only the credential-producing ones (`apiKeyHelper`,
  `forceLoginOrgUUID`, the `aws*` pair, `gcpAuthRefresh`) count as login
  evidence; `forceLoginMethod` and `proxyAuthHelper` select or proxy a login
  without providing one.
- **Codex MCP sign-in** is not copied (OAuth store, security review deviation);
  when the primary defines `[mcp_servers.*]` the mirror warns that the backup
  may need to sign in once.
- **Static tool auth is mirrored on purpose.** An MCP server definition
  (`.claude.json` `mcpServers.*`, Codex `[mcp_servers.*]`) is copied whole,
  including any token in its `env`/`headers`/`http_headers`: the owner
  sanctioned tool auth crossing accounts, never the harness's own login
  (`docs/plans/harness-account-stacks-grill.md`).
- **Login evidence ignores Claude Code's own session variables.** Inside the
  `CLAUDE_CODE_` namespace only the real login variables
  (`CLAUDE_CODE_OAUTH_TOKEN` and its file-descriptor/refresh forms,
  `CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR`, `CLAUDE_CODE_GATEWAY_TOKEN`, the
  remote-session tokens) count, so Agetor started from inside a Claude Code
  session (which exports e.g. `CLAUDE_CODE_MESSAGING_TOKEN`) does not read every
  account as logged in; the mirror still strips every secret-shaped key.
- **Safe mirror** skips settings hooks, permissions and every setting that
  runs a command — Claude Code 2.1.319's own list: `apiKeyHelper`,
  `awsAuthRefresh`, `awsCredentialExport`, `fileSuggestion`, `gcpAuthRefresh`,
  `otelHeadersHelper`, `policyHelpers`, `processWrapper`, `proxyAuthHelper`,
  `statusLine`, `subagentStatusLine` (Codex: `notify`); plugins and MCP
  servers are still mirrored. The backup's own value of every skipped key
  survives; the primary still wins the keys that are not skipped (`model`, …).

All reads are no-follow/regular-file; every write is atomic and 0600; symlinks,
FIFOs and oversize trees are skipped with a warning — except a **top-level**
symlink in Claude `skills/`/`commands/`/`agents/` or Codex `skills/`/`prompts/`
(a skills-manager layout links them in), which is recreated in the backup as an
absolute link to the source link's target without reading through it. The
target is resolved **lexically** (lstat + readlink per component, never
`realpath`; nothing below a protected folder is ever stat'ed), because an
agent can plant such a link. A dangling target, a link loop, a target at or
above either account root, a never-copy/credential path, a `.git` path, or a
target that reaches a macOS-protected home folder (`Desktop`, `Documents`,
`Downloads`, `Pictures`, `Movies`, `Music`, `Library/Mobile Documents`,
`Library/Mail`, `Library/Messages`, `Library/Safari`, `Library/Containers`,
`Library/Group Containers`) is refused. A real backup entry is never
replaced; an existing backup **link** is (primary wins — owner decision). Mirror copies keep the source
mtime, and a destination that is already a regular file of the same size and
mtime is skipped, as is a merged file whose result equals the backup's
current text, so a swap does not rewrite thousands of unchanged plugin files.
`mirrorForSwap` is single-flight per destination account and all mirror work
for one destination is serialized, so a stack save and N tasks swapping onto
the same backup never interleave. Before any other I/O, mirror, both transfer
adapters and cleanup resolve each account root (and, for Claude, each
`.claude.json` directory) lexically and refuse it when it lands in a
protected home folder its stored path did not name — a root swapped for a
symlink after it was gated (mirror: one warning, nothing written; transfer:
`unsafe-source`; cleanup: nothing removed). A root saved under such a folder
on purpose, and the `/tmp`/`/var` system links, are unaffected. Mirror and
both transfer adapters also refuse two accounts whose config roots are the
same directory **by realpath** (a symlinked alias included). A **source** path is also
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
emits only `CODEX_HOME=<home>/.codex`; `HOME` stays the user's real home. This
applies to **every** Codex account with a `home`, stacked or not (an owner
decision): before stacks, such an account also had `HOME=<home>`, so an alias
that relied on its own `HOME` for `.gitconfig`/`.ssh`/`gh` now runs shell tools
under the user's main identity — pin `HOME` in the account's env map to keep
the old behaviour.

All config roots resolve through one precedence, the pure
`src/shared/harness-config-root.ts`, which `src/bun/harness-config-root.ts`
feeds with the process values (used by the spawn env, mirror, transfer,
command discovery and the usage meters), matching what the spawn makes the CLI
read. The **spawn pin** (`claudeConfigDirOverrideFor` /
`codexHomeOverrideFor`) is only the env map's value, else `home`: an env-map
`HOME` alone pins nothing. Such a Claude account spawns without
`CLAUDE_CONFIG_DIR` (so on macOS it uses the unsuffixed keychain item) and
reads `<HOME>/.claude` and `<HOME>/.claude.json`; an unpinned spawn is handed
this process's `CLAUDE_CONFIG_DIR`/`CODEX_HOME` or has it unset
(`pinClaudeConfigDir`, `pinCodexHome`), so the long-lived tmux server's env can
never redirect it. Every reader uses `claudeConfigDirFor`/`claudeJsonDirFor`/
`codexHomeFor`. Codex: the env map's
`CODEX_HOME` → `<home>/.codex` → the process `CODEX_HOME` → `<env-map
HOME>/.codex` → `~/.codex`. Claude: the env map's `CLAUDE_CONFIG_DIR` → `home`
→ the process `CLAUDE_CONFIG_DIR` → `<env-map HOME>/.claude` → `~/.claude`
(`.claude.json` lives in the config dir when one is pinned, else in that
HOME). Blank values count as unset, and `harnessEnv` drops a blank
`CLAUDE_CONFIG_DIR`/`CODEX_HOME`/`HOME` from the env map so the spawn agrees. The rollout adapter copies the
rollout to the same relative path under the destination `CODEX_HOME` and, when
a `thread_history_*.sqlite` already exists, runs `codex migrate-rollouts
--apply` (30 s timeout, `coreSpawn`) once with `CODEX_HOME` set to the
destination's resolved root for every account shape (an env-map `HOME` one
included, so it never touches the user's own `~/.codex`); a failure is a warning and a failed
resume blocks the swap visibly.

## Crash safety and boot

- A persisted `pendingSwap` is completed if its successor already exists and is
  live, or left alone if it already settled (its visible outcome is
  authoritative). When **no successor was ever minted** (`task.runId ===
  pending.runId` — the run insert and the `runId` update are one transaction),
  boot re-runs the swap (`resumeInterruptedSwap`; the transfer is idempotent)
  after re-validating the destination. Only when the destination is no longer
  usable, or a successor exists that cannot be accounted for, is the task
  visibly blocked with `harness-swap-failed` — a blind second spawn could
  duplicate work.
- `allExhausted.nextAttemptAt` is re-armed on boot; overdue retries are
  staggered (`now + 5 s + i × 2 s`) so N tasks on one stack do not all mirror
  into the same backup in one tick, and a card `reconcileOrphans` sent to
  `ready` while its retry is armed is put back in `blocked`.
- Expired cooldowns are filtered out of read payloads and pruned on boot and on
  every cooldown write; a GET never writes.
- `reconcileHarnessFailover({ includeSwaps: false })` runs after
  `reconcileOrphans()` and before `markBootReady()` in `index.ts` and
  `headless.ts`; the swap reconcile (`reconcilePendingHarnessSwaps`, which may
  copy a transcript) runs **after** the boot gate opens, holding each affected
  task's start claim, so routes never wait on a copy.
- `freezeLaunches()` (the port is being handed to another core, or the app is
  quitting) stops every retry timer in this process (the persisted schedules
  are re-armed by the next owner), stashes held follow-ups to the backlog, and
  makes an in-flight swap stop before its spawn, leaving `pendingSwap` for the
  next owner. Headless shutdown and the app's `exit` stop the timers too.

## Cleanup

- **An agent switch never removes copied files.** After a swap the successor
  resumes the copied transcript/rollout, which then holds every later turn on
  that account — it is the live conversation, not a disposable copy. A switch
  outside the stack (and a same-stack switch whose transfer failed) clears the
  failover state but keeps the files and handoff rows; a handoff only steers a
  resume on the account it was copied onto, so switching back resumes the
  conversation there. Only task delete, retention and harness delete remove
  copies. A destination file that already existed before a copy (an A→B→A
  wrap overwrites A's own original) is never recorded, so cleanup can never
  delete an account's own transcript.
- **What cleanup trusts.** The database is agent-writable, so a recorded path
  is unlinked only when it lies below the destination account's root, matches
  a handoff shape (Claude `projects/<enc>/<sid>.jsonl` or
  `…/<sid>/{subagents,tool-results,mcp-tasks}/…`; Codex
  `sessions/YYYY/MM/DD/rollout-*.jsonl`), has no symlinked component and is a
  regular file, and nothing is removed under a root that resolves into a
  protected folder its stored path did not name. Nothing is removed
  recursively; afterwards only empty plain directories inside those shapes are
  pruned. The unlink loop is cooperative.
  Handoff upserts merge `copied_paths_json`, so a second copy onto the same
  account never orphans the first copy's files.
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
  `harnesses.delete` removes its membership row explicitly (there is no FK
  cascade, see Model) and re-packs the surviving ranks to `0..n-1`; the API also derives `position` from the surviving order, so a
  pre-fix database with a gap still reads contiguously.
- **Stack delete** clears the failover state and cancels the retry timer of
  every task whose recorded `stackId` **or currently resolved stack** is the
  deleted one (`failoverTaskIdsForStack`, computed before the delete), so an
  account edited into the stack after a task's last state write is caught too;
  cooldowns stay account-scoped. Every orchestrator state write goes through
  `updateTaskState`/`patchTaskState`, which re-point `stackId`, `position` and
  `count` from the current resolution.

## Manual paths

- `prepareTaskHarness({ manual: true })` runs before a Run/message: a cooling
  account is forced; an account removed/disabled/logged out moves to the next
  usable one, mirrors the config onto it and transfers the conversation
  (`moveTaskToMember`; its warnings become status lines on the run). A live
  run — or a task held by running background agents — is left alone (the
  message queues). The message path holds the task's start claim for the whole
  move, so an armed retry cannot mint a competing successor mid-copy.
- `PATCH /tasks/:id` with an `agent` inside the same stack is refused while a
  run is live (409 "stop the run before switching accounts") and while the
  task is held by running background agents (409 "stop the background agents
  before switching accounts"); for a CLI-token caller both members' roots are
  re-probed through the CLI path gate first (403 `path-not-accessible`). An
  outside-stack switch keeps the old kill/reset behavior.
- A same-stack manual switch is AWAITED by the PATCH route and holds the task's
  start claim for the whole transcript copy (`accountSwitchTaskIds` plus
  `startingTaskIds`). A Run during the copy is refused ("switching accounts —
  try again in a moment") and a message is declined for the same reason: the old
  REPL is about to be dropped and a fresh session would be displaced by the
  handoff. A same-stack switch of a task held by running background agents is
  refused at every entry (the route answers 409; `claimTaskForAccountSwitch`
  and `reconcileTaskSession` revert a direct caller's switch with a status
  line), so the REPL hosting them is never dropped. The intent is persisted as `harnessState.pendingSwap.manual` **before**
  the task row changes accounts, so a crash between the row update and the
  transcript copy is completed by the boot reconcile (the transcript is still on
  the source account) or visibly reported — never silently lost. The move
  records `lastMove.reason = "manual-switch"`, so the task header says "Switched
  to … — continuing this conversation" rather than claiming the previous
  account left or was unavailable. The move is recorded even when the task has
  no provider session to copy (nothing ran on the old account yet), matching
  the boot reconcile instead of silently clearing the state.
- A same-stack manual switch mirrors the config, transfers and keeps queued
  follow-ups; the boot completion of an interrupted manual switch mirrors too.
  Outside the stack the old fresh-start behavior applies (but copied files are
  kept, see Cleanup). In the RunPanel, a same-kind account switch PATCHes only
  `{ agent }`, so the task keeps its mode, model, effort, speed and Max mode;
  a refused or failed switch shows an error toast with the server's reason
  ("may have gone through" on a dropped connection — `taskPatchFailureToast`,
  `src/mainview/lib/task-patch-failure.ts`), while other dropdown PATCH
  failures stay quiet.
- A message typed during a swap window is held (`swapWindowTaskIds`) and
  delivered in order to the successor as soon as it registers, through the
  ordinary mid-turn path (Claude folds it into the live turn, Codex queues it);
  a settle-time drain onto the run that actually executes it remains the
  fallback. That send is the message's only `user` bubble — the window does
  not write one on the displaced run (that duplicated it).
  Stop/archive/delete, a settlement that ends blocked (timer or not), a refused
  send and a launch freeze re-stash it to the backlog at once; a message typed later,
  during an all-exhausted countdown, is a manual message and runs through
  `prepareTaskHarness` immediately.

## Surfaces

- **API**: `GET/POST /harness-stacks`, `GET/PATCH/DELETE /harness-stacks/:id`;
  `GET /harnesses` carries `stacks` and `limitStates`; `GET /tasks` carries
  `harnessState`. Create/edit run the config mirror inline when the change is
  mirror-relevant, so those handlers call `server.timeout(req, 0)` — a large
  plugin payload on a slow volume must not hit Bun's 255 s idle cap after the
  stack row is already saved; the CLI gives these two calls a 15-minute budget
  and the webview sends them with `retry: false`, and a connection dropped
  before the answer says the stack "may have been saved" and reloads instead
  of re-posting. Member warnings (install, login, model, process key) are
  computed only by the list, the detail `GET /harness-stacks/:id` and the
  create/edit responses; the runtime lookups (`get`, `getByMember`,
  `resolveForTask`) are plain DB reads. For a CLI-token caller, create/edit
  (and a same-stack account switch) first probe every member's config root
  through the CLI path gate (403 `path-not-accessible`). `POST`/`PATCH
  /harnesses` refuse (400, every caller) a non-blank `CLAUDE_CONFIG_DIR`/
  `CODEX_HOME`/`HOME` env value that is not absolute as given (relative, `~`,
  leading whitespace), refuse a `..` segment, and otherwise store `home` and
  those values exactly as given — the stored `CLAUDE_CONFIG_DIR`/`home`
  spelling is the string Claude hashes into its keychain item. `PATCH /harnesses/:id` refuses re-pointing a stack
  member onto another member's config root or another kind
  (`harnessStacks.validateMemberRoot`), and a `PATCH /tasks/:id` column move
  off `blocked` cancels an armed retry.
- **CLI**: `agetor harness stack ls|create|show|edit|rm` (listed in
  `agetor harness --help`; `agetor harness stack <sub> --help` prints that
  subcommand's flags); stack column in `harness ls`; `· 2/3` in `ls`;
  `stack:` / `failover:` lines in `show`; the formatted notice in `logs`; TUI
  toast + notice, and the active account with its position (`<label> · 2/3`)
  in the task header. While a retry run is live, `show` reads "running on
  <account> after a quota reset (attempt n/3)". A stored harness label or id
  can carry control characters (the route keeps it as typed), so every
  terminal renderer escapes it — a switch/continue line cannot repaint the
  log. A hidden continuation prints nothing (not even a blank line).
- **Webview**: Settings → Stacks editor (a disabled account can be added and
  shows the `member-disabled` warning; its same-config-directory blocker uses
  the shared spawn precedence of `src/shared/harness-config-root.ts`, env-map
  `HOME` included, lexically — the real home is `~` and a process
  `CLAUDE_CONFIG_DIR`/`CODEX_HOME` is unknown there, so the server stays
  authoritative); Harnesses chips (position + cooling);
  New Task/TaskCard and the task-launch pickers' badges (a not-yet-run task
  derives its `n/m` from the account's stack membership); RunPanel account
  line, countdown banner with a **Run now** action (forces a cooling account
  and resets the attempt cap) and the swap divider. While the retry run itself
  is live the banner reads "Running on <account> after a quota reset (attempt
  n/3)." with no Run now (`src/mainview/lib/harness-stack-banner.ts`).
- **Launch surfaces**: a launch is never refused client-side on an account
  that is disabled, unavailable or logged out when its stack has a usable
  backup (`stackBackupCanServe`, `src/mainview/lib/stack-launch.ts`): the Git
  issue/PR dialogs gate submit on `effectiveLaunchable`, the pipeline
  preflight (`resolvePipelineLaunch`) returns ready, and a hint says the run
  starts on the next usable account — the core's `startTask` makes the move.
- **One-account stacks**: a stack with fewer than two members is inert, so no
  surface shows an `n/m` position or "fails over" copy for it (webview, CLI,
  TUI, notifications); the card badge shows only a live state word. The rule
  lives once in `stackPositionText` (`src/shared/harness-stack.ts`), which the
  CLI and the webview's `stackPositionFor` both use.
- **Notifications**: `harness-swap` is a quiet kind; `blocked` with a stack
  reason reads "Stack out of quota" / "No usable backup account" (webview,
  headless core, TUI and CLI `--notify`). The old run's failed settle is
  silent for both `harness-swap` and `harness-exhausted`
  (`runStatusToastKind`, `src/mainview/lib/run-status-toast.ts`).
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
  failure, the card returns to `ready`, and a status line reads "account
  limit reached (<usage limit|rate limit|out of credits>)". Nothing is hidden — `agetor show`/`logs` still carry the
  failed run and the message — but the card does not block, because a lone
  account has never blocked on a quota notice (Claude's own auto-continue keeps
  the turn alive). Re-create/re-enable the stack before the next Run to resume
  failover.
- A Claude **built-in** account (no pinned config dir) uses the unsuffixed
  keychain item, so a logout of that account cannot be detected at pre-flight
  (its login evidence is "unknown", never "logged out"). Stack pre-flight login
  evidence for a pinned account reads its own config directory
  (`~/.claude*` / `CLAUDE_CONFIG_DIR`): `.credentials.json`, the credential in
  its `settings.json` `env` or `harness.env` map, or an `apiKeyHelper`-style
  login (`apiKeyHelper`, `forceLoginOrgUUID`, `awsCredentialExport`,
  `awsAuthRefresh`, `gcpAuthRefresh`). On **macOS** a pinned account keeps its OAuth login in the keychain,
  not in a file, so when none of those is present the core asks the keychain
  whether the item exists — existence only, never the secret:
  `/usr/bin/security find-generic-password -s "Claude
  Code-credentials-<first 8 hex of sha256(CLAUDE_CONFIG_DIR as given, NFC)>"`
  (or of `CLAUDE_SECURESTORAGE_CONFIG_DIR` when set), without `-w`, run as an
  async `coreSpawn` (2 s kill), single-flight per service, cached 60 s: found →
  logged in, missing (exit 44) → logged out, any error → unknown. Readers never
  block the main thread: they get the cached (or stale) value, or unknown until
  the first lookup lands, and trigger a background refresh. Test seams:
  `setLoginEvidenceDepsForTests` (`keychainProbe`, `securityRunner`) and
  `settleKeychainProbesForTests` (under `NODE_ENV=test` with no seam the probe
  reports "no item"). A Codex account whose
  `config.toml` sets `cli_auth_credentials_store = "keyring"|"auto"` and has no
  `auth.json` is "unknown" too. A Bedrock/Vertex/custom-provider setup (or a
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
