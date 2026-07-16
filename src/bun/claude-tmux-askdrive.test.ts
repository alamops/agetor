import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// claude-tmux.ts transitively opens the SQLite DB (db.ts) on module load —
// point AGETOR_DATA_DIR at a scratch dir before the import, mirroring
// claude-tmux-scraper.test.ts.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-askdrive-"));

import { __forTest } from "./claude-tmux.ts";
import type { AskModalKind } from "./claude-questions.ts";

const { decideAskDriveStep, ASK_VERIFY_MAX_RESENDS } = __forTest;

// ────────────────────────────────────────────────────────────────────────────
// decideAskDriveStep — pure per-poll decision table driving both phases of
// driveAskAnswers: the confirm-wait phase (confirmSent=false, waiting for the
// review screen to render before sending the confirm Enter) and the verify
// phase (confirmSent=true — or a singleFlat plan with no confirm phase at
// all — waiting for the modal to actually close). See claude-tmux.ts's
// doc comment on decideAskDriveStep for the full semantics this pins.
// ────────────────────────────────────────────────────────────────────────────

describe("decideAskDriveStep — kind=null (modal left the pane)", () => {
  test("→ 'done' regardless of confirmSent/resends — the only success case", () => {
    for (const confirmSent of [false, true]) {
      for (const resends of [0, 1, ASK_VERIFY_MAX_RESENDS, ASK_VERIFY_MAX_RESENDS + 1]) {
        expect(decideAskDriveStep(null, confirmSent, resends)).toBe("done");
      }
    }
  });
});

describe("decideAskDriveStep — kind='review'", () => {
  test("confirmSent=false → 'send-enter' (first confirm, not bounded by resends)", () => {
    // This is the initial confirm sent as soon as the review screen renders
    // during the confirm-wait phase — not a resend, so the resend cap does
    // not apply even if `resends` happens to already be at/above the cap.
    expect(decideAskDriveStep("review", false, 0)).toBe("send-enter");
    expect(decideAskDriveStep("review", false, ASK_VERIFY_MAX_RESENDS)).toBe("send-enter");
  });

  test("confirmSent=true, resends below the cap → 'send-enter' (resend the swallowed confirm)", () => {
    for (let resends = 0; resends < ASK_VERIFY_MAX_RESENDS; resends++) {
      expect(decideAskDriveStep("review", true, resends)).toBe("send-enter");
    }
  });

  test("confirmSent=true, resends === ASK_VERIFY_MAX_RESENDS → 'fail' (cap reached)", () => {
    expect(decideAskDriveStep("review", true, ASK_VERIFY_MAX_RESENDS)).toBe("fail");
  });

  test("confirmSent=true, resends beyond the cap → 'fail' (stays failed, not re-armed)", () => {
    expect(decideAskDriveStep("review", true, ASK_VERIFY_MAX_RESENDS + 1)).toBe("fail");
  });
});

describe("decideAskDriveStep — kind='question'", () => {
  test("confirmSent=false (mid-drive, still navigating the tab bar) → 'wait'", () => {
    expect(decideAskDriveStep("question", false, 0)).toBe("wait");
  });

  test("confirmSent=true (verify phase — treated as a teardown transient) → 'wait', even past the resend cap", () => {
    // A "question" sighting never fails on its own, unlike "review" — the
    // caller's own attempt budget is what eventually times a genuine
    // mis-drive out, not this function.
    expect(decideAskDriveStep("question", true, 0)).toBe("wait");
    expect(decideAskDriveStep("question", true, ASK_VERIFY_MAX_RESENDS)).toBe("wait");
    expect(decideAskDriveStep("question", true, ASK_VERIFY_MAX_RESENDS + 1)).toBe("wait");
  });
});

test("decideAskDriveStep — exhaustive table over kind × confirmSent × resends", () => {
  // Belt-and-suspenders: walk the full grid so a regression in any single
  // combination names itself instead of hiding behind the grouped cases
  // above. Mirrors the table in the plan doc (docs/plans/fix-ask-submit-
  // answers-stranded.md §5) rather than any hardcoded resend count.
  const kinds: Array<AskModalKind | null> = [null, "review", "question"];
  const resendsToTry = [0, 1, ASK_VERIFY_MAX_RESENDS, ASK_VERIFY_MAX_RESENDS + 1];

  for (const kind of kinds) {
    for (const confirmSent of [false, true]) {
      for (const resends of resendsToTry) {
        const step = decideAskDriveStep(kind, confirmSent, resends);
        if (kind === null) {
          expect(step).toBe("done");
        } else if (kind === "question") {
          expect(step).toBe("wait");
        } else {
          // kind === "review"
          expect(step).toBe(
            !confirmSent ? "send-enter" : resends < ASK_VERIFY_MAX_RESENDS ? "send-enter" : "fail",
          );
        }
      }
    }
  }
});
