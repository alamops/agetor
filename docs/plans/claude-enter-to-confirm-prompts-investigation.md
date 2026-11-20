# Investigation — Claude Code "Enter to confirm" prompts (startup add-dir trust, Login, Press-Enter screens)

| Field | Value |
| --- | --- |
| Date | 2026-11-17 |
| Change | Make agetor's claude-code tmux driver handle every Claude Code prompt that waits on Enter (the new 2.1.326 "Adding a new directory" startup dialog that multi-repository tasks hit, the Login flow's "Press Enter to continue" screens, and the rest of the Enter-to-confirm family), so a run never dies at the 30 s boot timeout or strands the user on a card that can't act. This brief informs the grill (owner decisions) and the plan. |
| Agents | none (the pipeline step said not to delegate). Research was done inline: codebase, git history, the prod DB (read-only), the installed claude binaries and 9 live tmux spikes against claude 2.1.326 |
| Flags | none |

## 0. Executive summary

The failure the owner pasted (task `4c34cf8f…`, pipeline step `ef488ef1…`, three runs on 2026-11-17 09:18–09:23) is a chain of **four independent defects**. Fixing only the first leaves the others to recur:

1. **New dialog, not auto-confirmed.** Claude 2.1.326 (installed 2026-11-16 17:20; absent from 2.1.321–2.1.325) shows an `Adding a new directory:` trust dialog at startup for every `--add-dir` whose source repository is not already trusted in `~/.claude.json`. agetor passes one `--add-dir` per repository of a multi-repository task (`src/bun/agents.ts:742`, `src/bun/orchestrator.ts:1739`). `STARTUP_CONSENT_DIALOGS` (`src/bun/claude-tmux.ts:6148`) doesn't recognise the dialog, so it is carded to the user. The answer **is not persisted** by claude ("Your answer holds for this session"), and it is **re-asked on every fresh launch and every `--resume`** (proved live). So without an auto-confirm, every follow-up turn after hibernation of a multi-repo task re-asks once per untrusted repository.
2. **Boot poller never re-cards an identical follow-up dialog.** The fingerprint of an unnumbered menu is choices + cursor only (`claude-tmux.ts:6306`). Two add-dir dialogs for two different repositories therefore get the **same** fingerprint (proved: both `8769bebdef…`). After the user answers the first card, the answer route stamps `recentlyAnsweredFingerprints`. The boot poller checks that map with `.has()` (`claude-tmux.ts:9285`) but never prunes it; only `scrapeOnce` GCs it (`claude-tmux.ts:7752`), and `scrapeOnce` starts only after the JSONL exists. So the second dialog is suppressed for the whole boot: no card, no "asking a question" status, and the boot window is not kept open. This reproduces the logged timeline exactly (§1.1).
3. **Deferred paste gives up into the dialog.** On the large-prompt path, the readiness window expires with no pending card. The flow then emits "claude readiness never confirmed — delivering prompt anyway", the modal guard withholds the paste, and `onPasteFailure` fails the run (`claude-tmux.ts:9046`, `:9088–9101`) while the dialog is still on the pane. The boot wait then kills the session 30 s later.
4. **Retries resume a session that was never created.** `spawnAgent` stamps the pre-generated claude session id on the run at spawn time (`src/bun/agents.ts:4249–4254`), before any JSONL exists. Every later follow-up resumes it (`orchestrator.ts:12192` → `--resume <id>`). Claude 2.1.326 prints `No conversation found with session ID: <id>` and exits 1 (proved). In tmux the pane closes with it, so the run reports "claude exited before writing its JSONL … (empty — claude has not drawn any TUI output yet)". That is run 3 exactly. Once a boot fails, every "try again" is doomed.

The "Login" half is a different gap. Claude's login flow ends on `Login successful. Press Enter to continue…` (and onboarding adds `Security notes: … Press Enter to continue…`). Those screens have no choice rows, so agetor can only show the unparsable "Claude is asking something Agetor can't read" card, whose only action is **Open in Terminal** (`src/mainview/components/kanban/RunPanel.tsx:9700`). The user can't press Enter from agetor. A logged-out account's first screen (the theme picker) has no footer at all, so at boot nothing cards it and the run dies at 30 s.

Two load-bearing TUI facts the plan must respect, both decoded from the 2.1.326 binary and proved live:

- **Typeahead guard on the add-dir dialog.** Keys sent within ~500 ms of the dialog mounting are refused. On a refusal the footer **changes** to `Esc to exit · To add it, press ↓ to Yes, then Enter`, which none of agetor's matchers recognise. The dialog then becomes invisible to the card path, the consent tracker and the paste guard. "Yes" is accepted only when the Enter directly follows a Down that the guard counted.
- **The two-row select wraps.** Down from "Yes, add it" lands on "No, exit". An accepted Enter there makes claude **exit** ("To go on without it, start again … without --add-dir …"). Driving from a stale cursor index kills the session.

## 1. What we know

### 1.1 The incident, reconstructed from the prod DB (read-only)

Command: `sqlite3 -readonly ~/.agetor/agetor.sqlite "select … from run_events where run_id=…"`. Task `ef488ef1-f1e9-4891-8746-1279af90dd4f` (pipeline step "Investigation" of `4c34cf8f…`, workdir = multi-repo workspace root, 5 repositories). Claude 2.1.326, model opus-5.5, mode auto.

| Time (EST) | Run | Event |
| --- | --- | --- |
| 09:18:29.08 | c51f535d | start; "prompt too large for launch argv — delivering via paste once claude is ready" (deferred paste) |
| 09:18:31.20 | c51f535d | "claude is asking a question on startup — answer it to continue" (one card registered) |
| 09:18:59.22 | c51f535d | "claude readiness never confirmed — delivering prompt anyway", so **no card was pending** 28 s later |
| 09:18:59.51 | c51f535d | "paste withheld: claude is waiting on a prompt …" → `Error: paste failed` → run failed |
| 09:19:29.28 | c51f535d | "claude session JSONL never appeared … after 30s"; pane: `Adding a new directory: …/repo-e … ❯ No, exit / Yes, add it / Enter to confirm · Esc to cancel`; session killed |
| 09:19:30.69 | 92c30f48 | user "try again" → "resuming claude session 05d0dcc7…" (the id of a session whose JSONL never existed) |
| 09:19:31.53 / 09:19:32.45 | 92c30f48 | two "asking a question on startup" statuses 0.9 s apart |
| 09:20:30.92 | 92c30f48 | JSONL never appeared; same repo-e dialog on the pane, cursor on "No, exit" |
| 09:22:07 | (outside agetor) | `~/.claude/projects/-Users-…-4c34cf8f…/122e6337….jsonl`: the user started `claude` by hand in the workspace (entrypoint `cli`, ran `/resume`, cancelled) |
| 09:23:09 → 09:23:39 | 2fa91334 | "try again" → resume 05d0dcc7 → "claude exited before writing its JSONL" with an **empty** pane, which is the signature of `--resume` on a missing session |

All three runs carry `claude_session_id = 05d0dcc7…`, and that JSONL never existed.

Why this fits defect 2. The worktree of a repository already trusted in `~/.claude.json` gets no dialog (proved, §2), so only the untrusted repositories prompted. Dialogs come in `--add-dir` order. If two repositories were untrusted at 09:18 (one earlier in the list, then repo-e, the last), the user answered the first card, the identical-fingerprint repo-e dialog was suppressed, and the deferred-paste window found no pending card. That produces exactly the sequence above, including the second window not re-arming. Run 2 ends the same way. `~/.claude.json` today shows all five source repositories `hasTrustDialogAccepted: true`, which is consistent with the user trusting them by hand at 09:22. Which repositories were untrusted at 09:18 cannot be recovered: tmux prompt cards are in memory only. This is assumption A1 (§3).

Past occurrences: 9 "asking a question on startup" statuses and 5 "readiness never confirmed" in the whole DB. 8 successful `trust-folder` auto-confirms, the latest 2026-11-16 23:02. No earlier add-dir failures, because the dialog is new in 2.1.326.

### 1.2 The boot path (`spawnClaudeViaTmux`, `src/bun/claude-tmux.ts:8769`)

- **Deferred-prompt readiness loop** `:8993–9140`. It polls `readPaneMode` for up to `DEFERRED_PROMPT_TIMEOUT_MS` (30 s, `:8686`) per window. It re-arms while `activeTmuxPromptsForTask` is non-empty. Otherwise it emits "readiness never confirmed" and pastes with `modalGuardGraceMs: 0`. When the guard withholds the paste, `onPasteFailure` rejects the run's `done` (`:9088–9101`).
- **Boot poller** `:9150–9305`. Every 350 ms (`STARTUP_DIALOG_POLL_MS`, `:6513`) it captures the pane. It runs `matchStartupConsentDialog` (auto-confirm through `createStartupConfirmTracker`, `:6427`: two sightings, 1.5 s retry window, at most 4 attempts, "auto-confirmed" only after 2 absent polls). Otherwise it runs `pickScrapeMatch` (`:5954`) on the last `SCRAPE_TAIL_LINES` lines and registers a generic `tmux_prompt` card (`:9290`) after **two** identical fingerprints. Note: the runtime scraper requires `UNPARSABLE_STABILITY_TICKS` (3) for an unparsable card, but the boot poller uses 2 for every matcher.
- **The suppression bug**: `if (state.recentlyAnsweredFingerprints.has(generic.fingerprint)) continue;` at `:9285`. The map's only GC is in `scrapeOnce` (`:7752`, TTL `RECENTLY_ANSWERED_TTL_MS` = 3 s, `:6519`), and the scraper starts in `attachTailer`, after the JSONL exists. The `continue` also skips `sawStartupPromptThisWindow = true`, so the boot wait (`:9320–9340`) stops re-arming.
- **Boot JSONL wait** `:9320–9375`. It re-arms while a startup prompt was seen in the window, a card is pending, or the deferred paste hasn't settled. Otherwise, after `CLAUDE_BOOT_TIMEOUT_MS` (30 s, `:3252`), it dumps the pane, kills the session and rejects every queued turn.
- **Consent table** `STARTUP_CONSENT_DIALOGS` `:6148`: `bypass-permissions` (`/bypass permissions mode/i`, affirmative `/\baccept\b/i`) and `trust-folder` (`/Quick safety check|trust this folder|trust the files in this (folder|directory)/i`, affirmative `/Yes\b.*\btrust this folder\b/i`). The doc comment `:6124–6146` states the policy: auto-confirm only screens tied to a choice the user already made; everything else (`/login`, the model picker, permission prompts) goes to the card.
- **Choice parsing.** `matchStartupConsentDialog` `:6207` falls back to `parseUnnumberedChoices` `:6264`, which needs an `enter to confirm` footer and ≥2 rows with one `❯` row. `confirmStartupDialog` `:6338` sends the arrows with a 150 ms gap, then Enter.

### 1.3 The card path

- Registry: `src/bun/interactions.ts:770` (`registerTmuxPrompt`), `:845` (`answerTmuxPrompt`), `:863` (`findTmuxPromptByFingerprint`), `:878` (`activeTmuxPromptsForTask`). In memory only, never persisted.
- Answer route: `POST /tmux-prompts/:id/answer`, `src/bun/server.ts:8139` (policy `app+cli`, `route-policy.ts:446`). It validates the key against the recorded choices, calls `dismissTmuxPrompt` (`claude-tmux.ts:2185`: arrows from the **registered** `cursorIndex`, 30 ms apart via `walkCursor`, then Enter or `confirmKey`), then `markTmuxPromptAnswered` (`:7848`) and `answerTmuxPrompt`. `reject: true` sends Escape. The route never re-reads the pane before driving, so a cursor that moved since registration is driven from a stale index (the wrap-around hazard, §2).
- Matchers, in `pickScrapeMatch` order: numbered > yes-no > slider > unnumbered (`:5755`, needs `\benter to confirm\b` in the last 3 non-blank lines, ≤9 rows, `hideKeys: true`) > unparsable (`:5883`, footer arm `MODAL_FOOTER_RE` `:5787` = `/esc to cancel|enter to confirm|enter to continue/i` in the last 3 non-blank lines, `choices: []`). The paste guard `paneShowsBlockingPrompt` (`:6077`) is the same chain.
- UI: `TmuxPromptCard` (`RunPanel.tsx:9563`). The unparsable branch (`:9700`) renders only "Open in Terminal". Choice cards render one button per choice (`tmuxChoiceLabel`, `src/mainview/lib/tmux-prompt.ts`). There is no "press Enter" or "continue" action anywhere.
- Parity surfaces: `agetor answer` (`src/cli/commands/answer.ts:62`, `answerTmux` `:321`, which adds a synthetic "Reject / Esc" row) and the TUI `AnswerOverlay` (`src/cli/tui/AnswerOverlay.tsx:304`). Any new card action needs them too (CLAUDE.md "CLI/TUI parity").

### 1.4 Multi-repository roots and resume

- `withTaskRepositoryRoots` (`orchestrator.ts:1739`) adds every materialised checkout as `extraDirectories` → `--add-dir <worktree>` for claude-code (`agents.ts:742`), codex and copilot. The paths are `~/.agetor/worktrees/<task-id>/<repo-name>`, agetor-owned, created from repositories the user picked.
- The doc `docs/architecture/multi-repo-tasks.md` and the plan `docs/plans/multi-repo-tasks-smoke.md:403` record a **successful** claude-code multi-repo smoke on **2.1.322**, before the dialog existed.
- Session id: `agents.ts:4249` pre-generates `sessionId`, and `:4254` calls `onSessionId` before `spawnClaudeViaTmux`. `findSessionIdForHarness` (`src/bun/harness-session-transfer.ts:738`) returns the newest stamped id with no check that its JSONL exists. `spawnResumedSessionInner` (`orchestrator.ts:12192`) resumes it.

### 1.5 Contract and standards

- **Contract.** The owner's request is in the pipeline prompt only (the pasted run log above). No ticket or spec is in the repo, so the plan should quote the prompt and this brief as its contract.
- **CLAUDE.md, "Agetor never adds its own text to a message"**: any fix must deliver keystrokes only, never text.
- **CLAUDE.md, "RunPanel is one long-lived instance"**: new per-task card state needs a reset line in `RunPanelBody`'s `[task.id]` effect.
- **CLAUDE.md, "Text the CLI or TUI prints from stored or third-party data goes through `src/shared/terminal-text.ts`"**: pane text shown by `agetor answer` and the TUI.
- **CLAUDE.md, "Every route needs a `ROUTE_POLICY` entry"**: only if a new route is added. A new answer shape on the existing route needs no new policy entry, but the body validation must stay a closed allow-list (`server.ts:8165–8181`, "an unknown key here is an attempt to inject arbitrary keystrokes").
- **`docs/architecture/harness-claude-code.md:24`** (boot poller and trust-dialog contract), **`:41`** (unnumbered matcher guards, "Both Chrome answers change a persistent Claude setting, so the card never auto-answers"), **`:75`** (no paste may ever type Enter into a live modal). Update this doc in the same change (CLAUDE.md: "When a change alters a subsystem's behavior, update its doc").
- **`docs/architecture/multi-repo-tasks.md`**: should gain the add-dir trust behavior.
- **Memory / fleet knowledge**: the trust-dialog knowledge entry (`dbe6fe4d…`) records the 2.1.284 lesson. A first-sighting confirm had no effect, so the poller must see the dialog twice, use ≥150 ms gaps and verify the dialog left. The 2.1.326 guard below is the mechanism behind that lesson.

### 1.6 Runtime and trust shape

- **Process.** One Bun core per machine owns every tmux session (per-instance socket, `tmuxSocketName()`). The boot poller and deferred paste are fire-and-forget IIFEs per spawn. Cards live in core memory, so a core restart loses them. The webview, `agetor answer` and the TUI all answer through `POST /tmux-prompts/:id/answer`.
- **Input parties.** The desktop app (master token) and the CLI (CLI token, `app+cli` route) can answer cards. Pane text is **agent-controlled**: claude, and anything claude prints, decides what's on the pane. An auto-confirm keyed on pane text is a trust decision. A hostile repository can't draw claude's own dialog chrome before claude boots, but transcript text can quote it. That is why the existing matchers require the footer in the last 3 non-blank lines and why the consent table anchors on exact affirmative labels.

## 2. What we proved

All spikes ran in the session scratchpad on private tmux sockets (`tmux -L agetor-spike-*`) at 80x24, the same size as agetor's detached panes, with `env -u CLAUDECODE …` and claude **2.1.326**. The scripts live in `<scratchpad>/spikes/*.sh`. One haiku prompt ("reply with just: ok") was sent, to create a JSONL for the resume test.

| # | Question | Verdict | Evidence | Versions |
| --- | --- | --- | --- | --- |
| P1 | Does `--add-dir <worktree>` show a startup dialog, and in what shape? | **Yes**, one per untrusted repo, in argv order | Pane: `Adding a new directory:` / path / `This directory is part of the repository at <src>. Trusting it trusts that whole repository, including its other worktrees and subdirectories.` / `This session hasn't worked here before. …` / `Security guide` / `❯ No, exit` / `  Yes, add it` / `Enter to confirm · Esc to cancel` (verbatim in Appendix A). Cursor starts on **No**. | claude 2.1.326 |
| P2 | Do two dialogs for two repos share agetor's fingerprint? | **Yes** | Repo matchers run on both panes (`bun spikes/matchers/run.ts`): `unnumbered: No, exit \| Yes, add it @0 fp=8769bebdef` for both; `matchStartupConsentDialog → null` for both | repo HEAD 32aa7c3a |
| P3 | Does agetor's card keystroke (Down, 30 ms, Enter) answer it? | **Yes, once the dialog is armed** | Sent ~9 s after mount → next dialog appeared. Sent ~700 ms after first paint → accepted. Sent 2 s into a held state → accepted. | 2.1.326 |
| P4 | Is the answer persisted? | **No** | After answering both dialogs, `~/.claude.json` held no entry for the add-dir paths; only the cwd entry (`hasTrustDialogAccepted: false`) | 2.1.326 |
| P5 | Does `--resume` of an existing session re-ask? | **Yes** | Created a session with one turn, killed it, relaunched `--resume <id> --add-dir …`, and the same dialog came back | 2.1.326 |
| P6 | Is the dialog skipped when the source repo is trusted? | **Yes** | Accepting the workspace trust dialog in `src/alpha` set `hasTrustDialogAccepted: true`; the relaunch asked only for `beta` | 2.1.326 |
| P7 | What happens to keys sent right at mount? | **Refused, and the footer changes** | Down + 30 ms + Enter at ~300 ms after first paint: cursor stays on `No, exit`, footer becomes `Esc to exit · To add it, press ↓ to Yes, then Enter`. Recovery: Down, wait ≥500 ms, Enter → accepted | 2.1.326 |
| P8 | Does the select wrap, and is an accidental "No, exit" fatal? | **Yes and yes** | From the held state, `Up` moved the cursor No → **Yes** (wrap). A burst `Down Enter` then landed on No, and claude exited with status 1: `To go on without it, start again with the same flags but without --add-dir <path>. Add --resume to pick up an earlier conversation.` | 2.1.326 |
| P9 | What do the repo's matchers see in the held state? | **Nothing** (inferred from code and P7) | The held footer has no `enter to confirm`, `enter to continue` or `esc to cancel`, so `matchUnnumberedModal`, the unparsable footer arm, `parseUnnumberedChoices` and `paneShowsBlockingPrompt` all miss it | repo HEAD |
| P10 | Cut-off dialog on 80x24 (very long paths) | **Accepted but invisible to matchers** | A ~450-char add-dir path made claude draw an `Adding: <path>` trailer **below** the footer (6 lines), and the title scrolled off. Down + Enter was still accepted (the "first make the window taller" lock is gated on another flag, `zs()`). Matchers: consent `null`, unnumbered `null`, unparsable `null` | 2.1.326 |
| P11 | `--resume <id>` whose JSONL never existed | **claude exits 1** | `claude --resume <random-uuid>` → `No conversation found with session ID: <uuid>`; in tmux the pane closes (matches run 3's empty pane) | 2.1.326 |
| P12 | 2.1.326 workspace-trust dialog still auto-confirmed? | **Yes** | Live pane `Accessing workspace: … ❯ No, exit / Yes, I trust this folder / Enter to confirm · Esc to cancel` → `matchStartupConsentDialog = trust-folder, acceptIndex 1` | 2.1.326 + repo HEAD |
| P13 | Which versions have the add-dir dialog? | **2.1.326 only** | `grep -a -c "Adding a new directory"` over `~/.local/share/claude/versions/*`: 2.1.321, .322, .323, .325 → 0; 2.1.326 → 2 | local installs |
| P14 | Login, logged-out config (fresh `CLAUDE_CONFIG_DIR`) | First screen is a **theme picker with no footer and no numbers**, then **numbered** `Select login method:` (no footer) | Live capture (Appendix A). Matchers: theme → nothing; login method → numbered card. Stopped before picking a method (would open a browser). | 2.1.326 |
| P15 | Login success and security-notes screens | `Login successful. Press Enter to continue…` and `Security notes: … Press Enter to continue…` → **unparsable card only** | From the binary (`["Login successful. Press ", <b>Enter</b>, " to continue…"]`, and `sessionAuth==="fresh" ? "Press Enter to continue…" : "Press Enter to retry."`). Repo matchers on reconstructed panes: consent/numbered/unnumbered `null`, unparsable footer arm fires. **Not live-captured** (needs a real OAuth round trip). | 2.1.326 binary + repo HEAD |
| P16 | `Paste code here if prompted >` (OAuth manual code) | **Nothing matches** | Repo matchers on the reconstructed pane: all `null` | repo HEAD |

**The add-dir dialog's guard, decoded** (2.1.326 chunks `qyt` / `ee` / `Unn` / `Qn`, Appendix B):

- The select is `hideIndexes`, `cancelFirst`, `focus: "cancel"` (so the cursor starts on No), with `armAfterMs: 500` (`g6 = 500`).
- An arrow counts only when the select is armed, meaning ≥500 ms after mount and ≥500 ms after the last refusal (the timer resets on every refusal), and not within 700 ms of typed text (`Jps = 700`). An uncounted arrow flips the dialog to **held**.
- Confirm on "Yes" is accepted only if the previous input event was a counted Down (`follows === "down"`) and the dialog isn't cut off. Otherwise it is refused, which sets held and bumps the refusal count.
- Enter on "No, exit" while held is refused too (`!w || be !== undefined`), so a refused Down-then-Enter at mount cannot exit claude. Only a counted arrow followed by Enter on "No, exit" exits.
- In the held state, typed printable keys go into claude's prompt buffer ("your text is kept"), and Enter adds a newline to that buffer instead of confirming.

## 3. What we're assuming

| # | Assumption | If wrong |
| --- | --- | --- |
| A1 | At 09:18 at least two of the five repositories were untrusted, and the user answered the first card (§1.1). | Defect 2 would not be this incident's trigger: one dialog, card answered, keys refused (P7) or never clicked. Defect 2 is still a real bug (any second dialog, and bypass then trust then add-dir chains), and P7 becomes the leading explanation, so the held-state handling moves from robustness to primary fix. The plan should fix both either way. |
| A2 | Dialog order follows `--add-dir` order (P1 shows alpha then beta). | Only matters if an auto-confirm verifies "the dialog's path is the next expected add-dir". Comparing against the whole set avoids depending on order. |
| A3 | The theme picker and the `Press Enter to continue…` screens appear at boot only for a never-onboarded or logged-out `CLAUDE_CONFIG_DIR` (a fresh harness-stack account), and mid-session only through `/login`. | If an expired login also shows them at boot for the default account, the boot path needs the Enter-only card too (it would anyway under "all Enter scenarios"). |
| A4 | The `Login successful…` pane text matches the binary string (P15). It wasn't captured live. | The matcher would need a looser anchor. Capture it during implementation with the owner's help, or from a harness-stack account login. |
| A5 | agetor's panes stay 80x24 at boot (detached `new-session` without `-x/-y`). | A taller pane makes the cut-off case (P10) rarer. Resizing at boot is one possible fix, already used by the ask collector (`GROW_PANE_COLS`, `claude-tmux.ts:3773`). |
| A6 | `follows === "down"` is set only by a counted Down, so Down + 30 ms + Enter is safe once armed (P3). | Under heavy boot load React may not re-render within 30 ms. Then the Enter is refused, the dialog goes held, and the card path needs verify-and-retry. A larger gap (≥150 ms, as `confirmStartupDialog` already uses) is the cheap hedge. |

## 4. What we must ask the owner

1. **Auto-confirm the startup "Adding a new directory" dialog for the task's own checkouts, or card it?**
   - Why it matters: P4 and P5 show it re-asks on every launch and every resume, once per untrusted repository. A card-only fix means up to N clicks per follow-up after hibernation, and a stalled run whenever nobody is watching (pipelines, unattended runs).
   - For auto-confirm: precedent in the existing `trust-folder` rationale (`claude-tmux.ts:6124–6146`: agetor owns the worktree and the user pointed the task at it). The add-dir paths are agetor-created checkouts of repositories the user picked.
   - Against: the dialog's own warning that trusting a worktree trusts the whole source repository and its git settings, which can run commands. It is session-scoped, though, not persisted.
   - Recommendation: auto-confirm, scoped tightly. Only the `No, exit` (startup) variant. Only when the dialog's path, after re-joining wrapped lines and stripping whitespace on both sides, equals one of the `--add-dir` paths agetor passed for this spawn. Anchored on the exact `Yes, add it` label. Mid-session `/add-dir` (`No, leave it out`) stays a card.
2. **"Press Enter to continue" screens (Login successful, Security notes, onboarding, retry prompts): give the card an in-card action that sends Enter?**
   - Why it matters: today the card can only say "Open in Terminal" (`RunPanel.tsx:9700`).
   - Recommendation: a single "Continue (press Enter)" button, offered only when the screen is Enter-only. That means a `Press Enter to continue…` line among the last non-blank lines and **no** choice rows or cursor glyph anywhere in the dialog region, so Enter can't confirm a hidden default. Never auto-press, since the user should see "Login successful" before agetor continues. Mirror it in `agetor answer` and the TUI.
3. **Retry after a failed boot: start fresh or keep resuming?**
   - Why it matters: defect 4 (P11) means a boot that never wrote its JSONL poisons every retry.
   - Recommendation: before resuming, check that the recorded session's JSONL exists under the harness config dir. If it doesn't, launch fresh with the same id via `--session-id`. Also stop stamping, or clear, the id when the boot fails with `jsonl-discovery-timeout`. Is this in scope for this change? (It is the same failure chain.)
4. **Logged-out account at boot (theme picker → login method → browser → paste-code → Press Enter):**
   - In scope: card each screen? The theme picker has no footer, so it needs a new anchor such as `Choose the text style …` or `To change this later, run /theme`.
   - Or out of scope: a pre-flight "not logged in" error instead (e.g. `claude auth status` if the CLI has it, unverified).
   - Which Login case did the owner hit: `/login` typed mid-session (the DB shows 5 such uses; the 2026-10-04 one stalled 12 h on `Select login method`), or a task starting on a logged-out account?
5. **Pipelines and unattended runs.** Should an Enter-to-confirm card in a pipeline step child also notify or surface on the parent? The incident was a pipeline step. Today the card carries `pipelineParentId` (`interactions.ts:525`); confirm the owner saw the card on the parent's panel.
6. **Held-state recovery policy.** If an auto-confirm or a card click is refused (P7), the plan has two options:
   - Re-drive on its own: re-read the cursor, Down only if the cursor isn't on Yes, wait ≥500 ms, Enter.
   - Re-card it with the held hint.

   Recommendation: re-drive for the auto-confirmed add-dir dialog (bounded retries as the tracker does today), and re-card for user-answered cards. **Never press Down from an unknown cursor**, because the select wraps (P8).

## 5. Completeness inventory

- **Callers and sites to change (direct)**
  - `src/bun/claude-tmux.ts`:
    - `STARTUP_CONSENT_DIALOGS` `:6148` (new add-dir entry, or a separate path-verified matcher).
    - `matchStartupConsentDialog` `:6207` (needs the expected add-dir paths; signature change; called only from the boot poller `:9206`; exported via `__forTest`).
    - `parseUnnumberedChoices` `:6264` (recognise the held footer `Esc to (exit|cancel) · To add it, press ↓ to Yes, then Enter`, and the cut-off `Adding: <path>` trailer below the footer).
    - `confirmStartupDialog` `:6338` (arm delay ≥500 ms; re-read the cursor before every attempt).
    - `createStartupConfirmTracker` `:6427` (a held dialog must not count as "absent", or it reports a false `auto-confirmed`).
    - Boot poller `:9150–9305` (`recentlyAnsweredFingerprints` TTL or prune at `:9285`; set `sawStartupPromptThisWindow` on that path).
    - Deferred-paste give-up `:9040–9090` (don't paste into a dialog the boot poller knows about).
    - `matchUnnumberedModal` `:5755` (footer gate) and `matchUnparsableModal` / `MODAL_FOOTER_RE` `:5787` / `:5883` (the Enter-only "press Enter to continue" class; any new footer phrase needs a captured pane, per that constant's doc).
    - `dismissTmuxPrompt` `:2185` (re-verify the cursor before driving; gap).
    - `paneShowsBlockingPrompt` `:6077` (held state).
  - `src/bun/agents.ts:4249–4254` (`onSessionId` timing) and/or `src/bun/harness-session-transfer.ts:738` and `src/bun/orchestrator.ts:12192` (resume only an existing JSONL).
  - `src/bun/server.ts:8139` (an Enter-only answer shape if Q2 is accepted; keep the closed allow-list).
  - `src/bun/interactions.ts:183` / `:770` (`TmuxPromptRequest`: a flag such as `enterOnly` or a choice kind).
  - `src/mainview/components/kanban/RunPanel.tsx:9563–9790` and `src/mainview/lib/tmux-prompt.ts` (card).
  - `src/cli/commands/answer.ts:321` and `src/cli/tui/AnswerOverlay.tsx:304` (parity).
  - `src/mainview/lib/api.ts` and `src/cli/api-client.ts` `answerTmuxPrompt` (body shape).
- **Entry points new code must be wired into.** The boot poller IIFE inside `spawnClaudeViaTmux` is the only startup-dialog surface, and `scrapeOnce` (`:7484`) the runtime one; both go through `pickScrapeMatch`. The add-dir paths must flow from `ClaudeLaunchOptions` (they're already in `opts.argv` as `--add-dir <p>` pairs, so they can be parsed back, or added as an explicit field). `spawnAgent` → `spawnClaudeViaTmux` (`agents.ts:4255`) is the single launch path for fresh, resume, swap and retry.
- **Propagation surface.** `TmuxPromptRequest` / `PendingTmuxPrompt` types (`src/bun/interactions.ts`, the webview copy in `src/mainview/lib/api.ts`, the CLI copy in `src/cli/api-client.ts`), the `/tasks/:id/interactions/pending` payload, and the SSE interaction broadcast.
- **Existing data.** None to migrate. Cards are in memory. Run rows that already carry a never-created `claude_session_id` (e.g. task `ef488ef1…`) would be healed by a resume-time existence check, with no backfill needed.
- **Tests that pin current behavior / where new tests go**
  - `src/bun/claude-tmux-scraper.test.ts`: the `matchUnnumberedModal` truth table `:790`, the #298 live-capture suite `:1000`, `startupConfirmDecision` `:2789`, `createStartupConfirmTracker` `:2820`. Add the 2.1.326 captures (Appendix A) as fixtures there.
  - **No test drives the boot poller end to end.** Nothing emits "claude is asking a question on startup". The stub-tmux seam that can (`AGETOR_TMUX_BIN` pointing at a script that answers `capture-pane` and records `send-keys`) exists in `src/bun/claude-tmux-slow-launch.test.ts:157` and `claude-tmux-death.test.ts:30`. A boot-poller integration test for defects 2 and 3 should be built on it.
  - e2e: the fake claude driver (`AGETOR_CLAUDE_DRIVER=fake`) bypasses tmux, so no e2e reaches these paths today. There is no `tmux_prompt` e2e at all (`grep -l tmux_prompt e2e/` is empty). A card-UI e2e for the Enter-only button would need a fake-driver prompt marker that registers a `tmux_prompt`.
- **Docs / config that describe current behavior.** `docs/architecture/harness-claude-code.md:24,:41,:75`, `docs/architecture/multi-repo-tasks.md`, the `STARTUP_CONSENT_DIALOGS` doc comment, and the `MODAL_FOOTER_RE` doc ("Do not add a phrasing without a captured pane").
- **What the change would orphan.** Nothing obvious. If the boot poller gets its own TTL'd check, the `.has()` call goes.

## 6. Runnability

- **Prereqs in an agetor worktree**: `export PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH"`, then `bun install --frozen-lockfile`. This worktree now has `node_modules`.
- **Unit tests**: `bun test src/bun/claude-tmux-scraper.test.ts`, `bun test src/bun/claude-tmux.test.ts`, `bun test src/bun/claude-tmux-slow-launch.test.ts`, `bun test src/bun/orchestrator-paste-withheld.test.ts`; the full suite is `bun test`. Known pre-existing failures are listed in memory "Pre-existing failing unit tests". Run `bun run typecheck` too.
- **e2e**: Playwright, `bun node_modules/@playwright/test/cli.js test e2e/<spec>` (not `bunx`), one run at a time. A card-UI test needs a fake-driver prompt marker.
- **Live smoke of the real dialog**: the spike recipe in §2. Example: `tmux -L <own-socket> new-session -d -x 80 -y 24 -c <non-git dir> -- env -u CLAUDECODE -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_ENTRYPOINT claude --model haiku --permission-mode auto --add-dir <worktree-of-untrusted-repo> [--add-dir <second>]`. A headless agetor core can be smoked per memory "Headless live smoke" (`~/.agetor-dev`, port 4319). A multi-repo task needs two scratch repos that are **not** trusted in `~/.claude.json`.

## 7. Risks and blast radius

- **Exiting claude by accident.** The two-row select wraps (P8). Any driver that sends Down from a stale or assumed cursor can land on "No, exit", and an accepted Enter there kills the session ("To go on without it …"). Every drive must re-read the cursor from the live pane right before sending, and arrow count must be computed from that read.
- **The held state is invisible today** (P7, P9). A too-early auto-confirm or a fast card click leaves the dialog in a footer shape no matcher sees. The consent tracker then counts it "absent" and emits a false `auto-confirmed`, and the paste guard won't withhold. The held footer must be matched.
- **False positive auto-confirm.** Pane text is agent-influenced. Keep the startup-only scope (the boot poller runs only before the JSONL exists), the exact-label anchor, and the path-equals-our-add-dir check, so quoted text in a transcript can never auto-confirm.
- **Runtime twin.** Mid-session `/add-dir` and `/cd` show the same family (`No, leave it out`, `No, stay put`, `Yes, move here`, `Yes, trust it and apply them`). The runtime scraper already prunes recently-answered fingerprints after 3 s, so those cards re-appear for a second identical dialog, but the held state affects them too.
- **Other harnesses.** codex and copilot also receive `--add-dir` (`agents.ts:1080`, `:1155`). Not investigated here; their CLIs may have their own trust prompts. Out of scope unless the owner says otherwise.
- **Version drift.** The dialog appeared in a patch release (2.1.326) with no changelog. Every pane-shape match should carry a captured fixture tagged with its version, as the #298 suite does.
- **Spike side effects on this machine**:
  - `~/.claude.json` gained entries for scratchpad paths (`…/spikes/adddir/ws` untrusted, `…/spikes/adddir/src/alpha` trusted), as earlier spikes did.
  - `~/.claude/projects/-private-tmp-…-spikes-adddir-ws/523e7d6b….jsonl` holds the one haiku turn.
  - A scratch `CLAUDE_CONFIG_DIR` under the scratchpad (logged out, onboarding not completed).
  - Nothing was written to the repo except `node_modules` (gitignored) and this brief.

## Appendix A — Captured panes (claude 2.1.326, 80x24)

Startup add-dir dialog (prod, run c51f535d; matches the spike):

```
────────────────────────────────────────────────────────────────────────────────
 Adding a new directory:
 /Users/me/.agetor/worktrees/4c34cf8f-a6fd-4f75-865c-92d7dbafa101/repo-e
 This directory is part of the repository at
 /Users/me/Projects/acme/repo-e. Trusting it trusts
 that whole repository, including its other worktrees and subdirectories.
 This session hasn't worked here before. Is this a directory you created or one
 you trust?
 Claude Code'll be able to read, edit, and execute files here. Its skills,
 commands, and agents load and can run commands, and so can the git settings of
 its repository. Your answer holds for this session.
 Security guide
 ❯ No, exit
   Yes, add it
 Enter to confirm · Esc to cancel
```

Held state after a refused confirm (spike):

```
 Security guide
 ❯ No, exit
   Yes, add it
 Esc to exit · To add it, press ↓ to Yes, then Enter
```

Cut-off (dialog taller than the pane; the title has scrolled off, and a trailer follows the footer):

```
 its repository. Your answer holds for this session.
 Security guide
 ❯ No, exit
   Yes, add it
 Enter to confirm · Esc to cancel
 Adding: /private/tmp/…/scratchpad/spi
kes/tall/ws/dddd…/gamma
```

Claude exited after a confirmed "No, exit":

```
To go on without it, start again with the same flags but without --add-dir /priv
ate/tmp/…/ws/beta. Add --resume to pick up an earlier conversation.
```

Workspace trust (still auto-confirmed):

```
 Accessing workspace:

 /private/tmp/…/spikes/adddir/src/alpha

 Quick safety check: Is this a project you created or one you trust? (Like your
 own code, a well-known open source project, or work from your team). If not,
 take a moment to review what's in this folder first.

 Claude Code'll be able to read, edit, and execute files here.

 Security guide

 ❯ No, exit
   Yes, I trust this folder

 Enter to confirm · Esc to cancel
```

Logged-out first launch (fresh `CLAUDE_CONFIG_DIR`). Theme picker, with no footer even at 80x40:

```
Welcome to Claude Code v2.1.326

 Let's get started.

 Choose the text style that looks best with your terminal
 To change this later, run /theme

 ❯ ✔ Auto (match terminal)
     Dark mode
     Light mode
     …
  Syntax theme: Monokai Extended (ctrl+t to disable)
```

Then the login method screen (numbered, no footer at boot; mid-session `/login` draws `Esc to cancel`, per prod run 39fc1505, 2026-10-04):

```
 Select login method:

 ❯ 1. Claude account with subscription · Individual, Team, or Enterprise
   2. Anthropic Console account · API usage billing
   3. 3rd-party platform · Bedrock, Microsoft Foundry, Google Vertex AI
```

From the binary (not live-captured): `Login successful. Press Enter to continue…`, `Security notes: …` followed by `Press Enter to continue…`, `Paste code here if prompted > `, and `Press Enter to retry.`

## Appendix B — Binary facts (claude 2.1.326, `strings` of `~/.local/share/claude/versions/2.1.326`)

- Dialog titles: `u ? "Now in a new directory:" : i ? "Adding a new directory:" : "Moving to a new directory:"`.
- Confirm labels: `"Yes, trust it and apply them" | "Yes, add it" | "Yes, move here"`.
- Cancel labels: `"No, keep them off" | (i===undefined ? "No, stay put" : i==="later" ? "No, leave it out" : "No, exit")`.
- Select: `Qn({hideIndexes:!0, disablePrintableKeybindings:!0, cancelFirst:!0, focus:"cancel", windowMs:Ko, armAfterMs: adding ? g6 : void 0})`, with `g6 = 500`.
- Startup wrapper `qyt` and guard `ee(atStartup, cutOff)`:
  - `A = _Oe() && Wr(g6, refusals)` is the armed flag (500 ms after mount and after each refusal).
  - `Jps = 700` is the typing window.
  - `takes(confirm) = confirm ? !cutOff && (notKeyEvent || follows === "down") : notKeyEvent || (isEscape ? !typingRecently() : !held || follows !== undefined)`.
  - Held hint: ``${Esc to exit|Esc to cancel} · To add it, press ↓ to Yes, then Enter${atStartup && typedAhead ? " (your text is kept)" : ""}``.
  - Cut-off hint: `"… · To add it, first make the window taller"`, plus an ` Adding: <path>` trailer.
- Enter-hint actions used across the TUI (`chord:"enter",action:…`): confirm ×32, select ×14, continue ×9, save ×7, view ×3, and singletons (open, choose, send, connect, resume, add, apply, answer, …). agetor's footer allow-list knows only `enter to confirm` and `enter to continue`, and `esc to cancel`.
