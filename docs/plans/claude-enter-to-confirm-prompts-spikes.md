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
