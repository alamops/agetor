# Grill — Harness account stacks

| Field | Value |
| --- | --- |
| Date | 2026-11-06 |
| Source | Pipeline "Alamo Pipeline (OpenCode)" step 2; `docs/plans/harness-account-stacks-investigation.md` (step 1). The feature requirement lives only in the pipeline step text. |
| Mode | Interactive via decision form, answered by the owner in 4 rounds |
| Answers | `docs/plans/harness-account-stacks-grill/round-1/answers.json` (+ `round-2/answers.json`, `round-3/answers.json`, `round-4/answers.json`) |
| Flags | none |
| Spec | Outside the repo: the pipeline step text. By owner decision (`round-3/answers.json#source-of-truth`), `docs/plans/harness-account-stacks.md` is the binding spec; the investigation brief stays as evidence. |

## One-way door resolution

The credential question was first answered **copy credential files between homes** (`round-1/answers.json#credentials`). Round 2 re-asked it with the evidence that a copied token makes the backup the *same provider account*, so it shares the primary's quota and provides no failover. The owner re-answered **each member uses its own login** (`round-2/answers.json#credentials-recheck`). **The round-1 answer is superseded and must not be implemented.** The mirror may copy MCP/plugin OAuth (tool auth), but never the harness's own login/account credential files.

## Decisions

| # | Topic | Question | Answer | Source |
| --- | --- | --- | --- | --- |
| 1 | Model | What is a "stack"? | **Implicit chain attached to each account.** An account belongs to at most one stack; a task's stack is derived from `Task.agent`; a swap changes `Task.agent` to the next member. No new task/profile/pipeline/bundle field. | owner (`round-1/answers.json#stack-model`; accepted recommendation) |
| 2 | Model | Same kind only, or cross-kind? | **Same kind only.** A cross-kind fallthrough is rejected at stack creation. | owner (`round-1/answers.json#same-kind`; accepted recommendation) |
| 3 | Model | Which kinds in v1? | **Claude Code + Codex only.** OpenCode is out of v1 and its adapter test is dropped. | owner (`round-1/answers.json#v1-kinds`; overrode recommendation; confirmed `round-2/answers.json#v1-kinds-recheck`; accepted recommendation) |
| 4 | Model | Per-task opt-out? | **No per-task opt-out in v1.** A task that must stay on one account uses an account that is not in a stack. | owner (`round-2/answers.json#per-task-opt-out`; accepted recommendation) |
| 5 | Model | Maximum stack size? | **No hard cap.** The stack editor virtualizes long lists and warns above 10 members; the swap UI shows position/count; selection stays O(n) per turn. | owner (`round-1/answers.json#max-size`; overrode recommendation; `round-2/answers.json#max-size-followup`; accepted recommendation) |
| 6 | Model | Name in the UI and docs? | **"Harness stack"**, members are **"accounts"**, the verb is **"stack"**. | owner (`round-1/answers.json#naming`; accepted recommendation) |
| 7 | Limits | Claude Code waits for its own usage-limit reset. Preempt it? | **Preempt.** Detect Claude's auto-continue notice, stop the turn, transfer the transcript, and continue on the backup. | owner (`round-1/answers.json#claude-limit-notice`; accepted recommendation) |
| 8 | Limits | What counts as a limit? | **Provider quota exhausted, HTTP 429, and 402/insufficient credits.** Auth failures, 5xx/529/network and model-not-available are excluded: auth blocks with the credential panel, 5xx is account-independent, model-not-available is a pre-flight skip. | owner (`round-1/answers.json#limit-signals`; accepted recommendation) |
| 9 | Limits | Proactive, reactive, or both? | **Both.** Skip a member whose cached quota clearly says exhausted; react to a failure as the backstop; a stale or missing snapshot never blocks a run on its own. | owner (`round-2/answers.json#proactive-reactive`; accepted recommendation) |
| 10 | Limits | Is exhaustion account-global or per task? | **Account-global.** A new `harness_limit_state` table (no FK, like `harness_usage`) with `exhausted_until_ms`, reason, source and message. Selection skips a cooling account in every task; it clears on a successful turn or on expiry. No concurrency reservation in v1. | owner (`round-2/answers.json#exhaustion-scope`; accepted recommendation) |
| 11 | Limits | What happens when every member is exhausted? | **Block with a countdown and auto-retry at the earliest reset, cap 3.** If it fails again, leave it blocked for a manual Run. | owner (`round-1/answers.json#all-exhausted`; accepted recommendation) |
| 12 | Limits | After a swap, where does the task run next? | **Forward within a task; when the last member limits, wrap to the head (the primary); stop after one full lap and enter the all-exhausted pause.** The owner's note: "it must return to the primary only if the last stack account reaches the limit, then a natural swap to the beginning of the stack happens… if all accounts are tried in a run, to avoid running the train in loop, we must pause, as a cap." | owner (`round-2/answers.json#after-swap`; accepted recommendation with note; `round-3/answers.json#after-swap-lap`; accepted recommendation) |
| 13 | Limits | Manual Run on a cooling account? | **Force it.** A manual Run or message on a cooling-down account runs there; automatic selection skips it. | owner (`round-3/answers.json#force-run`; accepted recommendation) |
| 14 | Mid-turn | What happens to the turn that hit the limit? | **Resume the same turn on the backup.** Stop the old turn, transfer the provider session, and resume with a synthetic "continue" prompt. If the failure happened before any tool call, retry the original prompt instead. If the transfer fails, block with a clear message rather than silently starting fresh. | owner (`round-1/answers.json#mid-turn`; accepted recommendation) |
| 15 | Mid-turn | Pending cards, background agents, queued follow-ups? | **Cancel pending cards; keep the user's queued follow-ups and drain them after the new run settles; abandon background agents with a status line naming them.** | owner (`round-2/answers.json#orphans`; accepted recommendation) |
| 16 | Continuity | What does "preserve the conversation" mean? | **Exact provider session** for the v1 kinds; if the transfer fails, block with a clear message, never silently start fresh. | owner (`round-1/answers.json#history-fidelity`; accepted recommendation) |
| 17 | Continuity | Copy or share authentication tokens? | **Each member uses its own login.** Never copy harness credential files. The round-1 `copy-tokens` answer is superseded. | owner (`round-2/answers.json#credentials-recheck`; accepted recommendation) |
| 18 | Continuity | How does the backup get user-level MCP/skills/commands/settings? | **Mirror the whole user-level config**, including MCP/plugin OAuth, skills, commands, settings, hooks and permissions. **Never copy the harness login/account credential files.** Owner's note: "when I say tokens, I mean the authenticated oauth for mcp, plugins,etc. but the harness login/account should be separated, so it works correctly each account with its own limits." | owner (`round-1/answers.json#capability-sharing`; overrode recommendation; `round-2/answers.json#mirror-scope`; overrode recommendation with note) |
| 19 | Continuity | What about `settings.json` `env`, which can carry harness API keys? | **Strip the known harness-auth keys** (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `CURSOR_API_KEY`, …). Keep MCP/plugin OAuth and ordinary env vars. | owner (`round-3/answers.json#mirror-env-keys`; accepted recommendation) |
| 20 | Continuity | When does the mirror run? | **At stack creation and before each swap.** The primary wins for entries it defines; entries that exist only on the backup are kept. | owner (`round-3/answers.json#mirror-when`; accepted recommendation) |
| 21 | Continuity | Does Codex need the whole HOME override? | **Test dropping it first.** A small real-binary spike: run Codex with only `CODEX_HOME=<account>/.codex` and the real `HOME`; verify login, resume, config, MCP and write locations. If isolation holds, drop the HOME override for Codex; if not, fall back to the allowlist overlay. | owner (`round-4/answers.json#codex-home-premise`; accepted recommendation) |
| 22 | Continuity | If the HOME override stays, what does the overlay share? | **Codex only, fixed allowlist, symlinked, only for stack members:** `~/.gitconfig`, `~/.gitignore_global`, `~/.ssh`, `~/.config/gh`, `~/.npmrc`, `~/.netrc`. `CODEX_HOME` stays per-account. The owner's note questioned the premise ("why do we need the same home for different codex accounts"); round 4 resolves that by testing the cheaper path first. | owner (`round-2/answers.json#home-tools`; overrode recommendation; `round-3/answers.json#home-overlay-scope`; accepted recommendation with note) |
| 23 | Continuity | Manual switch to another member of the same stack? | **Preserve the conversation within the stack; reset outside it.** | owner (`round-2/answers.json#manual-switch`; accepted recommendation) |
| 24 | Continuity | Is the synthetic "continue" prompt visible? | **Hidden from the visible transcript, tagged in storage** (e.g. `harness_swap`); the swap notice is the visible record. **No product name in any synthetic text.** | owner (`round-2/answers.json#synthetic-prompt`; accepted recommendation with note "Just don't mention `Agetor`") |
| 25 | UX | What does the swap message look like? | **A status divider with structured text** (from/to, reason, position), persisted on the `status` stream; no new event type. | owner (`round-2/answers.json#swap-notice`; accepted recommendation) |
| 26 | UX | Exact swap wording? | **`Switched to <account> — <reason>. Continuing from the transferred conversation.`** No product name. | owner (`round-3/answers.json#swap-wording`; accepted recommendation) |
| 27 | UX | What does the task show during the swap? | **Stays `running`; the old run's failure toast is suppressed; `Switching to backup…` before the new run starts; then the swap notice.** | owner (`round-1/answers.json#running-ux`; accepted recommendation) |
| 28 | UX | Where is the active account visible? | **Run panel `account · position/count`; task card stack badge; toast/OS notification on a swap when the window is unfocused; topbar keeps one usage chip per account in v1 (no grouping).** | owner (`round-3/answers.json#indicators`; accepted recommendation) |
| 29 | UX | Stack order? | **User drag order; a new member appends at the end; selection starts at the first enabled, logged-in member and follows the order.** | owner (`round-3/answers.json#order`; accepted recommendation) |
| 30 | Lifecycle | When do tasks pick up a stack or membership change? | **At the next turn.** The in-flight turn finishes on the current account. Disabling skips the member; removing it from the stack applies to the next selection; deleting it removes the membership (the existing delete check still protects a row a task is on). | owner (`round-2/answers.json#lifecycle`; accepted recommendation) |
| 31 | Lifecycle | Stack validation? | **Hard-block on a different kind or the same effective home; warn on not installed, not logged in, or the task's model not offered.** A hard block is only for conditions that make failover meaningless. | owner (`round-3/answers.json#validation`; accepted recommendation) |
| 32 | Lifecycle | Run-row semantics of a swap? | **A new run row on the same task with the new member in `runs.agent`; the `run_events` transcript stays canonical; the old run is marked failed with a swap reason and its failure toast is suppressed.** | owner (`round-3/answers.json#new-run`; accepted recommendation) |
| 33 | Lifecycle | Crash/restart safety? | **Persist the swap intent (like `fxRecovery`) and reconcile it on boot.** | owner (`round-1/answers.json#persist-intent`; accepted recommendation) |
| 34 | Integration | Pipelines? | **Step tasks inherit failover automatically; the implicit model needs no pipeline format change.** | owner (`round-3/answers.json#pipeline`; accepted recommendation) |
| 35 | Integration | CLI parity? | **`agetor harness stack` create/list/edit/remove; `ls`/`show`/`logs` show the active member and the swap line; the TUI shows the active member/position.** | owner (`round-3/answers.json#cli-bundle`; accepted recommendation) |
| 36 | Integration | Do stacks travel in bundles? | **No.** Stacks are machine-local and not exported; a profile still binds an account and the stack follows implicitly. | owner (`round-3/answers.json#cli-bundle`; accepted recommendation) |
| 37 | Integration | Process-level provider keys? | **Warn at stack creation when `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/… would be inherited by every member; do not scrub them in v1.** | owner (`round-3/answers.json#process-keys`; accepted recommendation) |
| 38 | Rollout | Feature gate? | **No global flag.** Stacks are opt-in by creating one; an existing user sees no behavior change until they build a stack. | owner (`round-2/answers.json#rollout`; accepted recommendation) |
| 39 | Rollout | Binding spec? | **`docs/plans/harness-account-stacks.md` is the binding spec; no separate PRD.** | owner (`round-3/answers.json#source-of-truth`; accepted recommendation) |
| 40 | Acceptance | What does "done" mean for v1? | **An e2e two-account Claude stack survives a simulated limit, shows the swap notice, and preserves the conversation; a Codex adapter test; a unit test for the limit classifier; no credential file is ever copied.** Owner's note: tests do not need a real Claude account — use the fake drivers. | owner (`round-1/answers.json#acceptance`; accepted recommendation with note; `round-2/answers.json#v1-kinds-recheck`) |
| 41 | Acceptance | Additions from the round-2 scope items? | **A Codex HOME-overlay test (if the overlay is built) and a mirror test (MCP/plugin auth copied, harness login never copied, harness-auth env keys stripped).** OpenCode is out of v1, so its adapter test is dropped. | owner (`round-3/answers.json#acceptance-overlay`; accepted recommendation) |

## Completeness dispositions

| Item | Disposition | Owner or reason |
| --- | --- | --- |
| OpenCode adapter | out of scope | Owner chose Claude + Codex only (`round-2/answers.json#v1-kinds-recheck`); a separate ticket can add it. |
| Cursor, fx, gemini, copilot, antigravity adapters | out of scope | v1 kinds are Claude + Codex; each needs its own spike and adapter (investigation S4). |
| Cross-kind fallthrough | out of scope | Owner chose same-kind only (`round-1/answers.json#same-kind`). |
| Multiple stacks per account | out of scope | Implicit model (`round-1/answers.json#stack-model`). |
| Per-task opt-out | out of scope | Owner chose no opt-out (`round-2/answers.json#per-task-opt-out`). |
| Bundle export of stacks | out of scope | Machine-local; bundles cannot carry credentials or homes (`round-3/answers.json#cli-bundle`). |
| Load balancing concurrent tasks across accounts | out of scope | The requirement is failover, not load balancing; no owner decision to spread work. |
| Topbar stack grouping | out of scope | v1 keeps one usage chip per account (`round-3/answers.json#indicators`). |
| Provider-key scrubbing | out of scope | Warn only in v1 (`round-3/answers.json#process-keys`); the mirror's `env` filter is the v1 protection. |
| Auth-failure swap | out of scope | Block with the credential panel (`round-1/answers.json#limit-signals`). |
| 5xx/529/network swap | out of scope | Account-independent (`round-1/answers.json#limit-signals`). |
| Cross-account concurrency reservation | out of scope | No reservation in v1 (`round-2/answers.json#exhaustion-scope`). |
| Hooks/permissions security review | **in this change** | The owner chose `mirror-everything`, which includes hooks and permissions; the plan must include a security review and a visible warning before this ships. |
| Codex HOME spike (drop `HOME`, keep `CODEX_HOME`) | **in this change** | Owner chose it (`round-4/answers.json#codex-home-premise`); it decides whether the overlay is needed. |
| Codex HOME overlay | **in this change, conditional** | Only if the spike shows Codex still writes account state to `$HOME` (`round-3/answers.json#home-overlay-scope`). |
| Account-global cooldown table | **in this change** | `round-2/answers.json#exhaustion-scope`. |
| All-exhausted auto-retry timer | **in this change** | `round-1/answers.json#all-exhausted`. |
| CLI/TUI parity | **in this change** | `round-3/answers.json#cli-bundle`. |
| Session-file security and cleanup | **in this change** | Investigation §7: copied session/context files may contain secrets; use no-follow/regular-file checks and atomic writes, keep them user-only, and clean them up on archive/delete/retention. This is a security requirement, not a product decision. |
| Docs/README/architecture updates | **in this change** | Repo rule; `CLAUDE.md`, `README.md`, `docs/architecture/harnesses.md`, `task-lifecycle.md`, `persistence.md`, `security.md`, and the per-kind harness docs. |
| Additive migrations | **in this change** | `harness_stacks`, `harness_stack_members`, `harness_limit_state`; no `harnesses` rebuild (`docs/architecture/persistence.md`). |
| Test hygiene | **in this change** | `snapshotHarnessState()` restore, `route-policy.test.ts`, `migrate.test.ts`, fake drivers, e2e fixtures. |
| Real-binary tests for Claude/Codex | not required | Owner accepted fake drivers; the Codex HOME spike is the only real-binary test (`round-1/answers.json#acceptance` note). |
| Windows/Linux support | out of scope | The app is macOS-first (keychain, WKWebView); the overlay is POSIX if it is built. |
| `defaultHarness` pointing at a stack | out of scope | Implicit model: it points at an account; the stack follows. |
| Model-not-available pre-flight | **in this change** | Validation warns and selection skips the member (`round-3/answers.json#validation`). |
| OpenCode watch tombstones | out of scope | OpenCode is out of v1. |
| Codex `thread_history` / rollout migration after copy | **in this change** | Part of the Codex adapter; the plan must handle the existing-DB projection risk (investigation §7). |
| Claude transcript sidecars (`subagents`, `tool-results`, `mcp-tasks`) | **in this change** | Part of the Claude adapter; copy/validate/cleanup. |
| Pending permission/question cards on the old account | **in this change** | Cancel (`round-2/answers.json#orphans`). |
| Background agents | **in this change** | Abandon with a status line naming them (`round-2/answers.json#orphans`). |
| Queued follow-ups | **in this change** | Keep and drain after the new run settles (`round-2/answers.json#orphans`). |
| Manual stack-internal switch | **in this change** | Preserve within the stack; reset outside (`round-2/answers.json#manual-switch`). |
| Boot reconcile of a swap intent | **in this change** | `round-1/answers.json#persist-intent`. |
| `reconcileTaskSession` stack-aware behavior | **in this change** | Same-stack preserve, outside reset (`round-2/answers.json#manual-switch`). |

## Assumptions still open

1. **Codex `CODEX_HOME` alone isolates login/history/config.** The round-4 spike decides. If it fails, the fallback is the Codex allowlist overlay; if it succeeds, the `HOME` override is dropped for Codex and the overlay is not built. This is the only unresolved technical premise.
2. **The mirror's per-kind allowlist.** "Mirror everything" still needs an enumerated list of files and keys per kind: `settings.json`/`config.toml`, MCP server definitions, MCP/plugin OAuth token files, skills, commands, plugins, hooks and permissions. The plan must enumerate it and exclude the harness login files (`.credentials.json`, `auth.json`, `cli-config.json` harness auth, OpenCode credential tables). If the security review rejects hooks/permissions, the fallback is the safe subset; the owner should ratify that review outcome.
3. **"Primary wins on shared keys, backup-only entries kept"** is the merge rule (`round-3/answers.json#mirror-when`). The plan must define what a "key" is per kind (an MCP server name, a skill directory name, a settings key) and what happens when the same name exists with different content.
4. **The one-full-lap definition.** A member counts as "tried" when a run on it ends in a limit/failure that triggers a swap; a success resets the lap. A member skipped because it is cooling is not "tried". The plan must pin this state machine, including what happens when the head is cooling at wrap time.
5. **All-exhausted backoff when no reset time is known.** The cap is 3, like `FX_AUTO_RESUME_MAX`; if `resetsAtMs` is null, the plan must choose a backoff (the investigation suggests the fx precedent).
6. **The swap notice's structured payload.** The plan must define the fields (from/to labels, reason, position/count, reset time) and how the CLI/TUI render them without a new event type.
7. **The synthetic continuation prompt's tag.** `hidden-tagged` needs a stable tag in `src/shared/user-message.ts` (or a run-level flag) so a later JSONL rebuild can distinguish it from a real user message. The tag must not contain the product name.
8. **The HOME overlay's exact allowlist and symlink semantics (if built).** The owner named `~/.gitconfig`, `~/.ssh`, `~/.config/gh`, `~/.npmrc`; round 3 added `.gitignore_global` and `.netrc`. The plan must decide whether to symlink or copy, and how to avoid merging `CODEX_HOME`/XDG state dirs.
9. **The mirror copies MCP/plugin OAuth.** The exact token locations are per kind and per tool; the plan must find them without copying harness credentials. A tool-auth token is still a secret: it must be handled no-follow, user-only, and never logged.
10. **Existing tasks pick up stack changes at the next turn.** A task currently on a member that is deleted is protected by the existing `harnesses.delete` check; a disabled member's in-flight turn finishes. The plan must make this observable in the UI (a "member removed, will move next turn" note) rather than silent.
11. **No global feature flag.** The feature is always present in the UI; the rollback is to remove the stack, which makes the feature inert again. The plan should note this as the rollback story.
12. **The plan is the binding spec.** `docs/plans/harness-account-stacks.md` is the file a reviewer opens; the investigation brief stays as evidence. No separate PRD.
13. **The acceptance tests use fake drivers.** The owner explicitly does not require a real Claude account. The Codex HOME spike is the only real-binary test; if it needs a real Codex login, the plan must say so and keep it opt-in.
14. **The swap notice never names an email, token or the product.** Only account labels. This follows the owner's note and the existing `CLAUDE.md:92` rule.
15. **The `mirror-everything` choice includes hooks and permissions.** This is a security-sensitive residual risk. The plan must include a security review, a visible warning in the stack editor, and a documented way to opt out per stack (the safe subset). The owner chose the full mirror; the review is how the build keeps that choice honest.
