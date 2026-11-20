# Spike S2 — can the ACP harnesses (cursor, fx) read a picked `~/Desktop` file?

| Field | Value |
| --- | --- |
| Date | 2026-11-18 (macOS arm64, Darwin 25.6.0) |
| Plan | `docs/plans/picked-image-preview-tcc.md` §5 (S2), grill D13 |
| Question | cursor and fx are spawned disclaimed with no tmux (`cursor-acp.ts`, `fx-acp.ts`). Can they read a file the user picked from a TCC-protected folder? |
| Verdict | **fx: reads it (via its shell tool), no denial, no prompt. cursor: could not be tested; its ACP session fails with `Invalid params` before any read, with or without the file, so the result is unrelated to TCC.** |

## Method

A headless core from this worktree at wave 1 (`src/bun/headless.ts`), `AGETOR_DATA_DIR=$HOME/.agetor-dev`, `AGETOR_API_PORT=4319`, `AGETOR_DISCLAIM_BIN=/Applications/Agetor.app/Contents/Resources/app/bin/disclaim` (disclaim active; the helper exists, and no `disclaimSpawnedAgents` row turns it off), driven over HTTP only (never the `agetor` CLI, which would reach the prod core). Each task was `isolation: "none"` in an empty scratch directory with the reference `~/Desktop/Screenshot 2026-11-18 at 2.40.41 PM.png` (U+202F before `PM`) and the prompt "Read the referenced image and reply with its pixel dimensions, or the exact error if you cannot read it". Answers were read from `run_events` in `~/.agetor-dev/agetor.sqlite` (read-only). The tasks were deleted and the core stopped with `POST /daemon/shutdown`.

## fx — `deepseek/deepseek-v4-flash`, `yolo` (Full access)

- The first `ls`/`sips` and `read_file` calls used the path as the model retyped it (a plain space before `PM`), so they failed with `No such file or directory` / `Path not found`. That is the model not reproducing U+202F, not a TCC denial.
- The agent then listed the Desktop (`ls -1 ~/Desktop | grep -i 'Screenshot 2026-11-18'`: it saw both screenshots), found the real name, and ran `sips -g pixelWidth -g pixelHeight` on it: `pixelWidth: 333`, `pixelHeight: 174`. Final answer: "333 × 174 pixels". Run status `succeeded`.
- Verdict: **reads**. A disclaimed fx child can list `~/Desktop` and read a screenshot through its shell tool, and no prompt was raised. Its `read_file` tool was not conclusively tested (the model could not type the U+202F path), so that one tool is unverified, not shown broken.

## cursor — `grok-4.7`, `gpt-5.2`, `auto`; `auto` mode

- Every start, with the reference (`grok-4.7`, `gpt-5.2`) and without it (a control task, prompt "Reply with the single word: pong", model `auto`), ended the same way within seconds: events `status: Invalid params`, `stderr: Invalid params`, `exit:1`; run `failed`. `cursor-agent` is `2026.10.22-27dcf5f`, logged in.
- The control task proves the failure does not depend on the picked file or on TCC: the ACP handshake or `session/new` is rejected before any file is touched.
- Verdict: **not testable here; cursor ACP is broken in this environment.** Per D13 the fix is owner-deferred. Ticket draft: *"cursor harness: every task fails with `Invalid params` on cursor-agent 2026.10.22"* — evidence: three failed runs (two with the reference, one control), events 938–940, 943–945 and 980–982 in `~/.agetor-dev/agetor.sqlite` at the time of the spike; reproduce with a headless core and `POST /tasks {agent: "cursor", model: "auto", isolation: "none"}` + `/start`. Likely cause is an ACP params mismatch between `cursor-acp.ts` and the new `cursor-agent`; not investigated further.

## Cleanup

All four smoke tasks deleted (two earlier ones had an empty reference list because the request carried strings instead of `{path, isDirectory}`, and were deleted unrun/failed); the core stopped; no `s2-%` task remains.
