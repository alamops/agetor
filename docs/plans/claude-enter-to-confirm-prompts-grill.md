# Grill — Claude Code "Enter to confirm" prompts

| Field | Value |
| --- | --- |
| Date | 2026-11-17 |
| Source | The pipeline prompt (the owner's pasted run log) and the investigation brief `docs/plans/claude-enter-to-confirm-prompts-investigation.md` |
| Mode | Interactive, through the decision form. The owner answered in 2 rounds; every required question was answered |
| Answers | `docs/plans/claude-enter-to-confirm-prompts-grill/round-1/answers.json`, `docs/plans/claude-enter-to-confirm-prompts-grill/round-2/answers.json` |
| Flags | none |
| Spec | No spec outside this repo. The contract is the pipeline prompt, quoted in the brief §0, plus this record |

No one-way door is left for a human: the owner answered all three in their own words (`adddir-policy`, `autotrust-cli`, `paste-code-caller`). Two of them **relax a guard** I had recommended keeping. The owner chose that with the risk written next to the question, so the plan and the PR body must say it out loud (see D14 and D15).

## Decisions

| # | Topic | Question | Answer | Source |
| --- | --- | --- | --- | --- |
| D1 | Trust | Startup "Adding a new directory" dialog for the task's own repositories | **Auto-confirm, behind a setting that defaults on.** Only the startup variant (`No, exit` / `Yes, add it`). Only when the path on screen, rejoined across wrapped lines, equals one of the `--add-dir` paths agetor passed for this spawn. Anchored on the exact `Yes, add it` label. Mid-session `/add-dir` and any path agetor didn't pass still get a card | owner (round-1/answers.json#adddir-policy; overrode `auto-scoped` with `auto-setting`) |
| D2 | Settings | Owner note on D1: "use this change to also update settings General UI, it's getting polluted" | **Move harness-specific rows to the Harnesses page, under a per-kind "Behaviour" block:** Claude Code's tmux source and the new auto-trust toggle; fx's auto-resume and its delay; the Claude Code/OpenCode session-import scan. **Group what stays in General under headings:** Appearance (theme, font size, sticky messages), Tasks (default harness), Privacy & security (macOS permissions), Background, Getting started. The owner provided no mock | owner (round-2/answers.json#general-cleanup, accepted recommendation; #general-mock left blank, optional) |
| D3 | Settings | Scope of the auto-trust setting | **One preference per kind:** `claude_auto_trust_repositories`, default on, applying to every Claude Code account. If the codex or copilot spike finds an equivalent prompt, the same setting covers it and its label becomes "Auto-trust a task's repositories". Turning it off brings back a card for each dialog | owner (round-2/answers.json#setting-scope, accepted) |
| D4 | Scope | Which Login cases the owner hit | Mid-session `/login`, and a task started while the default account was logged out or expired. **Owner note: "but should cover all cases"**, which adds a never-logged-in harness-stack account and a swap that lands on a logged-out account | owner (round-1/answers.json#login-case) |
| D5 | Login | Logged-out boot | **A pre-flight AND cards.** Start is refused when `claude auth status` reports logged out, and each onboarding screen (theme picker, login method, Enter-to-continue, paste-code) still gets a working card as a fallback | owner (round-1/answers.json#logged-out-boot, accepted) |
| D6 | Login | Pre-flight details | A spike first proves `claude auth status` writes nothing, needs no network and gives a parseable logged-out signal. The probe runs with the harness env (`CLAUDE_CONFIG_DIR`), capped at 5 s, and fails open: only an explicit "logged out" refuses. The header status dot shows "logged out" for Claude Code, as it does for fx. **If the spike fails, the pre-flight is dropped, the cards alone cover login, and that is reported to the owner** | owner (round-2/answers.json#preflight-details, confirmed) |
| D7 | Login | Logged-out harness-stack account | **Skip it like an exhausted account**, at start and at swap, with the status line "skipped <account>: not logged in". If every account is logged out, start is refused with the login hint. If the probe can't tell, the account is used (fail-open) and the cards cover it | owner (round-2/answers.json#stack-logged-out, accepted) |
| D8 | Cards | Enter-only screens ("Login successful. Press Enter to continue…", "Security notes … Press Enter to continue…", "Press Enter to retry.") | **A "Continue (press Enter)" button**, offered only when the screen is Enter-only: the press-Enter line is among the last non-blank lines, and the dialog shows **no** choice rows and no `❯` cursor. Never pressed automatically. Parity in `agetor answer` and the TUI | owner (round-1/answers.json#enter-card, accepted) |
| D9 | Cards | OAuth "Paste code here if prompted >" screen | **A text box on the card** that types the code into the pane | owner (round-1/answers.json#paste-code; overrode `terminal`) |
| D10 | Cards | Handling of the typed code | One line, at most 512 characters, no control characters. Sent with `tmux send-keys -l`, then Enter. **Never written** to run_events, a status line, a log or an error message, and a boot-timeout pane dump masks the paste-code line. The text box appears only on that screen; no other card takes free text | owner (round-2/answers.json#paste-code-handling, confirmed) |
| D11 | Boot | Retry after a boot that never wrote its session file | **Both mechanisms.** (a) The session id is recorded on the run only once Claude's session file appears; a failed boot leaves no id, so the next turn starts fresh. (b) Every resume first checks that the recorded session file exists; if it doesn't, it starts fresh under the same id (`--session-id`), which also heals rows already in the DB. Harness-stack swap and transfer read the id only after it is recorded, and a test pins that order | owner (round-1/answers.json#retry-semantics, overrode `check-then-fresh` with `both`; meaning confirmed in round-2/answers.json#retry-both) |
| D12 | Scope | Which members of the Enter-to-confirm family are in this change | **All of them:** the startup add-dir dialog; the held footer (startup and mid-session); cut-off dialogs (the `Adding: <path>` trailer); mid-session `/add-dir` and `/cd` dialogs as safely driven cards; Enter-only screens; the theme picker and login method at boot; and a footer match widened to every `Enter to <verb>` hint in claude's binary, each backed by a captured or binary-extracted fixture | owner (round-1/answers.json#families, accepted) |
| D13 | Boot | A refused confirm (held state) | **Retry the auto-confirmed dialogs:** read the cursor from the live pane, wait ≥500 ms, press Down only if the cursor isn't on Yes, then Enter, at most 4 attempts. **Re-card the user-answered ones** with the held hint. Never press Down from an unknown cursor | owner (round-1/answers.json#held-recovery, accepted) |
| D14 | Trust | Who may turn auto-trust back on | **The desktop app and the CLI alike.** I recommended app-on, CLI-off-only. The owner chose full parity knowing that an agent can read the CLI token. No value-level refusal is added for this preference. The plan must state this in `security.md` and in the PR body | owner (round-2/answers.json#autotrust-cli; overrode `app-on-cli-off`) |
| D15 | Trust | Who may submit the OAuth code text answer | **The app, `agetor answer` (a text option) and the TUI.** I recommended desktop app only. The owner chose full parity knowing an agent with the CLI token could submit a code for an account it controls. The answer route stays `app+cli`. The plan must state this in `security.md` and in the PR body, and the closed allow-list on the body must still allow free text only on a paste-code card (D10) | owner (round-2/answers.json#paste-code-caller; overrode `app-only`) |
| D16 | Pipelines | Card surfacing on a pipeline step | The owner saw the card where expected. **No change** | owner (round-1/answers.json#pipeline-surface; overrode `missed`) |
| D17 | Scope | Codex and copilot (they get `--add-dir` too) | **Spike them in this change, and fix anything that breaks a multi-repo task's extra directories on those two harnesses** (a refused `--add-dir`, a trust error, a missing flag), not only prompts. Anything large found goes back to the owner before it is planned | owner (round-1/answers.json#other-harnesses, overrode `out`; bound in round-2/answers.json#spike-fix-bound, accepted) |
| D18 | Scope | How to spike copilot (not installed here; codex-cli 0.166.0 is) | **The opt-in real-binary test path** (`copilot-real-binary.test.ts`, fake provider, no login). The binary must be installed for it | owner (round-2/answers.json#copilot-install, accepted) |
| D19 | Evidence | Capture "Login successful…" live? | **No.** Build it from the binary strings and a reconstructed pane. Assumption A4 stays open and goes in the PR body | owner (round-1/answers.json#login-capture; overrode `live`) |
| D20 | Acceptance | What must pass | Unit fixtures for every captured pane, tagged with claude 2.1.326, in `claude-tmux-scraper.test.ts`. A boot-poller integration test on the stub-tmux seam (two identical dialogs, a held refusal, the long-prompt paste, the add-dir auto-confirm). A test that a missing session file means a fresh start. A Playwright e2e for the Continue card through a new fake-driver prompt marker. A live smoke on a headless dev core (port 4319, `~/.agetor-dev`): a multi-repo task over 2 untrusted scratch repos, plus a follow-up after hibernation | owner (round-1/answers.json#acceptance, accepted) |
| D21 | Boot | Status line for an auto-confirm | One status line per repository, e.g. `auto-confirmed Claude's "Adding a new directory" prompt for <repo-name>` | owner (round-1/answers.json#status-line, confirmed) |
| D22 | Boot | Keystroke timing for every dialog agetor drives | Wait ≥500 ms after the dialog first appears. Re-read the cursor from the live pane right before sending. Leave ≥150 ms between Down and Enter. Before reporting success, confirm the dialog is gone, not held | owner (round-1/answers.json#timing, confirmed) |
| D23 | Cards | Card clicks | `dismissTmuxPrompt` re-reads the pane and drives from the live cursor. If the pane no longer shows the same dialog, it refuses with a clear error | owner (round-1/answers.json#card-reread, confirmed) |
| D24 | Boot | Boot-poller stability | Expire `recentlyAnsweredFingerprints` at boot after 3 s, as the runtime scraper does. A suppressed sighting still keeps the boot window open. An unparsable card needs 3 stable ticks at boot, as at runtime | owner (round-1/answers.json#boot-ticks, confirmed) |
| D25 | Boot | The long-prompt paste while a dialog is up | The deferred paste keeps waiting while the boot poller sees any startup dialog. It fails only when the boot itself times out, with the pane in the error | owner (round-1/answers.json#paste-defer, confirmed) |
| D26 | Boot | Cut-off dialogs | Match the cut-off shape. Don't resize the boot pane | owner (round-1/answers.json#pane-size, confirmed) |
| D27 | Docs | Docs updated in the same change | `docs/architecture/harness-claude-code.md`, `docs/architecture/multi-repo-tasks.md`, and the `STARTUP_CONSENT_DIALOGS` / `MODAL_FOOTER_RE` comments. D14 and D15 also make `docs/architecture/security.md` part of this change | owner (round-1/answers.json#docs, confirmed); security.md follows from D14 and D15 |
| D28 | Hygiene | Client names | Real client repository names and paths in the brief were replaced with synthetic ones (`repo-e`, `/Users/me/Projects/acme/…`). They stay out of fixtures, the plan and the PR | owner (round-1/answers.json#scrub-brief, confirmed); done in this step |

## Completeness dispositions

| Item | Disposition | Owner or reason |
| --- | --- | --- |
| Bug 1: the add-dir dialog isn't auto-confirmed | In this change | D1 |
| Bug 2: the boot poller suppresses an identical follow-up dialog | In this change | D24 (a plain bug; no decision needed) |
| Bug 3: the deferred paste fails the run into the dialog | In this change | D25 |
| Bug 4: retries `--resume` a session that was never created | In this change | D11 |
| Held footer, cut-off trailer, wrap hazard | In this change | D12, D13, D22, D23 |
| Mid-session `/add-dir` and `/cd` family | In this change (cards, driven safely) | D12 |
| Enter-only card action, with app, CLI and TUI parity | In this change | D8 |
| Theme picker, login method, paste-code text box | In this change | D5, D9, D10 |
| Claude Code login pre-flight, header dot, harness-stack skip | In this change; the pre-flight depends on its spike (D6) | D5, D6, D7 |
| Footer widened to every `Enter to <verb>` hint | In this change | D12 |
| Settings → General reorganisation and the auto-trust toggle | In this change | D2, D3 |
| Codex and copilot `--add-dir` spike, and fixes for what it finds | In this change; large finds go back to the owner | D17, D18 |
| Cursor, fx, OpenCode, Gemini, Antigravity add-dir prompts | Out of scope: they get no `--add-dir` and rely on the cwd (`multi-repo-tasks.md:234`) | evidence |
| Pipeline-parent notification for cards | Out of scope: the owner says today's surfacing is right | D16 |
| Resizing the boot pane | Out of scope by owner choice | D26 |
| Persisting add-dir trust in `~/.claude.json` | Out of scope: rejected option (writes another program's config and widens the grant) | owner, round 1 (`pretrust` not chosen) |
| Backfilling run rows with a never-created session id | No migration: the resume-time check heals them | D11 |
| Docs: harness-claude-code.md, multi-repo-tasks.md, security.md, code comments | In this change | D27 |
| Tests at every layer listed in D20 | In this change | D20 |

## Assumptions still open

- **A1** (brief §3): two or more repositories were untrusted at the time of the incident. If that's wrong, the held state (P7) is the main trigger. The fix covers both cases either way.
- **A3**: the theme picker and the press-Enter screens appear at boot only for a logged-out or never-onboarded config. If an expired login also shows them, D5's cards cover it.
- **A4** (D19): the "Login successful…" pane matches the binary strings. If it's wrong, the Enter-only matcher misses it and the unparsable card (Open in Terminal) is still the fallback. The PR body states this.
- **A6**: under load, the ≥150 ms gap (D22) is enough for claude to count the Down. If it isn't, D13's retry covers auto-confirms and the held re-card covers card clicks.
- **The `claude auth status` spike (D6)** may come back negative. Then the pre-flight and the D7 stack skip both drop to cards-only, and the owner is told. D7's skip then has no signal, so a logged-out stack account gets used and carded.
- **The codex/copilot spike (D17)** may find work larger than this change can absorb. That goes back to the owner before planning; it is not deferred silently.
- **D14 and D15** relax guards I recommended keeping. They were decided by the owner with the risk shown, not by me. Reviewers should see them called out in the PR body.
