# Plan — Issue #298: answerable Chrome prompt + working bundled-tmux terminal

| Field | Value |
| --- | --- |
| Date | 2026-11-12 |
| Source | Issue #298 (`https://github.com/alamops/agetor/issues/298`); investigation `docs/plans/issue-298-chrome-prompt-investigation.md`; grill `docs/plans/issue-298-chrome-prompt-grill.md` (17 decisions, 2 rounds) |
| Flags | none |
| Gates | grilled + approved by owner (2026-11-12; 17/17 decisions answered, no skips; no unratified one-way door) |
| Status | implemented — T1–T7 complete; typecheck clean; hygiene + wiring gates clean; targeted suites green (429 focused + 509 in the adjacent tmux/agents/core-spawn/CLAUDE.md suites, plus the `paneShowsBlockingPrompt` and `mirrorModelViaPicker` groups under `--timeout 30000`); manual bundled-tmux attach smoke recorded in §8.3; local commits made, not pushed. **Test loop (final run, §8.4):** `bun run typecheck` clean; `bun test --timeout 30000` → 12,894 pass / 31 skip / 8 fail across 499 files, where all 8 are pre-existing or a one-off hook timeout (7 reproduce identically at base `40d014a4`; the 8th — `orchestrator-hold-scope-claim` — is green alone in 1.4 s); the focused suites are 507/507 and every new guard was mutation-checked red. **Review fix round:** checkbox guard now rejects trailing rows too (the shape claude actually draws), the auto-mode wizard is pinned through `pickScrapeMatch`, stale chain comments corrected, the attach command is handed to `/bin/sh -c` (login-shell independence), timed-out osascript children are killed (reverted in the post-review round below: killing cancels the first-use Automation consent), and the terminfo DB is staged then swapped so a mid-copy failure can't leave a partial tree. |
| Branch | `fix/issue-298-bug-agent-gets-stuck-on-chrome` (already checked out in the worktree) |
| Base SHA | `40d014a4` |

## 1. Objective & success criteria

Make the **unnumbered** "Claude in Chrome extension detected" startup prompt answerable from Agetor's run panel, and make **Open in Terminal** actually attach when the app is using its bundled tmux on a Mac without the build machine's Homebrew ncurses. Both defects from #298 land in one local commit whose message carries `Fixes #298`.

Each criterion names the production path that produces it:

1. **The Chrome prompt becomes a two-button card.** Claude's pane → `scrapeOnce` (`src/bun/claude-tmux.ts:7449-7461`) or the boot poller (`:9028-9079`) → `pickScrapeMatch` (`:5783-5786`) → new `matchUnnumberedModal` → `registerTmuxPrompt` (`interactions.ts:762`) → SSE → `TmuxPromptCard` (`RunPanel.tsx:9285-9320`) → `POST /tmux-prompts/:id/answer` (`server.ts:7945`) → `dismissTmuxPrompt` (`claude-tmux.ts:2182`) → arrows + Enter. Proven by a unit test that drives `pickScrapeMatch` with the reconstructed 2.1.322 pane (returns two choices, `hideKeys: true`, not `unparsable`).
2. **The task resumes after the answer.** The existing answer route + `__external__` sweep + boot-window re-arm (`claude-tmux.ts:7526-7535`, `:9085-9099`) clear the card and keep the run alive. Proven by the existing route/registration tests staying green plus the new matcher's fingerprint being stable across ticks (same fingerprint on two consecutive `pickScrapeMatch` calls).
3. **No false choice card.** An idle composer, a working pane, a transcript that quotes a menu, a wizard (`Enter to continue`), a checkbox row, a value-selector row, or a footer outside the last three non-blank lines never produces the unnumbered card. Proven by negative unit tests through `pickScrapeMatch` and `matchUnnumberedModal`; `paneShowsBlockingPrompt` sees the same idle gate.
4. **The bundled-tmux attach works without the build Cellar path.** `POST /tasks/:id/open-tmux` (`server.ts:7040-7129`) → `buildTmuxAttachCommand` (new `src/bun/tmux-attach.ts`) → `toTerminalAppleScript` (`agents.ts:619`) → osascript → Terminal.app. The command carries `TERMINFO_DIRS=<bundle>/bin/terminfo:/usr/share/terminfo` only when the resolved binary is the bundled tmux. Proven by an exact-string builder test plus the manual attach smoke (§5).
5. **A failed terminal launch is recoverable.** The route awaits osascript with a 5 s ceiling and returns a 502 carrying the Automation-permission hint; a failure inside the terminal shell keeps the window open (the command's `|| { …; read -r _; }` fallback) instead of `[Process completed]`. Proven by the builder test pinning the fallback (the route cannot observe in-shell failures) and by the route mirroring the already-reviewed `/harnesses/:id/open-terminal` pattern (`server.ts:5759-5803`).
6. **No prompt is ever auto-answered and no persistent setting changes without the user.** The Chrome prompt stays out of `STARTUP_CONSENT_DIALOGS` (`claude-tmux.ts:5971-6006`) and `matchUnnumberedModal` only *presents* choices. Both choices change a persistent Claude setting (Yes connects the logged-in browser; No/Esc turns browser tools off), so only a click may choose.
7. **Green tree.** `bun run typecheck` clean; targeted unit tests green; full `bun test` green (or documented pre-existing failures); a recorded manual Terminal.app attach smoke. One local commit, not pushed.

## 2. Context & constraints

### 2.1 Grounded findings (all line numbers at `40d014a4`)

**Prompt half (defect A).**

- `pickScrapeMatch` is the single chain shared by `scrapeOnce` and the boot poller: `matchNumberedModal ?? matchYesNoModal ?? matchSliderModal ?? (paneWorking ? null : matchUnparsableModal)` — `src/bun/claude-tmux.ts:5783-5786`, exported for tests at `:11137-11141`.
- The only unnumbered parser, `parseUnnumberedConsentChoices` (`:6063-6100`), is private and reachable only from `matchStartupConsentDialog` (`:6030-6052`). It anchors on the **last** `Enter to confirm` line anywhere in the pane, walks upward over blank rows collecting `❯`/`›` cursor rows or rows indented 2+ spaces, requires ≥2 rows and exactly one cursor row, and returns 1-based keys + `cursorIndex`.
- The runtime/boot chain therefore falls through to `matchUnparsableModal` (`:5733-5767`), which registers `unparsable: true`, `choices: []`, and only "Open in Terminal" in the UI (`RunPanel.tsx:9240-9283`).
- `cleanPromptPane` strips the `Enter to confirm …` footer from the card preview (`src/mainview/lib/prompt-noise.ts:22-24`), which is why the reporter's card showed no footer even though the pane had one.
- The answer path already exists and needs nothing new: `dismissTmuxPrompt` maps a choice key to its index and walks arrows from the observed `cursorIndex` then Enter (`claude-tmux.ts:2182-2258`); the route validates the key against the registered set (`server.ts:7982-7987`); `markTmuxPromptAnswered` suppresses a ghost duplicate (`claude-tmux.ts:7635-7649`); the `__external__` sweep resolves a card whose fingerprint left the pane (`:7526-7535`).
- The current fixture is the **old numbered** shape (`claude-tmux-scraper.test.ts:412-446`); the test deliberately does not auto-confirm it (`:430-434`). There is no unnumbered-Chrome fixture, which is why the current suite is green.
- Stability: a non-`highConfidence` match needs the same fingerprint on two consecutive scrapes (`clearedStabilityGate`, `:5368-5370`); the boot poller has its own two-tick `lastGenericFingerprint` gate (`:9050-9053`). The unnumbered matcher must not claim `highConfidence`.

**Terminal half (defect B).**

- `POST /tasks/:id/open-tmux` resolves the binary with `resolveTmuxBin()` (`tmux-resolution.ts:62-67`), checks the session, builds `tell application "Terminal" to do script "exec \"<tmux>\" … attach -t …"` with hand-rolled bash + AppleScript escaping, spawns `/usr/bin/osascript`, and **returns `{ ok: true }` immediately**, logging a non-zero exit only (`server.ts:7100-7127`).
- The harness route directly above is the correct pattern: `stderr: "pipe"`, `Promise.race([proc.exited, Bun.sleep(5000)])`, timeout ⇒ ok, non-zero ⇒ 502 with the Automation hint (`server.ts:5759-5803`).
- `bundledTmuxPath()` points at `Contents/Resources/app/bin/tmux` (packaged) or `vendor/tmux/arm64/tmux` (dev) — `tmux-resolution.ts:17-30`. `scripts/fetch-tmux.ts` copies the Homebrew binary + dylibs and rewrites load commands to `@executable_path/…`; its cache check is `:142-158`.
- The bundled `libncursesw.6.dylib` has the build machine's compiled-in path `/opt/homebrew/Cellar/ncurses/<ver>/share/terminfo`; the bundle ships no terminfo. A tty attach then prints exactly `can't find terminfo database`. Core-side tmux calls have no tty and never resolve terminfo (investigation §1.4, spikes E/F/K).
- `TERMINFO_DIRS=/usr/share/terminfo` fixes the attach, even against a server started with the broken DB (spike J). On this host `/usr/share/terminfo` uses hashed dirs and contains all five needed entries: `78/{xterm,xterm-256color}`, `73/{screen,screen-256color}`, `74/tmux-256color` (checked with `find`/`infocmp`; `/usr/bin/tic` exists).
- `electrobun.config.ts:50-53` copies the whole `vendor/tmux/arm64` tree to `Contents/Resources/app/bin`, so a `terminfo/` subdirectory lands beside the binary with no config change. `vendor` is gitignored (`.gitignore:14-15`); `bun run vendor:tmux` is the build step (`package.json:12`, `:18-20`).
- `scripts/verify-vendor-signing.ts` only codesigns/verifies Mach-O files (`file -b` ⇒ "Mach-O"), so terminfo data files are skipped safely.
- Spawn sites: `claude-tmux.ts:1674-1697` (`tmux()`), `tmux-resolution.ts:179-209` (`ensureDisclaimedServer`) and `:229-250` (`spawnTmuxNewSession`), `opencode-tmux.ts:434-449` (`tmuxRun()`), `opencode-server.ts:554-590` (`runBounded`), `:1420` (sync `send-keys`). The five one-shot drivers all go through `spawnTmuxNewSession`.
- `core-spawn-allowlist.test.ts:177-179` pins that the literal `tmuxClientEnv` is gone (it was replaced by `childEnv`). A new tmux env helper must **not** reuse that name; the test strips comments, so comments may mention it.

### 2.2 Repo rules that bear on this change

- **Every route needs a `ROUTE_POLICY` entry** — `POST /tasks/:id/open-tmux` is already `POST: APP` (`route-policy.ts:411`); the route's caller class does not change. No new routes.
- **Every spawn goes through `coreSpawn`/`coreSpawnSync`** unless pinned with `// spawn-exempt(<category>)`; the two `server.ts:osascript` exemptions are pinned (`core-spawn-allowlist.test.ts:25-30`). The route keeps its raw `/usr/bin/osascript` spawn (Automation grant belongs to Agetor) and its marker; the exemption count must stay at two.
- **Tmux clients take `childEnv()`** (live `process.env`, master token scrubbed). A helper that wraps it must still return `childEnv()` semantics.
- **Evidence-gated pane matchers** — `MODAL_FOOTER_RE`'s doc (`claude-tmux.ts:5633-5643`) forbids adding a footer phrasing without a captured pane. The new matcher reuses the *existing* `Enter to confirm` evidence and adds guards; it does not add a new footer phrase.
- **User decisions are not auto-answered** — `STARTUP_CONSENT_DIALOGS` only auto-confirms dialogs whose choice the user already made; the Chrome test at `claude-tmux-scraper.test.ts:430-434` pins this.
- **Test organism** — `bun test` runs every file in one process against one `db.ts` singleton. Any test importing `db.ts`/`tmux-resolution.ts` sets `AGETOR_DATA_DIR` at the top level and restores env in `afterEach` (`tmux-resolution.test.ts:42-64`); clean up with `rmTestDataDir`. `bun run typecheck` must be green (`CLAUDE.md` commands).
- **Docs move with behavior** — `docs/architecture/harness-claude-code.md:23`, `:40`, `:74`; `docs/plans/unknown-claude-prompts-fallback.md` addendum; `docs/qa/master-token-agent-read-qa.md:53-54`. `src/bun/claudemd-citations.test.ts` forbids numbered CLAUDE.md citations in code.

### 2.3 Spec and live facts

- The spec lives outside the repo: issue #298's body and its Expected Behavior bullets (answer in Agetor / working terminal fallback / resume after answer / recoverable terminal error). The in-repo evidence brief is `docs/plans/issue-298-chrome-prompt-investigation.md`; the ratified decisions are `docs/plans/issue-298-chrome-prompt-grill.md`. No copy under `docs/specs/` is needed because the issue is the contract and it is cited by URL + the in-repo brief.
- Checked live on this host (2026-11-12): `/usr/share/terminfo` exists with hashed dirs and all five entries; `infocmp -A /usr/share/terminfo tmux-256color` exits 0; `/usr/bin/tic` exists; system tmux is `/opt/homebrew/bin/tmux` 3.6a; `/opt/homebrew/Cellar/ncurses/6.5/COPYING` exists (license source); this worktree has no `vendor/` tree; the branch is `fix/issue-298-bug-agent-gets-stuck-on-chrome` at `40d014a4`.

## 3. Approach & key decisions

Decisions 1–13 and 4a–4c are the owner's (grill record). Summarized with the evidence/reasoning split:

1. **Both halves in one local commit** (`Fixes #298`). *Owner.*
2. **Generic `matchUnnumberedModal` with strict guards**, inserted **after** `matchSliderModal` and **before** the unparsable fallback. Guards: `Enter to confirm` among the last 3 non-blank lines; exactly one cursor row; ≥2 contiguous choice rows; reject checkbox (`[ ]`/`[x]`/`[✔]`), value-selector (`◂…▸`) and numbered (`N. `) rows; require `!paneWorking` and `!paneIdle`. *Owner; guards are reasoning-based from the investigation's false-positive analysis.*
   - The numbered-label guard matters: `parseUnnumberedChoices`'s 2-space row rule also matches the older **numbered** Chrome fixture's `  2. No, …` rows, so without it the unnumbered matcher would parse a numbered menu. `matchNumberedModal` runs first, but the guard keeps the new matcher honest and testable in isolation.
   - Precedence after the slider is **load-bearing**: the slider footer also contains `Enter to confirm`; its indented track/label rows would be collected by the unnumbered parser (today it then rejects them for lack of a `❯` cursor row, but precedence keeps the slider's own `nav: "horizontal"` behavior unambiguous). *Evidence: `EFFORT_SLIDER_*` fixtures.*
   - Added hardening (reasoning): cap the contiguous block at 9 rows so a future dialog whose body is 2-space-indented without a blank separator falls to the unparsable card instead of presenting paragraph text as choices.
3. **Never auto-answer the Chrome prompt; no Settings preference.** *Owner, one-way door answered.*
4. **Vendored terminfo DB** (owner overrode the recommended system-DB-only option): five entries — `xterm-256color`, `xterm`, `screen`, `screen-256color`, `tmux-256color` — generated into the gitignored vendor tree by `bun run vendor:tmux`, with `/usr/share/terminfo` as the second search path; license + provenance copied beside the DB. *Owner.*
5. **Terminfo override applies to the Terminal.app attach and every bundled-tmux spawn**, via a tmux-specific env helper; the in-app terminal shell and the `agetor attach` CLI are out of scope. *Owner.*
6. **Failure feedback**: await osascript with a 5 s ceiling, 502 + Automation hint on non-zero; drop `exec` and append an in-shell fallback that prints the error and waits for Enter. *Owner.*
7. **Card presentation**: hide the synthetic keys only for unnumbered menus via a new `hideKeys` flag threaded `ScrapeMatch` → `TmuxPromptRequest` → `api.ts` → `TmuxPromptCard`; numbered prompts keep their real `1.`/`2.` labels; no Chrome permanence note, no terminal link on choice cards. *Owner.*
8. **No Dismiss/Esc action** on choice cards (Esc means a permanent "No" on the Chrome prompt). *Owner.*
9. **Acceptance**: unit tests + typecheck + a manual Terminal.app attach smoke (documented if the environment can't run it); no e2e. *Owner.*
10. **Docs**: harness doc, fallback-plan addendum, QA row. *Owner.*
11. **One local commit, not pushed**, message `fix: answer the unnumbered Claude Chrome prompt and repair bundled-tmux attach (Fixes #298)`. *Owner.*
12. **Keep the unparsable card** as the final fallback. *Owner.*
13. **No cross-agent Chrome arbitration.** *Owner.*

Implementation shape chosen by this plan (reasoning, not owner-visible decisions):

- Reuse and rename `parseUnnumberedConsentChoices` → `parseUnnumberedChoices`; do not fork a second parser. The trust-dialog caller and its tests are the pin.
- Add `paneIdle` as a **required** field of `pickScrapeMatch`'s opts so typecheck finds every call site; the three sites are `scrapeOnce`, the boot poller, and `paneShowsBlockingPrompt`.
- `hideKeys` is display-only: choice `key`s stay `"1"`/`"2"`, so `dismissTmuxPrompt` and the answer route are untouched.
- New pure modules: `src/bun/tmux-attach.ts` (attach command builder) and `src/mainview/lib/tmux-prompt.ts` (choice label helper) so both are unit-testable without React or a live terminal.
- Runtime terminfo helper `tmuxEnv()` (not `tmuxClientEnv` — that name is pinned as removed) wraps `childEnv()` and appends `TERMINFO_DIRS` only for the bundled binary. The route uses the pure `terminfoDirsFor()` + `isBundledTmuxBin()` instead of the env helper because the env must be inline in the shell command, not on osascript.

## 4. Work breakdown — implementation tasks

| ID | Goal | Owned files | Depends on | Acceptance (scenarios) | Risk | Wired by |
| --- | --- | --- | --- | --- | --- | --- |
| T1 | Parse the unnumbered Chrome menu, gate it on idle/working, and thread `hideKeys` to the card | `src/bun/claude-tmux.ts`, `src/bun/interactions.ts`, `src/mainview/lib/api.ts`, `src/mainview/lib/tmux-prompt.ts` (new), `src/mainview/components/kanban/RunPanel.tsx` | none | See T1 card below | `state`, `tests`, `trust` (pane text is agent-controlled) | `scrapeOnce` (`claude-tmux.ts:7449`) + boot poller (`:9040`) call `pickScrapeMatch`; `RunPanel.tsx:6269` renders `TmuxPromptCard` |
| T2 | Unit tests for T1 (matcher, chain, negatives, hideKeys, label helper) | `src/bun/claude-tmux-scraper.test.ts`, `src/bun/interactions.test.ts`, `src/mainview/lib/tmux-prompt.test.ts` (new) | T1 (same wave; pinned interface) | See T2 card below | `tests` | n/a (tests) |
| T3 | Vendor five terminfo entries + license/provenance into the bundled-tmux tree | `scripts/fetch-tmux.ts`, `scripts/terminfo/LICENSE-ncurses.txt` (new), `scripts/terminfo/README.md` (new) | none | See T3 card below | `infra`, `external` (build-host DB) | `bun run build`'s `vendor:tmux` step (`package.json:18-20`); `electrobun.config.ts:53` copies the tree to `Contents/Resources/app/bin` |
| T4 | Bundled-tmux terminfo env + attach command builder + awaited route | `src/bun/tmux-resolution.ts`, `src/bun/claude-tmux.ts` (env line only), `src/bun/opencode-tmux.ts`, `src/bun/opencode-server.ts`, `src/bun/tmux-attach.ts` (new), `src/bun/server.ts` | T1 (frees `claude-tmux.ts`), T3 | See T4 card below | `external` (osascript/Terminal), `infra`, `tests` | `POST /tasks/:id/open-tmux` (`server.ts:7040`, policy `route-policy.ts:411`); `tmuxEnv()` at every tmux client helper |
| T5 | Unit tests for T4 (terminfo helper + attach builder) | `src/bun/tmux-resolution.test.ts`, `src/bun/tmux-attach.test.ts` (new) | T4 (same wave; pinned interface) | See T5 card below | `tests` | n/a (tests) |
| T6 | Update the behavior docs and QA row | `docs/architecture/harness-claude-code.md`, `docs/plans/unknown-claude-prompts-fallback.md`, `docs/qa/master-token-agent-read-qa.md` | T1, T4 | See T6 card below | `none` (docs) | n/a (docs) |
| T7 | Full verification, manual smoke, and the single local commit | `docs/plans/issue-298-chrome-prompt.md` (Status only; plus the untracked grill/investigation docs ride the commit) | all | See T7 card below | `tests`, `infra` | n/a (verification) |

### T1 — unnumbered matcher, `paneIdle`, `hideKeys`

**`matchUnnumberedModal(tail: string): ScrapeMatch | null`** in `claude-tmux.ts`, placed next to the other matchers:

1. `const nonBlank = lines.filter(l => l.trim().length > 0)`; require `/\benter to confirm\b/i` on one of `nonBlank.slice(-3)`. Return null otherwise.
2. Call `parseUnnumberedChoices(tail)`. Return null if it does.
3. Reject if any parsed label matches `/^\[[ xX✔✓]?\]\s/` (checkbox row), contains `◂`, `◀`, `▸`, or `▶` (value selector), or matches `/^\d+\.\s/` (numbered row — keep the numbered shape with `matchNumberedModal`).
4. Reject if `parsed.choices.length > UNNUMBERED_MAX_CHOICE_ROWS` (9).
5. Return `{ paneText: lines.slice(-12).join("\n").trimEnd(), choices: parsed.choices, cursorIndex: parsed.cursorIndex, fingerprint: parsed.fingerprint, hideKeys: true }`. Never `highConfidence`.

**`pickScrapeMatch`** becomes:

```ts
function pickScrapeMatch(
  tail: string,
  opts: { paneWorking: boolean; paneIdle: boolean; watchdogArmed: boolean },
): ScrapeMatch | null {
  return matchNumberedModal(tail) ?? matchYesNoModal(tail) ?? matchSliderModal(tail)
    ?? (!opts.paneWorking && !opts.paneIdle ? matchUnnumberedModal(tail) : null)
    ?? (opts.paneWorking ? null : matchUnparsableModal(tail, opts.watchdogArmed));
}
```

Pass `paneIdle` at the three call sites: `scrapeOnce` uses its already-computed `paneIdle` (`:7428`); the boot poller computes `paneShowsIdleInputBox(tail)` (`:9040`); `paneShowsBlockingPrompt` computes `paneShowsIdleInputBox(tail)` and `paneShowsClaudeWorking(tail)` (`:5910-5913`). Update the `pickScrapeMatch` doc comment (numbered > yes-no > slider > unnumbered > unparsable; idle/working gates).

**Rename** `parseUnnumberedConsentChoices` → `parseUnnumberedChoices`, update its doc (serves the trust dialog and the generic unnumbered menu).

**`ScrapeMatch`** gains `hideKeys?: boolean` with a doc comment: display-only, set by `matchUnnumberedModal`; keys remain 1-based for `dismissTmuxPrompt`.

**Plumbing**: `registerTmuxPrompt` accepts `hideKeys?: boolean` and copies it onto `TmuxPromptRequest`; `TmuxPromptRequest.hideKeys?: boolean`; the `scrapeOnce` registration (`:7613-7623`) and boot registration (`:9068-9078`) pass `hideKeys: match.hideKeys` / `generic.hideKeys`; `PendingTmuxPrompt` in `api.ts` gains the mirrored optional field. Add `matchUnnumberedModal` (and, if useful, `UNNUMBERED_MAX_CHOICE_ROWS`) to the `__forTest` matcher exports (`:10757-10779`).

**Card**: new `src/mainview/lib/tmux-prompt.ts`:

```ts
export function tmuxChoiceLabel(choice: { key: string; label: string }, hideKeys?: boolean): string {
  return hideKeys === true ? choice.label : `${choice.key}. ${choice.label}`;
}
```

`RunPanel.tsx`'s generic-choice branch (`:9295-9315`) uses it; the plan branch and the unparsable branch are untouched.

**Acceptance**

- With the reconstructed 2.1.322 pane (§3 of the investigation / §8.1), `matchUnnumberedModal` returns exactly two choices (`No, keep browser tools off` cursor 0, `Yes, use my browser`), `hideKeys: true`, no `unparsable`; `pickScrapeMatch(..., { paneWorking:false, paneIdle:false, watchdogArmed:false })` returns the same object.
- Same pane with `paneWorking:true` ⇒ `pickScrapeMatch` null; with `paneIdle:true` ⇒ null.
- The old numbered `CHROME_EXTENSION_PANE` still parses through `matchNumberedModal` with its original labels/cursor; `matchUnnumberedModal` returns null on it (rejected by the `N. ` row guard), so `pickScrapeMatch` returns the numbered match with no `hideKeys` and no digit-less labels.
- The slider pane still resolves to `matchSliderModal` with `nav:"horizontal"` (the existing precedence test stays green); `matchUnnumberedModal(sliderPane)` is null (no `❯` cursor row).
- Negatives return null: auto-mode wizard (`Enter to continue`); footer only outside the last 3 non-blank lines; `❯ [ ] Cheese` / `❯ [✔] Cheese`; `❯ Low ◂───▸ High`; `❯ 1. Yes` / `  2. No`; zero or two cursor rows; one row; ten contiguous rows.
- `matchStartupConsentDialog` on both trust-dialog shapes still returns the same `acceptIndex`/fingerprints (existing tests at `claude-tmux-scraper.test.ts:301-385`).
- `registerTmuxPrompt({hideKeys:true})` ⇒ `req.hideKeys === true`, present in `listPendingForTask`, survives JSON.
- `tmuxChoiceLabel({key:"2",label:"Yes"}, true) === "Yes"`; with `false`/`undefined` ⇒ `"2. Yes"`.
- `paneShowsBlockingPrompt` is false for an idle pane whose transcript quotes the menu and true for the live unnumbered pane.

**Risk tags**: `state` (new matcher adds a card class), `tests`, `trust` (pane text is CLI-controlled; the guards are the boundary). No migration.

### T3 — vendored terminfo DB

`scripts/fetch-tmux.ts`:

- `const TERMINFO_SOURCE = "/usr/share/terminfo"`; `const TERMINFO_ENTRIES = ["xterm-256color","xterm","screen","screen-256color","tmux-256color"] as const`; `TERMINFO_DIR = path.join(VENDOR_DIR, "terminfo")`.
- New `vendorTerminfo()`: for each entry, find its hashed subdirectory under the source (`readdirSync(SOURCE)` + `existsSync(join(SOURCE, dir, entry))`), `mkdir` the same subdir under the destination, `copyFile`. If any entry is missing, `fail()` naming the entry and the source path **before** writing anything (resolve all five first, then copy).
- Copy the tracked `scripts/terminfo/LICENSE-ncurses.txt` and `scripts/terminfo/README.md` into the destination; write `PROVENANCE.txt` with the source path, the entry list, and an ISO-8601 UTC timestamp.
- Extend the cache check (`:145-158`) with `&& existsSync(TERMINFO_DIR) && existsSync(path.join(TERMINFO_DIR, "PROVENANCE.txt"))`; otherwise a tree vendored before this change never gains the DB.
- Keep the macOS-only early return (create the empty vendor dir on other platforms, as today). The new files are data, not Mach-O, so the signing step and `verify-vendor-signing.ts` ignore them.
- Add a sanity check after vendoring: `TERMINFO_DIRS=<TERMINFO_DIR> infocmp <entry>` for each entry; fail loudly if one does not resolve.

`scripts/terminfo/LICENSE-ncurses.txt`: the ncurses license text verbatim (source on this host: `/opt/homebrew/Cellar/ncurses/6.5/COPYING`; it must not be edited). `scripts/terminfo/README.md`: one paragraph naming the five entries, the macOS source path, the ncurses license, and that the DB is regenerated by `bun run vendor:tmux` on the build host (never hand-edited).

**Acceptance**

- `rm -rf vendor/tmux/arm64 && bun run vendor:tmux` creates `vendor/tmux/arm64/terminfo/{73/screen,73/screen-256color,74/tmux-256color,78/xterm,78/xterm-256color}`, `LICENSE-ncurses.txt`, `README.md`, `PROVENANCE.txt`; `PROVENANCE.txt` names `/usr/share/terminfo` and today's UTC date.
- A second run prints the cache line and changes no mtimes.
- `rm -rf vendor/tmux/arm64/terminfo && bun run vendor:tmux` restores the DB (the cache check is not satisfied without it).
- Pointing the source at a temp dir missing `tmux-256color` fails with that entry named and leaves no partial `terminfo/` directory.
- `TERMINFO_DIRS="$PWD/vendor/tmux/arm64/terminfo" infocmp xterm-256color` (and the other four) exits 0.
- `bun scripts/verify-vendor-signing.ts` still passes; `bun run typecheck` clean.

### T4 — `tmuxEnv()`, attach builder, awaited route

**`src/bun/tmux-resolution.ts`**

```ts
export const SYSTEM_TERMINFO_DIR = "/usr/share/terminfo";

/** Pure: the TERMINFO_DIRS value for `binPath` — its sibling `terminfo/` first
 *  (the vendored DB), then `systemDir`. Only existing dirs; null when neither. */
export function terminfoDirsFor(binPath: string, systemDir = SYSTEM_TERMINFO_DIR): string | null {
  const dirs = [path.join(path.dirname(binPath), "terminfo"), systemDir].filter((d) => existsSync(d));
  return dirs.length ? dirs.join(":") : null;
}

/** True when `bin` is the bundled tmux path (packaged or dev). */
export function isBundledTmuxBin(bin: string): boolean {
  return path.resolve(bin) === path.resolve(bundledTmuxPath());
}

/** Env for a tmux client spawn: childEnv() semantics (live PATH, master token
 *  scrubbed) plus TERMINFO_DIRS only for the bundled binary. Appends to an
 *  existing TERMINFO_DIRS rather than replacing it. */
export function tmuxEnv(
  bin: string = resolveTmuxBin(),
  extra?: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const env = childEnv(extra);
  if (!isBundledTmuxBin(bin)) return env;
  const dirs = terminfoDirsFor(bin);
  if (!dirs) return env;
  env.TERMINFO_DIRS = env.TERMINFO_DIRS ? `${dirs}:${env.TERMINFO_DIRS}` : dirs;
  return env;
}
```

Swap `env: childEnv()` → `env: tmuxEnv()` at the tmux client spawn sites: `claude-tmux.ts:1682` (`tmux()`), `tmux-resolution.ts:189`, `:202`, `:239`, `opencode-tmux.ts:444` (`tmuxRun()`), and `opencode-server.ts:1420` (`tmuxSync`). In `opencode-server.ts`, give `runBounded` an optional `env` parameter defaulting to `childEnv()` and pass `tmuxEnv()` from the two tmux callers (`tmuxQuery` at `:594`, `tmuxNewSession` at `:621`); the `ps` caller at `:673` keeps `childEnv()`. Do **not** rename `childEnv` or reintroduce `tmuxClientEnv`.

**`src/bun/tmux-attach.ts`** (new, pure, no spawning):

```ts
export interface TmuxAttachCommandInput {
  tmuxPath: string;
  socketArgs: string[];
  sessionName: string;
  /** `terminfoDirsFor()` for a bundled binary; null/undefined for system tmux. */
  terminfoDirs?: string | null;
}
export function buildTmuxAttachCommand(input: TmuxAttachCommandInput): string;
```

Rules: POSIX single-quote every interpolated value (`'` → `'\''`); optional `TERMINFO_DIRS='…' ` prefix; `'<tmuxPath>' <socketArgs…> attach -t '<session>'`; append exactly

```
 || { echo; echo 'Agetor could not attach to the tmux session.'; echo 'Press Enter to close this window.'; read -r _; }
```

No `exec`, no double quotes, no backslashes (so `toTerminalAppleScript`'s AppleScript escaping is a no-op beyond any `\`/`"` in a path, which it handles).

**`src/bun/server.ts` open-tmux route** (`:7040-7129`):

- Keep the 404/400/503/session checks and `healWindowSize`; replace the local `shellEscape`/script assembly with:
  ```ts
  const socketArgs = tmuxSocketArgs();
  const terminfoDirs = isBundledTmuxBin(tmuxPath) ? terminfoDirsFor(tmuxPath) : null;
  const command = buildTmuxAttachCommand({ tmuxPath, socketArgs, sessionName, terminfoDirs });
  const script = toTerminalAppleScript(command);
  ```
  (`toTerminalAppleScript` is already imported at `server.ts:98`.)
- Await the launch exactly like the harness route: `stderr: "pipe"`, `Promise.race([proc.exited, Bun.sleep(5000).then(() => "timeout" as const)])`; timeout ⇒ `{ ok: true, sessionName }`; non-zero ⇒ read stderr, `console.warn`, return 502
  `{ error: "Couldn't open Terminal (osascript exited N). <detail> Check System Settings → Privacy & Security → Automation.", sessionName }`.
- Keep the `// spawn-exempt(osascript)` marker and the raw `/usr/bin/osascript` spawn (exemption count stays two). Response shape on success stays `{ ok: true, sessionName }` (`api.ts:2069-2072` unchanged).

**Acceptance**

- `terminfoDirsFor()`: temp vendored dir + temp system dir ⇒ `vendored:system` (order pinned); only system ⇒ `system`; neither ⇒ null; a path that does not exist is never included.
- `isBundledTmuxBin(bundledTmuxPath())` true; `isBundledTmuxBin("/usr/bin/tmux")` false.
- `tmuxEnv()`: system source ⇒ byte-equal to `childEnv()` (plus any extra), no `TERMINFO_DIRS` added; bundled path ⇒ `TERMINFO_DIRS` starts with the vendored dir and includes `/usr/share/terminfo`; an existing `TERMINFO_DIRS` is appended to, not replaced; `AGETOR_API_TOKEN` is absent in every case.
- Grep proves every tmux helper uses `tmuxEnv()`: no `env: childEnv()` remains in `claude-tmux.ts`'s `tmux()`, `tmux-resolution.ts`'s three spawns, `opencode-tmux.ts`'s `tmuxRun`, or `opencode-server.ts`'s `tmuxSync`; `tmuxQuery`/`tmuxNewSession` pass `tmuxEnv()` to `runBounded`, whose `ps` caller still gets `childEnv()`.
- `buildTmuxAttachCommand` pins the exact string (T5): env prefix present/absent; single-quote escaping for a path with `'` and a space; `-L`/`attach -t` order; `|| { … read -r _; }` present; no `exec ` in the output.
- `toTerminalAppleScript(buildTmuxAttachCommand(...))` yields a `tell application "Terminal" to do script "…"` + activate script with the command's quotes/backslashes escaped.
- Route review: 400 non-claude, 503 missing tmux, 404 missing session unchanged; timeout ⇒ 200; non-zero ⇒ 502 with the hint; success ⇒ 200 `{ok:true, sessionName}`.

### T6 — docs

- `docs/architecture/harness-claude-code.md`: line ~23 (boot poller) — add that a non-consent unnumbered startup menu is carded as choices; line ~40 — insert `matchUnnumberedModal` into the matcher sentence (footer in the last 3 non-blank lines, exactly one cursor, ≥2 contiguous rows, no checkbox/slider rows, `!paneWorking`/`!paneIdle`, keys hidden in the card); line ~74 — add "unnumbered" to `paneShowsBlockingPrompt`'s list; add a sentence that the bundled-tmux Terminal attach exports `TERMINFO_DIRS=<bundle>/bin/terminfo:/usr/share/terminfo` and awaits osascript with a 502.
- `docs/plans/unknown-claude-prompts-fallback.md`: append a dated addendum (2026-11-12) — the unnumbered matcher now handles footer-terminated unnumbered menus before the fallback; the fallback still covers footerless/unknown widgets and remains the final arm.
- `docs/qa/master-token-agent-read-qa.md` C2 (`:54`): expected becomes "Terminal.app opens attached to the task's tmux session; with the bundled tmux the attach works via the vendored terminfo DB, and a failed attach keeps the window open with an error (and a launch failure shows a 502 in the card)".
- No change to `README.md` (line 160's "offers a bundled copy" is now accurate), `CLAUDE.md`, or the topic map.

### T7 — verification, smoke, commit

- `bun run typecheck`.
- `bun test src/bun/claude-tmux-scraper.test.ts src/bun/interactions.test.ts src/bun/tmux-resolution.test.ts src/bun/tmux-attach.test.ts src/mainview/lib/tmux-prompt.test.ts src/bun/core-spawn-allowlist.test.ts`, then full `bun test` (allow ≥ 300 s; the investigation saw `claude-tmux-local-command.test.ts` exceed 180 s once — rerun with a larger budget before treating it as a signal).
- Manual smoke (record command + outcome in the Status row):
  1. `bun run vendor:tmux` (asserts the DB + license exist).
  2. `export PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH"; bun run dev` (data dir `~/.agetor-dev`, port 4318); Settings → tmux source = bundled; start a claude-code task; **Open tmux** (Task Details) and the unparsable card's **Open in Terminal** both attach to `agetor-<id>` and the window stays attached. Dev exercises the same sibling layout the bundle uses (`vendor/tmux/arm64/{tmux,terminfo}` vs `Contents/Resources/app/bin/{tmux,terminfo}`), so no full `.app` build is required.
  3. Failure recipe: in a scratch copy of the vendored tree, rename `terminfo/` away and point a dev build at a `TERMINFO_DIRS`-less environment, or temporarily deny the vendor dir; confirm the command falls back to `/usr/share/terminfo` and, when both are unavailable, the window stays open showing the tmux error + the Agetor message + "Press Enter".
  4. Chrome prompt: cannot be live-driven on this machine (`claudeInChromeDefaultEnabled: true`); record that the fixture tests are the verification and that the card visual is unverified live (grill assumption).
- Stage everything (including the untracked `docs/plans/issue-298-chrome-prompt-investigation.md`, `docs/plans/issue-298-chrome-prompt-grill.md`, its two round folders, and this plan) and commit locally:
  `fix: answer the unnumbered Claude Chrome prompt and repair bundled-tmux attach (Fixes #298)`.
  `git status` clean afterward. **Do not push.**

## 5. Work breakdown — test tasks

| ID | Layer | Covers | Owned files | Acceptance |
| --- | --- | --- | --- | --- |
| T2 | unit | T1: matcher, chain precedence, negatives, `paneIdle`, `hideKeys`, label helper | `src/bun/claude-tmux-scraper.test.ts`, `src/bun/interactions.test.ts`, `src/mainview/lib/tmux-prompt.test.ts` | Primary regression drives the **existing** `pickScrapeMatch` with the unnumbered fixture and new opts: at base it returns `unparsable:true`/0 choices, so the test fails on its assertion (Bun ignores the extra runtime-only `paneIdle` key); at HEAD it returns two choices + `hideKeys`. Keep the numbered/slider/yes-no precedence tests green; update every `pickScrapeMatch` call to pass `paneIdle:false`. Add the full negative truth table from T1. Add `interactions.test.ts` `hideKeys` registration/broadcast/JSON coverage (mirror the unparsable test at `:338-369`) and the label helper tests. Each new guard must be demonstrated red by temporarily removing it. |
| T5 | unit | T4: `terminfoDirsFor`, `isBundledTmuxBin`, `tmuxEnv`, attach-command builder | `src/bun/tmux-resolution.test.ts`, `src/bun/tmux-attach.test.ts` | Pin the exact attach string (bundled + system paths), the fallback suffix, single-quote escaping, no `exec`, `-L`/`-t` order; pin the env truth table incl. `AGETOR_API_TOKEN` scrubbing and append-not-replace; show the exact-string test red against the pre-fix route string (which had `exec`, no env, no fallback). |

**E2e: not applicable.** The change has user-visible flows, but the only e2e driver (`AGETOR_CLAUDE_DRIVER=fake`) bypasses tmux entirely, so no Playwright spec can reach pane matchers, `tmux send-keys`, osascript, or Terminal.app. The grill ratified unit tests + a manual Terminal smoke as the acceptance bar. This is a recorded non-applicability, not a silent omission.

**Run recipe**

- Unit: `bun test src/bun/claude-tmux-scraper.test.ts`, `bun test src/bun/interactions.test.ts`, `bun test src/bun/tmux-resolution.test.ts`, `bun test src/bun/tmux-attach.test.ts`, `bun test src/mainview/lib/tmux-prompt.test.ts`; full `bun test` (root scoped to `src/` by `bunfig.toml`).
- Typecheck: `bun run typecheck`.
- Manual: `bun run vendor:tmux`; `export PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH"; bun run dev`; select bundled tmux in Settings; start a claude task; attach. Dev data dir `~/.agetor-dev`, API port 4318 — never `~/.agetor`.
- Spawn-allowlist: `bun test src/bun/core-spawn-allowlist.test.ts` (two `server.ts:osascript` exemptions only).

## 6. Execution waves

**Wave 1** (parallel, disjoint files): T1 (production) + T2 (tests, same-wave pinned interface) + T3 (vendor script).
Barrier: `bun run typecheck` clean; `bun test src/bun/claude-tmux-scraper.test.ts src/bun/interactions.test.ts src/mainview/lib/tmux-prompt.test.ts` green; `bun run vendor:tmux` produces the DB; checkpoint commit (or one working-tree checkpoint before the single final commit).

**Wave 2** (after wave 1, parallel): T4 (runtime env + attach + route) + T5 (its tests).
Barrier: `bun run typecheck`; `bun test src/bun/tmux-resolution.test.ts src/bun/tmux-attach.test.ts`; `bun test src/bun/core-spawn-allowlist.test.ts`; checkpoint.

**Wave 3**: T6 (docs) + T7 (full suite, manual smoke, single local commit).

**Delivery slices**: one slice. The diff is well under ~1,500 lines (two small modules, one matcher + guards, one script extension, one route rewrite, tests/docs) and cannot be usefully split: the prompt half and terminal half reproduce independently but the issue asks for both, and the owner chose one local commit. No stacked PRs.

## 7. Invariants, runtime shape & risks

**Invariants and their single enforcement point**

1. *The Chrome prompt is never auto-answered.* Every auto-confirm path goes through `STARTUP_CONSENT_DIALOGS` + `matchStartupConsentDialog` (`claude-tmux.ts:5971-6052`); the Chrome prompt has no entry, and `matchUnnumberedModal` only returns choices. A new matcher must never call `confirmStartupDialog` or `send-keys`.
2. *Only registered choice keys can be typed into the pane.* `POST /tmux-prompts/:id/answer` validates `key` against `pending.choices` (`server.ts:7982-7987`); `hideKeys` never changes keys.
3. *No unnumbered card on an idle or working pane.* `pickScrapeMatch` is the one gate; all three call sites (`scrapeOnce`, boot poller, `paneShowsBlockingPrompt`) pass `paneIdle`/`paneWorking`. Adding a fourth call site is a typecheck error because both fields are required.
4. *The terminfo override is bundled-only.* `tmuxEnv()` gates on `isBundledTmuxBin`; the route passes `terminfoDirs` only when the resolved binary is the bundle. System tmux keeps its own lookup.
5. *Every spawn goes through `coreSpawn`.* The only exceptions remain the two pinned `/usr/bin/osascript` sites (harness terminal + open-tmux); no new exemption.
6. *`hideKeys` is display-only.* It has exactly one producer (`matchUnnumberedModal`) and one consumer (`tmuxChoiceLabel`), and never participates in a fingerprint or an answer key.

**Runtime shape**: one local macOS desktop app plus one core per data dir; the tmux server is long-lived and survives app/core restarts; the attach is a one-off client on the app's own socket (`tmuxSocketArgs()`). No rolling deploy, no crash-between-steps state, no schema, no migration, no persisted prompt rows. The vendored terminfo DB is read-only build output shipped in the bundle.

**Blast radius**

- Any pane shaped like a footer-terminated unnumbered menu can now produce a card. Mitigations: the matcher's guards (footer in the last 3 non-blank lines, one cursor row, ≥2 and ≤9 rows, no checkbox/value-selector/numbered rows), the 2-tick stability gate (never `highConfidence`), `!paneWorking`/`!paneIdle`, and the retained unparsable fallback. A false card costs one click or the Task Details terminal; it cannot send a key until the user clicks.
- Adding `TERMINFO_DIRS` to bundled tmux client spawns (including `start-server`) is additive and only affects the bundled path; panes inherit it, which is harmless for the agent CLIs.
- The open-tmux response now waits up to 5 s instead of returning immediately; the card already shows an "Opening…" state, and the timeout branch still returns ok.
- The unnumbered trust dialog, when the boot auto-confirmer gives up after 4 attempts, now falls through to clickable choices instead of an unparsable card — a positive side effect; `matchStartupConsentDialog` behavior is unchanged.
- Rollback: revert the commit. No data, no schema, no config preference changes.

**Cross-repo dependencies**: none.

## 8. Open questions / assumptions

No unratified one-way door. The Chrome auto-answer policy (the only one-way door) was answered **card-only** at the grill.

Carried from the grill (with what breaks if wrong):

1. The reporter's hidden footer is `Enter to confirm` (boot footer arm + 2.1.322 strings; not a raw capture). If wrong, the generic matcher misses their exact CLI; the fixture is the pin and a Chrome marker/footer anchor is the fallback.
2. The `er` select responds to Down+Enter for the Chrome dialog (same component family as 2.1.284's trust dialog; not live-driven here). If wrong, a click won't advance; the manual smoke on a fresh onboarding state would catch it.
3. `/usr/share/terminfo` exists with the five entries on the build host (verified today). The vendor script must fail loudly rather than ship an empty DB.
4. The five entries cover Terminal.app's default profile and tmux clients; a custom `TERM` falls back to the system DB, which is second in the search path.
5. The 5 s osascript ceiling is enough; a timeout returns ok (same as the harness route).
6. Dropping `exec` does not change a successful attach; the builder test pins the exact command.
7. `hideKeys` is added to the hand-mirrored `PendingTmuxPrompt`; typecheck catches drift.
8. The `paneIdle` signature change is propagated to all three call sites; required-field typing makes a missed site a compile error.
9. The vendor script's cache check includes the terminfo dir.
10. The generic matcher's false-positive class is acceptable with no dismiss; the guards + 2-tick gate are the mitigation.

Added by this plan (reasoning-based):

11. `paneShowsBlockingPrompt` and the boot poller compute `paneIdle` without a styled capture (`paneShowsIdleInputBox(tail)`); a dim placeholder row may therefore read non-idle there. The matcher's own footer/choice guards prevent a false card, and `scrapeOnce` still uses the styled capture.
12. The attach command intentionally overrides `TERMINFO_DIRS` for that one client (the value includes the system DB). `tmuxEnv()` appends to an existing value instead, so core spawns never drop a user setting; a user-set `TERMINFO` (single dir) still wins for core spawns by ncurses semantics.
13. The 9-row cap is an added hardening; an unnumbered menu with more than 9 options falls to the unparsable card (safe, not silently wrong).
14. `scripts/terminfo/LICENSE-ncurses.txt` is copied verbatim from the ncurses distribution (this host: `/opt/homebrew/Cellar/ncurses/6.5/COPYING`); if the implementing agent cannot obtain it, stop and ask rather than shipping the DB without its license.

### Added by the implementation (recorded, not owner-ratified — no one-way door)

15. **T1's acceptance line "same pane with `paneIdle:true` ⇒ `pickScrapeMatch` null" needed the idle gate on the trailing unparsable arm too.** The pseudocode in §4 gates only the unnumbered arm on `paneIdle`, so the same pane (which carries the footer) would still fall through to `matchUnparsableModal` on an idle tick. `stuckTurnFallbackArmed`'s own doc already states the principle — "an idle input box is proof the turn is over, not a stuck/unparsable modal, so carding it would be wrong" — so `pickScrapeMatch` now treats `paneWorking || paneIdle` as "quiet = false" for BOTH trailing arms. Effect: a finished transcript that quotes a footer-terminated menu cannot card at all while the composer is idle; idle panes keep their existing `signalIdleSettle` handler. The numbered / yes-no / slider arms are untouched (their shapes are precise enough to win on an idle pane). No route, spawn exemption, public contract or stored data changes.
16. `paneShowsBlockingPrompt` now passes both gates (`paneWorking` and an unstyled `paneIdle`) into the shared chain, so a paste is never withheld behind a quoted menu on an idle composer.
17. The T2 test for the boot poller's "gave up on the trust dialog" fall-through (N4) now expects the CLICKABLE choice card (hideKeys) instead of the unparsable card — the positive side effect recorded in §7's blast radius, pinned as a test.
18. The vendor script's cache hit path also re-runs the `infocmp` sanity check (cheap, and it catches a corrupted vendor tree); a cached binary without `terminfo/` gets the DB added in place without re-copying/re-signing the binary.

### Added by the review fix round (recorded, not owner-ratified — no one-way door)

19. `matchUnnumberedModal`'s checkbox guard is `CHECKBOX_ROW_RE`, matching a `[ ]`/`[x]`/`[✔]` token at EITHER end of the row label. The original leading-only regex missed claude's trailing form (`Also scan shell history    [ ]`, the auto-mode wizard fixture), which would have presented a multi-select checklist as a single-choice card when its footer read `Enter to confirm`.
20. `parseUnnumberedChoices`' footer anchor is now case-insensitive, matching the `matchUnnumberedModal` gate it is reached through. Previously a differently-cased footer passed the gate and then failed to parse.
21. `buildTmuxAttachCommand` hands the whole command to `/bin/sh -c`. Terminal's `do script` runs through the user's LOGIN shell, and `VAR=val` prefixes plus `{ …; }` / `read -r` are POSIX-only — fish/nushell login shells would have failed at the first token. The inner command keeps the exact POSIX quoting; `/bin/sh` ships with every macOS.
22. ~~Both osascript routes kill the child on the 5 s timeout branch~~ — reverted after review: both routes now share `awaitTerminalLaunch` (`src/bun/terminal-launch.ts`), which answers ok at the 5 s ceiling and leaves the child running, because the usual slow case is the first-use Automation consent prompt and a killed child means the window never opens. `vendorTerminfo` builds into a sibling staging directory and swaps it into place, so a timed-out launcher can't linger and a mid-copy failure can't leave a partial terminfo tree at the path the cache check trusts.
23. The unnumbered card's preview (`paneText`) starts at the top of the dialog instead of the fixed last 12 lines: up to `UNNUMBERED_PREVIEW_CONTEXT_LINES` (16) lines above the first choice row, cut below the dialog's top horizontal rule when one is in that window. The 12-line window dropped "Claude in Chrome extension detected" from the 13-line dialog, so the user chose a persistent setting without the title. Display-only; the fingerprint is unchanged.


### 8.3 Manual smoke record (2026-11-12, this host: macOS 26.6.2, arm64)

**Vendoring (T3).**

- `bun run vendor:tmux` (fresh): copies 3 dylibs, then `vendored 5 terminfo entries → vendor/tmux/arm64/terminfo/`, `✓ TERMINFO_DIRS resolves all 5 entries`, `✓ tmux 3.6a`. The tree is `73/{screen,screen-256color}`, `74/tmux-256color`, `78/{xterm,xterm-256color}` plus `LICENSE-ncurses.txt`, `README.md`, `PROVENANCE.txt` (source `/usr/share/terminfo`, UTC timestamp).
- A second run prints `cached at vendor/tmux/arm64/ — skipping` and leaves `PROVENANCE.txt`'s mtime unchanged.
- `rm -rf vendor/tmux/arm64/terminfo` + re-run restores the DB (`vendored tmux is cached but its terminfo database is missing — adding it`), i.e. the cache check includes it.
- Missing-entry path: with `TERMINFO_SOURCE` temporarily pointed at a temp copy lacking `tmux-256color`, the script exits 1 naming exactly `tmux-256color` and leaves **no** `vendor/tmux/arm64/terminfo` directory (all entries are resolved before anything is written). `bun scripts/verify-vendor-signing.ts` still passes (skips without `ELECTROBUN_DEVELOPER_ID`).

**Attach reproduction and fix (T4) — under `sandbox-exec` denying only the build machine's Cellar terminfo (`/opt/homebrew/Cellar/ncurses`), i.e. the reporter's situation.** Session created with the bundled binary on an isolated socket.

- Pre-fix command shape under a pty (`tmux -L … attach -t …`, `TERM=xterm-256color`, no `TERMINFO_DIRS`): printed **`can't find terminfo database`**, exit 1 — the reported failure.
- `buildTmuxAttachCommand`'s command for the bundled binary (`TERMINFO_DIRS=<bundle>/bin/terminfo:/usr/share/terminfo`): attached and drew the real tmux client, exit 0 when the session ended.
- Stay-open fallback: the built command run in a pty against a nonexistent session printed `no sessions`, then `Agetor could not attach to the tmux session.` and `Press Enter to close this window.`, and waited at `read -r _` instead of closing with `[Process completed]`.

**Chrome prompt.** Not live-driven here (this machine already has Chrome onboarding completed, grill assumption #2). The reconstructed 2.1.322 fixture tests are the verification of the card; the card's visual rendering on a fresh onboarding state remains unverified live. The full GUI smoke (`bun run dev`, Settings → bundled tmux, a real task, Open tmux) was not run: the attach half was exercised end-to-end against the same binary/layout the dev build uses (`vendor/tmux/arm64/{tmux,terminfo}`), and the route mirrors the already-reviewed `/harnesses/:id/open-terminal` await/502 pattern.

**Full-suite note (environment).** The whole `bun test` suite (493 files in one process) could not complete on this shared worktree host — a 30-minute run and a 25-file chunked run both exceeded the wall clock, and the fake-bun-tmux files (`claude-tmux-askdrive`, `claude-tmux-local-command`'s `mirrorModelViaPicker` group) hit bun's 5 s default per-test timeout under load. That is not this change: `claude-tmux-askdrive` fails identically at base (13 timeouts at base vs the same class at HEAD), and one mirror test takes 5.5 s at base *and* at HEAD. With `--timeout 30000` both are fully green (42/42 and 11/11), and the first alphabetical 25-file chunk (831 tests) is green. The focused suites for every changed unit are green without a timeout override (429 tests), as are `claude-tmux-queue`, `claude-tmux`, `agents`, `core-spawn` and `claudemd-citations` (509 tests, `--timeout 30000`).

## 9. Completeness ledger

| Item | Disposition | Task ID / reason / who deferred |
| --- | --- | --- |
| Unnumbered Chrome prompt: matcher, choices, cursor, card, answer-route reuse | In this run | T1 |
| `paneIdle` threading through all `pickScrapeMatch` call sites (and their tests) | In this run | T1, T2 |
| `hideKeys` through `ScrapeMatch` → `TmuxPromptRequest` → `api.ts` → `TmuxPromptCard` + label helper | In this run | T1, T2 |
| Vendored terminfo DB: five entries, hashed layout, copy step, cache check, license + provenance, `infocmp` sanity check | In this run | T3 |
| Runtime terminfo helper (`terminfoDirsFor`, `isBundledTmuxBin`, `tmuxEnv`) + all bundled-tmux spawn sites | In this run | T4 |
| Attach command builder, awaited osascript/502, stay-open in-shell fallback | In this run | T4, T5 |
| Unit tests for matcher/parser/chain negatives/hideKeys/label helper | In this run | T2 |
| Unit tests for terminfo helper + attach builder | In this run | T5 |
| Manual Terminal.app attach smoke (bundled tmux) + failure fallback | In this run | T7 |
| Docs: harness doc, fallback addendum, QA row | In this run | T6 |
| Single local commit with `Fixes #298`; grill/investigation/plan docs ride it | In this run | T7 |
| Old numbered `CHROME_EXTENSION_PANE` fixture | Kept (not orphaned) | T1/T2 pin it as older-CLI coverage |
| `matchUnparsableModal` / unparsable card | Kept (not orphaned) | Final fallback for genuinely unknown widgets; T1 keeps it last in the chain |
| `parseUnnumberedConsentChoices` | Reused + renamed, not duplicated | T1 |
| `agetor attach` CLI resolving `resolvedBin` / setting terminfo | Out of scope | Owner chose `attach-bundled` (grill #5); needs its own `GET /tmux-source` call and error path — different ticket |
| In-app terminal shell env (`terminals.ts`) | Out of scope | Grill #5; not the reported path and it changes the user's shell environment |
| Cross-agent Chrome arbitration (Codex/Claude Desktop) | Out of scope | Grill #13; a different feature |
| Agetor Settings preference for the Chrome prompt | Out of scope | Rejected in grill #3 |
| Dismiss/Esc action on choice cards | Out of scope | Rejected in grill #8 (Esc = permanent "No") |
| Full system DB or ncurses-release terminfo DB | Out of scope | Grill #4a chose the five-entry set |
| Live-driving the Chrome prompt with a fresh onboarding state | Out of scope (environment) | Grill #9; fixture verification + documented manual gap |
| CLI TUI `AnswerOverlay`'s "Reject / Esc" row on a tmux prompt (Esc = permanent "No" on the Chrome prompt) | Out of scope | Pre-existing for every tmux_prompt and unchanged by this fix; the desktop card gains no dismiss. A separate CLI-UX ticket if the owner wants it hidden for `hideKeys` prompts |
| `GET /tmux-source` exposing terminfo-DB presence | Out of scope | Not needed for the fix; `TmuxInstallDialog`/Settings copy stays accurate |
| Schema, migrations, backfill | None | Prompt is ephemeral; terminal fix is runtime/build-only |
| E2e coverage | Not applicable | Fake Claude driver bypasses tmux; pane matchers and Terminal.app attach are unit/manual surfaces (grill #9) |

## 8.4 Test loop record (2026-11-12, final tree)

**Run recipe** — `bunfig.toml` scopes `bun test` to `src/` with the `src/test-preload.ts`
preload; there is no CI workflow in this repo, so the gates are `bun run typecheck`, the
full `bun test`, and `bun scripts/verify-vendor-signing.ts`.

| Layer / gate | Command | Result |
| --- | --- | --- |
| Typecheck | `bun run typecheck` | clean |
| Focused suites | `bun test src/bun/claude-tmux-scraper.test.ts src/bun/interactions.test.ts src/bun/tmux-resolution.test.ts src/bun/tmux-attach.test.ts src/mainview/lib/tmux-prompt.test.ts src/bun/core-spawn-allowlist.test.ts src/bun/route-policy.test.ts src/bun/claudemd-citations.test.ts` | 507 pass / 0 fail (1.4 s) |
| Full suite | `bun test --timeout 30000` | 12,894 pass / 31 skip / 8 fail, 12,933 tests in 499 files (1,616 s) |
| Vendor signing | `bun scripts/verify-vendor-signing.ts` | skips without `ELECTROBUN_DEVELOPER_ID` (exit 0) |
| Build script | `bun run vendor:tmux` (cached tree) | `✓ TERMINFO_DIRS resolves all 5 entries`, mtime unchanged |
| E2e | not run — recorded not applicable | no Playwright spec reaches a tmux pane, `tmux_prompt` card or Terminal.app; the fake Claude driver bypasses tmux (grill #9) |

**The 8 full-suite failures are not this change** (checked per file against a
`40d014a4` worktree with the same `node_modules`/`vendor`):

- `claude-turn-routing.test.ts` — 5 (`an unambiguous 'gone' probe…`, `a large (>4KB)
  follow-up resume…`, `a resume spawn with a deferred large prompt…`, `cancelling a run
  while its large prompt is deferred…`, `a failed deferred paste…`): 6 pass / 9 fail at
  base and 10 pass / 5 fail at HEAD **with the same five names**; real-tmux + wall-clock
  budgets.
- `opencode-tmux.test.ts` — 2 (`drop of a client that honors C-c returns quickly`,
  `reattach: null when the session is gone…`): identical names at base and HEAD.
- `codex-limit`, `claude-tmux-askdrive`, `claude-tmux-local-command` fail only under
  bun's 5 s default timeout (15/9/… at default) and are fully green at
  `--timeout 30000` (19/42/106) — matching base counts exactly at the default timeout.
- `orchestrator-hold-scope-claim.test.ts` — one `beforeEach/afterEach` hook timeout at
  30 s under full-suite load; **1 pass / 0 fail in isolation (1.4 s)**. Flake, not wired
  to this change.

Skips are all platform/host-conditional (`test.skipIf(process.platform …)`, the
`tmux`/`direct` host split, missing real transcripts) — no silent early returns.

**Green is real (mutation checks).** Each new guard was removed in a throwaway copy of
`src/` and the scraper file re-run: dropping `hideKeys: true` → 5 red (incl. the
`scrapeOnce` registration test and the boot-poll fall-through); letting the unnumbered arm
ignore `quiet` → 3 red (incl. the idle-composer tick test); letting the unparsable arm
ignore `paneIdle` + a case-sensitive parser footer → 4 red; leading-only `CHECKBOX_ROW_RE`
+ no row cap → 2 red. Restored afterwards; nothing mutated in the repo.

**Live reproduction and fix of defect B** (bundled binary, `sandbox-exec` denying only
`/opt/homebrew/Cellar/ncurses/6.5/share/terminfo` — the reporter's "no Homebrew" case):
`tmux attach` under a pty printed `can't find terminfo database`; the
`buildTmuxAttachCommand` string for the bundled binary, run the same way, attached to a
real session and detached cleanly (`[detached (from session live)]`, 0 occurrences of the
error), and the same command against a missing session printed
`Agetor could not attach to the tmux session.` / `Press Enter to close this window.` and
waited for Enter instead of `[Process completed]`.

**Known residuals** (recorded, not fixed here): the boot poller's `hideKeys:` forwarding
line (`claude-tmux.ts:9250`) is covered indirectly (the tracker fall-through test) but has
no spawn-level seam; `scripts/fetch-tmux.ts` staging is a build script outside `bun test`
(exercised by hand above); the open-tmux route's 502/timeout mapping has no route test
because it would launch Terminal.app.
