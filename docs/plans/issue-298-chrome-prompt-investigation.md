# Investigation — issue #298: Chrome browser-integration prompt blocks the task; bundled-tmux attach dies on terminfo

| Field | Value |
| --- | --- |
| Date | 2026-11-12 |
| Change | Make the unnumbered "Claude in Chrome extension detected" prompt answerable from Agetor, and make the bundled-tmux **Open in Terminal** fallback work on macOS hosts that do not have the build machine's Homebrew ncurses; surface a recoverable error when the terminal cannot be launched. |
| Agents | 0 subagents (this pipeline step forbids delegation); inline code/history reading + 4 scratchpad spikes |
| Flags | none |
| Branch | `fix/issue-298-bug-agent-gets-stuck-on-chrome` (base `40d014a4`) |
| Evidence | issue #298 body + screenshot; installed `Agetor 1.2.0` bundle; Claude Code `2.1.322`; macOS `26.6.2` |

## 0. One-paragraph summary

Two independent defects compound in the report. **(A) Prompt parsing:** current Claude Code renders the "Claude in Chrome extension detected" startup question as an **unnumbered** Ink select (`❯ No, keep browser tools off` / `  Yes, use my browser`) with an `Enter to confirm · Esc keep browser tools off` footer. Agetor has no generic unnumbered-choice matcher; the only unnumbered parser (`parseUnnumberedConsentChoices`, `src/bun/claude-tmux.ts:6063`) is private and reachable only through the known consent dialogs in `matchStartupConsentDialog`. The runtime/boot matcher chain therefore falls through to `matchUnparsableModal`, which registers the `unparsable: true` "Claude is asking something Agetor can't read" card with zero choices; the card's only action is **Open in Terminal**. **(B) Terminal fallback:** the app is using its bundled tmux (`/Applications/Agetor.app/Contents/Resources/app/bin/tmux` in the screenshot). That binary loads a vendored Homebrew `libncursesw.6.dylib` whose **compiled-in default terminfo directory is the build machine's Cellar path**, `/opt/homebrew/Cellar/ncurses/6.5/share/terminfo`; the bundle ships no terminfo database. Agetor's core-side tmux commands work because they run without a tty (stdout pipes), and tmux does not resolve terminfo for detached `new-session`/`has-session`; Terminal.app gives the attach a real tty and `TERM=xterm-256color`, so `tmux attach` tries the missing database and prints exactly `can't find terminfo database` before the shell exits. The task is left `running` with no answer path. Both halves were reproduced in isolation (parser: current `pickScrapeMatch` returns `unparsable: true` on the exact prompt; terminal: the exact error under a sandbox that hides the Cellar path, and a successful attach with `TERMINFO_DIRS=/usr/share/terminfo`).

## 1. What we know

### 1.1 How the card is produced today

- The unparsable card is the `req.unparsable === true` branch of `TmuxPromptCard` — `src/mainview/components/kanban/RunPanel.tsx:9240-9283` ("Claude is asking something Agetor can't read", `choices: []`, one **Open in Terminal** button, inline `openError`). The generic choice card directly below it (`:9285-9319`) renders `req.choices` as `${key}. ${label}` buttons and is fully wired to the answer route.
- `matchUnparsableModal(tail, watchdogArmed)` — `src/bun/claude-tmux.ts:5733-5767` — fires on (1) a footer matching `MODAL_FOOTER_RE` (`esc to cancel|enter to confirm|enter to continue`, `:5643`) among the **last 3 non-blank tail lines**, or (2) the stuck-turn watchdog (`stuckTurnFallbackArmed`, `:5668-5682`; turn in flight, JSONL quiet > 60 s, not working, no ask card, not idle). It returns `choices: []`, `unparsable: true`, and its own 3-consecutive-tick stability gate (`UNPARSABLE_STABILITY_TICKS`, `:7577-7580`).
- The boot poller (`spawnClaudeViaTmux`'s startup watcher, `src/bun/claude-tmux.ts:8962-9083`) calls `pickScrapeMatch(tail, { paneWorking, watchdogArmed: false })` at `:9040`. Because `watchdogArmed` is forced false at boot, the fallback can only fire through its **footer** arm (`:5761-5762`). The status line in the screenshot, "CLAUDE IS ASKING A QUESTION ON STARTUP — ANSWER IT TO CONTINUE", is emitted by this boot path at `:9080`; it is not emitted by the runtime scraper.
- The card's preview in the screenshot has no footer, but `req.paneText` does. `cleanPromptPane` (`src/mainview/lib/prompt-noise.ts:22-46`, `:57-64`) strips any line beginning with `enter to confirm` (case-insensitive). Confirmed with a spike: a pane ending in `Enter to confirm · Esc keep browser tools off` renders as just the two choice rows. Therefore the reporter's pane *did* carry a footer matching `MODAL_FOOTER_RE`, and the visible card is the boot poller's footer-arm fallback. The hidden footer is almost certainly the `ChromeAutoEnableDialog` input guide, `Enter to confirm · Esc keep browser tools off` (see §1.3).
- The answer/auto-resolve plumbing already exists and needs no new interaction kind:
  - `dismissTmuxPrompt` (`:2182-2258`) maps a choice key to its index, arrows from the scraper-observed `cursorIndex` to that index (one `send-keys` per press, 30 ms apart; `walkCursor`, `:2283-2296`), then sends `Enter` (or `ctx.confirmKey`). This is the same path every numbered modal uses.
  - The answer route validates the key against the registered choice set and calls `dismissTmuxPrompt` (`src/bun/server.ts:7945-8015`).
  - The `__external__` sweep in `scrapeOnce` resolves any pending prompt whose fingerprint is no longer on the pane (`claude-tmux.ts:7526-7535`), so once the user answers, the card clears without a dedicated resolver.
  - `markTmuxPromptAnswered` (`:7635-7649`) suppresses a ghost duplicate on the next repaint.

### 1.2 The matcher gap: no generic unnumbered menu

- The shared chain is `pickScrapeMatch` (`src/bun/claude-tmux.ts:5783-5785`):
  `matchNumberedModal ?? matchYesNoModal ?? matchSliderModal ?? (paneWorking ? null : matchUnparsableModal)`.
  It is used by both `scrapeOnce` (`:7440-7455`) and the boot poller (`:9040`), and is exported through `__forTest` (`:11141`).
- `matchNumberedModal` (`:5249-5358`) requires at least two rows with a literal `N.` prefix and exactly one `❯`/`›` cursor row. `matchYesNoModal` (`:5375-5391`) requires a `(y/N)` / `[Y/n]` tail. `matchSliderModal` (`:5524-5631`) requires a `▲` track, a label row, and `←/→ to adjust`. None can parse the Chrome prompt.
- The only unnumbered parser in the file is `parseUnnumberedConsentChoices` (`:6063-6097`):
  - it anchors on the **last** line containing `Enter to confirm` anywhere in the supplied pane,
  - walks upward over blank rows, collecting contiguous rows that are either a `❯`/`›` cursor row or a row indented 2+ spaces,
  - requires at least two rows and exactly one cursor row,
  - returns `choices` with 1-based keys and a `cursorIndex`.
  It is private and has exactly one caller: `matchStartupConsentDialog` (`:6030-6049`), which first requires a known consent-dialog marker (`bypass permissions mode` or `Quick safety check`/`trust this folder`) and then an affirmative option. That is why the trust dialog is auto-confirmed but the Chrome prompt is not parsed.
- The old Chrome fixture in the test suite is the **numbered** shape — `CHROME_EXTENSION_PANE` at `src/bun/claude-tmux-scraper.test.ts:412-446`, with `❯ 1. Yes, use my browser` / `  2. No, keep browser tools off` and `Enter to confirm · Esc to keep browser tools off`. The test asserts `matchNumberedModal` parses it and `matchStartupConsentDialog` does not auto-confirm it. There is **no fixture/test for the unnumbered shape**, which is why the current regression is green.
- `parseUnnumberedConsentChoices` will parse the unnumbered Chrome prompt if it is given the chance: spike output = two rows, cursor index 0. But it also parses a transcript that quotes such a menu, and there is no `paneIdle` check in the parser. Any generic use must add guards (see §3/§4).

### 1.3 Claude Code's actual prompt shape

- Official docs, "Use Claude Code with Chrome" → "Answer the startup dialog" (`https://code.claude.com/docs/en/chrome`): the "Claude in Chrome extension detected" dialog appears at startup; **Yes, use my browser** turns the setting on and connects the session; **No, keep browser tools off**, or Esc, turns the setting off and Claude Code stops offering Chrome setup. This is a user policy choice, not an Agetor decision.
- The reporter's screenshot shows exactly two unnumbered rows, cursor on **No, keep browser tools off**, header "Claude in Chrome extension detected", and an Auto-mode paragraph. The card preview omits the footer (see §1.1).
- The user's installed Claude Code is `2.1.322` (this machine's CLI). Its `ChromeAutoEnableDialog` component in the Mach-O strings renders the same dialog with:
  - `hideIndexes: !0` (no `N.` prefixes),
  - `cancelFirst: !0` (No row first),
  - `focus: "cancel"` (cursor starts on No),
  - `confirmLabel: "Yes, use my browser"`, `cancelLabel: "No, keep browser tools off"`,
  - an `inputGuide` built from `Enter` / `Esc`, with the Esc entry described as `keep browser tools off`.
  The screenshot matches this shape. The older numbered fixture is a previous CLI rendering, not the current one.
- The prompt is a one-time user setting (`claudeInChromeDefaultEnabled` / `hasCompletedClaudeInChromeOnboarding` in `~/.claude.json`). Auto-answering "No" would permanently turn Chrome integration off for the user; auto-answering "Yes" would connect their logged-in browser session without consent. The existing design (test comment at `claude-tmux-scraper.test.ts:412-416`) deliberately does not auto-confirm. The fix must present the choice, not choose it.
- The same `er` select component family is used by the 2.1.284 unnumbered workspace-trust dialog, which Agetor drives with `Down` + `Enter` through `confirmStartupDialog` (`:6120+`) and `parseUnnumberedConsentChoices` (commit `d4df873d`; the unit tests pin the cursor/accept indexes, and `docs/architecture/harness-claude-code.md:23` records the boot poller confirming that dialog). That is strong evidence that arrow-navigation + Enter will work for the Chrome prompt too, but the Chrome prompt itself has not been live-driven here (it requires a fresh Chrome-onboarding state; this machine already has `claudeInChromeDefaultEnabled: true`).

### 1.4 Why the terminal attach fails

- `POST /tasks/:id/open-tmux` — `src/bun/server.ts:7040-7128`:
  - resolves the binary with `resolveTmuxBin()` (`src/bun/tmux-resolution.ts:62-67`),
  - checks the tmux binary and the live session,
  - builds `tell application "Terminal" to do script "exec \"<tmux>\" \"-L\" \"agetor\" attach -t \"<session>\""`, then calls `activate application "Terminal"` (`:7100-7110`),
  - spawns `/usr/bin/osascript` and **returns `{ ok: true }` immediately**, only logging a non-zero exit (`:7112-7126`). The harness terminal route directly above it (`:5759-5801`) does the opposite: it awaits osascript with a 5 s ceiling and returns a 502 with a recoverable message.
- The screenshot's command is the **bundled** binary:
  `/Applications/Agetor.app/Contents/Resources/app/bin/tmux -L agetor attach -t agetor-92876414-902`.
  `bundledTmuxPath()` (`src/bun/tmux-resolution.ts:17-30`) points at `Contents/Resources/app/bin/tmux`; `scripts/fetch-tmux.ts:2-14` copies the Homebrew tmux plus its dylibs and rewrites load commands to `@executable_path/…`. The bundle contains **only** `tmux`, `libevent_core-2.1.7.dylib`, `libncursesw.6.dylib`, `libutf8proc.3.dylib` (and unrelated helpers) — no `terminfo` directory (`electrobun.config.ts:51-53`).
- `otool -L` on the installed bundle shows `@executable_path/libncursesw.6.dylib`. `strings` on that dylib shows the compiled-in default database path:
  `/opt/homebrew/Cellar/ncurses/6.5/share/terminfo`.
  That path is the **build machine's Cellar version**, not a stable runtime location. If the user has no Homebrew ncurses, a different Cellar version, or Homebrew upgraded ncurses after Agetor was built, the directory is absent. This is the classic tmux failure mode (tmux issues #743/#1672: a Homebrew ncurses upgrade/removal under a running tmux server).
- Why the task nevertheless started and Claude reached the prompt:
  - Agetor's core-side tmux calls are spawned with stdout/stderr pipes and no tty. A detached `tmux new-session -d` / `has-session` **does not resolve terminfo** in that state, even with `TERM` set and the Cellar path denied: spike K (`sandbox-exec … env TERM=xterm-256color tmux -L ti-k new-session -d …`) exits 0 and the session appears. Spike F confirms the same with `env -u TERM`. (The same command under a pty via `script` fails — scenario E — which is the difference that matters.)
  - Terminal.app runs the `do script` with a real tty and `TERM=xterm-256color`. The tmux client/server must resolve terminfo for that terminal; with the Cellar path absent it prints exactly `can't find terminfo database` and exits 1 (spike, below).
  - This also explains why the core's own `tmux has-session` check in the route passed (no tty) while the Terminal window failed.
- `/usr/share/terminfo` is present on macOS and contains `xterm-256color`, `screen-256color`, `screen`, and `tmux-256color` (checked with `infocmp -A`). Pointing the tmux client at it fixes the attach: `TERMINFO_DIRS=/usr/share/terminfo` makes the same attach succeed even when the server was started with the broken database (spike J). The server does not need to be restarted for the reported case; the client's own lookup is the failing one.
- Scope note: the same hardcoded lookup affects any tmux invocation that has a tty — the Terminal.app attach, the `agetor attach` CLI (which inherits the user's terminal and uses bare `tmux`/`AGETOR_TMUX_BIN`), and anything run in the in-app terminal (`src/bun/terminals.ts:267-271` forces `TERM: "xterm-256color"`). A headless core's own tmux calls have no tty (spike K) and are unaffected. The reported path is the Terminal.app attach, but the root cause is not limited to the route.

### 1.5 Error reporting gap

- The UI already knows how to display a recoverable error: the unparsable card stores `openError` and renders it (`RunPanel.tsx:9241-9252`, `:9278-9280`); the Task Details Attach button toasts (`:8554-8557`); `api.openTmux` throws on non-2xx (`src/mainview/lib/api.ts:2069-2072`, generic `j` at `:445-485`).
- The route's fire-and-forget osascript means an Automation-permission failure is only a `console.warn`; the card stays with no explanation. The harness route's await/502 pattern is the precedent to copy. Note it cannot see a failure that happens *inside* the terminal shell (the terminfo case): osascript returns 0 as soon as Terminal accepts the command. The terminfo fix removes that specific failure; the osascript await covers the launch-permission failure.

### 1.6 History / prior art

- `4b1c1ac8` / PR #76 added the boot poller's generic startup-question path specifically for the Chrome-extension prompt (then numbered), plus the "not auto-confirmed" test. `b48404e8` is the same change on another branch.
- `d4df873d` added `parseUnnumberedConsentChoices` for Claude Code 2.1.284's unnumbered workspace-trust dialog and the `Chat about this` noise fix. It is the direct reusable parser for this issue.
- `docs/plans/unknown-claude-prompts-fallback.md` (#185) designed the `unparsable` card and made **Open in Terminal** its only action; `docs/plans/claude-code-placeholder-investigation.md`/`.md` (#194 era) document the footer arm, the 3-tick gate, `cleanPromptPane`, and the idle-settle/placeholder work. The current code is the post-#194 shape.
- `32ffbedb` ("propagate live PATH to tmux clients") and `497f6d43`/`#281` introduced the `childEnv()` choke point and the `core-spawn-allowlist` rule that every non-exempt spawn goes through `coreSpawn`. `src/bun/core-spawn-allowlist.test.ts:177-179` explicitly pins that `tmuxClientEnv` is gone (replaced by `childEnv`), so reintroducing that helper needs a deliberate test update; adding a benign default env var to `childEnv` or to the tmux call sites is the alternative.
- `TmuxInstallDialog` (`src/mainview/components/tmux/TmuxInstallDialog.tsx:166-186`) offers "Use Agetor's bundled tmux" as the **recommended** path when system tmux is missing, and says "No extra installation, works offline". The terminfo bug breaks exactly that promise. The Settings picker (`SettingsDialog.tsx:1378-1395`) exposes the same choice.
- No prior GitHub issue in `alamops/agetor` mentions terminfo (GitHub search API: only #298). The bundled-tmux path has not been reported before.

### 1.7 Standards / rules that apply

- **Contract.** The specification is **outside the repo**: issue #298's body and its one comment (`issue-298-thread.md`), plus Claude Code's own "Use Claude Code with Chrome" docs for what the two answers mean (`https://code.claude.com/docs/en/chrome`, "Answer the startup dialog"). The issue's "Expected Behavior" bullets are the acceptance criteria: answer in Agetor, a working terminal fallback, resume after the answer, and a recoverable error if terminal initialization fails. The plan should cite the issue in the commit/PR body; there is no repo PRD to update.
- **Runtime & trust shape.** A single local macOS desktop app + one core process per data dir; the tmux server is long-lived and survives app/core restarts. `POST /tasks/:id/open-tmux` is app-only (`callers: "app"`), `GET /tmux-source` is app+cli; no remote/webhook caller reaches either. The pane text and the prompt labels are agent/CLI-controlled input, so the matcher must not become a general "drive anything shaped like a menu" primitive — the guards in §3/§4 are part of the trust boundary, not just UX.
- **Evidence-gated matchers.** `MODAL_FOOTER_RE`'s doc (`claude-tmux.ts:5633-5643`) says not to add a footer phrasing without a captured pane; `matchUnparsableModal` is deliberately never `highConfidence`. A new matcher must be tested against captured/synthetic fixtures and must not auto-drive a widget it doesn't understand.
- **User decisions are not auto-answered.** `STARTUP_CONSENT_DIALOGS` (`:5971-6010`) only auto-confirms dialogs that map to a choice the user already made (bypass mode explicitly selected, trust-folder for an Agetor worktree). The Chrome dialog is explicitly excluded by test `claude-tmux-scraper.test.ts:430-434`. Keep it that way.
- **One spawn wrapper.** Every core spawn goes through `coreSpawn`/`coreSpawnSync` unless marked `// spawn-exempt(<category>)`; `/usr/bin/osascript` is pinned as two `src/bun/server.ts:osascript` exemptions (`core-spawn-allowlist.test.ts:25-30`). A terminal-command fix must not add a third raw spawn.
- **Route policy.** `POST /tasks/:id/open-tmux` is `callers: "app"` (`src/bun/route-policy.ts:411`) and has no path params; the CLI gets `403 desktop-only`. `GET /tmux-source` is app+cli and returns `resolvedBin` (`server.ts:4400-4410`), but the CLI `attach` command currently uses bare `tmux` (`src/cli/commands/attach.ts:94-123`); that is a related gap, not the reported path.
- **No schema change / no backfill.** Both fixes are runtime/parse/UI-only; no migration, no existing rows to rewrite.
- **Docs.** `docs/architecture/harness-claude-code.md:8-13`, `:23`, `:37-40`, `:74` are the current written description of the scraper/prompt behavior; any new matcher's behavior belongs there and in the `unknown-claude-prompts-fallback.md` addendum. `docs/qa/master-token-agent-read-qa.md:53-54` has manual QA rows for "Open terminal"/"Open tmux" that should get a terminfo note if the fix is manual-smoked.

### 1.8 Related surfaces (completeness)

- `GET /tmux-source` returns `bundledPath`/`resolvedBin`; the Settings UI and TmuxInstallDialog use it. A bundled-tmux terminfo fix could be surfaced as a source-level detail in the same route if desired.
- `src/cli/commands/attach.ts` uses `process.env.AGETOR_TMUX_BIN ?? "tmux"` and has its own `has-session` error ("if the app uses bundled tmux, set AGETOR_TMUX_BIN to match"). If the core is configured for bundled tmux, the CLI attach path fails before it ever reaches the terminfo issue. Out of scope for #298 but worth naming as a follow-up.
- The in-app terminal (`src/bun/terminals.ts:267-271`) forces `TERM=xterm-256color`; a `tmux attach` typed there would hit the same bundled-ncurses lookup unless `TERMINFO_DIRS` is set for terminal PTYs too.

## 2. What we proved

| Question | Verdict | Evidence (command → output / measurement) | Versions / artifact |
| --- | --- | --- | --- |
| Does the current matcher chain parse the reporter's unnumbered Chrome prompt? | **No — `unparsable: true`, zero choices.** | Scratch script imports `__forTest` from the repo and feeds a fixture reconstructed from the screenshot + 2.1.322 binary: `numbered: null`, `yesNo: null`, `chain: {choices: [], unparsable: true, fingerprint: 976a8bd7edd3eefe}`, `unparsable.paneText` contains the two rows + footer. | `spikes/issue298/parser-spike.ts` (scratchpad) |
| Would `parseUnnumberedConsentChoices` parse it if it were reachable? | **Yes: two choices, cursor index 0.** | Copied the private parser verbatim into a scratch script: `screenshotLike {"rows":[{"label":"No, keep browser tools off","cursor":true},{"label":"Yes, use my browser","cursor":false}],"cursorIndex":0}`. The same parser returns `null` on the auto-mode wizard (its footer says `Enter to continue`, not `Enter to confirm`) and on a pane without the footer. It **does** parse a transcript that quotes the menu; a generic matcher needs the footer-last / not-idle guards. | `spikes/issue298/parse-unnumbered-spike.ts` |
| Is the pane footer really present but invisible in the card? | **Yes.** | `cleanPromptPane("❯ No, keep browser tools off\n  Yes, use my browser\n\nEnter to confirm · Esc keep browser tools off")` → `"❯ No, keep browser tools off\n  Yes, use my browser"`. `cleanPromptPane` strips `^enter to confirm` (`prompt-noise.ts:23-24`). | `spikes/issue298/clean-pane-spike.ts` |
| What is the compiled-in terminfo path of the bundled ncurses? | **`/opt/homebrew/Cellar/ncurses/6.5/share/terminfo` (build-machine Cellar version).** | `otool -L /Applications/Agetor.app/Contents/Resources/app/bin/tmux` → `@executable_path/libncursesw.6.dylib`; `strings -a …/libncursesw.6.dylib \| grep terminfo` → that path; `find …/Resources/app -iname '*terminfo*'` → none. | installed Agetor 1.2.0 |
| Can the exact reported error be reproduced with the bundled binary? | **Yes.** | Created a session on an isolated socket, then ran the attach under a pty with a `sandbox-exec` rule denying only the Cellar terminfo subtree: `can't find terminfo database`, `attach exit=1`. Control without the deny: attach exit 0. | `sandbox-exec` + `script -q /dev/null`; macOS 26.6.2, tmux 3.6a |
| Does `TERMINFO_DIRS=/usr/share/terminfo` fix it? | **Yes, including when the server predates the fix.** | Scenario A: healthy server, denied client + `TERMINFO_DIRS=/usr/share/terminfo` → attach exit 0. Scenario J: server started denied with `TERM` unset, then denied client + `TERMINFO_DIRS` → attach exit 0. Scenario G/H: server + client both denied but with system terminfo → `new-session` and attach both exit 0. | same; `/usr/share/terminfo` contains `xterm-256color`, `screen-256color`, `tmux-256color` (`infocmp -A`) |
| Why does the app's background tmux keep working when the database is missing? | **No tty ⇒ no terminfo lookup; a pty ⇒ lookup.** | Scenario K: denied + `TERM=xterm-256color`, no `script`/pty, `new-session -d` → exit 0 and the session appears. Scenario F: denied + `env -u TERM`, `new-session -d` under `script` → exit 0. Scenario E: the **same pty** with `TERM=xterm-256color` → `can't find terminfo database`, exit 1. | same |
| Does the current suite notice any of this? | **No.** | `bun test src/bun/claude-tmux-scraper.test.ts` → 323 pass (the only Chrome fixture is the old numbered shape); `bun test src/bun/core-spawn.test.ts src/bun/agents.test.ts` → 310 pass; `bun test src/bun/tmux-resolution.test.ts` → 14 pass; `bun run typecheck` → clean after `bun install`. No test asserts the `open-tmux` command string or `TERMINFO_DIRS`. | repo at `40d014a4` |

## 3. What we're assuming

- **The hidden footer exists and is the 2.1.322 `ChromeAutoEnableDialog` guide.** This is inferred from (a) the boot status line, (b) the boot poller's `watchdogArmed: false`, (c) `matchUnparsableModal` requiring a footer in that path, (d) `cleanPromptPane` stripping exactly an `Enter to confirm` line, and (e) the binary's component props. If the reporter's CLI version rendered a different footer, the generic matcher must anchor differently; a Chrome-specific marker is the fallback.
- **`dismissTmuxPrompt`'s Down/Enter works on this select.** The same `er` component family backs the 2.1.284 unnumbered trust dialog that `confirmStartupDialog`/`parseUnnumberedConsentChoices` already drive with Down+Enter (unit-tested cursor/accept indexes; the docs record the boot poller confirming that dialog). The Chrome dialog has `focus: "cancel"` and `cancelFirst: true`, so choosing "Yes" means one Down, choosing "No" means Enter. Not live-verified on a fresh Chrome-onboarding state here. If the component ignores arrows, a click would do nothing; a live smoke on `~/.agetor-dev` with a fresh account is the check.
- **`/usr/share/terminfo` is present and sufficient on every supported macOS.** Verified on macOS 26.6.2; the path is a long-standing macOS system directory. If a user has a custom Terminal profile with a `TERM` that is not in the system DB, `TERMINFO_DIRS` alone would not cover it; pinning `TERM=xterm-256color` for the attach command would (Terminal.app is xterm-compatible).
- **A generic unnumbered matcher can be made safe enough.** The parser alone also matches a transcript quote; the plan needs the `!paneIdle` gate (and, for belt-and-braces, `!paneWorking` — a real modal replaces the working chrome), the footer-in-last-3-non-blank rule, rejection of checkbox/value-selector rows, and tests. If the owner prefers zero new false-positive class, a marker-gated matcher (`Claude in Chrome extension detected` / `Claude wants to use your browser`) is the conservative fallback.
- **The reporter's `TERM` is a standard Terminal.app value.** The screenshot shows Terminal.app and the stock error; `xterm-256color` is the default. If their profile uses another value, the system DB likely still has it; pinning `TERM` is a belt-and-suspenders option.
- **No production data changes are needed.** The card and prompt are ephemeral; no schema, no backfill, no persisted prompt rows to migrate.

## 4. What we must ask the owner

1. **Scope: both halves in this change?** Recommendation: yes — (a) parse the unnumbered Chrome menu so the card has choices, (b) set a working `TERMINFO_DIRS` for the bundled-tmux attach, (c) await osascript and return a 502 on launch failure. The issue explicitly asks for the terminal fallback even if prompts are handled, and (b) is a real defect in the recommended bundled-tmux path. Alternative: split (b) into a separate issue/commit if the owner wants #298 narrowly about the prompt.
2. **How broad should the unnumbered matcher be?** (a) Generic `matchUnnumberedModal` anchored on `Enter to confirm` in the last 3 non-blank lines, exactly one cursor row, 2+ contiguous plain rows, gated on `!paneIdle` (and optionally `!paneWorking`), rejecting checkbox/value-selector rows; or (b) a marker-gated matcher only for the Chrome startup prompts. (a) also fixes other future unnumbered menus but adds a small false-positive class; (b) is narrower and safer but leaves the next unknown menu unreadable. The existing code's philosophy (`matchStartupConsentDialog` markers, `MODAL_FOOTER_RE` evidence list) leans (b); the issue's "interactive prompts" wording leans (a). What does the owner prefer?
3. **Auto-answer vs. card?** Confirm the Chrome prompt must remain a user decision. Recommendation: never auto-answer it. Docs: No/Esc permanently turns Chrome integration off; Yes connects the user's logged-in browser. If the owner wants an unblock-by-default, the only defensible default is an explicit Settings preference, not a silent choice.
4. **Terminfo source and scope.** Use the macOS system database (`TERMINFO_DIRS=/usr/share/terminfo`) at the attach, or vendor a terminfo DB into `vendor/tmux/arm64/terminfo` and point at it? The system DB is tested and adds no bundle weight; a bundled DB is more self-contained but adds files/signing/verification work. Also: only the Terminal.app attach, or all bundled-tmux spawns (headless core with `TERM` set, in-app PTY)? Recommendation: system DB for the attach now; add it to the tmux spawn env as well so the bundled path is genuinely self-contained.
5. **Recoverable error depth.** Is copying the harness route's await-osascript + 502 enough? It catches Automation-permission/terminal-launch failures, not a shell-side failure like the terminfo error. A deeper guarantee would need a preflight (PTY `tmux attach` probe), a copy-command fallback in the card, or the in-app terminal; those are extra scope. Recommendation: the terminfo fix plus the await/502; leave deeper failure telemetry as a follow-up.
6. **Card labels for an unnumbered menu.** The generic card renders `1. No…` / `2. Yes…` even though the real prompt has no numbers. Keep the existing convention (consistent with the slider, whose options are also numbered in the UI), or add a `hideKeys` flag to `PendingTmuxPrompt`/the card for this matcher? Minor UI call.
7. **CLI attach follow-up.** Should `agetor attach` also resolve `GET /tmux-source`'s `resolvedBin` instead of bare `tmux`, so a bundled-tmux user can attach from the CLI? Related but not reported; recommend a separate follow-up unless the owner wants it in this change.

## 5. Completeness inventory

- **Callers of the parser / matcher chain:**
  - `parseUnnumberedConsentChoices` ← `matchStartupConsentDialog` only (`claude-tmux.ts:6041`). The trust dialog's tests are `claude-tmux-scraper.test.ts:301-385` (numbered, unnumbered, negatives, fingerprints) and `:2163`/`:2322` (key choreography). Keep them green if the parser is extracted/renamed.
  - `pickScrapeMatch` ← `scrapeOnce` (`:7440`) and the boot poller (`:9040`); exported via `__forTest` (`:11141`) and tested at `claude-tmux-scraper.test.ts:1558-1614` (precedence + `paneWorking` gate).
  - `matchUnparsableModal` ← the same chain; tests at `:612-938`, `:1077-1276`, `:2012-2039`.
  - `dismissTmuxPrompt` ← answer route `server.ts:8000-8015`; tests in `claude-tmux.test.ts`/interactions tests.
- **Entry points new code must be wired into:**
  - the `pickScrapeMatch` chain (one change covers runtime + boot),
  - the `open-tmux` route's command builder (and optionally the tmux spawn env),
  - `__forTest` exports for the new matcher/builder,
  - docs in `docs/architecture/harness-claude-code.md` and the `unknown-claude-prompts-fallback.md` addendum.
- **Propagation surface:**
  - `ScrapeMatch` (`claude-tmux.ts:5165-5213`) — if the new match needs a UI-only flag (`hideKeys`), it must thread through `TmuxPromptRequest` (`interactions.ts:183-242`), `registerTmuxPrompt` (`:465-510`), the server answer route, and the hand-mirrored `PendingTmuxPrompt` (`src/mainview/lib/api.ts:282-296`). If no new flag, nothing to propagate.
  - `TmuxPromptChoice.key`/`label`, `cursorIndex`, `nav`, `confirmKey` are already enough for an unnumbered vertical menu. No new interaction kind.
  - Tests/fixtures: `claude-tmux-scraper.test.ts` is the main pane-fixture home; `src/bun/fixtures/askuserquestion/` is the convention for file fixtures, but these are plain inline strings. `tmux-resolution.test.ts` is the home for a pure attach-command builder. `agents.test.ts` already tests `toTerminalAppleScript` if the builder lives there.
- **Existing data a migration would have to backfill:** none. No schema, no persisted prompt history to rewrite.
- **Docs/config/examples describing current behavior:** `docs/architecture/harness-claude-code.md` (lines 8-13, 23, 37-40, 74), `docs/plans/unknown-claude-prompts-fallback.md` (§2/§3/Addendum; the unparsable card is the designed fallback), `docs/plans/claude-code-placeholder-investigation.md` §1.1/§5 (matcher chain, tests), `docs/plans/claude-code-placeholder.md` (test/docs list), `CLAUDE.md`'s harness pointer table, `README.md:160` (bundled tmux offer) and the `fetch-tmux.ts` "self-contained" comment, `docs/qa/master-token-agent-read-qa.md:53-54` manual QA rows. Update only the ones whose claims change: the harness doc (unnumbered matcher + attach env), the fallback plan addendum, and the bundled-tmux comment if the runtime env fix lands.
- **What the change would orphan:** nothing. `parseUnnumberedConsentChoices` should be reused/renamed rather than duplicated; the old numbered `CHROME_EXTENSION_PANE` fixture remains valid coverage for older CLIs and must not be deleted. `unparsable` remains the fallback for genuinely unknown widgets (auto-mode wizard, free-text prompts).

## 6. Runnability

- Install: `bun install` (the worktree had no `node_modules`; `bun run typecheck` failed with `tsc: command not found` until installed).
- Typecheck: `bun run typecheck` → clean at base.
- Unit tests: `bun test` (root scoped to `src/` by `bunfig.toml`); per file `bun test src/bun/claude-tmux-scraper.test.ts`, `bun test src/bun/tmux-resolution.test.ts`, `bun test src/bun/agents.test.ts`, `bun test src/bun/core-spawn.test.ts`. The 323 scraper tests / 310 agents+core-spawn tests / 14 tmux-resolution tests were green at base. A full `bun test src/bun/claude-tmux-local-command.test.ts` run exceeded a 180 s timeout in this worktree once; rerun it with a larger budget before treating it as a product signal (it is unrelated to this change).
- Dev app: `export PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH"`; `bun run dev` uses `~/.agetor-dev` (never prod `~/.agetor`); `bun run dev:hmr` for webview work. Headless smoke: `AGETOR_DATA_DIR=<tmp> AGETOR_API_PORT=<port> AGETOR_API_TOKEN=<t> AGETOR_DAEMON_IDLE_MS=0 AGETOR_DEBUG=1 bun src/bun/headless.ts`.
- Bundled tmux: `bun run vendor:tmux` (`scripts/fetch-tmux.ts`) requires a local system tmux and arm64; `vendor/tmux/arm64` is gitignored and absent in this worktree. The installed `/Applications/Agetor.app` was used for the bundled-binary spike.
- E2E: Playwright, specs under `e2e/`; `bun node_modules/@playwright/test/cli.js test <spec>` (not `bunx`), one run at a time. The fake claude driver (`AGETOR_CLAUDE_DRIVER=fake`) bypasses tmux, so **pane matchers and Terminal.app attach are unit/manual-only**; no e2e will notice this change. A manual smoke for the terminal fix: start a claude task in `~/.agetor-dev`, click Attach/Open in Terminal, confirm the window stays attached; optionally reproduce the failure with a scratch copy of the bundle under a `sandbox-exec` deny (the spike recipe below).
- Manual smoke for the prompt: with a fresh Claude Chrome-onboarding state (or a stubbed pane), confirm the card renders two buttons and choosing each advances the prompt; choosing No=Enter on the default, Yes=Down+Enter.

## 7. Risks & blast radius

- **False positives from the unnumbered matcher.** A false card gates the composer and can send Down/Enter into a live TUI. Mitigations: footer in the last 3 non-blank lines, exactly one cursor row, 2+ contiguous plain rows, `!paneIdle` and (optionally) `!paneWorking`, reject `[ ]`/`[x]`/`◂…▸` rows, keep the 2-tick (or 3-tick) stability gate, and add transcript/idle/wizard/slider negatives. A marker-gated matcher is the zero-new-false-positive alternative.
- **Trust-dialog regression.** Extracting/renaming `parseUnnumberedConsentChoices` must keep `matchStartupConsentDialog`'s choice labels, cursor index, affirmative index, and fingerprint stability intact; the existing tests at `:301-385` are the pin.
- **Wrong-option keystrokes.** The Chrome prompt's No is first and the default. Arrow navigation from a stale `cursorIndex` could confirm the wrong option if the pane changes between registration and click; `dismissTmuxPrompt` re-checks the session but not the pane. This is pre-existing for every modal; the fingerprint/cursor-in-hash re-registration keeps it fresh. The fix must not add a matcher that can register on a pane whose cursor it guessed.
- **Terminfo override.** `TERMINFO_DIRS` affects any curses process it reaches. Apply it to the Terminal.app command and, if broadening, only to tmux children (or to the bundled-tmux path), not the user's whole environment. Do not clobber an explicit user `TERMINFO`/`TERMINFO_DIRS` silently; the attach command is a controlled one-off, so an explicit override there is fine.
- **osascript await latency.** A 5 s ceiling matches the harness route; the UI's `opening` state already handles a wait. A timeout still returns ok (assume the window is coming up) to avoid false errors.
- **Existing users / stale servers.** The attach-only client fix works even against a server started under the broken database (spike J). A broader server-env fix only affects newly started servers; no session restart is needed for the reported case. Do not add a server reap just for this.
- **Platform.** Agetor is macOS-arm64; `/usr/share/terminfo` is a macOS path. If the repo ever builds for Linux, the constant needs a platform guard (or `infocmp -D` discovery).
- **Test gap.** There are no tests for the open-tmux route/command; a pure builder + unit tests is the only cheap regression pin. There are no e2e tests for Terminal.app, and the fake driver bypasses panes. Plan for unit tests + a documented manual smoke.
- **Scope creep.** The CLI `agetor attach` path and the in-app terminal are related surfaces; fixing them here adds files and test surface. Recommend naming them as follow-ups unless the owner includes them.

## 8. Appendix — reproduction commands and fixtures

### 8.1 Parser reproduction (scratchpad, read-only on the repo)

```
cd <scratchpad>/spikes/issue298
AGETOR_DATA_DIR="$PWD/data" NODE_ENV=test AGETOR_TMUX_BIN=/bin/echo bun run parser-spike.ts
# numbered: null
# yesNo: null
# chain: { choices: [], cursorIndex: 0, unparsable: true, fingerprint: "976a8bd7edd3eefe" }
```

Fixture used (from the issue screenshot + 2.1.322 `ChromeAutoEnableDialog`):

```
Claude in Chrome extension detected

Claude will use your Chrome browser by default — navigating sites, filling
forms, and capturing screenshots in your existing session.

This session is in Auto mode, which checks routine browser actions — you are
only prompted when it is unsure. Turn browser tools off for future sessions
with /chrome.

❯ No, keep browser tools off
  Yes, use my browser

Enter to confirm · Esc keep browser tools off
```

### 8.2 Terminfo reproduction (installed Agetor 1.2.0)

```
TMUX=/Applications/Agetor.app/Contents/Resources/app/bin/tmux
SANDBOX='(version 1)(allow default)(deny file-read* (subpath "/opt/homebrew/Cellar/ncurses/6.5/share/terminfo"))'

# 1) Prove the compiled-in path and that the bundle has no terminfo:
otool -L "$TMUX" | grep ncurses                    # @executable_path/libncursesw.6.dylib
strings -a "$(dirname "$TMUX")/libncursesw.6.dylib" | grep /terminfo
# /opt/homebrew/Cellar/ncurses/6.5/share/terminfo
find /Applications/Agetor.app/Contents/Resources/app -iname '*terminfo*'   # none

# 2) Reproduce the exact error under a pty, hiding only that subtree:
"$TMUX" -L terminfo-spike new-session -d -s spike sleep 30
script -q /dev/null sandbox-exec -p "$SANDBOX" env TERM=xterm-256color \
  "$TMUX" -L terminfo-spike attach -t spike </dev/null
# can't find terminfo database; exit 1

# 3) Prove the fix (same sandbox, system database):
script -q /dev/null sandbox-exec -p "$SANDBOX" env TERM=xterm-256color \
  TERMINFO_DIRS=/usr/share/terminfo "$TMUX" -L terminfo-spike attach -t spike </dev/null
# attach succeeds; exit 0
```

### 8.3 Spike artifacts

- `<scratchpad>/issue298-screenshot.png` — the issue's screenshot, downloaded from the GitHub attachment (card + Terminal error).
- `<scratchpad>/spikes/issue298/parser-spike.ts` — current-chain reproduction.
- `<scratchpad>/spikes/issue298/parse-unnumbered-spike.ts` — parser feasibility + negatives.
- `<scratchpad>/spikes/issue298/clean-pane-spike.ts` — footer-hidden proof.
- `<scratchpad>/spikes/issue298/` — no repo files were modified for the spikes; only this brief is added.
