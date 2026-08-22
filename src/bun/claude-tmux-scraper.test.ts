import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Set data dir before db.ts is loaded transitively (claude-tmux.ts imports
// it now that the scraper looks up the task's runId).
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-scraper-"));

import { __forTest } from "./claude-tmux.ts";
import { detectAskModal } from "./claude-questions.ts";

const {
  matchNumberedModal,
  matchYesNoModal,
  matchStartupConsentDialog,
  clearedStabilityGate,
  matchUnparsableModal,
  stuckTurnFallbackArmed,
  MODAL_FOOTER_RE,
  STUCK_TURN_FALLBACK_MS,
  WORKING_LINE_RE,
  MODAL_NOTICE_RE,
  paneShowsClaudeWorking,
  WORKING_CHROME_WINDOW_LINES,
  UNPARSABLE_STABILITY_TICKS,
  nextUnparsableStreak,
  unparsableStreakCleared,
} = __forTest;

/** Real tmux pane captures of claude-code 2.1.161's AskUserQuestion modal —
 *  same fixture directory claude-questions.test.ts reads from. */
const fx = (name: string): string =>
  readFileSync(path.join(import.meta.dir, "fixtures", "askuserquestion", `${name}.txt`), "utf8");

test("matchNumberedModal — claude plan-mode dialog (cursor on choice 1)", () => {
  const pane = `
  Edit file
    src/foo.ts
    1 line changed
  Do you want to make this edit to foo.ts?
  ❯ 1. Yes
    2. Yes, allow all
    3. No
`;
  const m = matchNumberedModal(pane);
  expect(m).not.toBeNull();
  expect(m!.choices.map((c) => c.key)).toEqual(["1", "2", "3"]);
  expect(m!.choices[0]!.label).toBe("Yes");
  expect(m!.choices[1]!.label).toBe("Yes, allow all");
  expect(m!.choices[2]!.label).toBe("No");
  expect(m!.cursorIndex).toBe(0);
});

test("matchNumberedModal — alt cursor glyph (›)", () => {
  const pane = `Question?
› 1. Pick A
  2. Pick B`;
  const m = matchNumberedModal(pane);
  expect(m?.choices.length).toBe(2);
  expect(m?.cursorIndex).toBe(0);
});

test("matchNumberedModal — cursor on non-first choice (model picker shape)", () => {
  // Regression for the "Allow all edits silently picks Yes" class of
  // bug: selection modals (model picker, /login) open with the cursor
  // on the *current* value, not option 1. The cursor index must
  // reflect that so the dismissal path can navigate from the right
  // starting position.
  const pane = `Pick a model
  1. Opus 4.7
❯ 2. Sonnet 4.6
  3. Haiku 4.5`;
  const m = matchNumberedModal(pane);
  expect(m).not.toBeNull();
  expect(m!.cursorIndex).toBe(1);
});

test("matchNumberedModal — same labels with different cursor position yield different fingerprints", () => {
  // Cursor position is part of the fingerprint so that an in-progress
  // modal whose selection changed (e.g., user arrowed via real tmux
  // attach) re-registers with the new starting position. Without
  // this, the second-tick stability check would silently match the old
  // fingerprint and the dismissal path would navigate from a stale
  // cursor index.
  const a = matchNumberedModal(`❯ 1. A\n  2. B\n  3. C`)!;
  const b = matchNumberedModal(`  1. A\n❯ 2. B\n  3. C`)!;
  expect(a.cursorIndex).toBe(0);
  expect(b.cursorIndex).toBe(1);
  expect(a.fingerprint).not.toBe(b.fingerprint);
});

test("matchNumberedModal — no cursor anywhere means it's a printed list, not a modal", () => {
  const pane = `Here are the next steps:
  1. Install
  2. Configure
  3. Run`;
  expect(matchNumberedModal(pane)).toBeNull();
});

test("matchNumberedModal — only one numbered line → not a choice set", () => {
  const pane = `Foo
❯ 1. Just one`;
  expect(matchNumberedModal(pane)).toBeNull();
});

test("matchNumberedModal — same content yields a stable fingerprint", () => {
  const pane = `Q?
❯ 1. A
  2. B`;
  const a = matchNumberedModal(pane)!;
  const b = matchNumberedModal(pane + "\n   "); // trailing whitespace shouldn't change fp
  expect(a.fingerprint).toBe(b!.fingerprint);
});

test("matchNumberedModal — changing labels changes the fingerprint", () => {
  const a = matchNumberedModal(`❯ 1. A\n  2. B`)!;
  const b = matchNumberedModal(`❯ 1. A\n  2. C`)!;
  expect(a.fingerprint).not.toBe(b.fingerprint);
});

test("matchNumberedModal — tool-use permission prompt: wrapped description's '0.' line is not a choice", () => {
  // Regression: an MCP tool-use permission prompt wraps the tool description
  // across pane lines. When a line happens to break right before a number —
  // here "… remaining >" / "0. Use the offset …" — the phantom "0." row is
  // numerically contiguous with the real "1." option and used to be swallowed
  // as choice 0 (shifting the cursor index too). The choice set must be exactly
  // the 1/2/3 options below "Do you want to proceed?".
  const pane = `  Tool use

    example MCP server – Fetch Records(scope: "demo") (MCP)
    Fetch records in pages. Keep fetching while remaining >
    0. Use the offset arg to paginate.

  Do you want to proceed?
  ❯ 1. Yes
    2. Yes, and don't ask again for example MCP server – Fetch Records commands in
       /Users/me/.agetor/worktrees/demo
    3. No

  Esc to cancel · Tab to amend`;
  const m = matchNumberedModal(pane);
  expect(m).not.toBeNull();
  expect(m!.choices.map((c) => c.key)).toEqual(["1", "2", "3"]);
  expect(m!.choices[0]!.label).toBe("Yes");
  expect(m!.cursorIndex).toBe(0);
  // The wrapped continuation row (the worktree path) is folded into option 2's
  // label rather than dropped, so the "don't ask again" scope stays legible.
  expect(m!.choices[1]!.label).toBe(
    "Yes, and don't ask again for example MCP server – Fetch Records commands in /Users/me/.agetor/worktrees/demo",
  );
  expect(m!.choices[2]!.label).toBe("No");
});

test("matchNumberedModal — a same-indent line under the last option is not folded into its label", () => {
  // The last option isn't capped by a following numbered row, so it relies on
  // the indentation rule: only rows indented PAST the option marker are wraps.
  // A standalone hint at the option's own indent must stay out of the label.
  const pane = `Do you want to proceed?
❯ 1. Yes
  2. No
  This runs immediately.

Esc to cancel`;
  const m = matchNumberedModal(pane);
  expect(m!.choices.map((c) => c.label)).toEqual(["Yes", "No"]);
});

test("matchNumberedModal — modal footer marks the match high-confidence (skips the two-tick gate)", () => {
  // A real interactive modal carries an `Esc to cancel …` footer; streamed
  // numbered output never does. scrapeOnce registers high-confidence matches on
  // the first sighting so tool-use asks surface promptly instead of ~2s late.
  const withFooter = matchNumberedModal(`Do you want to proceed?
❯ 1. Yes
  2. No

Esc to cancel · Tab to amend`);
  expect(withFooter!.highConfidence).toBe(true);

  const withoutFooter = matchNumberedModal(`Do you want to proceed?
❯ 1. Yes
  2. No`);
  expect(withoutFooter!.highConfidence).toBeFalsy();
});

test("matchNumberedModal — footer is found past trailing blank rows (tmux pads the capture)", () => {
  // `tmux capture-pane` can emit trailing blank rows. The footer detection must
  // look at the last non-blank lines, not a fixed window of raw lines, or the
  // fast path silently never engages and the delay fix is a no-op in practice.
  const m = matchNumberedModal(`Do you want to proceed?
❯ 1. Yes
  2. No

Esc to cancel · Tab to amend


`);
  expect(m!.highConfidence).toBe(true);
});

test("matchNumberedModal — AskUserQuestion review/submit screen ('Ready to submit your answers?') matches as a numbered modal", () => {
  // scrapeOnce now narrows the ask-modal suppression to detectAskModal ===
  // "question" only (claude-tmux.ts), so a lingering "review" screen falls
  // through to this matcher instead of being structurally invisible. Slice
  // the fixture down to the review block itself — tab bar through the
  // "2. Cancel" line — the way a real 40-line pane tail would present it.
  const lines = fx("review_submit").split("\n");
  const tabBarIdx = lines.findIndex((l) => l.includes("✔ Submit"));
  const cancelIdx = lines.findIndex((l) => /2\.\s+Cancel/.test(l));
  expect(tabBarIdx).toBeGreaterThan(-1);
  expect(cancelIdx).toBeGreaterThan(tabBarIdx);
  const tail = lines.slice(tabBarIdx, cancelIdx + 1).join("\n");

  const m = matchNumberedModal(tail);
  expect(m).not.toBeNull();
  expect(m!.choices).toEqual([
    { key: "1", label: "Submit answers" },
    { key: "2", label: "Cancel" },
  ]);
  expect(m!.cursorIndex).toBe(0);
  // No "Esc to cancel" footer on the review screen → not high-confidence,
  // so the two-tick stability gate applies before scrapeOnce registers it
  // (guards against a mid-drive transient sighting registering a ghost card).
  expect(m!.highConfidence).toBeFalsy();
});

test("clearedStabilityGate — high-confidence registers on first sighting; others need two ticks", () => {
  const hi = { fingerprint: "fp", highConfidence: true } as any;
  const lo = { fingerprint: "fp", highConfidence: false } as any;
  // High-confidence clears even when the previous tick saw nothing.
  expect(clearedStabilityGate(hi, null)).toBe(true);
  // Low-confidence needs the previous tick to have seen the same fingerprint.
  expect(clearedStabilityGate(lo, null)).toBe(false);
  expect(clearedStabilityGate(lo, "different")).toBe(false);
  expect(clearedStabilityGate(lo, "fp")).toBe(true);
});

test("matchYesNoModal — (y/N) prompt on last line", () => {
  const pane = `Continue with the operation? (y/N)`;
  const m = matchYesNoModal(pane);
  expect(m).not.toBeNull();
  expect(m!.choices.map((c) => c.key)).toEqual(["y", "n"]);
});

test("matchYesNoModal — bracket variant [Y/n] with trailing colon", () => {
  const pane = `Proceed [Y/n]:`;
  const m = matchYesNoModal(pane);
  expect(m).not.toBeNull();
});

test("matchYesNoModal — ignores numbered modal pane (different signature)", () => {
  const pane = `❯ 1. Yes
  2. No`;
  expect(matchYesNoModal(pane)).toBeNull();
});

test("matchStartupConsentDialog — bypass-permissions warning, accept is option 2", () => {
  // The exact shape claude draws on the first `--dangerously-skip-permissions`
  // launch of a version that re-prompts. The cursor defaults to "No, exit"
  // (option 1); we must navigate to the affirmative.
  const pane = `
  WARNING: Claude Code running in Bypass Permissions mode

  By proceeding, you accept all responsibility for actions taken while running
  in Bypass Permissions mode.

  https://code.claude.com/docs/en/security

  ❯ 1. No, exit
    2. Yes, I accept
`;
  const m = matchStartupConsentDialog(pane);
  expect(m).not.toBeNull();
  expect(m!.name).toBe("bypass-permissions");
  expect(m!.cursorIndex).toBe(0);
  expect(m!.acceptIndex).toBe(1); // must move off the default "No, exit"
});

test("matchStartupConsentDialog — workspace-trust dialog (real observed text), accept is the cursor default", () => {
  // The real first-run workspace-trust prompt (claude 2.1.x). NOT suppressed by
  // --dangerously-skip-permissions, so agetor's fresh worktrees hit it; left
  // unanswered it blocks JSONL creation until the 30s boot timeout kills the run.
  const pane = `────────────────────────────────────────────────────────────────────────────────
 Accessing workspace:

 /Users/me/.agetor/worktrees/00000000-0000-0000-0000-000000000000

 Quick safety check: Is this a project you created or one you trust? (Like your
 own code, a well-known open source project, or work from your team). If not,
 take a moment to review what's in this folder first.

 Claude Code'll be able to read, edit, and execute files here.

 Security guide

 ❯ 1. Yes, I trust this folder
   2. No, exit

 Enter to confirm · Esc to cancel`;
  const m = matchStartupConsentDialog(pane);
  expect(m).not.toBeNull();
  expect(m!.name).toBe("trust-folder");
  expect(m!.cursorIndex).toBe(0);
  expect(m!.acceptIndex).toBe(0); // already on "Yes, I trust this folder" → Enter alone
});

test("matchStartupConsentDialog — a normal per-tool permission modal is NOT auto-confirmed", () => {
  // Runtime permission prompts carry no startup marker → must stay null so
  // they route through the interactive scraper for the user to decide.
  const pane = `Do you want to make this edit to foo.ts?
  ❯ 1. Yes
    2. Yes, allow all
    3. No`;
  expect(matchStartupConsentDialog(pane)).toBeNull();
});

test("matchStartupConsentDialog — bypass marker without a parseable choice list → null", () => {
  // A half-drawn frame (marker present, choices not yet rendered) must not
  // trigger a stray Enter.
  const pane = `WARNING: Claude Code running in Bypass Permissions mode`;
  expect(matchStartupConsentDialog(pane)).toBeNull();
});

test("matchStartupConsentDialog — distinct dialogs get distinct fingerprints", () => {
  const bypass = matchStartupConsentDialog(`Bypass Permissions mode\n❯ 1. No, exit\n  2. Yes, I accept`)!;
  const trust = matchStartupConsentDialog(`Quick safety check\n❯ 1. Yes, I trust this folder\n  2. No, exit`)!;
  expect(bypass).not.toBeNull();
  expect(trust).not.toBeNull();
  expect(bypass.fingerprint).not.toBe(trust.fingerprint);
});

// The "Claude in Chrome extension detected" startup prompt (introduced by a
// claude version bump) blocks JSONL creation just like the consent dialogs —
// but enabling/disabling browser tools is NOT a choice agetor can make for the
// user. It must therefore route through the interactive scraper path (surfaced
// as a tmux_prompt card the user answers), never the boot auto-confirmer.
const CHROME_EXTENSION_PANE = `  Claude in Chrome extension detected

  Claude will use your Chrome browser by default — navigating sites, filling
  forms, and capturing screenshots in your existing session.

  Site-level permissions come from the Chrome extension. Turn browser tools
  off for future sessions with /chrome.

❯ 1. Yes, use my browser
  2. No, keep browser tools off

Enter to confirm · Esc to keep browser tools off`;

test("matchStartupConsentDialog — Chrome-extension startup prompt is NOT auto-confirmed", () => {
  // No startup-consent marker → null, so boot leaves it for the user instead
  // of guessing whether to grant browser access.
  expect(matchStartupConsentDialog(CHROME_EXTENSION_PANE)).toBeNull();
});

test("matchNumberedModal — Chrome-extension startup prompt surfaces as an interactive modal", () => {
  // The boot poller falls back to this matcher for non-consent startup
  // questions; a hit is what gets registered as a tmux_prompt card.
  const m = matchNumberedModal(CHROME_EXTENSION_PANE)!;
  expect(m).not.toBeNull();
  expect(m.cursorIndex).toBe(0);
  expect(m.choices.map((c) => c.label)).toEqual([
    "Yes, use my browser",
    "No, keep browser tools off",
  ]);
});

test("dispatchLine updates permissionMode BEFORE the dedup guard (reattach safety)", async () => {
  const { __forTest } = await import("./claude-tmux.ts");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir: t } = await import("node:os");
  const path2 = await import("node:path");
  const dir = mkdtempSync(path2.default.join(t(), "agetor-pm-"));
  const jsonl = path2.default.join(dir, "session.jsonl");
  writeFileSync(jsonl, "");
  const state = __forTest.installSession("t-pm-reattach", jsonl);
  // Simulate the reattach situation: the uuid is already in the dedup
  // set (the previous process persisted it to run_events), so any
  // SSE-emitting work would be skipped. The permission-mode update
  // must still apply because it lives ABOVE the dedup return.
  const uuid = "11111111-1111-1111-1111-111111111111";
  state.seenLineUuids.add(uuid);
  __forTest.dispatchLine(state, JSON.stringify({
    type: "permission-mode", uuid, permissionMode: "plan",
  }));
  expect(state.permissionMode).toBe("plan");
  __forTest.uninstallSession("t-pm-reattach");
});

// ────────────────────────────────────────────────────────────────────────────
// Idle scrape throttle — regression for "a question raised after the task went
// to review never appears in the stream (user has to answer it in tmux)".
//
// A native AskUserQuestion / permission modal appears with NO JSONL write
// (claude doesn't persist the tool_use until it's answered), so once a session
// is JSONL-idle past SCRAPE_IDLE_AFTER_MS the old hard `return` stopped the
// scraper forever — `lastJsonlAppendAt` never advanced again, so a modal raised
// after the turn resolved was never captured. The throttle must keep scraping.

const {
  decideScrapeTick,
  SCRAPE_IDLE_AFTER_MS,
  SCRAPE_IDLE_POLL_MS,
  SCRAPE_DEEP_IDLE_AFTER_MS,
  SCRAPE_DEEP_IDLE_POLL_MS,
} = __forTest;

const NOW = 1_000_000;
// A session that's been JSONL-quiet long enough to be idle, but not yet
// "deeply" idle — the common "just resolved to review" window (2s cadence).
const NEAR_IDLE_APPEND = NOW - (SCRAPE_IDLE_AFTER_MS + 1_000);
// A session quiet past SCRAPE_DEEP_IDLE_AFTER_MS — the slow 10s cadence.
const DEEP_IDLE_APPEND = NOW - (SCRAPE_DEEP_IDLE_AFTER_MS + 5_000);

test("decideScrapeTick — busy session (turn in flight) always scrapes at full rate", () => {
  const d = decideScrapeTick({
    turnInFlight: true,
    lastJsonlAppendAt: 0,
    activePromptCount: 0,
    askCardLive: false,
    lastIdleScrapeAt: 0,
    now: NOW,
  });
  expect(d).toEqual({ run: true, stampIdle: false });
});

test("decideScrapeTick — recently-active session (within idle window) scrapes, no idle stamp", () => {
  const d = decideScrapeTick({
    turnInFlight: false,
    lastJsonlAppendAt: NOW - (SCRAPE_IDLE_AFTER_MS - 1), // still 'recent'
    activePromptCount: 0,
    askCardLive: false,
    lastIdleScrapeAt: 0,
    now: NOW,
  });
  expect(d).toEqual({ run: true, stampIdle: false });
});

test("decideScrapeTick — near-idle session STILL scrapes once past the 2s throttle (the bug)", () => {
  // No turn in flight, JSONL silent past SCRAPE_IDLE_AFTER_MS, last idle
  // capture > SCRAPE_IDLE_POLL_MS ago. The old code returned here and never
  // looked at the pane again — stranding a modal raised after `review`.
  const d = decideScrapeTick({
    turnInFlight: false,
    lastJsonlAppendAt: NEAR_IDLE_APPEND,
    activePromptCount: 0,
    askCardLive: false,
    lastIdleScrapeAt: NOW - SCRAPE_IDLE_POLL_MS - 1,
    now: NOW,
  });
  expect(d).toEqual({ run: true, stampIdle: true });
});

test("decideScrapeTick — near-idle but within the 2s throttle skips (keeps idle cost low)", () => {
  const d = decideScrapeTick({
    turnInFlight: false,
    lastJsonlAppendAt: NEAR_IDLE_APPEND,
    activePromptCount: 0,
    askCardLive: false,
    lastIdleScrapeAt: NOW - (SCRAPE_IDLE_POLL_MS - 1), // just scraped
    now: NOW,
  });
  expect(d).toEqual({ run: false, stampIdle: false });
});

test("decideScrapeTick — deeply-idle session backs off to the 10s cadence", () => {
  // Quiet > SCRAPE_DEEP_IDLE_AFTER_MS, and the last capture was 3s ago. At the
  // near-idle 2s rate this would scrape; the deep tier must skip it so long-
  // dead sessions don't fork tmux every 2s forever.
  const d = decideScrapeTick({
    turnInFlight: false,
    lastJsonlAppendAt: DEEP_IDLE_APPEND,
    activePromptCount: 0,
    askCardLive: false,
    lastIdleScrapeAt: NOW - 3_000, // > SCRAPE_IDLE_POLL_MS but < SCRAPE_DEEP_IDLE_POLL_MS
    now: NOW,
  });
  expect(d).toEqual({ run: false, stampIdle: false });
});

test("decideScrapeTick — deeply-idle session still scrapes once past the 10s cadence (very-late modal)", () => {
  const d = decideScrapeTick({
    turnInFlight: false,
    lastJsonlAppendAt: DEEP_IDLE_APPEND,
    activePromptCount: 0,
    askCardLive: false,
    lastIdleScrapeAt: NOW - SCRAPE_DEEP_IDLE_POLL_MS - 1,
    now: NOW,
  });
  expect(d).toEqual({ run: true, stampIdle: true });
});

test("decideScrapeTick — a live ask-card forces full-rate scraping (modal-gone backstop)", () => {
  const d = decideScrapeTick({
    turnInFlight: false,
    lastJsonlAppendAt: DEEP_IDLE_APPEND,
    activePromptCount: 0,
    askCardLive: true, // card up → never idle-gated
    lastIdleScrapeAt: NOW, // would otherwise be inside the throttle window
    now: NOW,
  });
  expect(d).toEqual({ run: true, stampIdle: false });
});

test("decideScrapeTick — a pending prompt forces full-rate scraping (auto-cancel backstop)", () => {
  const d = decideScrapeTick({
    turnInFlight: false,
    lastJsonlAppendAt: DEEP_IDLE_APPEND,
    activePromptCount: 1,
    askCardLive: false,
    lastIdleScrapeAt: NOW,
    now: NOW,
  });
  expect(d).toEqual({ run: true, stampIdle: false });
});

test("decideScrapeTick — a session that never appended (lastJsonlAppendAt === 0) is not idle-gated", () => {
  // Guards the `lastJsonlAppendAt !== 0` clause: a brand-new session shouldn't
  // be treated as idle before it has produced any output.
  const d = decideScrapeTick({
    turnInFlight: false,
    lastJsonlAppendAt: 0,
    activePromptCount: 0,
    askCardLive: false,
    lastIdleScrapeAt: 0,
    now: NOW,
  });
  expect(d).toEqual({ run: true, stampIdle: false });
});

// ────────────────────────────────────────────────────────────────────────────
// matchUnparsableModal / stuckTurnFallbackArmed — the unknown/unparsable
// Claude Code prompt fallback (docs/plans/unknown-claude-prompts-fallback.md
// §5). Last-resort matcher for a pane no real matcher parsed: fires on a
// recognised modal footer (`MODAL_FOOTER_RE`) over the last 3 non-blank tail
// lines, or on the stuck-turn watchdog. Always `unparsable: true`, empty
// `choices`, never `highConfidence` — so it always needs the two-tick
// stability gate.

// The claude 2.1.234 "Set up auto mode for your environment?" startup wizard
// — a real tmux pane capture (from a screenshot). Unnumbered arrow-key
// widget (`◂ Mixed ▸` value selector, `[ ]` checkbox rows) that
// matchNumberedModal/matchYesNoModal/detectAskModal all reject, bounded by a
// real Ink footer. This is the canonical fixture the fallback exists for.
const AUTO_MODE_WIZARD_PANE = `Set up auto mode for your environment?

Claude Code reads this project, your recent Claude sessions, and optionally your shell history and other
repositories. Claude analyzes this data and customizes auto mode to make better decisions.

  How you use Claude here    ◂ Mixed ▸
❯ Also scan shell history    [ ]
  Also scan your other repos [ ]

  Continue

←/→ to change usage · Enter to continue · Esc to cancel`;

test("matchUnparsableModal — auto-mode wizard: no real matcher parses it, fallback fires via the footer arm", () => {
  expect(matchNumberedModal(AUTO_MODE_WIZARD_PANE)).toBeNull();
  expect(matchYesNoModal(AUTO_MODE_WIZARD_PANE)).toBeNull();
  expect(detectAskModal(AUTO_MODE_WIZARD_PANE)).toBeNull();

  const m = matchUnparsableModal(AUTO_MODE_WIZARD_PANE, false);
  expect(m).not.toBeNull();
  expect(m!.unparsable).toBe(true);
  expect(m!.choices).toEqual([]);
  expect(m!.cursorIndex).toBe(0);
  // Deliberately never high-confidence — footer presence IS the trigger, not
  // extra confidence on top of an already-parsed choice set, so a single-tick
  // sighting must still clear the two-tick stability gate.
  expect(m!.highConfidence).toBeFalsy();
});

test("MODAL_FOOTER_RE — matches the three evidence-backed footer phrasings, case-insensitively", () => {
  expect(MODAL_FOOTER_RE.test("Esc to cancel · Tab to amend")).toBe(true);
  expect(MODAL_FOOTER_RE.test("Enter to confirm · Esc to cancel")).toBe(true);
  expect(MODAL_FOOTER_RE.test("←/→ to change usage · Enter to continue · Esc to cancel")).toBe(true);
  expect(MODAL_FOOTER_RE.test("ENTER TO CONTINUE")).toBe(true);
  expect(MODAL_FOOTER_RE.test("? for shortcuts")).toBe(false);
});

// ── Fingerprint stability ────────────────────────────────────────────────
//
// `matchUnparsableModal`'s fingerprint is sha1 of the same last-12-raw-line
// window used for `paneText`, with blank + volatile lines stripped before
// hashing. That's only tick-to-tick stable when the meaningful content has
// slack inside the 12-line window — i.e. fewer than 12 raw lines total, so a
// trailing blank row or a transient volatile line (the spinner, the "Tip:"
// banner) lands in the slack instead of evicting real content from the
// FRONT of the window (`lines.slice(-12)` is a raw positional slice, not a
// last-N-non-blank slice the way the footer-arm check and paneText's own
// "12 lines" comment imply).
//
// The canonical wizard fixture above is exactly 12 raw lines (8 meaningful +
// 4 blank) with the footer as its true last line — zero slack — so it is
// the worst case, not the representative one. Use a shorter footer-bearing
// pane (well under 12 lines, as a fuller real capture with scrollback above
// the modal would leave slack in this window) to pin the intended
// tolerance; see the fixture below for the canonical pane's actual
// (fragile) behavior at zero slack, which is a discovered gap, not
// something this suite asserts as "working".
const SHORT_UNPARSABLE_PANE = `Do a thing?

Enter to continue · Esc to cancel`;

test("matchUnparsableModal — fingerprint is stable across trailing blank-row padding (with window slack)", () => {
  const clean = matchUnparsableModal(SHORT_UNPARSABLE_PANE, false)!;
  const withTrailingBlanks = matchUnparsableModal(`${SHORT_UNPARSABLE_PANE}\n\n\n`, false)!;
  expect(clean).not.toBeNull();
  expect(withTrailingBlanks.fingerprint).toBe(clean.fingerprint);
});

test("matchUnparsableModal — fingerprint is stable across an inserted volatile line (with window slack)", () => {
  // A spinner/"Tip:" line appearing between ticks (VOLATILE_PANE_LINE_RE)
  // must not change the fingerprint — it's stripped before hashing.
  const clean = matchUnparsableModal(SHORT_UNPARSABLE_PANE, false)!;
  const withVolatile = matchUnparsableModal(
    SHORT_UNPARSABLE_PANE.replace("Do a thing?", "Do a thing?\n✳ Compacting… (esc to interrupt)"),
    false,
  )!;
  expect(withVolatile.fingerprint).toBe(clean.fingerprint);

  const withTip = matchUnparsableModal(
    SHORT_UNPARSABLE_PANE.replace("Do a thing?", "Do a thing?\nTip: press Shift+Tab to cycle modes"),
    false,
  )!;
  expect(withTip.fingerprint).toBe(clean.fingerprint);
});

test("matchUnparsableModal — a genuinely different modal gets a different fingerprint", () => {
  const a = matchUnparsableModal(SHORT_UNPARSABLE_PANE, false)!;
  const b = matchUnparsableModal(`Do a DIFFERENT thing?\n\nEnter to continue · Esc to cancel`, false)!;
  expect(a.fingerprint).not.toBe(b.fingerprint);
});

test("matchUnparsableModal — the canonical (zero-slack) wizard fixture's fingerprint IS stable across trailing padding", () => {
  // Regression guard for a window-saturation bug: an earlier implementation
  // took a raw `lines.slice(-12)` BEFORE filtering blank/volatile lines, so
  // when the meaningful content already filled all 12 lines (as the real
  // wizard pane does — 8 meaningful + 4 blank, footer as the true last
  // line), a fluctuating trailing blank row or a transient spinner line
  // evicted real content from the FRONT of the window and jittered the
  // hash — the two-tick stability gate could never converge on exactly the
  // tall modal this feature was built for. The filter must run first.
  const clean = matchUnparsableModal(AUTO_MODE_WIZARD_PANE, false)!;
  const withTrailingBlanks = matchUnparsableModal(`${AUTO_MODE_WIZARD_PANE}\n\n`, false)!;
  const withTrailingSpinner = matchUnparsableModal(
    `${AUTO_MODE_WIZARD_PANE}\n✳ Compacting… (esc to interrupt)`,
    false,
  )!;
  expect(clean).not.toBeNull();
  expect(withTrailingBlanks).not.toBeNull();
  expect(withTrailingBlanks.fingerprint).toBe(clean.fingerprint);
  expect(withTrailingSpinner.fingerprint).toBe(clean.fingerprint);
});

// ── Negative panes (footer arm must stay silent) ─────────────────────────

test("matchUnparsableModal — normal idle input-box pane does not fire", () => {
  const pane = `╭──────────────────────────────────────────────────────────────────────────╮
│ >                                                                            │
╰──────────────────────────────────────────────────────────────────────────╯
  ? for shortcuts · ← for agents`;
  expect(matchUnparsableModal(pane, false)).toBeNull();
});

test("matchUnparsableModal — working pane with the 'esc to interrupt' spinner but no footer does not fire", () => {
  const pane = `● Running Bash(npm test)…

✳ Working… (esc to interrupt · 12s · 1.2k tokens)`;
  expect(matchUnparsableModal(pane, false)).toBeNull();
});

test("matchUnparsableModal — plain transcript pane does not fire", () => {
  const pane = `● I've updated the file to fix the bug.

Let me run the tests now to confirm the fix works as expected.`;
  expect(matchUnparsableModal(pane, false)).toBeNull();
});

test("matchUnparsableModal — a footer phrase quoted in transcript prose ABOVE the last 3 non-blank lines does not fire", () => {
  const pane = `The dialog said "Esc to cancel · Tab to amend" when I saw it earlier.

Here's what I found after digging further:
Line A
Line B
Line C
Line D`;
  expect(matchUnparsableModal(pane, false)).toBeNull();
});

// ── Precedence sanity ─────────────────────────────────────────────────────

test("matchUnparsableModal — precedence: a numbered tool-permission modal is caught by matchNumberedModal first, but WOULD also match the fallback alone", () => {
  // scrapeOnce's real dispatch is `matchNumberedModal(tail) ?? matchYesNoModal(tail)
  // ?? matchUnparsableModal(...)` — the fallback is the final `??` arm, so a
  // parseable numbered modal never reaches it in practice. This test documents
  // that ordering is load-bearing: in isolation, matchUnparsableModal WOULD
  // also fire on the same pane (it carries a recognised footer), so if the
  // `??` chain were ever reordered, a real numbered modal would silently
  // downgrade to the "read it in the terminal" fallback card instead of
  // rendering real clickable choices.
  const pane = `Do you want to proceed?
❯ 1. Yes
  2. No

Esc to cancel · Tab to amend`;

  const numbered = matchNumberedModal(pane);
  expect(numbered).not.toBeNull();
  expect(numbered!.choices.map((c) => c.key)).toEqual(["1", "2"]);
  expect(numbered!.highConfidence).toBe(true);

  const fallbackAlone = matchUnparsableModal(pane, false);
  expect(fallbackAlone).not.toBeNull();
  expect(fallbackAlone!.unparsable).toBe(true);

  // scrapeOnce's actual `??` chain: numbered wins.
  const dispatched = matchNumberedModal(pane) ?? matchYesNoModal(pane) ?? matchUnparsableModal(pane, false);
  expect(dispatched).toEqual(numbered);
});

// ── stuckTurnFallbackArmed truth table ────────────────────────────────────

const WATCHDOG_NOW = 2_000_000;
const ALL_ARMED = {
  turnInFlight: true,
  lastJsonlAppendAt: WATCHDOG_NOW - STUCK_TURN_FALLBACK_MS - 1,
  now: WATCHDOG_NOW,
  paneWorking: false,
  askCardLive: false,
};

test("stuckTurnFallbackArmed — all conditions true → armed", () => {
  expect(stuckTurnFallbackArmed(ALL_ARMED)).toBe(true);
});

test("stuckTurnFallbackArmed — no turn in flight → not armed", () => {
  expect(stuckTurnFallbackArmed({ ...ALL_ARMED, turnInFlight: false })).toBe(false);
});

test("stuckTurnFallbackArmed — lastJsonlAppendAt === 0 (never appended) → not armed", () => {
  expect(stuckTurnFallbackArmed({ ...ALL_ARMED, lastJsonlAppendAt: 0 })).toBe(false);
});

test("stuckTurnFallbackArmed — quiet exactly AT the threshold (not strictly over) → not armed", () => {
  expect(stuckTurnFallbackArmed({
    ...ALL_ARMED,
    lastJsonlAppendAt: WATCHDOG_NOW - STUCK_TURN_FALLBACK_MS, // quiet === threshold, not >
  })).toBe(false);
});

test("stuckTurnFallbackArmed — quiet one ms past the threshold → armed", () => {
  expect(stuckTurnFallbackArmed({
    ...ALL_ARMED,
    lastJsonlAppendAt: WATCHDOG_NOW - STUCK_TURN_FALLBACK_MS - 1,
  })).toBe(true);
});

test("stuckTurnFallbackArmed — pane shows claude working → not armed (busy, not stuck)", () => {
  // No longer spinner-specific: `paneWorking` is `paneShowsClaudeWorking(tail)`,
  // which stays true across a working turn's quiet-JSONL windows (background
  // agent waits, long tool calls, elapsed-summary spinners) — not just while
  // the 1 Hz-blinking "esc to interrupt" text happens to be on-screen.
  expect(stuckTurnFallbackArmed({ ...ALL_ARMED, paneWorking: true })).toBe(false);
});

test("stuckTurnFallbackArmed — an ask card/collection is already live → not armed (owns its own give-up ladder)", () => {
  expect(stuckTurnFallbackArmed({ ...ALL_ARMED, askCardLive: true })).toBe(false);
});

// ── Watchdog arm on matchUnparsableModal ──────────────────────────────────

test("matchUnparsableModal — watchdog arm fires on a footerless stuck pane when watchdogArmed is true, stays silent when false", () => {
  const stuckPane = `● Running Bash(a very long build)…

Still going, no visible progress, nothing that looks like a modal or a
footer — just a wedged TUI.`;
  expect(matchUnparsableModal(stuckPane, false)).toBeNull();
  const armed = matchUnparsableModal(stuckPane, true);
  expect(armed).not.toBeNull();
  expect(armed!.unparsable).toBe(true);
  expect(armed!.choices).toEqual([]);
});

// ── Two-tick stability gate applies to unparsable matches ─────────────────

test("clearedStabilityGate — an unparsable match never has highConfidence, so it needs two ticks like any other low-confidence match", () => {
  const m = matchUnparsableModal(AUTO_MODE_WIZARD_PANE, false)!;
  expect(m.unparsable).toBe(true);
  expect(m.highConfidence).toBeFalsy();
  // First sighting: no previous fingerprint recorded yet → does not clear.
  expect(clearedStabilityGate(m, null)).toBe(false);
  // A different prior fingerprint (a different modal was on screen last
  // tick) → still does not clear.
  expect(clearedStabilityGate(m, "some-other-fingerprint")).toBe(false);
  // Same fingerprint on the second consecutive tick → clears.
  expect(clearedStabilityGate(m, m.fingerprint)).toBe(true);
});

// ────────────────────────────────────────────────────────────────────────────
// 2.1.239 hardening — docs/plans/unknown-tui-detection-flicker.md §5.
//
// The #185 fallback card was flickering during NORMAL claude-code 2.1.239
// activity (streaming, tool calls, background-agent waits): the working
// indicators the old `SPINNER_RE=/esc to interrupt/i` guard relied on moved
// (status-bar `esc to interrupt` now blinks at ~1 Hz and is absent for whole
// quiet-JSONL windows during a bg-agent wait or long tool call) or changed
// shape (a ticking spinner glyph + elapsed/token-counter line). This section
// covers: (A) `paneShowsClaudeWorking`'s truth table against real captured
// 2.1.239 panes, (B) `MODAL_NOTICE_RE`'s usage-limit auto-continue veto on
// BOTH matchUnparsableModal arms, (C) that the veto/gate doesn't over-
// suppress genuinely actionable notices or the existing wizard fixture, (D)
// that the working-gate — not the matcher itself — is what suppresses a
// footer-bearing pane that also shows working chrome (mirrors scrapeOnce's
// real `paneShowsClaudeWorking(tail) ? null : matchUnparsableModal(...)`
// dispatch), (E) fingerprint stability across the new volatile forms, and
// (F) the raised 3-tick stability constant.

// ── A. paneShowsClaudeWorking truth table ──────────────────────────────────

const WORKING_PANE_LINES = [
  // Present-participle spinner (glyph + word + ellipsis).
  "✽ Frosting… (2m 52s · ↓ 12.1k tokens)",
  // Dot-glyph spinner — `·` doubles as the spinner glyph here, not just a
  // mid-line separator; the leading-anchor is what makes this safe (see the
  // prose-bullet false case below).
  "· Prestidigitating… (1h 21m 31s · ↓ 259.0k tokens)",
  // Elapsed summary — no ellipsis, just "<Word> for <n><unit>".
  "✻ Cooked for 2m 18s",
  // Elapsed + a live shell.
  "✻ Brewed for 9s · 1 shell still running",
  // Background-agent wait — the only normal-work window with NO ticking
  // spinner line at all; this phrase is what covers it.
  "✻ Waiting for 1 background agent to finish",
  // Status-bar interrupt (auto mode) — the legacy signal, now 1 Hz-blinking,
  // kept as one input among several rather than the sole gate.
  "  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt · ← 1 agent",
  // Background-agent roster row — ticking token counter, no spinner glyph.
  "  ◯ general-purpose  W2-A launch-path persistence  10s · ↓ 46.2k tokens",
  // Status-bar shell count (no "esc to interrupt" on this particular frame).
  "  ⏵⏵ auto mode on · 1 shell · ← 1 agent · ↓ to manage",
];

for (const line of WORKING_PANE_LINES) {
  test(`paneShowsClaudeWorking — true for 2.1.239 working chrome: ${JSON.stringify(line)}`, () => {
    expect(paneShowsClaudeWorking(line)).toBe(true);
    // Also true when the line sits inside a fuller pane tail.
    expect(paneShowsClaudeWorking(`some prior line\n${line}\nsome later line`)).toBe(true);
  });
}

const IDLE_INPUT_BOX_PANE = `╭────╮
│ >  │
╰────╯
  ? for shortcuts · ← for agents`;

test("paneShowsClaudeWorking — false for the idle input-box pane", () => {
  expect(paneShowsClaudeWorking(IDLE_INPUT_BOX_PANE)).toBe(false);
});

test("paneShowsClaudeWorking — false for the auto-mode wizard fixture (fallback must still fire for it)", () => {
  // This is the safety property the whole gate rests on: a real prompt/wizard
  // REPLACES the working chrome rather than co-rendering with it, so gating
  // the fallback on `!paneShowsClaudeWorking` can never hide this fixture.
  expect(paneShowsClaudeWorking(AUTO_MODE_WIZARD_PANE)).toBe(false);
});

test("paneShowsClaudeWorking — false for a prose bullet that merely starts with the '·' glyph", () => {
  // Regression for the over-match the review caught: the dot-glyph spinner
  // form requires an ellipsis (`…`) right after the leading word, and the
  // elapsed form requires `\d+` immediately followed by `s`/`m`/`h` (no
  // space). "for 3 reasons" has neither — the digit is followed by a space,
  // not a unit letter — so ordinary prose starting with "· " must not read
  // as a spinner.
  expect(paneShowsClaudeWorking("  · Something worth noting for 3 reasons below")).toBe(false);
});

test("paneShowsClaudeWorking — false for prose that merely mentions tokens", () => {
  // Regression for the over-match the review caught: TOKEN_COUNTER_LINE is
  // anchored to a `·`/arrow separator immediately before the count, so plain
  // prose mentioning "tokens" (no `·↓`/`·↑` glyph) must not match.
  expect(paneShowsClaudeWorking("The response used about 5 tokens total, roughly.")).toBe(false);
});

test("paneShowsClaudeWorking — false for the idle manual-mode status bar", () => {
  expect(paneShowsClaudeWorking("  ⏸ manual mode on · ? for shortcuts · ← 1 agent")).toBe(false);
});

test("WORKING_LINE_RE — sanity: still matches the legacy 'esc to interrupt' status-bar phrase directly", () => {
  expect(WORKING_LINE_RE.test("esc to interrupt")).toBe(true);
  expect(WORKING_LINE_RE.test("nothing to see here")).toBe(false);
});

test("paneShowsClaudeWorking — transcript prose that merely RESEMBLES working chrome stays false", () => {
  // Regression for the review finding: every arm is anchored to the chrome
  // shape it came from, so look-alike prose in the transcript can't read as
  // working (and thereby hide a genuine prompt rendered below it).
  expect(paneShowsClaudeWorking("  · 3 shell scripts were updated")).toBe(false); // status-bar arm needs `· N shell ·`/EOL
  expect(paneShowsClaudeWorking("Waiting for 2 background agents to report back.")).toBe(false); // needs the leading spinner glyph
  expect(paneShowsClaudeWorking("· Loading… more text follows")).toBe(false); // spinner arm needs `(` or EOL after `…`
  // …while the real chrome shapes those guards protect still read as working.
  expect(paneShowsClaudeWorking("✻ Waiting for 1 background agent to finish")).toBe(true);
  expect(paneShowsClaudeWorking("  ⏵⏵ auto mode on · 1 shell · ← 1 agent · ↓ to manage")).toBe(true);
  expect(paneShowsClaudeWorking("✻ Determining…")).toBe(true); // bare spinner, no parenthetical yet
  expect(paneShowsClaudeWorking("✳ Compacting… (esc to interrupt)")).toBe(true);
});

test("paneShowsClaudeWorking — only inspects the bottom widget area (last WORKING_CHROME_WINDOW_LINES non-blank lines), not the scrollback transcript", () => {
  expect(WORKING_CHROME_WINDOW_LINES).toBe(16);
  // A tool result that echoes claude chrome (an agent inspecting tmux panes —
  // agetor dogfooding) sits in the TRANSCRIPT, well above a real wizard that
  // then renders below it. Before the window was bounded, that echo gated the
  // fallback off for as long as it stayed inside the 40-line scrape tail.
  const echoedChromeAboveWizard =
    "  ⎿  status: ⏵⏵ auto mode on · esc to interrupt · ← 1 agent\n"
    + Array.from({ length: 20 }, (_, i) => `transcript line ${i + 1}`).join("\n")
    + "\n" + AUTO_MODE_WIZARD_PANE;
  expect(paneShowsClaudeWorking(echoedChromeAboveWizard)).toBe(false);
  // …and the real scrapeOnce dispatch therefore still cards the wizard.
  const dispatched = paneShowsClaudeWorking(echoedChromeAboveWizard)
    ? null
    : matchUnparsableModal(echoedChromeAboveWizard, false);
  expect(dispatched).not.toBeNull();
  expect(dispatched!.unparsable).toBe(true);
  // Boundary: a working line exactly WORKING_CHROME_WINDOW_LINES non-blank
  // lines from the bottom is still seen; one line further up is not. The
  // deepest live widget area captured (4 background agents) was 13 rows, so
  // 16 keeps every real form inside the window.
  const filler = (n: number) => Array.from({ length: n }, (_, i) => `row ${i + 1}`).join("\n");
  const working = "  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt · ← 1 agent";
  expect(paneShowsClaudeWorking(`${working}\n${filler(WORKING_CHROME_WINDOW_LINES - 1)}`)).toBe(true);
  expect(paneShowsClaudeWorking(`${working}\n${filler(WORKING_CHROME_WINDOW_LINES)}`)).toBe(false);
  // Blank rows don't count toward the window (tmux pads the capture).
  expect(paneShowsClaudeWorking(`${working}\n\n\n\n${filler(WORKING_CHROME_WINDOW_LINES - 1)}`)).toBe(true);
});

// ── B. MODAL_NOTICE_RE veto — both matchUnparsableModal arms ───────────────

test("matchUnparsableModal — usage-limit auto-continue notice is vetoed on the footer arm", () => {
  const m = matchUnparsableModal(
    "Usage limit reached · continuing automatically at 8am · esc to cancel",
    false,
  );
  expect(m).toBeNull();
});

test("matchUnparsableModal — usage-limit auto-continue notice is ALSO vetoed on the watchdog arm (the must-fix from review)", () => {
  // A mid-turn limit pause keeps the turn in flight and the pane quiet, which
  // would otherwise arm the stuck-turn watchdog — so the notice veto has to
  // apply regardless of which arm would have fired.
  const m = matchUnparsableModal(
    "Usage limit reached · continuing automatically at 8am · esc to cancel",
    true,
  );
  expect(m).toBeNull();
});

test("matchUnparsableModal — 'continuing shortly' variant is also vetoed on the watchdog arm", () => {
  const m = matchUnparsableModal(
    "Usage limit reached · continuing shortly · esc to cancel",
    true,
  );
  expect(m).toBeNull();
});

test("MODAL_NOTICE_RE — matches both auto-continue phrasings, not the actionable reset notice", () => {
  expect(MODAL_NOTICE_RE.test("continuing automatically")).toBe(true);
  expect(MODAL_NOTICE_RE.test("continuing shortly")).toBe(true);
  expect(MODAL_NOTICE_RE.test("press enter to continue")).toBe(false);
});

// ── C. Still-cards cases (veto/gate must not over-suppress) ────────────────

test("matchUnparsableModal — 'Usage limit has reset · press enter to continue' is never vetoed (genuinely actionable)", () => {
  // Carries a MODAL_FOOTER_RE phrase ("enter to continue") and no
  // MODAL_NOTICE_RE phrase ("has reset" is not an auto-continue notice) — the
  // veto must not sweep this one up along with the auto-continue variants.
  // Drawn as the bottom line it fires the footer arm outright …
  const bottom = matchUnparsableModal("Usage limit has reset · press enter to continue", false);
  expect(bottom).not.toBeNull();
  expect(bottom!.unparsable).toBe(true);
  // … but claude draws notice-class lines in the HINT SLOT above the input
  // box (observed 5 non-blank lines from the bottom for the weekly-limit
  // hint), which is outside the footer arm's last-3 window. There it reaches
  // the user via the watchdog arm instead — the turn is still in flight, the
  // pane is quiet, nothing shows working — so assert exactly that split, not
  // an instant footer-arm card the real rendering can't deliver.
  const hintSlot = `⏺ Working on it.

          Usage limit has reset · press enter to continue
────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ auto mode on (shift+tab to cycle) · ← 1 agent`;
  expect(paneShowsClaudeWorking(hintSlot)).toBe(false);
  expect(matchUnparsableModal(hintSlot, false)).toBeNull(); // footer arm can't see it
  const viaWatchdog = matchUnparsableModal(hintSlot, true);
  expect(viaWatchdog).not.toBeNull(); // watchdog arm: NOT vetoed
  expect(viaWatchdog!.unparsable).toBe(true);
});

test("matchUnparsableModal — the auto-continue veto covers the card's 12-line window, not just the last 3 lines (hint-slot notice + watchdog → null)", () => {
  // Regression for the review finding: with the veto scoped to the last 3
  // non-blank lines, a notice drawn in the hint slot (5th from the bottom)
  // was invisible to the veto while the watchdog arm — turn in flight, JSONL
  // quiet for hours during the limit pause, no working chrome — still built
  // the card. The veto must scan the same window the card is built from.
  const hintSlot = `⏺ Working on it.

          Usage limit reached · continuing automatically at 8am · esc to cancel
────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ auto mode on (shift+tab to cycle) · ← 1 agent`;
  expect(paneShowsClaudeWorking(hintSlot)).toBe(false); // so the watchdog WOULD arm
  expect(matchUnparsableModal(hintSlot, true)).toBeNull();
  expect(matchUnparsableModal(hintSlot, false)).toBeNull();
});

test("matchUnparsableModal — the auto-mode wizard fixture still cards (unchanged; see the existing footer-arm test above)", () => {
  const m = matchUnparsableModal(AUTO_MODE_WIZARD_PANE, false);
  expect(m).not.toBeNull();
  expect(m!.unparsable).toBe(true);
});

// ── D. Working-gate composition (mirrors scrapeOnce's real dispatch) ───────

test("matchUnparsableModal + paneShowsClaudeWorking — a footer-bearing pane that ALSO shows working chrome is only suppressed by the gate, not the matcher", () => {
  const pane = `Some prompt?

✻ Waiting for 1 background agent to finish

Enter to continue · Esc to cancel`;

  // The matcher alone doesn't know about working chrome — it still matches.
  const alone = matchUnparsableModal(pane, false);
  expect(alone).not.toBeNull();
  expect(alone!.unparsable).toBe(true);

  // scrapeOnce's real call site gates on `!paneShowsClaudeWorking` first —
  // this is what actually suppresses it. Documents the gate is load-bearing:
  // if it were ever dropped at the call site, this exact pane would flicker
  // a card during a normal background-agent wait.
  const gated = paneShowsClaudeWorking(pane) ? null : matchUnparsableModal(pane, false);
  expect(gated).toBeNull();
});

// ── E. Fingerprint stability across the new volatile forms ─────────────────

test("matchUnparsableModal — fingerprint is stable across an inserted elapsed-spinner/shell line (widened VOLATILE_PANE_LINE_RE)", () => {
  // Analogous to the existing "inserted volatile line" test above, but for
  // the new 2.1.239 forms specifically: a `✻ Brewed for 9s · 1 shell still
  // running` line landing between ticks must not jitter the fingerprint, or
  // the __external__ auto-cancel sweep would resolve a card that never
  // stopped being the same real modal.
  const clean = matchUnparsableModal(SHORT_UNPARSABLE_PANE, false)!;
  const withElapsedSpinner = matchUnparsableModal(
    SHORT_UNPARSABLE_PANE.replace(
      "Do a thing?",
      "Do a thing?\n✻ Brewed for 9s · 1 shell still running",
    ),
    false,
  )!;
  expect(clean).not.toBeNull();
  expect(withElapsedSpinner).not.toBeNull();
  expect(withElapsedSpinner.fingerprint).toBe(clean.fingerprint);

  const withTokenCounterRoster = matchUnparsableModal(
    SHORT_UNPARSABLE_PANE.replace(
      "Do a thing?",
      "Do a thing?\n  ◯ general-purpose  some task  10s · ↓ 46.2k tokens",
    ),
    false,
  )!;
  expect(withTokenCounterRoster.fingerprint).toBe(clean.fingerprint);
});

// ── F. Constant sanity ──────────────────────────────────────────────────────

test("UNPARSABLE_STABILITY_TICKS is 3 (raised from the generic 2-tick gate)", () => {
  expect(UNPARSABLE_STABILITY_TICKS).toBe(3);
});

// Drive the pure streak step exactly the way scrapeOnce does: per tick,
// `streak = nextUnparsableStreak(streak, sameFingerprintAsLastTick)` when the
// tick produced an unparsable match, `streak = 0` on any tick that didn't
// (null match, parseable match, answered prompt). Registration happens on the
// first tick where `unparsableStreakCleared(streak)`.
function driveStreak(ticks: Array<string | null>): number | null {
  let streak = 0;
  let last: string | null = null;
  for (const [i, fp] of ticks.entries()) {
    if (fp === null) { streak = 0; last = null; continue; }
    streak = nextUnparsableStreak(streak, last === fp);
    last = fp;
    if (unparsableStreakCleared(streak)) return i; // 0-based tick index of registration
  }
  return null;
}

test("unparsable streak — the same fingerprint on 3 consecutive ticks registers on the 3rd, never earlier", () => {
  expect(driveStreak(["A", "A"])).toBeNull();
  expect(driveStreak(["A", "A", "A"])).toBe(2);
});

test("unparsable streak — a different fingerprint in between restarts the count (A,B,A never registers)", () => {
  expect(driveStreak(["A", "B", "A"])).toBeNull();
  expect(driveStreak(["A", "B", "A", "A"])).toBeNull();
  expect(driveStreak(["A", "B", "B", "B"])).toBe(3);
});

test("unparsable streak — a null-match tick (claude wrote JSONL / working chrome appeared) resets it (A,A,∅,A,A never registers)", () => {
  expect(driveStreak(["A", "A", null, "A", "A"])).toBeNull();
  expect(driveStreak(["A", "A", null, "A", "A", "A"])).toBe(5);
});

test("unparsable streak — a 1–2 tick blip (the old flicker) never registers", () => {
  // The exact shape the fix exists for: a transient match that survives one
  // or two ticks before the pane moves on must never become a card.
  expect(driveStreak(["A", null, "A", null, "A", null])).toBeNull();
  expect(driveStreak(["A", "A", null, "A", "A", null])).toBeNull();
});
