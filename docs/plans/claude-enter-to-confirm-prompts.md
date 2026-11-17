# Plan — Claude Code "Enter to confirm" prompts (startup add-dir trust, Login, Press-Enter screens)

| Field | Value |
| --- | --- |
| Date | 2026-11-17 |
| Source | The pipeline prompt (the owner's pasted run log, quoted in the brief §0); investigation `docs/plans/claude-enter-to-confirm-prompts-investigation.md`; decision record `docs/plans/claude-enter-to-confirm-prompts-grill.md` (D1–D28) with `docs/plans/claude-enter-to-confirm-prompts-grill/round-{1,2}/answers.json` |
| Flags | none |
| Gates | grilled (2 rounds, every required question answered) + plan approved by owner as written (2026-11-17, one branch, wave-ordered checkpoint commits; the mid-boot-restart orphan consequence in §3.7 / §8 P-2 accepted) |
| Status | executed on branch `fix/agetor-claude-code-press-enter` (W1–W4 committed; code review and the full-suite run follow) |
| Branch | `fix/agetor-claude-code-press-enter` |
| Base SHA | `32aa7c3a974c5b89b3b94b91ecbb6a0a0cce1935` |

There is no spec outside the repo. The contract is the pipeline prompt as quoted in the brief §0, plus the grill record. Both live in `docs/plans/`. They are uncommitted and should be committed, unamended, as their own docs commit before the code.

## 1. Objective & success criteria

Make agetor's claude-code tmux driver handle every Claude Code screen that waits on Enter. No run may die at the 30 s boot timeout because of one, and no card may leave the user unable to act. The four defects from the incident (brief §0) and the Login gap are all fixed.

| # | Criterion | Production path that produces it | Proven by |
| --- | --- | --- | --- |
| SC1 | A multi-repository claude task whose repositories are untrusted boots with no user action while `claude_auto_trust_repositories` is on (the default). Exactly one status line per repository: `auto-confirmed Claude's "Adding a new directory" prompt for <repo-name>` (D1, D21). | `POST /tasks/:id/start` → `startTask` → `spawnAgentOrFail` → `withTaskRepositoryRoots` (sets `autoTrustDirectories`) → `spawnAgent` → `spawnClaudeViaTmux` boot poller → `matchStartupConsentDialog` → `matchAddDirAutoTrust` → `confirmStartupDialog` | TT3, live smoke TT9 |
| SC2 | The same holds for a follow-up after hibernation (a `--resume` launch re-asks every untrusted repository, P5). | `POST /runs/:id/input` → `sendInput` → `spawnResumedSessionInner` → `spawnAgentOrFail` → … → `spawnClaudeViaTmux` resume consent window | TT3, TT9 |
| SC3 | With the preference off, or for a path agetor didn't pass, each dialog is a card. A second dialog with an identical fingerprint is carded again after the first is answered (defect 2). | boot poller → `pickScrapeMatch` → `registerTmuxPrompt`; `recentlyAnsweredFingerprints` TTL at boot | TT3 |
| SC4 | The large-prompt deferred paste never pastes into a startup dialog and never fails the run while one is on the pane. It fails only when the boot itself times out, with the pane in the error (defect 3, D25). | deferred-paste IIFE in `spawnClaudeViaTmux` | TT3 |
| SC5 | A boot that never wrote its session JSONL never poisons the next turn. The id is recorded only once the JSONL exists, and a resume of a missing JSONL starts fresh under the same id (defect 4, D11). | `spawnAgent` claude branch (`resolveClaudeResume`) and `spawnClaudeViaTmux` (`onSessionFileReady`) → `runs.update` | TT6, TT9 |
| SC6 | Enter-only screens (`Login successful. Press Enter to continue…`, `Security notes … Press Enter to continue…`, `Press Enter to retry.`) show a **Continue (press Enter)** action in the app, `agetor answer` and the TUI. It is never pressed automatically (D8). | scraper or boot poller → `matchEnterOnlyScreen` → `registerTmuxPrompt({answerKind:"enter"})` → card → `POST /tmux-prompts/:id/answer {enter:true}` → `answerTmuxPromptInPane` | TT4, TT5, TT8 (e2e), T12 tests |
| SC7 | The OAuth `Paste code here if prompted >` screen shows a one-line text box (≤512 chars, no control characters). The code is typed with `send-keys -l`, then Enter. It is never written to run_events, a status line, a log, an error, or a pane dump (D9, D10, D15). | `matchPasteCodeScreen` → `registerTmuxPrompt({answerKind:"code"})` → card / CLI / TUI → route `{code}` → `validateOAuthCode` → `answerTmuxPromptInPane` | TT4, TT5, TT8 |
| SC8 | On a logged-out boot, the theme picker (no footer) and the login-method screen are carded (D5, D12). | boot poller → `matchThemePicker` / numbered matcher | TT2, TT3 |
| SC9 | Starting a claude task on an account that `claude auth status` reports logged out is refused with a login hint. The header dot shows "logged out". A harness stack skips such an account at start and at swap ("skipped <account>: not logged in"), and refuses only when every member is logged out (D5–D7). | `checkHarness` → `probeClaudeAuth` → `startTask` pre-flight (`status.loggedIn === false`) and `/harnesses` → `App.tsx:2637`; `memberUnusableReason` → stack planners | T3, T8 tests, TT9 |
| SC10 | Held footers, cut-off dialogs, and mid-session `/add-dir` and `/cd` dialogs are carded and driven safely. Every keystroke is computed from a live re-read of the cursor, Down is never sent from an unknown cursor, and a refused confirm is retried (auto) or re-carded (user) (D12, D13, D22, D23). | `answerTmuxPromptInPane`, `confirmStartupDialog` | TT2, TT4 |
| SC11 | Settings → General is grouped (Appearance / Tasks / Privacy & security / Background / Getting started). Harness-specific rows and the new auto-trust toggle live on Settings → Harnesses under a per-kind **Behaviour** block (D2, D3). | `SettingsDialog` → `HarnessesPage` → `HarnessBehaviourSection` → `PUT /preferences/:key` | T5 unit + e2e |
| SC12 | Multi-repository extra directories work on codex and copilot, verified by spike and fixed where broken (D17, D18). | `withTaskRepositoryRoots` → `buildCommand` codex/copilot branches | T4 spike doc, T14 |
| SC13 | The docs describe the new behavior: `harness-claude-code.md`, `multi-repo-tasks.md`, `security.md` (with D14 and D15 stated as owner decisions), `harness-stacks.md`, `harnesses.md`, and the code comments (D27). | — | T15, review |

## 2. Context & constraints

### Grounded findings (HEAD `32aa7c3a`, unchanged since the investigation, so the brief's anchors hold)

- **Boot path.** `spawnClaudeViaTmux` `src/bun/claude-tmux.ts:8769`.
  - Deferred-paste readiness loop `:8993–9140`. It gives up into "readiness never confirmed" at `:9040–9046`, and `onPasteFailure` rejects the run at `:9088–9101`.
  - Boot poller `:9150–9305`. The suppression bug is `state.recentlyAnsweredFingerprints.has(...)` at `:9285`, never pruned at boot. Its `continue` also skips `sawStartupPromptThisWindow`. Generic cards need 2 ticks at boot (`:9269`).
  - Boot JSONL wait `:9320–9375`. Pane dump at `:9349–9363`.
  - **New finding:** on a `--resume` launch the JSONL already exists, so the poller returns on its first tick (`:9180–9198`, comment "a re-shown consent dialog on resume is out of scope"). The add-dir dialog that `--resume` re-asks (P5) then reaches the runtime scraper (`scrapeOnce` `:7484`), which cards it. SC2 therefore needs a resume consent window.
- **Consent.** `STARTUP_CONSENT_DIALOGS` `:6148`, `matchStartupConsentDialog` `:6207`, `parseUnnumberedChoices` `:6264`, `confirmStartupDialog` `:6338`, `startupConfirmDecision` `:6384`, `createStartupConfirmTracker` `:6427`. Constants: `STARTUP_DIALOG_POLL_MS` 350 `:6513`, `RECENTLY_ANSWERED_TTL_MS` 3 s `:6519`, `UNPARSABLE_STABILITY_TICKS` 3 `:6524`, `DEFERRED_PROMPT_TIMEOUT_MS` 30 s `:8686`.
- **Matchers.** `matchUnnumberedModal` `:5755`, `MODAL_FOOTER_RE` `:5787`, `matchUnparsableModal` `:5883`, `pickScrapeMatch` `:5954`, `paneShowsBlockingPrompt` `:6077`. Scraper registration `:7795–7838`, GC of recently-answered `:7752`.
- **Card drive.** `dismissTmuxPrompt` `:2185` drives from the **registered** `cursorIndex` with no pane re-read. `walkCursor` `:2286` uses a 30 ms gap. Its only production caller is the route (`src/bun/server.ts:8194`). `tmux()` `:1674` does not log argv. `send-keys -l -- <text>` with `escapeTypedTrailingSemicolon` is the existing typed-text idiom (`:2676`).
- **Answer route.** `POST /tmux-prompts/:id/answer` `src/bun/server.ts:8139–8211`, policy `app+cli` (`src/bun/route-policy.ts:446`). Today's body is `{key}` or `{reject:true}`. Keys are validated against the recorded choices (closed allow-list).
- **Interaction contract.** `TmuxPromptRequest` `src/bun/interactions.ts:183–250`, `registerTmuxPrompt` `:770` (the single point every card's `paneText` passes through; it already rejects `__`-prefixed keys and validates `confirmKey`), `answerTmuxPrompt` `:845`. Webview copy: `PendingTmuxPrompt` `src/mainview/lib/api.ts:281–301`, `answerTmuxPrompt` `:2242`. CLI client: `src/cli/api-client.ts:402`. The TUI imports the bun types directly (`src/cli/tui/AnswerOverlay.tsx:4`).
- **Card UI.** `TmuxPromptCard` `src/mainview/components/kanban/RunPanel.tsx:9563`. Its unparsable branch (`:9700`) offers only "Open in Terminal". `tmuxChoiceLabel` is in `src/mainview/lib/tmux-prompt.ts`.
- **CLI/TUI.** `answerTmux` `src/cli/commands/answer.ts:321` prints `req.paneText` **unescaped** (`:322`), which is an existing breach of the CLAUDE.md terminal-text rule on a line this change touches. The TUI handles tmux prompts at `src/cli/tui/AnswerOverlay.tsx:304`.
- **Session id.** `spawnAgent` claude branch `src/bun/agents.ts:4249–4266`: it pre-generates the id and calls `onSessionId` **before** `spawnClaudeViaTmux`. Run inserts that pre-stamp an inherited id are at `orchestrator.ts:5763` (swap), `:11810`, `:12102`, `:12206` (`spawnResumedSessionInner`, resume at `:12253`). `findSessionIdForHarness` `src/bun/harness-session-transfer.ts:738` iterates the task's runs. Boot reconciliation reattaches a running claude run only if it has a `claude_session_id` (`orchestrator.ts:1274+`, `reattachKey`).
- **Multi-repo roots.** `withTaskRepositoryRoots` `orchestrator.ts:1739`, called from `spawnAgentOrFail` `:1800`, so it covers every spawn path. `--add-dir` is passed at `agents.ts:742` (claude), `:1155` (codex, as a parent flag before `resume`) and `:1080` (copilot).
- **Login.** `checkHarness` `src/bun/agent-status.ts:723` already carries `loggedIn`/`authHelp`, and fx probes it with a cached status (`getCachedStatus`, `freshAuth` bypass). `startTask`'s pre-flight already refuses `status.loggedIn === false` and moves a stacked task once to a backup (`orchestrator.ts:2519–2570`). The header dot is kind-agnostic (`src/mainview/App.tsx:2637`), and so is the account row (`HarnessAccountRow.tsx:155`). Stack planners skip `memberUnusableReason` ≠ null (`src/bun/harness-failover.ts:239`), which already returns "logged out" from the file/keychain `loginEvidence` (`src/bun/harness-stacks.ts:412`). The limit swap plans synchronously at `orchestrator.ts:5287`, retry at `:7729`, manual switch at `:7443`.
- **Settings.** `GeneralSection` `src/mainview/components/settings/SettingsDialog.tsx:1276`. Its rows: default harness, tmux source `:1376`, theme, font size, `BackgroundSection` `:1468`, launch scan `:1470` (`CLAUDE_SESSIONS_LAUNCH_SCAN_PREF`, `src/shared/types.ts:3066`), sticky messages, macOS permissions `:1508`, fx auto-resume and delay `:1530–1560`, getting started `:1570`. `HarnessesPage.tsx` (144 lines) has no behaviour block. Preferences are opaque strings (`server.ts:4260`). The value-level rules exist only for `disclaimSpawnedAgents`, `tmux_source` and `remoteAccess` (`docs/architecture/security.md:18–21`). e2e that reach the moved rows: `e2e/import-claude-sessions.spec.ts:97` (launch scan via `openSettingsGeneral`), and `e2e/fx-recovery.spec.ts` (verify). `e2e/helpers.ts:88` has `openSettingsGeneral` only.
- **Fakes and e2e.** `AGETOR_CLAUDE_DRIVER=fake` (`makeFakeAgent` `agents.ts:2522`, markers `FAKE_CLAUDE_*_PROMPT_MARKER`) bypasses tmux, so no e2e reaches a `tmux_prompt` today, and the answer route answers 410 because `sessionExists` checks real tmux. Playwright: `bun node_modules/@playwright/test/cli.js test e2e/<spec>`, one run at a time.
- **Tests that pin behavior this change alters.**
  - `src/bun/claude-tmux-scraper.test.ts` (matcher truth tables, #298 suite, `startupConfirmDecision`, tracker).
  - `src/bun/claude-tmux-askdrive.test.ts` (5 consent references).
  - `src/bun/claude-tmux-local-command.test.ts` (15 `dismissTmuxPrompt`).
  - `src/bun/claude-tmux-queue.test.ts` (11 `dismissTmuxPrompt`).
  - `src/bun/orchestrator-paste-withheld.test.ts` (4 route calls).
  - `src/bun/interactions.test.ts`.
  - `src/mainview/lib/tmux-prompt.test.ts`.
  - `src/cli/answer.test.ts`, `src/cli/tui/AnswerOverlay.test.tsx`.
  - `src/mainview/components/settings/SettingsDialog.test.ts`.
  - The stub-tmux seam for new integration tests: `src/bun/claude-tmux-slow-launch.test.ts:157`, `claude-tmux-death.test.ts:30`.

### Spike verdicts

From the brief: P1–P16, claude 2.1.326. The ones the plan rests on:

- P5: `--resume` re-asks the add-dir dialog.
- P7: keys sent within 500 ms of mount are refused, and the footer flips to held.
- P8: the two-row select wraps, and an accepted Enter on "No, exit" exits claude.
- P10: the cut-off variant has an `Adding:` trailer below the footer.
- P11: `--resume` of a missing JSONL exits 1.

**Run during planning (2026-11-17, claude 2.1.326; D6 spike)**, on a scratchpad `CLAUDE_CONFIG_DIR`, with network denied through `sandbox-exec -p '(version 1)(allow default)(deny network*)'`:

| Case | Result |
| --- | --- |
| Logged out (fresh config dir) | `claude auth status` → JSON `{"loggedIn": false, "authMethod": "none", …}`, **exit 1**, ~0.2 s. Works with network denied. `--text` prints `Not logged in. Run claude auth login to authenticate.` |
| Logged in (default account) | exit 0, `loggedIn: true`, `authMethod: "claude.ai"`. Works with network denied. `~/.claude.json` is unchanged and nothing new appears under `~/.claude/`. The JSON also carries `email`, `orgId`, `orgName`, `subscriptionType`, so **only `loggedIn` may be read and nothing else logged**. |
| Writes | On an **existing** config: none. Two reruns left the same hash and no new files. On a **never-launched, empty** config dir: the first run bootstraps `.claude.json` (firstStartTime, machineID, migrationVersion), a `.claude.json.lock` dir and a `backups/` dir. Claude's own first launch writes the same files. |

**Verdict: the pre-flight is in.** One constraint goes with it: probe only when the account's `.claude.json` exists (`claudeRootFor` resolution). When it doesn't, fall back to `loginEvidence()`. Then agetor never writes another program's config.

**Live facts checked:**

- `claude --version` → 2.1.326.
- `claude auth status --help` → `--json` (the default) and `--text`.
- `codex --version` → 0.166.0, and `codex exec --help` lists `--add-dir <DIR>`. `codex exec resume` has none of its own, so agetor passes it as a parent flag (`agents.ts:1140–1155`).
- `which copilot` → not installed.
- codex passed a multi-repo first turn and a follow-up on 2026-11-12 (`docs/architecture/multi-repo-tasks.md:600`).
- Copilot's real-binary test passed on 1.0.109 (`multi-repo-tasks.md:243`). Executing an npm-downloaded copilot binary needs the owner's go-ahead (fleet memory, 2026-11-12: the owner ran it via `!`).

### Repo rules that bear on this change (CLAUDE.md unless noted)

- "Agetor never adds its own text to a message." Every fix sends keystrokes only, and the OAuth code is the user's own text.
- "RunPanel is one long-lived instance." New card state lives in the card component, keyed by `req.id`, never in `RunPanelBody`. If any per-task state is added there, it gets a `[task.id]` reset line.
- "Text the CLI or TUI prints from stored or third-party data goes through `src/shared/terminal-text.ts`." This covers the pane text in `agetor answer` and the TUI.
- "Every route needs a `ROUTE_POLICY` entry." No new route is planned. The new body shapes ride the existing `app+cli` route behind a closed allow-list.
- "Every spawn goes through `coreSpawn`" and `env: childEnv(...)`. The `claude auth status` probe follows `probeEnvFor(harness)` like fx.
- "The Bun main thread is shared." Probes are async and capped at 5 s, and nothing loops synchronously.
- "A popover inside a dialog carries `data-popover-open`…" applies to any new popover on the card. None is planned.
- Status tokens only (`text-warning`, …), never palette classes (UI conventions).
- Memory "No real tickets in code": fixtures use synthetic paths (`/Users/me/…`, `repo-e`), per D28.
- `docs/architecture/harness-claude-code.md:24,:41,:75` state the boot-poller and trust-dialog contract, the unnumbered-matcher guards and the "no paste may ever type Enter into a live modal" rule. All stay true and get extended.
- Fleet knowledge `dbe6fe4d…` (the 2.1.284 trust-dialog lesson: two sightings, ≥150 ms gaps, verify the dialog left) and `2617e244…` (a `CLAUDE_CONFIG_DIR` account's login lives in a keychain item keyed by the dir).

### Runtime and trust shape

- **One Bun core per machine** owns every tmux session on its own socket. Cards live in memory, so a core restart loses them. The boot poller and the deferred paste are per-spawn IIFEs. A per-task `queueTmuxOp` chain serialises every keystroke agetor sends.
- **Callers.** The desktop app (master token) and the CLI and TUI (CLI token) all answer cards through one route. Any process running as the user can read the CLI token. The SQLite file is agent-writable, so a stored preference is only a request (`security.md:53`).
- **Pane text is agent-influenced.** Transcript text can quote a dialog. So auto-confirm is gated by the startup window, the exact labels and the path equality, never by a preference alone.

## 3. Approach & key decisions

1. **A new pure module, `src/bun/claude-prompt-screens.ts`, for every new screen shape.** It covers the add-dir family parser, the held and cut-off variants, Enter-only, paste-code, the theme picker, the Enter-hint footer allow-list, `redactPaneSecrets` and `validateOAuthCode`. `claude-tmux.ts` (12,327 lines) only wires them in.
   - Why: the pure shape logic gets its own unit tests, the hot file stays smaller, and Wave 1 can build it in parallel with everything else. *Reasoning.*
   - Rejected: adding more matchers inside `claude-tmux.ts`. That serialises every task on one file.
2. **Auto-confirm only through `matchAddDirAutoTrust(pane, autoTrustDirectories)`**, called from the existing consent tracker path (D1, D3). It needs all of the following:
   - the startup title `Adding a new directory:`;
   - the cancel label `No, exit`;
   - the exact affirmative `Yes, add it`;
   - a footer in the armed, held or cut-off shape at the bottom of the pane;
   - a rejoined path equal to one of this spawn's `autoTrustDirectories[].paths` (as passed, plus the realpath of the agetor-owned worktrees root joined with the name, so `/tmp` ↔ `/private/tmp` can't defeat it).

   The list is empty when the preference is off, so the matcher refuses. *Evidence:* P1, P2, P4–P6, and Appendix A.
   - Rejected: persisting trust in `~/.claude.json`. The owner turned that down in round 1.
   - Rejected: keying on fingerprint only. Two repos give the same fingerprint (P2).
3. **The fingerprint of an add-dir dialog includes its path.** Two dialogs are then two tracker entries and two cards, which removes defect 2's root as well as the TTL symptom. The boot-time TTL prune (D24) still lands for every other identical follow-up dialog. *Evidence:* P2.
4. **Every agetor-driven keystroke into a dialog starts from a live re-read** (D13, D22, D23).
   - `confirmStartupDialog` (auto) and `answerTmuxPromptInPane` (cards) capture the pane inside the `queueTmuxOp` body and re-match the same dialog. Identity is the title, path and labels, not the cursor.
   - They compute arrows from the **live** cursor, never sending Down when the cursor can't be read.
   - They wait ≥500 ms after the dialog's first sighting, leave ≥150 ms between Down and Enter, and verify the dialog left (not held).

   A refused auto-confirm retries up to 4 times. A refused card answer re-cards with `held: true`. *Evidence:* P3, P7, P8, and decoded binary B.
5. **The resume consent window.** On a spawn whose JSONL already exists, the boot poller keeps one job: matching consent dialogs. It stops once the pane shows claude's idle composer or working chrome, or a JSONL line is appended after the spawn, or `CLAUDE_BOOT_TIMEOUT_MS` passes with no dialog seen (re-armed while one is seen). While the tracker owns a dialog, `scrapeOnce` does not card it. **One owner per dialog:** the tracker, or the scraper only after the tracker gave up. *Reasoning from `:9180–9198` + P5.*
   - Rejected: auto-confirming from `scrapeOnce`. The runtime scraper runs for the whole session, where transcript text can quote a dialog. That widens the window for a false positive.
6. **The deferred paste waits on a shared "startup dialog on pane" signal** (the poller's last-sighting timestamp), not only on pending cards. It re-arms while either is true and never prints "delivering prompt anyway" into a known dialog (D25).
7. **Session ids (D11).**
   - (a) `spawnAgent` stops calling `onSessionId` before spawn. It passes it as `ClaudeLaunchOptions.onSessionFileReady`, which `spawnClaudeViaTmux` calls only when the JSONL is found (immediately on a resume whose JSONL exists).
   - (b) A pure `resolveClaudeResume({resumeSessionId, jsonlExists})` in `agents.ts` turns a resume of a missing JSONL into a fresh launch with `--session-id <same id>` and a status line.
   - Resumed and inherited run inserts are audited: each either inserts `claudeSessionId: null` and lets file-ready stamp it, or keeps its pre-stamp with a written reason. The swap path reads the id only after it is recorded, and TT6 pins that order.
   - **Consequence:** a core restart during a boot (before the JSONL) now orphans that run instead of reattaching it. The boot was not yet past the point a reattach could resume, so the next turn starts fresh. This goes in the PR body and in `harness-claude-code.md`.
8. **Enter-only and paste-code are new `answerKind`s on the existing `tmux_prompt` card, not new interaction kinds.**
   - The route accepts exactly one of `{key}`, `{reject:true}`, `{enter:true}` (only on `answerKind:"enter"`) or `{code}` (only on `answerKind:"code"`, validated by `validateOAuthCode`). Anything else is a 400 that never echoes the value.
   - The answer promise carries the sentinels `__enter__` and `__code__`, never the code.
   - Rejected: a new interaction kind. It would widen the propagation surface (SSE, pending list, toasts, pipeline-parent fan-out, CLI/TUI routing) for no gain.
9. **One redaction point.** `registerTmuxPrompt` applies `redactPaneSecrets` to every card's `paneText`. Every pane dump in `claude-tmux.ts` (boot timeout, slow launch, death) applies it too. It masks the remainder of any `Paste code here if prompted >` line.
10. **Footer widening (D12)** is an **allow-list** of `Enter to <verb>` hints extracted from the 2.1.326 binary (`chord:"enter",action:…`, brief App. B). Each verb is classified as a modal footer or as chrome. Chrome hints are excluded, with negative fixtures: for example the background-sessions bar `· enter to return · space to reply`, and anything shown under an idle composer. The existing `paneShowsIdleInputBox` and `paneShowsClaudeWorking` gates still apply. *Evidence:* binary. Each modal verb gets a binary-extracted or captured fixture.
11. **Claude login probe (D5–D7).**
    - `probeClaudeAuth` in `agent-status.ts` runs `claude auth status --json` through `coreSpawn` with `probeEnvFor(harness)`, capped at 5 s and fail-open, and parses only `loggedIn`. It skips the probe (and uses `loginEvidence`) when `.claude.json` is absent.
    - The cache mirrors fx's (`STATUS_CACHE_TTL_MS`), with `freshAuth` bypass at Start.
    - `peekClaudeLoggedIn` (sync) feeds `memberUnusableReason`. `refreshClaudeAuth(harnesses)` warms the cache, in parallel within 5 s, before every stack planner, so the skip works on a headless core with no `/harnesses` poll.
12. **Settings (D2).**
    - General is regrouped under headings.
    - A new `HarnessBehaviourSection` on the Harnesses page holds:
      - Claude Code: the tmux source, the new auto-trust toggle, and the session-import scan, shown once and labelled for Claude Code and OpenCode;
      - fx: auto-resume and its delay.
    - The preference key and its "default on" reader live in a new `src/shared/claude-auto-trust.ts`, so `src/shared/types.ts` stays untouched.
    - **D14:** no value-level refusal, so the CLI may set it either way. The real boundary is decision 2's path equality.
13. **Fake-pane seam for e2e.** `claude-tmux.ts` exports `registerFakePromptPane(taskId, {text, onKeys})`, honoured only under `AGETOR_CLAUDE_DRIVER=fake`. It registers the card through the **same** matcher chain and lets `answerTmuxPromptInPane` and `sessionExists` treat the fake pane as live. New fake markers drive it, so the e2e exercises the real route, allow-list, matcher and card.

**Pinned interfaces** (same-wave tasks code against these):

```ts
// src/bun/claude-prompt-screens.ts (T1)
export interface AutoTrustDirectory { name: string; paths: string[] }
export type AddDirFooter = "armed" | "held" | "cutoff";
export interface AddDirDialog {
  variant: "startup" | "later" | "move" | "apply"; // No, exit | No, leave it out | No, stay put | No, keep them off
  title: string | null;          // null when scrolled off (cut-off)
  path: string | null;           // rejoined across wrapped lines
  labels: string[];              // choice labels in screen order
  cursorIndex: number | null;    // null = no ❯ row readable
  yesIndex: number;
  footer: AddDirFooter;
  identity: string;              // title+path+labels — cursor excluded
}
export function parseAddDirDialog(pane: string): AddDirDialog | null;
export function matchAddDirAutoTrust(pane: string, dirs: AutoTrustDirectory[]):
  { name: string; dir: AutoTrustDirectory; acceptIndex: number; cursorIndex: number | null;
    footer: AddDirFooter; fingerprint: string } | null;
export const HELD_FOOTER_RE: RegExp;
export const ENTER_HINT_FOOTER_RE: RegExp;   // replaces MODAL_FOOTER_RE's alternatives
export function matchEnterOnlyScreen(tail: string): { paneText: string; fingerprint: string } | null;
export function matchPasteCodeScreen(tail: string): { paneText: string; fingerprint: string } | null;
export function matchThemePicker(tail: string):
  { paneText: string; choices: { key: string; label: string }[]; cursorIndex: number; fingerprint: string } | null;
export function redactPaneSecrets(text: string): string;
export const OAUTH_CODE_MAX_LEN = 512;
export function validateOAuthCode(raw: unknown):
  { ok: true; code: string } | { ok: false; error: "not-a-string" | "empty" | "too-long" | "multi-line" | "control-char" };

// src/bun/interactions.ts (T2)
TmuxPromptRequest.answerKind?: "choice" | "enter" | "code";   // absent ≡ "choice"
TmuxPromptRequest.held?: boolean;                              // re-carded after a refused confirm
// answer sentinels: "__enter__", "__code__" (the code itself never enters the registry)

// src/bun/claude-tmux.ts (T6)
ClaudeLaunchOptions.autoTrustDirectories?: AutoTrustDirectory[];
ClaudeLaunchOptions.onSessionFileReady?: (sessionId: string) => void;
export function matchStartupConsentDialog(pane: string, ctx?: { autoTrustDirectories?: AutoTrustDirectory[] }): StartupDialogMatch | null;

// src/bun/claude-tmux.ts (T9)
export type PromptAction = { kind: "choice"; key: string } | { kind: "enter" } | { kind: "code"; code: string };
export type PromptDriveResult = { ok: true } | { ok: false; reason: "no-session" | "dialog-changed" | "wrong-kind" | "send-failed" };
export async function answerTmuxPromptInPane(pending: TmuxPromptRequest, action: PromptAction): Promise<PromptDriveResult>;
export function registerFakePromptPane(taskId: string, pane: { text: string; onKeys: (keys: string[]) => void }): void;
export function clearFakePromptPane(taskId: string): void;

// src/bun/agents.ts (T7)
SpawnAgentArgs["opts"].autoTrustDirectories?: AutoTrustDirectory[];
export function resolveClaudeResume(a: { resumeSessionId: string | null; jsonlExists: boolean; newId: () => string }):
  { sessionId: string; resume: boolean; status: string | null };

// src/bun/agent-status.ts (T3)
export function peekClaudeLoggedIn(harness: Harness): boolean | null;
export async function refreshClaudeAuth(harnesses: Harness[], budgetMs?: number): Promise<void>;

// src/shared/claude-auto-trust.ts (T5)
export const CLAUDE_AUTO_TRUST_PREF = "claude_auto_trust_repositories";
export function isClaudeAutoTrustOn(stored: string | undefined | null): boolean; // default on; off only for "0"|"false"|"off"

// webview + CLI body (T2): answerTmuxPrompt(id, {key} | {reject:true} | {enter:true} | {code})
```

## 4. Work breakdown — implementation tasks

Every task's agent works in the pipeline worktree. It never runs `git stash`/`pop`/`checkout` on files it doesn't own (memory "No git stash in subagent briefs"), and it starts with `export PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH"` (memory "Bun PATH in agetor worktrees"). The scripted-edit rule applies: assert each replace hit exactly once.

| ID | Goal | Owned files | Depends on | Acceptance (scenarios) | Risk | Wired by |
| --- | --- | --- | --- | --- | --- | --- |
| **T1** | Pure screen matchers + version-tagged fixtures | `src/bun/claude-prompt-screens.ts` (new), `src/bun/claude-prompt-screens.test.ts` (new), `src/bun/fixtures/claude-prompts/2.1.326/*.txt` (new) | — | **Capture:** re-capture live with claude 2.1.326 per the brief §6 recipe (own `tmux -L` socket, 80x24, scratch repos outside any trusted path): add-dir startup armed (1 and 2 repos), held (send Down+Enter within 300 ms), cut-off (long path), mid-session `/add-dir` (`No, leave it out`), `/cd` (`No, stay put`/`Yes, move here`), theme picker and login method from a fresh `CLAUDE_CONFIG_DIR` (stop before picking a method). Build `Login successful…`, `Security notes…`, `Press Enter to retry.` and `Paste code here if prompted >` from binary strings (D19, A4). Scrub every path to `/Users/me/…`/`repo-a…` (D28). Header line `# claude 2.1.326 · <live\|binary>` in each file. **Given** the startup fixture and `dirs=[{name:"repo-e",paths:[<that path>]}]`, **then** `matchAddDirAutoTrust` returns `acceptIndex` 1, cursor 0, footer `armed`. **Given** the same with the path not listed, the `later`/`move` variants, an `Is this a directory…` sentence quoted inside a transcript above an idle composer, or `dirs=[]` → `null`. Held fixture → footer `held`, cursor read. Cut-off fixture → path from the `Adding:` trailer, footer `cutoff`. Two repos' dialogs → different fingerprints. `matchEnterOnlyScreen` hits only with the press-Enter line in the last 3 non-blank lines and no `❯`/`›` row and no choice rows in the dialog region (negative: a press-Enter line above choice rows; above an idle composer). `matchPasteCodeScreen` hits the paste-code line; `redactPaneSecrets` turns `Paste code here if prompted > abc123` into `Paste code here if prompted > ••••` and leaves everything else byte-identical. `validateOAuthCode`: 512 chars ok; 513 → `too-long`; `\n`, `\r`, `\t`, ESC, DEL, C1 → refused; non-string → `not-a-string`; whitespace-only → `empty`. `ENTER_HINT_FOOTER_RE` matches every allow-listed modal verb fixture and none of the chrome negatives (`enter to return · space to reply`, idle-composer hints). The verb list and its classification are written as a comment table citing the binary strings. | trust | T6, T9 (claude-tmux), T2 (`redactPaneSecrets`), T10 (`validateOAuthCode`) |
| **T2** | Interaction contract + the redaction choke point | `src/bun/interactions.ts`, `src/bun/interactions.test.ts`, `src/mainview/lib/api.ts` (types + `answerTmuxPrompt` body union only), `src/cli/api-client.ts` (body type only) | T1 (pinned `redactPaneSecrets`) | `TmuxPromptRequest` gains `answerKind`, `held` (pinned). `registerTmuxPrompt` stores `redactPaneSecrets(paneText)`: a registration with an echoed code stores and broadcasts the masked text. `answerKind:"enter"\|"code"` with non-empty `choices` or `unparsable:true` throws. `__enter__`/`__code__` are accepted only as answer sentinels, and choices may still not start with `__`. Webview `PendingTmuxPrompt` mirrors `answerKind` and `held`. `bun run typecheck` green. | trust | T6/T9 register through it; T10, T11, T12 consume the types |
| **T3** | Claude Code login probe | `src/bun/agent-status.ts`, `src/bun/agent-status.test.ts` | — | **Given** a stub claude printing `{"loggedIn":false,…}` exit 1 → `checkHarness(...).loggedIn === false`, `authHelp` = "run `claude auth login`, or open a terminal for this account from Settings → Harnesses". `loggedIn:true` exit 0 → `true`. Non-JSON / timeout (>5 s) / spawn error / missing field → `null`. With `.claude.json` absent in the account root → no spawn, and the value comes from `loginEvidence` (`false` → `false`, else `null`). The probe uses `coreSpawn` + `probeEnvFor(harness)`. stdout never reaches a log, error or status (assert on a stub that prints an email). Cached for `STATUS_CACHE_TTL_MS`. `freshAuth:true` bypasses the cache. `peekClaudeLoggedIn` returns the cached value or `null`. `refreshClaudeAuth` probes in parallel and returns within its budget. Existing `/bin/echo` claude tests stay green (echo output → `null`). | external, trust | `checkHarness` (existing callers: `startTask` pre-flight, `/harnesses` poll, `App.tsx:2637` dot); T7/T8 call `refreshClaudeAuth`/`peekClaudeLoggedIn` |
| **T4** | Spike codex + copilot `--add-dir` on a multi-repo task (D17, D18) | `docs/plans/claude-enter-to-confirm-prompts-spikes.md` (new) | — | **codex 0.166.0:** build the real argv through `buildCommand` (a `bun -e` script in the scratchpad) for a 2-repo task. Run `codex exec --json … --add-dir A --add-dir B "reply ok"` and a follow-up `codex exec … --add-dir A --add-dir B resume <thread> "reply ok"` in scratch repos. Record: accepted or refused flags, any trust or approval prompt, writes allowed under each extra dir in Auto. **copilot:** install into a **scratch prefix** (`npm install --prefix <scratchpad>/copilot @github/copilot`, never global). **Ask the owner** before executing the downloaded binary (fleet memory 2026-11-12), or have them run it via `!`. Run `AGETOR_COPILOT_REAL_BIN=… bun test src/bun/copilot-real-binary.test.ts`. The doc records versions, commands, verdicts, and a **fix list with size**. Barrier rule: anything beyond a small argv/flag fix (no new route, migration, driver or UI) goes to the owner before T14 is planned in detail. If no install go-ahead comes, copilot is recorded as unverified and listed in §8. | external | n/a (research; feeds T14) |
| **T5** | Settings regroup + Harnesses **Behaviour** block + auto-trust toggle | `src/shared/claude-auto-trust.ts` (new), `src/mainview/components/settings/SettingsDialog.tsx`, `src/mainview/components/settings/HarnessesPage.tsx`, `src/mainview/components/settings/HarnessBehaviourSection.tsx` (new), `src/mainview/components/settings/SettingsDialog.test.ts`, `e2e/helpers.ts`, `e2e/import-claude-sessions.spec.ts`, `e2e/fx-recovery.spec.ts`, `e2e/harness-behaviour-settings.spec.ts` (new) | — | General shows headings Appearance (theme, font size, sticky messages) · Tasks (default harness) · Privacy & security (macOS permissions) · Background (`BackgroundSection`) · Getting started, and no harness-specific row. Harnesses → Behaviour shows Claude Code (tmux source, **"Auto-trust a task's repositories"** switch, default on, with a one-line explanation that it only confirms the checkouts agetor created for the task, for this session), the session-import scan (one control, labelled for Claude Code and OpenCode), and fx (auto-resume + delay). Each control writes the same preference or route it wrote before (no key renamed). The toggle writes `CLAUDE_AUTO_TRUST_PREF` `"1"`/`"0"`. `isClaudeAutoTrustOn(undefined)` → true. Last-write-wins write queue like the launch-scan toggle. Status tokens only. `e2e/helpers.ts` gains `openSettingsHarnesses`. The launch-scan e2e moves there, and fx-recovery's settings steps follow the moved rows. The new spec toggles auto-trust and reads the preference back through the API. | none | `SettingsDialog` → `HarnessesPage` (existing Settings route); the preference is read by T7 |
| **T6** | claude-tmux **boot path**: consent, tracker, resume window, deferred paste, matcher wiring, masking, file-ready stamping | `src/bun/claude-tmux.ts` | T1 (W1), T2 (W1) | (1) `matchStartupConsentDialog(pane, {autoTrustDirectories})` returns `add-dir:<name>` matches via `matchAddDirAutoTrust`. bypass/trust-folder are unchanged. (2) `confirmStartupDialog`: waits until ≥500 ms after first sighting; re-captures; aborts if the identity differs; Down only if the live cursor ≠ yes **and** is readable; ≥150 ms Down→Enter; never Down from `cursorIndex:null`. (3) Tracker: a held footer counts as **present** (never "absent → auto-confirmed"); retries from the live cursor ≥500 ms after the refusal, ≤4 attempts, then gives up → card. A status line per repo per D21, emitted only after the dialog has been absent for 2 polls. (4) Boot poller: prunes `recentlyAnsweredFingerprints` older than 3 s each tick; a suppressed sighting sets `sawStartupPromptThisWindow`; unparsable cards need 3 stable ticks; theme picker, enter-only and paste-code match at boot. (5) Resume consent window per §3.5; `scrapeOnce` skips registering a pane the tracker owns. (6) Deferred paste re-arms while the poller saw a startup dialog within the last poll window, or a card is pending; no "delivering prompt anyway" with a dialog on the pane; boot timeout still ends it. (7) `MODAL_FOOTER_RE`, `matchUnnumberedModal`, `parseUnnumberedChoices`, `paneShowsBlockingPrompt` and `pickScrapeMatch` accept the held footer, the cut-off trailer, the allow-listed Enter hints, enter-only (→ `answerKind:"enter"`) and paste-code (→ `answerKind:"code"`). `paneShowsBlockingPrompt` withholds a paste on all of them. (8) Every pane dump goes through `redactPaneSecrets`. (9) `onSessionFileReady(sessionId)` fires once when the JSONL is found, and at once on resume; it is never fired on a boot timeout. (10) Doc comments on `STARTUP_CONSENT_DIALOGS` and `MODAL_FOOTER_RE` updated (D27). Existing suites `claude-tmux*.test.ts` other than TT2's two files stay green. | trust, concurrency, state | `spawnClaudeViaTmux` (existing; reached from `spawnAgent`) |
| **T7** | Launch plumbing: auto-trust dirs, session-id timing and resume check, stack auth warm-up | `src/bun/agents.ts`, `src/bun/orchestrator.ts` | T1, T3, T5 (W1); T6 pinned options (W2) | (1) `withTaskRepositoryRoots` adds `autoTrustDirectories` (name = workspace repo name, paths = as passed + realpath of the agetor worktrees root joined with the name; never stats inside the checkout) **only** when `isClaudeAutoTrustOn(preferences.get(CLAUDE_AUTO_TRUST_PREF))`. A single-repo task's opts stay byte-identical. (2) The claude branch passes `autoTrustDirectories` and `onSessionFileReady: onSessionId` to `spawnClaudeViaTmux` and no longer calls `onSessionId` pre-spawn. The fake branch is unchanged. (3) `resolveClaudeResume`: resume id + JSONL present (`jsonlPathFor(cwd,id,claudeConfigDirFor(harness))`) → `--resume`. Resume id + JSONL missing → `--session-id <same id>` + status `no saved claude conversation <id8>… — starting fresh under the same id`. No resume id → new uuid. (4) Audit the claude-code `runs.insert` sites (`:5763`, `:11810`, `:12102`, `:12206`). Resumed or inherited ones insert `claudeSessionId: null` unless a reader between insert and file-ready needs the id; each site's disposition goes in a code comment and the PR body. (5) `await refreshClaudeAuth(<stack members>)` before the sync planners at `:5287`, `:7443`, `:7729` (claude stacks only; within 5 s). (6) The skip status line reads `skipped <account label>: not logged in`. When all members are logged out, start is refused with the claude login hint. | state, concurrency, trust | `spawnAgentOrFail` → `spawnAgent` (existing); `startTask`/`sendInput`/swap paths (existing) |
| **T8** | Stack skip for logged-out Claude accounts | `src/bun/harness-failover.ts`, `src/bun/harness-failover.test.ts` | T3 | `memberUnusableReason` returns `"not logged in"` when `loginEvidence(h) === false` **or** `peekClaudeLoggedIn(h) === false`; `null` stays usable (fail-open). `prepareTaskHarness` awaits `refreshClaudeAuth(members)` before planning. A `none-usable` result whose reasons are all "not logged in" yields an error carrying the login hint. Tests: a 3-member stack with a logged-out middle member skips it at start and at swap; all logged out → refused with the hint; probe unknown → used. | state | stack planners (existing) ← `startTask`, limit swap, retry, manual switch |
| **T9** | claude-tmux **card drive**: live re-read, Enter-only, OAuth code, held re-card, fake-pane seam | `src/bun/claude-tmux.ts`, `src/bun/claude-tmux-local-command.test.ts`, `src/bun/claude-tmux-queue.test.ts` | T6 (W2) | `answerTmuxPromptInPane` (pinned) inside `queueTmuxOp`. **choice:** re-capture, re-match, compare identity (no cursor). A different dialog → `dialog-changed`, no keys. Arrows from the live cursor; ≥150 ms before Enter for the unnumbered/add-dir family (other modals keep 30 ms); `cursorIndex:null` → no Down, `dialog-changed`. After Enter, a held footer → `answerTmuxPrompt(__external__)` + re-register with `held:true` and return ok (the old card goes, a held card appears). **enter:** only if live `matchEnterOnlyScreen` hits with the same identity → one `Enter`. **code:** only `answerKind:"code"` and live `matchPasteCodeScreen` → `send-keys -t … -l -- <escapeTypedTrailingSemicolon(code)>`, ≥150 ms, `Enter`. The code is never in a thrown message, `console.*`, `onChunk` or the returned value. **wrong kind** → `wrong-kind`. `dismissTmuxPrompt` becomes a thin wrapper or is removed (its only caller is the route), and the two owned test files move to the new contract (stub `capture-pane`). **Fake seam:** `registerFakePromptPane` and `clearFakePromptPane` are a no-op unless `AGETOR_CLAUDE_DRIVER=fake`; registration goes through `pickScrapeMatch` → `registerTmuxPrompt`; `answerTmuxPromptInPane` delivers keys to `onKeys`; `sessionExists(taskId)` is true for a fake pane. | trust, concurrency | `POST /tmux-prompts/:id/answer` (T10) |
| **T10** | Answer route: closed allow-list for `enter` and `code` | `src/bun/server.ts`, `src/bun/server-tmux-prompt-answer.test.ts` (new), `src/bun/orchestrator-paste-withheld.test.ts` | T2; T9 pinned (same wave) | Body must carry exactly one of `key`/`reject:true`/`enter:true`/`code`, else 400 `"exactly one of key, reject, enter or code"`. `enter` on a non-enter card → 400. `code` on a non-code card → 400. `validateOAuthCode` failure → 400 with a fixed message per error code and **no echo** of the value (the test asserts the body doesn't contain the submitted string). Drive result mapping: `no-session` → 410 (existing text), `dialog-changed` → 409 `{ok:false,error:"the prompt changed on screen — the card will refresh"}`, `send-failed` → 500. Success → `markTmuxPromptAnswered` + `answerTmuxPrompt(id,{key:"__enter__"\|"__code__"\|key})`. The CLI token is accepted for all shapes (D15; `ROUTE_POLICY` unchanged, `route-policy.test.ts` green). After a code answer, no `run_events` row and no SSE payload contains the code. | trust | existing route table entry |
| **T11** | RunPanel card: Continue button and OAuth code box | `src/mainview/components/kanban/TmuxPromptAnswerControls.tsx` (new), `src/mainview/components/kanban/RunPanel.tsx` (render hook-up only), `src/mainview/lib/tmux-prompt.ts`, `src/mainview/lib/tmux-prompt.test.ts` | T2 | `answerKind:"enter"` → card title "Claude is waiting for Enter", the pane text, and the **Continue (press Enter)** primary button plus **Open in Terminal**. A click posts `{enter:true}`; `ok:false` clears the card; a 409/410/500 shows the error and keeps the card. `answerKind:"code"` → one-line input (`autocomplete="off"`, `spellCheck={false}`, `maxLength={512}`, Enter submits, no draft persisted, cleared on unmount) plus **Submit code**. `held:true` → hint "Claude didn't take the first keypress — choose again". Choice cards are unchanged. State lives in the card component keyed by `req.id`; nothing is added to `RunPanelBody`. Status tokens only. `tmux-prompt.ts` gains `tmuxPromptAnswerKind(req)`, unit-tested. | none | `TmuxPromptCard` in `RunPanel.tsx` (existing) |
| **T12** | `agetor answer` + TUI parity | `src/cli/commands/answer.ts`, `src/cli/answer.test.ts`, `src/cli/tui/AnswerOverlay.tsx`, `src/cli/tui/AnswerOverlay.test.tsx` | T2 | `answerTmux`: pane text printed through `escapeFreeText` (fixes `:322`). `enter` → options "Continue (press Enter)" / "Reject / Esc" → `{enter:true}`. `code` → `p.password` prompt (keeps it out of scrollback), validated locally with the same rules, → `{code}`; a 400 is shown without echoing the input. The TUI shows the same rows; `code` opens the existing one-line text field and submits `{code}`. A `held` hint line. A 409 shows "the prompt changed — run `agetor answer` again". Tests cover both kinds, reject, and no echo. | trust | `agetor answer` command, TUI answer mode (existing) |
| **T13** | Fake driver markers for the e2e | `src/bun/agents.ts` | T9 pinned | `FAKE_CLAUDE_ENTER_PROMPT_MARKER = "__agetor_fake_claude_enter_prompt__"`: the fake registers a fake pane with the binary-shaped `Login successful. Press Enter to continue…` screen via `registerFakePromptPane`, holds the turn, and on `["Enter"]` clears the pane and completes the turn with `continued`. `FAKE_CLAUDE_PASTE_CODE_PROMPT_MARKER = "__agetor_fake_claude_paste_code__"`: paste-code screen; on keys `[code…, "Enter"]` it completes with `code received (<n> chars)` and never the code. Documented beside the markers. Unit: both markers register a card with the right `answerKind`. | tests | `makeFakeAgent` under `AGETOR_CLAUDE_DRIVER=fake` |
| **T14** | codex/copilot fixes from T4 (only if T4 found any, and only the small ones) | decided at the W1 barrier: subset of `src/bun/agents.ts` (codex/copilot branches), `src/bun/codex-tmux.ts`, `src/bun/copilot-tmux.ts`, their tests; plus, if T4 finds an equivalent trust prompt, the label change in `HarnessBehaviourSection.tsx` (D3) | T4, T13 (agents.ts owner in W3) | Each T4 finding has a fix with a regression test that fails on the pre-fix argv, or is reported to the owner. If none: the task closes with "no change", and the spike doc says so. | external | `buildCommand` (existing) |
| **T15** | Docs | `docs/architecture/harness-claude-code.md`, `docs/architecture/multi-repo-tasks.md`, `docs/architecture/security.md`, `docs/architecture/harness-stacks.md`, `docs/architecture/harnesses.md` | T6–T13 | harness-claude-code: add-dir family, auto-trust rules, held/cut-off, resume consent window, live-cursor drive, Enter-only and code cards, theme/login at boot, deferred-paste wait, file-ready stamping + resume check + the mid-boot-restart consequence, the fake-pane seam and markers. multi-repo-tasks: claude add-dir trust and the preference; codex/copilot spike results. security.md: under "Multiple repositories in one task", auto-trust's boundary (path equality, startup window) and **D14** (the CLI may set it either way; owner decision; the DB is agent-writable anyway). Under the answer route, **D15** (OAuth code accepted from app, CLI and TUI; owner decision; closed allow-list; never persisted) and the redaction point. harness-stacks: the "not logged in" skip and warm-up. harnesses: the claude login pre-flight (spike facts, `.claude.json` rule, fail-open). `src/bun/claudemd-citations.test.ts` green. | none | n/a |

## 5. Work breakdown — test tasks

Each test must be shown red against a broken copy of the behavior it guards: revert the one line, run, see the assertion fail, restore. A test that needs the real `claude` or tmux and doesn't find it skips with a loud reason, never silently.

| ID | Layer | Covers | Owned files | Acceptance |
| --- | --- | --- | --- | --- |
| TT1 | unit | T1 | (inside T1) `src/bun/claude-prompt-screens.test.ts` | per T1 |
| TT2 | unit | T6 matchers and consent through the **real chain** | `src/bun/claude-tmux-scraper.test.ts`, `src/bun/claude-tmux-askdrive.test.ts` | Every 2.1.326 fixture through `pickScrapeMatch`, `paneShowsBlockingPrompt` and `matchStartupConsentDialog(pane, ctx)`: add-dir with ctx → consent match; without ctx → unnumbered card; held/cut-off → card + blocking; enter-only → `answerKind:"enter"`; paste-code → `"code"`; theme picker at boot only; chrome negatives → nothing. Tracker: held counts present; 4 attempts then give-up. `startupConfirmDecision` table extended. The #298 suite and existing truth tables stay green (updated only where T6 intentionally changes them, each change named in the PR). |
| TT3 | integration | T6 boot poller end to end (no test drives it today) | `src/bun/claude-tmux-boot-dialogs.test.ts` (new; stub `AGETOR_TMUX_BIN` that serves scripted `capture-pane` frames and records `send-keys`, as `claude-tmux-slow-launch.test.ts:157`) | (a) Pref on, 2 repos: two dialogs in sequence → keys `Down, Enter` per dialog, never before 500 ms, ≥150 ms gap; two status lines naming each repo; JSONL appears → `ready`. (b) Held after the first confirm → retry from the live cursor (cursor on Yes → Enter only). (c) Pref off: both carded; answering the first card re-cards the identical second (defect 2). (d) Path not in list → card. (e) Deferred prompt + dialog pending 40 s → no paste, no "delivering prompt anyway", paste after the dialog leaves (defect 3). (f) Resume (JSONL pre-exists) + add-dir dialog → auto-confirmed, `scrapeOnce` registers no card. (g) Boot timeout with a paste-code line on the pane → stderr dump masked. (h) Theme picker at boot → card after 2 ticks; unparsable → 3 ticks. (i) `onSessionFileReady` not called on timeout, called once on found. |
| TT4 | integration | T9 card drive | `src/bun/claude-tmux-card-drive.test.ts` (new; same stub seam) | The cursor moved since registration (registered 0, live 1) → no Down, Enter only. Dialog changed → `dialog-changed`, zero keys. `cursorIndex:null` → no Down. Held after Enter → old card resolved, new card `held:true`. enter → exactly one `Enter`, only when the live pane matches. code → `send-keys -l -- <code>` then `Enter`; spy on `console.*` and `onChunk`: the code never appears; trailing `;` escaped. Wrap hazard: a 2-row unnumbered dialog with the cursor on Yes and target Yes → no arrow. |
| TT5 | integration | T10 route | (inside T10) `src/bun/server-tmux-prompt-answer.test.ts` | per T10, through the real `Bun.serve` with master and CLI tokens; `route-policy.test.ts` unchanged and green. |
| TT6 | integration | T7 session ids (D11) | `src/bun/orchestrator-claude-session-fresh.test.ts` (new; real `spawnClaudeViaTmux` with stub tmux and stub claude bin, `AGETOR_DATA_DIR` mkdtemp at top level, `rmTestDataDir`, `snapshotHarnessState`) | Boot timeout → run row `claude_session_id` null → next turn's argv has `--session-id <new>` and no `--resume`. A legacy row stamped with an id whose JSONL is missing → argv `--session-id <same id>` + the status line. JSONL present → `--resume <id>`. Stamp order: the id appears on the row only after the stub writes the JSONL. A swap planned during boot (before the JSONL) → destination starts fresh and copies nothing. Single-repo opts byte-identical (no `autoTrustDirectories`); multi-repo with pref off → none; on → names + paths. |
| TT7 | unit | T3, T8 | (inside T3, T8) | per T3, T8 |
| TT8 | e2e | SC6, SC7 through the real route, matcher and card | `e2e/claude-tmux-prompt-actions.spec.ts` (new) | Fake driver + `FAKE_CLAUDE_ENTER_PROMPT_MARKER`: the card shows "Continue (press Enter)" → click → card gone → transcript shows `continued`. `FAKE_CLAUDE_PASTE_CODE_PROMPT_MARKER`: type `test-code-123` → Submit → card gone → `code received (13 chars)`; the run's events (`GET /tasks/:id/events`) and the DOM never contain `test-code-123`. A second Submit on a resolved card is harmless. |
| TT9 | live smoke | SC1, SC2, SC5, SC9 against real claude 2.1.326 | (no repo files; results in the PR body and the spikes doc) | Headless core per memory "Headless live smoke": `AGETOR_DATA_DIR=$HOME/.agetor-dev AGETOR_API_PORT=4319 AGETOR_API_TOKEN=<hex> bun src/bun/headless.ts`. Two scratch git repos **not** in `~/.claude.json`, a multi-repo claude task (haiku, auto): first run → two auto-confirm lines, a reply. Hibernate (stop the tmux session via the API), send a follow-up → resume → two auto-confirm lines again, a reply. Turn the preference off → follow-up → two cards → answer via `agetor answer` against port 4319 (never the prod core: memory "CLI smoke hits prod core") → reply. Login: add a scratch Claude account whose `CLAUDE_CONFIG_DIR` is an empty dir → start refused with the hint; a stack [scratch, built-in] → "skipped …: not logged in" and the run proceeds. Delete the smoke tasks and the scratch account afterwards (memory "Test cleanup"). Record the `~/.claude.json` entries the workspace-trust confirm adds (existing behavior). |

**E2e: applies** to the card actions (TT8) and to the moved Settings rows (T5's specs).

- **Run recipe:** `export PATH=…`, `bun install --frozen-lockfile` if `node_modules` is missing, then `bun node_modules/@playwright/test/cli.js test e2e/claude-tmux-prompt-actions.spec.ts e2e/harness-behaviour-settings.spec.ts e2e/import-claude-sessions.spec.ts e2e/fx-recovery.spec.ts`. `playwright.config.ts` starts Vite, and `e2e/fixtures.ts` starts a per-test backend with fake drivers. No credentials are needed.
- One Playwright run at a time (memory "agetor e2e via Playwright").
- The real tmux and claude paths can't run in CI e2e. They are covered by TT3/TT4 on the stub seam and by the TT9 live smoke.

**Full gates at the end:** `bun run typecheck`; `bun test`. Expected pre-existing failures are in memory "Pre-existing failing unit tests": tmux-socket ×2 + reconcile cancel; re-confirm on main before calling any of them pre-existing. Plus the e2e above, and TT9.

## 6. Execution waves

| Wave | Tasks (parallel) | Barrier (must be green before the next wave) |
| --- | --- | --- |
| W1 | T1, T2, T3, T4, T5 | `bun run typecheck`; `bun test src/bun/claude-prompt-screens.test.ts src/bun/interactions.test.ts src/bun/agent-status.test.ts src/mainview/components/settings/`; T5's e2e specs; **T4 review**: classify findings, and bring anything large to the owner before T14 is detailed. Checkpoint commit. |
| W2 | T6, T7, T8, TT2 | typecheck; `bun test src/bun/claude-tmux*.test.ts src/bun/harness-failover.test.ts src/bun/orchestrator*.test.ts src/bun/agents*.test.ts`; full `bun test` at the end of the wave. Checkpoint commit. |
| W3 | T9, T10, T11, T12, T13, TT3, TT6 | typecheck; full `bun test`. Checkpoint commit. |
| W4 | T14 (if any), T15, TT4, TT8 | typecheck; full `bun test`; e2e recipe; `claudemd-citations.test.ts`. Checkpoint commit. |
| Verify | TT9 live smoke; PR body | All gates above green; smoke results recorded. |

Ownership was cross-checked per wave, and no path appears twice:

- W1: T1 owns the screens module, its test and the fixtures. T2 owns `interactions.ts`, its test, `mainview/lib/api.ts` and `cli/api-client.ts`. T3 owns `agent-status.ts` and its test. T4 owns the spikes doc. T5 owns `shared/claude-auto-trust.ts`, the 4 settings files and 4 e2e files.
- W2: T6 owns `claude-tmux.ts`. T7 owns `agents.ts` and `orchestrator.ts`. T8 owns `harness-failover.ts` and its test. TT2 owns `claude-tmux-scraper.test.ts` and `claude-tmux-askdrive.test.ts`.
- W3: T9 owns `claude-tmux.ts` and 2 tests. T10 owns `server.ts` and 2 tests. T11 owns 3 webview files and 1 test. T12 owns 4 CLI files. T13 owns `agents.ts`. TT3 and TT6 own new files.
- W4: T14 owns its subset (agents.ts is free in W4). T15 owns the docs. TT4 and TT8 own new files.

The only knowingly tight coupling is T7 → T6's options and T10/T13 → T9's exports. All three are pinned in §3 and land in the same wave, so the barrier compiles them together.

**Delivery.** The change is roughly 3–4k lines with tests across several subsystems. The pipeline delivers on one branch with wave-ordered checkpoint commits. If the owner wants reviewable slices, the waves already cut into a stack in which each slice is wired and green:

1. **Boot and resume:** T1, T2, T5, T6, T7, TT2, TT3, TT6. This fixes defects 1–4 and ships the setting.
2. **Card actions:** T9–T13, TT4, TT8.
3. **Login pre-flight and stack skip:** T3, T8.
4. **Codex/copilot:** T4, T14.

T15 is split across the slices. Slice 3's code lands in W1/W2 for scheduling, so as a separate PR it would be cherry-picked.

## 7. Invariants, runtime shape & risks

**Invariants**, each with its single enforcement point:

- **Auto-confirm.** An auto-confirmed add-dir dialog is always the startup variant (`No, exit` / exact `Yes, add it`), whose rejoined path equals a directory agetor passed to **this** spawn, while the preference was on. Enforced in `matchAddDirAutoTrust` (`claude-prompt-screens.ts`). Its only caller is `matchStartupConsentDialog`, which only the boot poller's startup window calls. `withTaskRepositoryRoots` is the only producer of `autoTrustDirectories`.
- **Dialog keystrokes.** Every keystroke agetor sends to a claude dialog is computed from a live re-read of the same dialog. Enforced in `confirmStartupDialog` (auto) and `answerTmuxPromptInPane` (cards), and nowhere else; the route has no other path to `send-keys`.
- **One owner per dialog.** While the startup tracker holds a consent dialog, no card exists for it. Enforced in the boot poller and in `scrapeOnce`'s registration guard.
- **Card pane text.** Every card's `paneText` and every pane dump is redacted. Enforced in `registerTmuxPrompt` (cards) and the `redactPaneSecrets` calls at each dump in `claude-tmux.ts`; TT3(g) and T2's test pin both.
- **Free text into a pane.** Only `answerTmuxPromptInPane({kind:"code"})` types it, only on an `answerKind:"code"` card, only after `validateOAuthCode`. Enforced by the route's closed allow-list (T10).
- **Session id timing.** A run's `claude_session_id` is written only after its JSONL exists, and a resume runs only when the JSONL exists. Enforced in `onSessionFileReady` (`spawnClaudeViaTmux`) and `resolveClaudeResume` (`spawnAgent`), the single launch path for start, follow-up, swap and retry.
- **No text of agetor's own in a message.** Every new path sends keystrokes or the user's typed code, and the status lines are run events, not message text.

**Runtime shape.**

- Single core. Cards are in memory: a core restart loses a pending Continue or code card, and the scraper re-cards the screen after a reattach.
- A core restart mid-boot (before the JSONL) now orphans the run rather than reattaching it (§3.7), and the next turn starts fresh under a new id. Documented in T15 and the PR body.
- The `claude auth status` probe is one ~0.2 s child per Claude account per 60 s while the app polls `/harnesses`, at Start (fresh), and once per stack plan (warm-up, ≤5 s). It needs no network (spiked).
- **Kill switch:** the auto-trust preference turned off brings back a card per dialog. Nothing else is behind a flag; every other change is a bug fix.

**Trust.**

- Pane text is agent-influenced. The startup-window restriction plus the label and path equality mean a transcript quoting the dialog can't trigger an auto-confirm (T1 negative fixture).
- Any process that can read the CLI token can answer cards, submit an OAuth code (D15) and flip auto-trust (D14). Both are owner decisions with the risk shown, so they are documented in `security.md` and the PR body.
- A same-user process can already read the pane through the tmux socket, so `send-keys -l` putting the code briefly in a `tmux` argv adds no new exposure.

**Blast radius.**

- `claude-tmux.ts` matchers change for every claude session. Widening the footer is the main false-card risk, covered by the chrome negative fixtures and the existing idle and working gates.
- `MODAL_FOOTER_RE` widening also changes the paste guard, so a paste may now be withheld on a newly recognised modal. That is intended.
- `loggedIn` for claude now feeds `mergeModelOptions` rule 7 (kind-agnostic, `src/shared/model-options.ts:46–65`): a logged-out claude account shows only curated model rows. Accepted, as documented there.
- Settings rows move, but no preference key or route changes.
- Existing run rows that carry a never-created id are healed by `resolveClaudeResume` with no migration.
- There is no schema change or migration.
- Rollback: revert the branch; the preference key is harmless if left in the DB.

**Cross-repo dependencies:** none.

**Top risks.**

1. Claude version drift. The add-dir dialog appeared in a patch release. Every pane fixture is version-tagged, so a new version's capture slots in.
2. The resume consent window overlapping a fast claude that already shows its composer. Its close conditions are idle composer, working chrome or a JSONL append; TT3(f) pins it.
3. Stub-tmux tests passing while real claude behaves differently. TT9 against the real binary is the check.

## 8. Open questions / assumptions

No unratified one-way door. D14 and D15 relax guards the grill recommended keeping, but the **owner decided both** with the risk stated. They go in the PR body and in `security.md` for reviewers, not back to the owner.

| # | Assumption / open item | If wrong |
| --- | --- | --- |
| A1 | Two or more repositories were untrusted at the incident (brief §1.1). | The held state (P7) was the trigger. Both are fixed either way. |
| A3 | The theme picker and the press-Enter screens appear at boot only for a never-onboarded or logged-out config. | The boot-time cards (T6) cover the other case too. |
| A4 | `Login successful. Press Enter to continue…` matches the binary strings (D19). Not live-captured. | `matchEnterOnlyScreen` misses it, and the unparsable card (Open in Terminal) remains the fallback. **State it in the PR body.** |
| A6 | A ≥150 ms Down→Enter gap is enough under load. | D13's retry covers auto-confirms; the held re-card covers card clicks. |
| P-1 | *(planning choice)* The login probe is skipped when the account's `.claude.json` is absent, because the D6 spike showed `claude auth status` bootstraps that file on an empty config dir. `loginEvidence` decides instead. | A never-launched account with credentials but no `.claude.json` would read as "unknown" and is carded at boot. This is unlikely: OAuth login writes `.claude.json`. |
| P-2 | *(planning choice)* A core restart mid-boot orphans that run (§3.7). | If the owner wants a reattach to survive that window, T7 keeps a pre-stamp on a separate "pending" column. That needs a migration, so it would be a scope change. |
| P-3 | *(planning choice)* Resumed and inherited run inserts move to file-ready stamping only where no reader needs the id earlier; T7 records each site. | A site that must keep its pre-stamp still heals through `resolveClaudeResume`. |
| S-1 | The T4 codex/copilot spike may find more than a small argv fix. | It goes back to the owner at the W1 barrier (D17); nothing is deferred silently. |
| S-2 | Copilot needs the owner's go-ahead to execute the npm-downloaded binary (or the owner runs it via `!`). | Without it, copilot is recorded as unverified in the spikes doc and the PR body. Codex is still verified. |
| S-3 | The live smoke (TT9) needs real claude logins (the owner's default account) and adds scratch-path entries to `~/.claude.json` through the existing workspace-trust confirm. | Smoke is skipped for that part and recorded. |

## 9. Completeness ledger

| Item | Disposition | Task / reason / who |
| --- | --- | --- |
| Defect 1: add-dir dialog not auto-confirmed | In this run | T1, T6, T7 (D1) |
| Defect 2: identical follow-up dialog suppressed at boot | In this run | T6 (TTL + path fingerprint), TT3(c) |
| Defect 3: deferred paste fails the run into the dialog | In this run | T6, TT3(e) |
| Defect 4: retry resumes a never-created session | In this run | T7 (both mechanisms), TT6 |
| Resume (`--resume`) re-asks add-dir: consent window | In this run | T6, TT3(f), TT9 |
| Held footer (startup + mid-session) | In this run | T1, T6, T9, TT2–TT4 |
| Cut-off dialog / `Adding:` trailer (no resize) | In this run | T1, T6 (D26) |
| Mid-session `/add-dir`, `/cd`, "apply them" variants as safely driven cards | In this run | T1, T9 |
| Live-cursor drive for every card (not only add-dir) | In this run | T9 (D23) |
| Enter-only card action, app + CLI + TUI | In this run | T6, T9–T12, TT8 |
| OAuth paste-code box, app + CLI + TUI, never persisted, masked | In this run | T1, T2, T9–T12, TT4, TT5, TT8 |
| Theme picker + login method at boot | In this run | T1, T6 |
| Footer widened to every modal `Enter to <verb>` hint (chrome excluded) | In this run | T1, T6, TT2 |
| Paste guard covers held, cut-off, enter-only, paste-code | In this run | T6 (a paste into the code field would submit the user's message as a code) |
| Claude login pre-flight + header dot | In this run (spike passed) | T3; the dot needs no UI change (`App.tsx:2637`) |
| Harness-stack skip of logged-out accounts, at start and swap, all-logged-out refusal | In this run | T7, T8 |
| Settings General regroup + Harnesses Behaviour block + auto-trust toggle | In this run | T5 (D2, D3) |
| e2e specs that reach moved rows | In this run | T5 |
| Codex/copilot `--add-dir` spike + small fixes | In this run; large → owner at the W1 barrier | T4, T14 (D17, D18) |
| `agetor answer` prints unescaped pane text (`answer.ts:322`) | In this run | T12, a line this change touches; CLAUDE.md terminal-text rule |
| `dismissTmuxPrompt` superseded by `answerTmuxPromptInPane` | In this run | T9 removes it or keeps it as a wrapper; nothing left orphaned |
| The boot poller's `.has()` without prune | In this run | T6 replaces it |
| Fake-pane seam + markers documented | In this run | T13, T15 |
| Existing rows with a never-created session id | No migration | healed by `resolveClaudeResume` (D11) |
| Docs: harness-claude-code, multi-repo-tasks, security (D14, D15), harness-stacks, harnesses, code comments | In this run | T15, T6 (D27) |
| PR body statements: D14, D15, A4, the mid-boot reattach consequence, run-insert dispositions, spike results | In this run | final verify step |
| Tests at every layer in D20 | In this run | TT1–TT9 |
| Cursor, fx, OpenCode, Gemini, Antigravity add-dir prompts | Out of scope | they get no `--add-dir` (`multi-repo-tasks.md:234`) |
| Pipeline-parent surfacing of cards | Out of scope | owner, D16 |
| Resizing the boot pane | Out of scope | owner, D26 |
| Persisting add-dir trust in `~/.claude.json` | Out of scope | owner, round 1 (rejected option) |
| Fleet knowledge: the `claude auth status` spike facts, the add-dir guard | In this run | captured at planning (spike) and after T6 (guard) |

## 10. Execution notes (deviations from the plan, recorded at the end of the build)

None of these changes a decision the owner made; each is a smaller or safer reading of a task.

| # | Plan said | Built | Why |
| --- | --- | --- | --- |
| E1 | `resolveClaudeResume({ jsonlExists: boolean })` | `jsonlExists: (id) => boolean` | The file check only runs when there is an id to resume |
| E2 | `dismissTmuxPrompt` becomes a thin wrapper or is removed | Kept as the registered-cursor primitive, with a doc note that production uses `answerTmuxPromptInPane`; its 26 unit-test usages pin the shared walk and `confirmKey` choreography | Porting them added risk and no coverage; the route no longer calls it |
| E3 | T6 widens `matchUnnumberedModal` to every allow-listed Enter hint | Only `enter to confirm` and the held footer; `MODAL_FOOTER_RE` (unparsable arm, paste guard) takes every allow-listed hint | An existing test pins that the auto-mode wizard's `Enter to continue` stays an unparsable card (its answer changes a persistent setting) |
| E4 | `TmuxPromptRequest` gains `answerKind`, `held` | Also a server-side `identity` (cursor-free dialog identity), used by the card drive to refuse a changed dialog | The fingerprint of a menu includes its cursor, which moves |
| E5 | `OAUTH_CODE_MAX_LEN` / `validateOAuthCode` in `claude-prompt-screens.ts` | Implemented in `src/shared/oauth-code.ts` and re-exported there | One implementation for the route, the webview and the CLI/TUI (CLAUDE.md: extend `src/shared`, never fork) |
| E6 | `warmStackLogins` before every planner | Awaited before `prepareTaskHarness`, the limit swap and the all-exhausted retry; only started (not awaited) in `switchTaskAccountNow` and `applyScheduledSwitch` | Those two check state and take a claim in one synchronous run; an await let a start slip in (the S5 test caught it) |
| E7 | After a refused confirm a held dialog with the cursor on Yes gets `Up`, `Down`, `Enter` | Kept as a safety net; the live spike showed a refusal puts the cursor back on "No, exit", so the normal retry is `Down`, `Enter` | Live evidence, `claude-enter-to-confirm-prompts-spikes.md` |
| E8 | T14 (codex/copilot fixes) | Closed with no change: codex verified, copilot unverified on the current version | `claude-enter-to-confirm-prompts-spikes.md` |
| E9 | T1 fixtures captured live | The startup, held and cut-off dialogs are the live captures of the investigation (paths scrubbed); the mid-session `/add-dir`, `/cd` and apply variants, `Login successful`, `Security notes`, `Press Enter to retry` and the OAuth-code prompt are built from the binary's strings and tagged `binary` in their header (A4) | An OAuth round trip is needed for the last four |

The run-insert dispositions asked for by T7(4) are code comments at the four `runs.insert` sites in `orchestrator.ts`: all four **keep** their pre-stamp, because an id is now recorded only after its session file exists (so an inherited id names a real session, and boot reconcile's reattach key needs it from the start), and a legacy never-created id heals in `spawnAgent`.

