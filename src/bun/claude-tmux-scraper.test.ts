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
  tailHasSpinner: false,
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

test("stuckTurnFallbackArmed — working spinner present → not armed (busy, not stuck)", () => {
  expect(stuckTurnFallbackArmed({ ...ALL_ARMED, tailHasSpinner: true })).toBe(false);
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
