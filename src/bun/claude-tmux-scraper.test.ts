import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Set data dir before db.ts is loaded transitively (claude-tmux.ts imports
// it now that the scraper looks up the task's runId).
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-scraper-"));

import { __forTest } from "./claude-tmux.ts";

const { matchNumberedModal, matchYesNoModal, matchStartupConsentDialog, clearedStabilityGate } = __forTest;

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
