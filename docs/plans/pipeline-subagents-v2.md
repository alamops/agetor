# Plan — Pipelines v2: agetor-spawned subagents + agetor MCP server

| Field | Value |
| --- | --- |
| Date | 2026-09-23 |
| Status | **Parked — not started.** Written at the end of the Pipelines v1 run so the design survives the context; pick it up as its own task. |
| Source | Owner direction during the v1 run: "these subagents in the canvas aren't harness subagents, they must be spawned by Agetor depending on the request of the main agent for that step", "the subagents can also be from different harnesses to the main one", and "what if we add an MCP again?" |
| Depends on | Pipelines v1 (`docs/plans/pipelines.md`, branch `feature/agetor-pipelines`) merged |
| Branch | to be cut from `main` after v1 lands (suggested: `feature/pipeline-subagents-v2`) |

## 0. What v1 ships, and what v2 replaces

v1 (the current branch) treats a step's **subagents** as *guidance*: the step prompt lists the personas (agent profiles) the step may delegate to and the cap, but nothing is enforced and nothing is spawned by agetor. The canvas already renders one **satellite** node per persona under each step (`SubagentNode`/`SubagentEdge`, derived — see `docs/plans/pipelines.md` §10 "Subagent satellites"), and in the run view a satellite animates when a *harness-internal* helper (Claude Code's own `Agent` tool subagents, discovered from the session JSONL) is attributed to that persona by name. That attribution is a v1 stopgap with three known gaps: only Claude Code exposes its helpers, the persona/harness of the real helper is whatever the main agent's harness spawned (never a different harness), and the count/cap are not enforced.

v2 makes the satellites literal: **agetor itself launches each requested persona as its own run** — with that persona's frozen profile, on that profile's harness (which may differ from the main agent's), in the step's shared worktree — and feeds the result back to the main agent. Everything the v1 canvas already draws (satellites, working/done, details dialog, "Open transcript") is kept and re-pointed at these real helper tasks; the name-matching attribution and the `listSubagents`-polling in the run view are deleted once v2 lands.

## 1. Objective & success criteria

1. A step's agent can ask agetor to run one or more of the step's configured personas on a described sub-task. Agetor validates the request (persona is on the step's list; the step's `subagents.cap` is honoured — **enforced**, no longer guidance), launches one hidden **helper task** per request, and delivers each helper's result back to the main agent.
2. Helpers run on the persona's own harness (a Codex helper under a Claude Code main agent must work), with the persona's frozen profile snapshot from the pipeline run, in the pipeline's shared worktree, and end with the same `<handoff>` block a step does (reused parser).
3. The main agent is **not blocked** while helpers run: the request returns immediately; results arrive as a follow-up turn when the helpers finish (batched per request round). The main agent may keep working, poll, or end its turn and be resumed by the results.
4. The canvas satellites reflect real helper tasks: `idle` (available), `working` (helper running), `done`/`failed`; `×N` per persona when several ran; the details dialog lists each helper as a real task with "Open transcript" opening that helper's own RunPanel (not a subagent tab).
5. Requests reach agetor through an **agetor MCP server** (`delegate` / `helper_status` tools) for harnesses that can take a per-launch MCP registration without agetor editing user config, and through a `<delegate>` text block (mirroring `<handoff>`) as the universal fallback — the runner treats both identically.
6. Stop/Retry/Restart/delete/archive of the pipeline task cascade to helpers; a Stop on a helper alone fails only that helper (reported to the main agent), never the whole run. Boot reconciliation and `reconcilePipelineRuns` cover helpers.
7. CLI parity (`agetor pipeline status` shows helpers per execution; `agetor ls --steps` lists helper rows; `agetor show <helper>` prints `helper of: <step task>`), unit + runner + endpoint + e2e coverage, CLAUDE.md item 19 update, README note.

## 2. Context & constraints

- **No MCP server exists today.** `src/bun/hook-installer.ts` is strip-only: it removes the stale `mcpServers.agetor` registration and PreToolUse hook older builds wrote. It was made non-invasive because agetor was editing the user's `.claude/settings.local.json` and shipping an approval hook that deadlocked on upgrades. v2 must stay non-invasive: **per-launch registration only** (flags / session params), never a file agetor doesn't own.
- Per-launch MCP registration, known or to be spiked:
  - Claude Code: `--mcp-config <json|file>` (+ `--strict-mcp-config` to avoid merging the user's own servers if wanted). Known to exist; verify against the pinned CLI version.
  - Codex: `-c mcp_servers.agetor.url=…` style config overrides on `codex exec` (streamable-HTTP MCP servers supported since mid-2025). Spike.
  - fx: `session/new`/`session/load` already accept an `mcpServers` array the driver sends empty (`src/bun/fx-acp.ts`); pass the agetor server there. Spike whether fx accepts an HTTP server entry or needs a stdio command.
  - Cursor `cursor-agent -p`: no known per-launch flag; likely needs `<cwd>/.cursor/mcp.json` — that's a file in the (agetor-owned) worktree for isolated tasks, but a user file for `isolation:"none"`. Spike; fallback to the text block.
  - Gemini CLI: MCP servers come from `settings.json`; a `GEMINI_CLI_HOME` override could point at an agetor-owned settings dir for the run, but that also hides the user's own settings. Spike; fallback to the text block.
- The follow-up delivery path already exists and is harness-agnostic: `orchestrator.sendInput` (used by the v1 handoff reminder) folds a message into a live claude session or resumes a one-shot harness by its session/thread id. Results go through it.
- Hidden helper tasks can reuse the step-task machinery: `pipeline_parent_id` set (hidden from the board/CLI/TUI, cascaded on delete/archive, `stepsForParent` returns them), worktree copied from the parent, profile fields copied from the frozen snapshot. They need a way to be told apart from step rows (see §3.2).
- Prompt text delivered to any agent must never name the product (decision recorded 2026-09-23; `src/shared/pipeline.test.ts` pins the step prompt and reminder `/agetor/i`-free). The MCP server name the *harness* shows can be neutral too (e.g. `pipeline`).

## 3. Approach & key decisions

### 3.1 Request channel — MCP first, text block fallback

- `delegate({ requests: [{ persona, task, context? }] })` — validates and launches; returns `{ accepted: [{ helperId, persona }], rejected: [{ persona, reason }] }` **immediately**. Never blocks on the helper.
- `helper_status({ helperIds? })` — current status/summary of this step's helpers, for an agent that prefers to wait.
- `<delegate>{"requests":[…]}</delegate>` at the end of a turn (only for harnesses without MCP wiring, or as a belt-and-braces path): parsed on settle exactly like `<handoff>` (last block wins, optional ```json fence, brace-balanced fallback), same validation, same launch.
- Both channels produce the same `DelegationRound` (§3.3). The step prompt's `## Delegation` section documents whichever channel the launch wired (the MCP tool when registered, the block otherwise) — one contract per run, never both described at once.

### 3.2 Helper tasks (storage)

Migration `0NN_pipeline_helpers.sql` (number after whatever `main` is at): `tasks.helper_of_task_id TEXT` (the step task this helper serves), `tasks.helper_round INTEGER`, `tasks.helper_profile_id TEXT`. Helper rows also carry `pipeline_parent_id` (so every existing hide/cascade/lock path applies) but `pipeline_step_id = NULL`. All three new columns are server-managed: written once by `tasks.insert`, excluded from the generic `tasks.update` SET clause and from `ALLOWED_PATCH_FIELDS`. `isPipelineStepTask` gains a sibling `isPipelineHelperTask`; every runner path that iterates `stepsForParent` must filter on `pipelineStepId != null` for steps and `helperOfTaskId != null` for helpers (audit list in §4).

### 3.3 Runner state

`PipelineStepRecord.delegations: DelegationRound[]` where `DelegationRound = { seq, requestedAt, source: "mcp" | "block", helpers: [{ taskId, profileId, persona, task, status: "running" | "succeeded" | "failed" | "cancelled", summary?: string, handoff?: Handoff }], deliveredAt: number | null }`. Round-tripped by `db.ts`'s `sanitizeStepRecord` (like `reminder`).

- Launch: `launchHelper(parent, stepTask, round, request)` mirrors `launchStep` (insert via `tasks.insert`, copy worktree fields + the persona's snapshot fields, `startTask`), prompt = `composeHelperPrompt` (persona instructions/skills preamble via the existing profile injection, the delegated `task` + `context` fenced as untrusted with a nonce, the shared handoff contract; **no** `## Delegation` section — helpers cannot delegate in v2).
- Cap: `effective helpers this execution + new requests ≤ step.subagents.cap` (null = unlimited); rejected requests are returned in the tool result / reported in the results turn, never silently dropped.
- Settle: the runner's existing `run-status` listener recognises a helper settle (by `helperOfTaskId`), records status + parsed handoff on the round, and once every helper in the round has settled composes ONE results turn (`composeHelperResultsMessage`: per helper, persona, status, the handoff's summary/artifacts/openQuestions, each fenced `--- BEGIN untrusted helper result <nonce> … ---`) and `sendInput`s it to the step task. If that send is withheld/fails (claude modal guard etc.) the round stays `deliveredAt: null` and is retried on the next settle/poll, like the reminder's one-shot rule but without the one-shot cap.
- Step lifecycle: a step whose turn ended with a `<delegate>` block classifies as a new `StepResponseKind` `"delegate"` — the execution stays `active`, the step is not advanced, no handoff-reminder fires; the results turn resumes it. A step that ends its turn *while helpers are still running* (MCP path) likewise stays `active` until the round is delivered and the agent hands off afterwards. Handoff precedence: a turn carrying a valid `<handoff>` still wins (the agent explicitly finished), and any still-running helpers are cancelled with a status line.
- Whole-run Stop / delete / archive cascade to helpers (they are `pipeline_parent_id` children); a helper's own Stop marks that helper `cancelled` in its round and the round still delivers.
- `reconcilePipelineRuns` also sweeps helpers whose run is no longer live but whose round entry still says `running`.

### 3.4 MCP server

- Streamable-HTTP JSON-RPC on the existing `Bun.serve` API server: `POST /mcp/pipeline/:stepTaskId` gated by a per-step-task token minted at launch (not the app-wide API token — a helper prompt must never learn the app token). Methods: `initialize`, `tools/list`, `tools/call` (`delegate`, `helper_status`), `ping`. Per-launch registration passes the URL + token.
- The same server is the home for a future `ask_user` revival; out of scope here.

### 3.5 Canvas (already built in v1, re-pointed)

- `subagentSatellites(step, helpers, …)` takes the step's helper tasks (from the run view's `steps` payload, filtered by `helperOfTaskId`) instead of observed subagents; `matchSubagentToProfile` and the `listSubagents` polling are removed. `instances` become helper tasks; `visual` = running → `working`, all settled → `done` (or `failed` if any failed — new visual).
- `SubagentDetailsDialog`'s "Open transcript" → `onOpenTask(helperTask)`; the `focusSubagent` RunPanel prop and the `subagent-tab` test id stay (still useful for harness-internal helpers) but the pipeline path no longer needs them.
- A helper task's RunPanel gets a strip like the step strip: "Helper for step Build · persona Test Reviewer" with "Open pipeline".

## 4. Work breakdown

| # | Task | Notes |
| --- | --- | --- |
| T1 | Spike per-launch MCP registration for Claude Code / Codex / fx / Cursor / Gemini | 1–2 h each; record exact flags + versions in `docs/plans/` |
| T2 | Migration + `tasks` columns + `isPipelineHelperTask` + audit of every `stepsForParent` consumer | runner, server routes, CLI `ls --steps`, run view |
| T3 | `src/shared/pipeline.ts`: `parseDelegate`, `composeHelperPrompt`, `composeHelperResultsMessage`, `StepResponseKind` `"delegate"`, delegation types + limits | pure, unit-tested; `/agetor/i`-free pin extended |
| T4 | Runner: `launchHelper`, round bookkeeping, settle + delivery, cap enforcement, cascades, reconcile sweep | per-parent lock; tests in `pipeline-runner.test.ts` |
| T5 | MCP server + per-launch wiring in `agents.ts`/drivers per T1 | token minting, `tools/call` handlers → runner |
| T6 | Canvas re-point (§3.5), helper strip in RunPanel, `failed` visual | delete name-matching + polling |
| T7 | CLI: `pipeline status` helpers, `ls --steps`, `show` | |
| T8 | Fake driver: `__agetor_fake_claude_delegate__[<persona>:<task>]` emitting a `<delegate>` block (block path) + a fake MCP call seam (tool path) | e2e for both channels |
| T9 | Docs: CLAUDE.md item 19, README, this plan's landed notes | |

## 5. Test plan

- Unit: parser/composer/limits (`pipeline.test.ts`), satellites from helper tasks (`pipelines.test.ts`), MCP JSON-RPC handler (`mcp-server.test.ts`).
- Runner: happy path (1 helper, batch of 3, cross-harness via fake codex + fake claude), cap rejection, unknown persona, helper failure/cancel reported, whole-run Stop cascades, reconcile after crash, handoff-wins precedence, delivery retry after a withheld send.
- Endpoint: `/mcp/pipeline/:id` auth (wrong token 401, other step's token 403), tools/list shape.
- e2e: run view satellites go working → done off a real helper task; details dialog lists the helper; "Open transcript" opens the helper's own panel with the helper strip; cap rejection surfaces in the main transcript.

## 6. Open questions (decide at kickoff)

1. Result delivery: one batch per round (recommended) vs one message per helper.
2. Nested delegation (helpers delegating further): out of v2; revisit once cap accounting across depths is designed.
3. MCP server name as seen by the harness (`pipeline`? `orchestrator`?) — must not be the product name.
4. Whether `helper_status` should also let the main agent **cancel** a helper.
