# Grill — Issue #298: Chrome browser prompt + bundled-tmux terminal

| Field | Value |
| --- | --- |
| Date | 2026-11-12 |
| Source | Issue #298 (`https://github.com/alamops/agetor/issues/298`) + `docs/plans/issue-298-chrome-prompt-investigation.md` |
| Mode | Interactive via decision form, answered by the owner in 2 rounds (13 + 4 questions; no skips, no blanks) |
| Answers | `docs/plans/issue-298-chrome-prompt-grill/round-1/answers.json`, `docs/plans/issue-298-chrome-prompt-grill/round-2/answers.json` |
| Flags | none |
| Spec | Outside the repo: issue #298. The in-repo evidence/acceptance brief is `docs/plans/issue-298-chrome-prompt-investigation.md`. |

**Commit note:** the record and both round folders are left uncommitted in the worktree so they can ride the single local `Fixes #298` commit chosen in decision 11; the implementation step owns that commit.

No one-way door is awaiting a human: the only one (the Chrome auto-answer policy) was answered **card-only**.

## Settled facts (from the investigation; not re-asked)

- The current `pickScrapeMatch` chain returns `unparsable: true` with zero choices on the reporter's unnumbered Chrome prompt (`src/bun/claude-tmux.ts:5783`, investigation §2).
- `parseUnnumberedConsentChoices` parses the prompt as two rows with the cursor on `No`; it is private and reachable only from `matchStartupConsentDialog` (`src/bun/claude-tmux.ts:6037-6041`).
- The card hides the footer: `cleanPromptPane` strips any line beginning `enter to confirm` (`src/mainview/lib/prompt-noise.ts:24`).
- The bundled tmux's `libncursesw` has the build machine's Cellar terminfo path and the bundle ships no terminfo; the exact `can't find terminfo database` error reproduces under a pty, and a terminfo override fixes the attach (investigation §2).
- Answering the prompt already resumes the task: the answer route validates the key and sends arrows + Enter, the `__external__` sweep clears the card, and the boot wait re-arms while a prompt is pending (`src/bun/server.ts:8000`, `src/bun/claude-tmux.ts:9045`, `:9091`).
- The Chrome prompt is a persistent Claude setting: Yes connects the logged-in browser; No/Esc turns browser tools off and stops offering setup. The existing test deliberately does not auto-confirm it (`src/bun/claude-tmux-scraper.test.ts:430`).
- No schema, migration, or backfill: the prompt is ephemeral and the terminal fix is runtime-only.
- No e2e can reach this: the fake Claude driver bypasses tmux, so pane matchers and Terminal.app attach are unit/manual surfaces only.

## Decisions

| # | Topic | Question | Answer | Source |
| --- | --- | --- | --- | --- |
| 1 | Scope | Which halves of #298? | **Both** (prompt parser + terminal fallback) in this change, as **one local commit** whose message carries `Fixes #298`. | owner (round-1/answers.json#scope; accepted recommendation) |
| 2 | Matcher breadth | Generic vs marker-gated unnumbered matcher? | **Generic `matchUnnumberedModal` with strict guards**, inserted after the slider and before the unparsable fallback: an `Enter to confirm` footer among the last 3 non-blank lines, exactly one cursor row, 2+ contiguous choice rows, reject checkbox/value-selector rows, gate on `!paneWorking` and `!paneIdle`. It reuses `parseUnnumberedConsentChoices` and only **presents** choices; it never auto-answers. Both chain call sites (`scrapeOnce`, boot poller) and `paneShowsBlockingPrompt` must pass the new idle signal. The old numbered Chrome fixture stays as coverage for older CLIs. | owner (round-1/answers.json#matcher-breadth; accepted recommendation) |
| 3 | Chrome policy (one-way door) | May Agetor ever answer the Chrome prompt for the user? | **Never auto-answer; no Settings preference.** The card always presents Yes/No; both answers change a persistent Claude setting (Yes connects the logged-in browser; No/Esc turns browser tools off permanently), so only the user can choose. | owner (round-1/answers.json#chrome-policy; one-way door answered; accepted recommendation) |
| 4 | Terminfo source | System DB vs vendored DB? | **Vendored terminfo DB** — the owner overrode the recommended system DB. The concrete content/storage/license decisions below make it buildable. | owner (round-1/answers.json#terminfo-source; overrode `system-db`) |
| 4a | Terminfo content | Which entries, from where? | **Five entries from the macOS system DB**: `xterm-256color`, `xterm`, `screen`, `screen-256color`, `tmux-256color` (~12 KB total). The runtime search path puts the vendored dir first and `/usr/share/terminfo` second, so a custom `TERM` still resolves when the OS DB exists. | owner (round-2/answers.json#terminfo-db-content; accepted recommendation) |
| 4b | Terminfo storage | Committed or generated? | **Generated, gitignored**: `bun run vendor:tmux` copies the five entries into `vendor/tmux/arm64/terminfo`; `electrobun.config.ts:53` already maps that tree to `Contents/Resources/app/bin/`. The vendor script's cache check must also verify the terminfo dir. A missing dir (dev checkout) falls back to `/usr/share/terminfo`. | owner (round-2/answers.json#terminfo-db-storage; accepted recommendation) |
| 4c | Terminfo license | License/provenance? | Include the ncurses/terminfo license text and a one-line provenance note (source path + date) next to the vendored DB. | owner (round-2/answers.json#terminfo-license; accepted recommendation) |
| 5 | Terminfo scope | Which surfaces get the override? | **The Terminal.app attach + every bundled-tmux spawn** (a tmux-specific env helper applied only when the source is bundled). The in-app terminal shell and the `agetor attach` CLI are not changed in this change. | owner (round-1/answers.json#terminfo-scope; accepted recommendation) |
| 6 | Failure feedback | How much terminal failure feedback? | **Await osascript with a 5 s ceiling and return a 502** with the Automation-permission hint, and **keep the Terminal window open on an in-shell failure** by dropping `exec` and appending a shell fallback that prints the error and waits for Enter. | owner (round-1/answers.json#failure-feedback; accepted recommendation) |
| 7 | Card presentation | How should the unnumbered card render choices? | **Hide the synthetic keys only for unnumbered menus** via a new `hideKeys` flag threaded `ScrapeMatch` → `TmuxPromptRequest` → `api.ts` → `TmuxPromptCard`; numbered prompts keep their real `1.`/`2.` labels. No Chrome permanence note, no terminal link on choice cards. | owner (round-2/answers.json#card-presentation-r2; resolved the round-1 multi that selected both `keep-keys` and `hide-keys`) |
| 8 | Dismiss | Add a Dismiss (Esc) action? | **No dismiss.** Rely on the strict matcher and answer a wrong card in the terminal via Task Details; for the Chrome prompt Esc means `No, keep browser tools off` (permanent), so a Dismiss would be a trap. | owner (round-1/answers.json#dismiss; accepted recommendation) |
| 9 | Acceptance | What counts as done? | **Unit tests + typecheck + a manual Terminal.app attach smoke** (documented if the environment can't run it). Prompt coverage is fixture-based (the unnumbered Chrome shape + transcript/idle/wizard/slider negatives); **no e2e** — the fake driver bypasses tmux. Add tests for the attach command and the terminfo helper. | owner (round-1/answers.json#acceptance; accepted recommendation) |
| 10 | Docs | Update the behavior docs? | Update `docs/architecture/harness-claude-code.md` (matcher chain + attach env), the `docs/plans/unknown-claude-prompts-fallback.md` addendum, and the QA row `docs/qa/master-token-agent-read-qa.md:53-54`. | owner (round-1/answers.json#docs; accepted recommendation) |
| 11 | Commit | Local commit shape? | **One local commit, not pushed**, message `fix: answer the unnumbered Claude Chrome prompt and repair bundled-tmux attach (Fixes #298)`. | owner (round-1/answers.json#commit; accepted recommendation) |
| 12 | Fallback | Keep the unparsable card? | **Yes** — genuinely unknown prompts still get the `unparsable` card with its Open in Terminal action. | owner (round-1/answers.json#unparsable-stays; accepted recommendation) |
| 13 | Cross-agent | Coordinate Chrome across agents? | **No** — this change only makes the Claude startup prompt answerable; it does not arbitrate Chrome between Codex, Claude Desktop, and Agetor. | owner (round-1/answers.json#cross-agent; accepted recommendation) |

## Completeness dispositions

| Item | Disposition | Owner or reason |
| --- | --- | --- |
| Unnumbered Chrome prompt: matcher, choices, card, answer route reuse | In this change | #2, #7 |
| `hideKeys` plumbing through `ScrapeMatch` → `TmuxPromptRequest` → `api.ts` → card | In this change | #7 |
| Vendored terminfo DB: five entries, copy step, vendor-script cache check, license/provenance, runtime helper, attach env | In this change | #4, #4a-4c, #5 |
| Await/502 + keep the Terminal window open on in-shell failure | In this change | #6 |
| Unit tests for matcher/parser/`hideKeys`, attach-command builder, terminfo helper; manual Terminal smoke | In this change | #9 |
| Docs: harness doc, fallback addendum, QA row | In this change | #10 |
| `agetor attach` CLI resolving `GET /tmux-source`'s `resolvedBin` and setting the terminfo env | Out of scope | Owner chose `attach-bundled` (#5); the CLI uses bare `tmux`/`AGETOR_TMUX_BIN` and needs its own route call and error path — a different ticket |
| In-app terminal shell env (`terminals.ts`) | Out of scope | Owner chose `attach-bundled` (#5); not the reported path, and it changes the user's shell environment — a different ticket |
| Cross-agent Chrome arbitration | Out of scope | #13; a different feature with a different owner |
| Agetor Settings preference for the Chrome prompt | Out of scope | Rejected in #3 |
| Dismiss/Esc action on choice cards | Out of scope | Rejected in #8 |
| Full system DB or ncurses-release terminfo DB | Out of scope | #4a chose the minimal five-entry set |
| Live-driving the Chrome prompt with a fresh onboarding state | Out of scope (environment) | #9 chose fixture verification + a manual Terminal smoke; this machine already has `claudeInChromeDefaultEnabled: true` |
| Old numbered `CHROME_EXTENSION_PANE` fixture | Kept | Coverage for older Claude CLIs; not orphaned |
| `matchUnparsableModal` / unparsable card | Kept | Final fallback for genuinely unknown prompts (#12); not orphaned |
| Schema, migrations, backfill | None | The prompt is ephemeral; the terminal fix is runtime-only |

## Assumptions still open

| Assumption | If wrong |
| --- | --- |
| The reporter's hidden footer is `Enter to confirm` (the boot footer arm fired, the card strips exactly that line, and the installed 2.1.322 binary strings match). | The generic matcher won't fire on their exact CLI. The plan should keep the reconstructed fixture as the pin and can add a Chrome marker or a different footer anchor; a raw `tmux capture-pane` from the reporter would close this. |
| The `er` select responds to `Down` + `Enter` for the Chrome dialog (same component family as the 2.1.284 trust dialog; not live-driven here). | Card clicks won't advance the prompt. The manual smoke on a fresh Chrome-onboarding state (or a follow-up with the reporter) would catch it; there is no click fallback. |
| `/usr/share/terminfo` exists on the build host and has the five entries. | `bun run vendor:tmux` must fail loudly rather than ship an empty DB; the plan should check the copy and the license file. |
| The five entries cover Terminal.app's default profile and tmux clients; a custom `TERM` falls back to the OS DB. | A custom `TERM` without an OS entry still hits the original error; the runtime search path must include `/usr/share/terminfo` as the second entry. |
| The 5 s osascript ceiling is enough for Terminal.app; a timeout returns ok (same as the harness route). | A slow launch is reported as success; the stay-open fallback covers the in-shell side, not the launch side. |
| Dropping `exec` and adding the in-shell fallback does not change a successful attach. | An extra shell process per attach; if the wait-for-Enter step misbehaves in Terminal's `do script` shell, the failure window may close. The attach-builder unit test must pin the exact command. |
| `hideKeys` is added to the hand-mirrored `PendingTmuxPrompt` in `src/mainview/lib/api.ts`. | The webview type drifts; the unnumbered card keeps `1.`/`2.` or the build fails typecheck. |
| The `pickScrapeMatch` signature change (`paneIdle`) is propagated to `scrapeOnce`, the boot poller, and `paneShowsBlockingPrompt`. | The idle guard is silently skipped at one call site; the matcher false-positives on a transcript quote. |
| The vendor script's cache check includes the terminfo dir. | A previously vendored tree skips the new copy and the packaged app ships no DB; the plan must add the check. |
| The generic matcher's false-positive class is acceptable with no dismiss. | A false card needs a choice click or the terminal; the guards and 2-tick gate are the mitigation. A marker-gated matcher is the fallback if the negative tests show otherwise. |
