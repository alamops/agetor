import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// claude-tmux.ts transitively opens the SQLite DB (db.ts) on module load —
// point AGETOR_DATA_DIR at a scratch dir before the import, mirroring
// claude-tmux-scraper.test.ts.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-askdrive-"));

import { __forTest, driveAskAnswers } from "./claude-tmux.ts";
import type { AskModalKind, DriveStep } from "./claude-questions.ts";

const { decideAskDriveStep, ASK_VERIFY_MAX_RESENDS, paneShowsTypedAnswer } = __forTest;

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

// ────────────────────────────────────────────────────────────────────────────
// paneShowsTypedAnswer — pure echo check for a typed custom answer.
// ────────────────────────────────────────────────────────────────────────────

describe("paneShowsTypedAnswer", () => {
  test("true for a single-select echo on the cursor row", () => {
    expect(paneShowsTypedAnswer("Question?\n  1. red\n❯ 4. purple\n", "purple")).toBe(true);
  });

  test("true for a multi-select echo (auto-checked row)", () => {
    expect(paneShowsTypedAnswer("  4. Other\n❯ 5. [✔] extra topping\n", "extra topping")).toBe(true);
  });

  test("true when only the first 40 chars of a long answer are on the cursor row (soft wrap)", () => {
    const text = "abcdefghij".repeat(12); // 120 chars
    expect(text.length).toBe(120);
    const pane = `❯ 4. ${text.slice(0, 40)}\n     ${text.slice(40, 80)}\n`;
    expect(paneShowsTypedAnswer(pane, text)).toBe(true);
    // ...but not when even the first 40 chars aren't all there.
    expect(paneShowsTypedAnswer(`❯ 4. ${text.slice(0, 30)}\n`, text)).toBe(false);
  });

  test("false when the row is not the cursor row", () => {
    expect(paneShowsTypedAnswer("  4. purple\n", "purple")).toBe(false);
  });

  test("false for an unrelated pane", () => {
    expect(paneShowsTypedAnswer("❯ 4. Type something.\n  5. Chat about this\n", "purple")).toBe(false);
    expect(paneShowsTypedAnswer("", "purple")).toBe(false);
  });

  test("false for empty text", () => {
    expect(paneShowsTypedAnswer("❯ 4. \n", "")).toBe(false);
  });

  test("regex metacharacters in the text match literally, not as a pattern", () => {
    const text = "a (b) [c] $d ^e .*";
    expect(paneShowsTypedAnswer(`❯ 4. ${text}\n`, text)).toBe(true);
    // If `.*` were live regex, this pane (different literal text) would match.
    expect(paneShowsTypedAnswer("❯ 4. a (b) [c] $d ^e zzz\n", text)).toBe(false);
    expect(paneShowsTypedAnswer("❯ 4. a b c d e\n", text)).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// driveAskAnswers against a recording fake tmux. The fake binary appends one
// JSON argv line per call and answers `capture-pane` with the contents of a
// pane file the test controls. `flipOnEnter` empties the pane file when the
// final `Enter` key arrives (modal closes), which is how the verify phase
// sees "done".
// ────────────────────────────────────────────────────────────────────────────

const scratchDirs: string[] = [];
afterAll(() => {
  // These dirs hold only the recorder script / log / pane file — never
  // agetor.sqlite — so a plain rm is safe.
  for (const d of scratchDirs) rmSync(d, { recursive: true, force: true });
});

interface FakeTmux {
  logPath: string;
  panePath: string;
  setPane(text: string): void;
  /** Argv of every call with the leading `-L <socket>` args stripped. */
  calls(): string[][];
}

function makeFakeTmux(opts: { emptyPaneOnEnter: boolean }): FakeTmux {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-askdrive-tmux-"));
  scratchDirs.push(dir);
  const binPath = path.join(dir, "tmux");
  const logPath = path.join(dir, "log.jsonl");
  const panePath = path.join(dir, "pane.txt");
  writeFileSync(panePath, "");
  writeFileSync(
    binPath,
    `#!${process.execPath}\n` +
      `import { appendFileSync, readFileSync, writeFileSync } from "node:fs";\n` +
      `const argv = process.argv.slice(2);\n` +
      `appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(argv) + "\\n");\n` +
      `const i = argv.indexOf("capture-pane");\n` +
      `if (i >= 0) { process.stdout.write(readFileSync(${JSON.stringify(panePath)}, "utf8")); }\n` +
      (opts.emptyPaneOnEnter
        ? `if (argv.includes("send-keys") && argv[argv.length - 1] === "Enter") writeFileSync(${JSON.stringify(panePath)}, "");\n`
        : ``),
  );
  chmodSync(binPath, 0o755);
  return {
    logPath,
    panePath,
    setPane: (t) => writeFileSync(panePath, t),
    calls: () => {
      if (!existsSync(logPath)) return [];
      return readFileSync(logPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          const argv = JSON.parse(l) as string[];
          return argv[0] === "-L" ? argv.slice(2) : argv;
        });
    },
  };
}

async function withDrive<T>(
  fake: FakeTmux,
  fn: (ctx: { taskId: string; sessionName: string; chunks: Array<{ stream: string; data: string }> }) => Promise<T>,
): Promise<T> {
  const prevBin = process.env.AGETOR_TMUX_BIN;
  process.env.AGETOR_TMUX_BIN = path.join(path.dirname(fake.logPath), "tmux");
  const taskId = `askdrive-${Math.random().toString(36).slice(2, 10)}`;
  const state = __forTest.installSession(taskId, path.join(path.dirname(fake.logPath), "s.jsonl"));
  const chunks: Array<{ stream: string; data: string }> = [];
  state.lastChunk = (stream, data) => { chunks.push({ stream, data }); };
  try {
    return await fn({ taskId, sessionName: state.sessionName, chunks });
  } finally {
    __forTest.uninstallSession(taskId);
    if (prevBin === undefined) delete process.env.AGETOR_TMUX_BIN;
    else process.env.AGETOR_TMUX_BIN = prevBin;
  }
}

const TEXT = 'a -leading-dash "quoted" ; text';
const TYPED_STEPS: DriveStep[] = ["Down", "Down", "Down", { type: "text", text: TEXT }, "Enter"];

describe("driveAskAnswers — typed text step over a recorded fake tmux", () => {
  test("sends the text as ONE `send-keys -l -- <text>` argv, in order, and returns true", async () => {
    const fake = makeFakeTmux({ emptyPaneOnEnter: true });
    fake.setPane(`Pick a colour\n  1. red\n  2. blue\n  3. green\n❯ 4. ${TEXT}\n  5. Chat about this\n\nEnter to select · Esc to cancel\n`);
    await withDrive(fake, async ({ taskId, sessionName }) => {
      const ok = await driveAskAnswers(taskId, { steps: TYPED_STEPS, confirmsReview: false });
      expect(ok).toBe(true);

      const sends = fake.calls().filter((a) => a[0] === "send-keys");
      // The exact recorded line for the text step (also reported by the task).
      const textIdx = sends.findIndex((a) => a.includes("-l"));
      expect(sends[textIdx]).toEqual(["send-keys", "-t", sessionName, "-l", "--", TEXT]);
      expect(sends[textIdx]![5]).toBe(TEXT); // verbatim, one argv element
      // Three Downs precede it, Enter follows only after it.
      expect(sends.slice(0, textIdx)).toEqual([
        ["send-keys", "-t", sessionName, "Down"],
        ["send-keys", "-t", sessionName, "Down"],
        ["send-keys", "-t", sessionName, "Down"],
      ]);
      expect(sends.slice(textIdx + 1)).toEqual([["send-keys", "-t", sessionName, "Enter"]]);
      // The pane was read between the text and the Enter (echo verification).
      const all = fake.calls();
      const textAt = all.findIndex((a) => a.includes("-l"));
      const enterAt = all.findIndex((a) => a[0] === "send-keys" && a[a.length - 1] === "Enter");
      expect(all.slice(textAt + 1, enterAt).some((a) => a[0] === "capture-pane")).toBe(true);
    });
  });

  test("echo never appears → returns false, sends NO Enter or further key, emits a status chunk", async () => {
    const fake = makeFakeTmux({ emptyPaneOnEnter: true });
    fake.setPane("Pick a colour\n  1. red\n  2. blue\n  3. green\n❯ 4. Type something.\n  5. Chat about this\n\nEnter to select · Esc to cancel\n");
    await withDrive(fake, async ({ taskId, chunks }) => {
      const ok = await driveAskAnswers(taskId, { steps: TYPED_STEPS, confirmsReview: false });
      expect(ok).toBe(false);

      const sends = fake.calls().filter((a) => a[0] === "send-keys");
      const textIdx = sends.findIndex((a) => a.includes("-l"));
      expect(textIdx).toBe(3);
      // Nothing at all was sent after the text step.
      expect(sends.length).toBe(textIdx + 1);
      expect(sends.some((a) => a[a.length - 1] === "Enter")).toBe(false);

      expect(
        chunks.some((c) => c.stream === "status" && c.data.includes("typed answer did not land in the modal")),
      ).toBe(true);
    });
  });

  test("a plan with no text steps sends keys only and returns true once the modal closes", async () => {
    const fake = makeFakeTmux({ emptyPaneOnEnter: true });
    fake.setPane("Pick a colour\n❯ 1. red\n  2. blue\n\nEnter to select · Esc to cancel\n");
    await withDrive(fake, async ({ taskId, sessionName }) => {
      const ok = await driveAskAnswers(taskId, { steps: ["Down", "Enter"], confirmsReview: false });
      expect(ok).toBe(true);
      expect(fake.calls().filter((a) => a[0] === "send-keys")).toEqual([
        ["send-keys", "-t", sessionName, "Down"],
        ["send-keys", "-t", sessionName, "Enter"],
      ]);
      expect(fake.calls().some((a) => a.includes("-l"))).toBe(false);
    });
  });
});
