# Spikes — claude Enter-to-confirm prompts (T4: codex and copilot `--add-dir`)

Plan: `docs/plans/claude-enter-to-confirm-prompts.md` (T4, owner decisions D17 and D18).
Date: 2026-11-17. Machine: macOS arm64, claude 2.1.326, codex-cli 0.166.0.

A multi-repository task passes one `--add-dir <checkout>` per repository to claude (`agents.ts` claude branch), codex and copilot. Claude 2.1.326 asks a trust question for each one. This spike asks whether codex or copilot has a prompt or a flag problem of its own.

## codex 0.166.0 — verified, no change needed

Method. The argv came from the real `buildCommand` (a `bun` script in the scratchpad, kind `codex`, mode `auto`, `extraDirectories` = two scratch git repositories). It was then run as agetor runs it: `codex exec --model … -c model_reasoning_effort=low --json --color never --skip-git-repo-check --sandbox workspace-write --add-dir A --add-dir B -` with the prompt on stdin, from a third scratch directory.

| Check | Result |
| --- | --- |
| First turn: both `--add-dir` flags accepted | Yes. Exit 0, `thread.started`, `turn.completed`. |
| Any trust or approval prompt | None. `codex exec` is non-interactive and printed no prompt on stdout or stderr. |
| Write under an extra directory in `auto` (`workspace-write`) | Yes. `hello.txt` was created under B. |
| Follow-up turn: `… --add-dir A --add-dir B resume <thread_id> -` (the flags are parent flags before `resume`, as `agents.ts:1140–1155` emits them) | Yes. Exit 0, same event shape, and `hello2.txt` was created under A. |
| Model | `gpt-5.2` is refused on a ChatGPT login (`The 'gpt-5.2' model is not supported when using Codex with a ChatGPT account`). That is the account's catalog, not a flag problem, and agetor's pre-flight resolves the model from the account. The run used the model the account supports. |

Verdict: nothing to fix. This agrees with the 2026-11-12 multi-repository smoke (`docs/architecture/multi-repo-tasks.md`).

## copilot — not re-verified in this change

`copilot` is not installed on this machine (`which copilot` finds nothing). The plan's route is the opt-in real-binary test, `AGETOR_COPILOT_REAL_BIN=… bun test src/bun/copilot-real-binary.test.ts`, which needs the binary installed into a scratch prefix (`npm install --prefix <scratch> @github/copilot`, never global) and then executed. Executing a downloaded binary needs the owner's go-ahead, and this run was unattended, so it was not installed or executed.

What is known without running it:

- The real-binary test passed on copilot 1.0.109 and recorded `--add-dir` as accepted (`docs/architecture/multi-repo-tasks.md`, copilot section).
- copilot has no startup trust dialog in that record, and agetor passes `--add-dir` for it with the same argv shape (`agents.ts` copilot branch).

Status: **unverified on the current copilot version.** No fix is planned for it. To close it, install into a scratch prefix and run the real-binary test above. This is listed in the PR body.

## Fix list

| Harness | Finding | Size | Task |
| --- | --- | --- | --- |
| codex | none | — | T14 closes with "no change" |
| copilot | not re-verified | — | T14 closes with "no change"; listed as unverified |

## Live held-state spike (claude 2.1.326, 2026-11-17)

A real `claude --add-dir <untrusted scratch repo>` on a private tmux socket (80x24). After the workspace-trust dialog was confirmed and the add-dir dialog was armed (>500 ms), the keys were sent by `python3` with `tmux send-keys`:

| Step | Pane after |
| --- | --- |
| `Down` (armed) | cursor on `Yes, add it`, footer `Enter to confirm · Esc to cancel` |
| `Right`, then `Enter` (an Enter that does not follow a counted Down) | **refused**: footer `Esc to exit · To add it, press ↓ to Yes, then Enter`, **cursor back on `No, exit`** |
| bare `Enter` (held, cursor on No) | **refused again**; claude did not exit |
| `Up`, `Down` | cursor on Yes, then back on No, footer still held |
| `Enter` after that counted arrow, cursor on `No, exit` | the dialog closed because **claude exited** ("To go on without it…") |

What this settled: a refusal puts the cursor back on "No, exit", so the live-cursor drive (`Down`, `Enter` from No) is the real recovery, and an Enter after a counted arrow on "No, exit" exits claude, which is the wrap hazard the drive guards against by never sending a key from a cursor it did not just read. The `Up`, `Down`, `Enter` branch of `planConfirmArrows` (a held dialog whose cursor is on Yes) is a safety net the live run did not need.


## Live smoke of the branch (TT9, claude 2.1.326, 2026-11-17)

A headless core of this branch (`AGETOR_DATA_DIR=$HOME/.agetor-dev AGETOR_API_PORT=4319`) driven with curl; two scratch git repositories that were not in `~/.claude.json`; a multi-repository claude task (haiku 5.5, Auto). Every smoke task, the scratch account and the scratch stack were deleted afterwards.

| Scenario | Result |
| --- | --- |
| First run, preference on (default) | `status: auto-confirmed Claude's "Adding a new directory" prompt for smoke-a`, then `… for smoke-b`, both within 6 s of the start; `claude session … ready`; the reply `ok`; the run `succeeded`; `claude_session_id` recorded only after the session file existed |
| Hibernate (tmux session killed) then a follow-up | `resuming claude session 60468492…`, the same two auto-confirm lines again (the resume consent window), reply `again` |
| Preference off, hibernate, follow-up | Both dialogs became cards (one pending `tmux_prompt` per repository, each with `identity`), each answered through `POST /tmux-prompts/:id/answer {"key":"2"}`; reply `third`. The second dialog was not suppressed after the first was answered |
| A logged-out Claude account (`home` = an empty directory) | `/harnesses` reports `loggedIn: false` with `authHelp` "run `claude auth login`, or open a terminal for this account from Settings → Harnesses"; starting a task on it is refused with `zz smoke logged-out isn't logged in — run \`claude auth login\`, …` |
| A stack [logged-out account, built-in account], task on the logged-out one | The start moved the task to the built-in account (`agent=claude-code`) and the turn ran |

Not exercised live: the OAuth `Paste code here if prompted >` and `Login successful…` screens (an OAuth round trip is needed; built from the binary's strings, plan A4), the held-state auto-retry inside a real boot (the held behaviour itself was proved by the spike above), and `agetor answer` against the smoke core (the CLI would have used the production core, memory "CLI smoke hits prod core"; its code path is unit-tested against the same route).
