import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// claude-tmux.ts transitively opens the SQLite DB (db.ts) on module load —
// point AGETOR_DATA_DIR at a scratch dir before the import, mirroring
// claude-tmux-scraper.test.ts.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-askdrive-"));

import { __forTest, dismissAskModalForMessage, driveAskAnswers } from "./claude-tmux.ts";
import type { AskModalKind, DriveStep } from "./claude-questions.ts";

const {
  decideAskDriveStep,
  ASK_VERIFY_MAX_RESENDS,
  paneShowsTypedAnswer,
  paneFocusedRowIsEmptyType,
  escapeTypedTrailingSemicolon,
  confirmStartupDialog,
  STARTUP_CONFIRM_KEY_GAP_MS,
} = __forTest;

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

  test("the untouched placeholder row never echoes a prefix of `Type something` (T / Type / Types)", () => {
    const untouched = "  3. green\n❯ 4. Type something.\n  5. Chat about this\n";
    for (const text of ["T", "Ty", "Type", "Types", "Type something", "Type something."]) {
      expect(paneShowsTypedAnswer(untouched, text)).toBe(false);
    }
    // Multi-select placeholder, and the unpunctuated spelling.
    expect(paneShowsTypedAnswer("❯ 5. [ ] Type something\n     Next\n", "Type")).toBe(false);
    // ...whereas the same text really typed into the row (row now reads `Type`) does echo.
    expect(paneShowsTypedAnswer("  3. green\n❯ 4. Type\n  5. Chat about this\n", "Type")).toBe(true);
    expect(paneShowsTypedAnswer("  3. green\n❯ 4. Types\n  5. Chat about this\n", "Types")).toBe(true);
  });

  test("false for an unrelated pane", () => {
    expect(paneShowsTypedAnswer("❯ 4. Type something.\n  5. Chat about this\n", "purple")).toBe(false);
    expect(paneShowsTypedAnswer("", "purple")).toBe(false);
  });

  test("false for empty text", () => {
    expect(paneShowsTypedAnswer("❯ 4. \n", "")).toBe(false);
  });

  test("joins the ❯ row with its indented continuation rows (a wrap inside the first 40 chars)", () => {
    const text = "the quick brown fox jumps over the lazy dog again and again";
    // Wrapped mid-phrase at ~20 chars: the first row alone is NOT a 40-char prefix.
    const pane = `  3. other\n❯ 4. the quick brown fox\n     jumps over the lazy dog again\n     and again\n  5. Chat about this\n`;
    expect(paneShowsTypedAnswer(pane, text)).toBe(true);
    // A wrap that swallowed the space at the break still matches (whitespace-insensitive).
    expect(paneShowsTypedAnswer("❯ 4. the quick brown fox\n     jumps over the lazy dog again and again\n", text)).toBe(true);
    // CJK: no spaces in the text, the wrap adds none but the join inserts one.
    const cjk = "今日は天気がいいので散歩に行きましょう。それから買い物もします";
    expect(paneShowsTypedAnswer(`❯ 4. ${cjk.slice(0, 12)}\n     ${cjk.slice(12)}\n`, cjk)).toBe(true);
  });

  test("continuation stops at an option row, Next, a rule or a blank line", () => {
    // The text continues on the NEXT option row's label only by coincidence — must not join.
    expect(paneShowsTypedAnswer("❯ 4. hello\n  5. world\n", "hello world")).toBe(false);
    expect(paneShowsTypedAnswer("❯ 4. hello\n     Next\n", "hello Next")).toBe(false);
    expect(paneShowsTypedAnswer("❯ 4. hello\n─────\n     world\n", "hello world")).toBe(false);
    expect(paneShowsTypedAnswer("❯ 4. hello\n\n     world\n", "hello world")).toBe(false);
  });

  test("collapses whitespace runs in the text and the row", () => {
    expect(paneShowsTypedAnswer("❯ 4. a b   c\n", "a  b c")).toBe(true);
  });

  test("regex metacharacters in the text match literally, not as a pattern", () => {
    const text = "a (b) [c] $d ^e .*";
    expect(paneShowsTypedAnswer(`❯ 4. ${text}\n`, text)).toBe(true);
    // If `.*` were live regex, this pane (different literal text) would match.
    expect(paneShowsTypedAnswer("❯ 4. a (b) [c] $d ^e zzz\n", text)).toBe(false);
    expect(paneShowsTypedAnswer("❯ 4. a b c d e\n", text)).toBe(false);
  });
});

describe("paneFocusedRowIsEmptyType", () => {
  test("true for an empty Type row focused (single-select, multi-select, either cursor glyph)", () => {
    expect(paneFocusedRowIsEmptyType("  3. green\n❯ 4. Type something.\n  5. Chat about this\n")).toBe(true);
    expect(paneFocusedRowIsEmptyType("  3. [ ] green\n❯ 4. [ ] Type something\n     Next\n")).toBe(true);
    expect(paneFocusedRowIsEmptyType(" › 4. Type something.  \n")).toBe(true);
  });

  test("false for a row already holding text, a checked row, a cursor elsewhere, or no Type row at all", () => {
    expect(paneFocusedRowIsEmptyType("❯ 4. half typed\n  5. Chat about this\n")).toBe(false);
    expect(paneFocusedRowIsEmptyType("❯ 4. [✔] Type something and more\n")).toBe(false);
    expect(paneFocusedRowIsEmptyType("❯ 1. red\n  4. Type something.\n")).toBe(false);
    // Preview layout: bare Chat row, cursor on an option, no Type row.
    expect(paneFocusedRowIsEmptyType("❯ 3. Gamma\n  Chat about this\n")).toBe(false);
    expect(paneFocusedRowIsEmptyType("")).toBe(false);
  });
});

describe("escapeTypedTrailingSemicolon", () => {
  test("escapes only a trailing `;` as `\\;`", () => {
    expect(escapeTypedTrailingSemicolon("done;")).toBe("done\\;");
    expect(escapeTypedTrailingSemicolon(";")).toBe("\\;");
    expect(escapeTypedTrailingSemicolon("a;b")).toBe("a;b");
    expect(escapeTypedTrailingSemicolon("plain")).toBe("plain");
    expect(escapeTypedTrailingSemicolon("")).toBe("");
  });

  test("a text already ending in backslashes gets exactly ONE more before the `;` (tmux 3.6a eats one)", () => {
    // Verified on tmux 3.6a via `send-keys -l --` into a `cat` pane: N backslashes
    // + `;` arrive as max(N - 1, 0) backslashes + `;`; N = 0 truncates.
    const BS = String.fromCharCode(92);
    expect(escapeTypedTrailingSemicolon("A" + BS + ";")).toBe("A" + BS + BS + ";");
    expect(escapeTypedTrailingSemicolon("A" + BS + BS + ";")).toBe("A" + BS + BS + BS + ";");
    expect(escapeTypedTrailingSemicolon(BS + ";")).toBe(BS + BS + ";");
    // A trailing backslash WITHOUT a `;` is left alone.
    expect(escapeTypedTrailingSemicolon("A" + BS)).toBe("A" + BS);
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
  /** `{ k: last argv element, t: epoch ms }` per call, in order. */
  times(): Array<{ k: string; t: number }>;
}

function makeFakeTmux(opts: { emptyPaneOnEnter: boolean; paneAfterText?: string }): FakeTmux {
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
      // The text step (`send-keys -l`) repaints the pane with the typed echo.
      (opts.paneAfterText !== undefined
        ? `if (argv.includes("send-keys") && argv.includes("-l")) writeFileSync(${JSON.stringify(panePath)}, ${JSON.stringify(opts.paneAfterText)});\n`
        : ``) +
      `appendFileSync(${JSON.stringify(path.join(dir, "times.jsonl"))}, JSON.stringify({ k: argv[argv.length - 1], t: Date.now() }) + "\\n");\n` +
      (opts.emptyPaneOnEnter
        ? `if (argv.includes("send-keys") && argv[argv.length - 1] === "Enter") writeFileSync(${JSON.stringify(panePath)}, "");\n`
        : ``),
  );
  chmodSync(binPath, 0o755);
  return {
    logPath,
    panePath,
    setPane: (t) => writeFileSync(panePath, t),
    times: () => {
      const f = path.join(dir, "times.jsonl");
      if (!existsSync(f)) return [];
      return readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { k: string; t: number });
    },
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

const TYPE_ROW_PANE = "Pick a colour\n  1. red\n  2. blue\n  3. green\n❯ 4. Type something.\n  5. Chat about this\n\nEnter to select · Esc to cancel\n";

describe("driveAskAnswers — typed text step over a recorded fake tmux", () => {
  test("sends the text as ONE `send-keys -l -- <text>` argv, in order, and returns true", async () => {
    const fake = makeFakeTmux({
      emptyPaneOnEnter: true,
      paneAfterText: `Pick a colour\n  1. red\n  2. blue\n  3. green\n❯ 4. ${TEXT}\n  5. Chat about this\n\nEnter to select · Esc to cancel\n`,
    });
    fake.setPane(TYPE_ROW_PANE);
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
      // The pane was read BEFORE the text (empty-Type-row guard) and between the
      // text and the Enter (echo verification).
      const all = fake.calls();
      const textAt = all.findIndex((a) => a.includes("-l"));
      const enterAt = all.findIndex((a) => a[0] === "send-keys" && a[a.length - 1] === "Enter");
      expect(all.slice(0, textAt).some((a) => a[0] === "capture-pane")).toBe(true);
      expect(all.slice(textAt + 1, enterAt).some((a) => a[0] === "capture-pane")).toBe(true);
    });
  });

  test("a trailing `;` is sent as `\\;` (tmux 3.6a swallows a bare trailing `;`); the echo check still uses the original text", async () => {
    const fake = makeFakeTmux({
      emptyPaneOnEnter: true,
      paneAfterText: "Pick a colour\n  3. green\n❯ 4. all done;\n  5. Chat about this\n\nEnter to select · Esc to cancel\n",
    });
    fake.setPane(TYPE_ROW_PANE);
    await withDrive(fake, async ({ taskId, sessionName }) => {
      const ok = await driveAskAnswers(taskId, {
        steps: ["Down", "Down", "Down", { type: "text", text: "all done;" }, "Enter"],
        confirmsReview: false,
      });
      expect(ok).toBe(true);
      const text = fake.calls().find((a) => a.includes("-l"));
      expect(text).toEqual(["send-keys", "-t", sessionName, "-l", "--", "all done\\;"]);
      expect(text![5]!.length).toBe("all done;".length + 1);
    });
  });

  test("echo never appears → 'typed-abort', sends NO Enter or further key, emits a status chunk", async () => {
    const fake = makeFakeTmux({ emptyPaneOnEnter: true });
    fake.setPane(TYPE_ROW_PANE);
    await withDrive(fake, async ({ taskId, chunks }) => {
      const ok = await driveAskAnswers(taskId, { steps: TYPED_STEPS, confirmsReview: false });
      expect(ok).toBe("typed-abort");

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

  const REFUSED: Array<[string, string]> = [
    [
      "a preview-layout question with no Type row (bare Chat row, cursor on an option)",
      "Pick one\n❯ 1. Alpha\n  2. Beta\n  3. Gamma\n  Chat about this\n\nEnter to select · Esc to cancel\n",
    ],
    [
      "a Type row already holding text",
      "Pick a colour\n  3. green\n❯ 4. half typed answer\n  5. Chat about this\n\nEnter to select · Esc to cancel\n",
    ],
    [
      "the cursor on another row while an empty Type row is visible",
      "Pick a colour\n❯ 1. red\n  2. blue\n  4. Type something.\n  5. Chat about this\n\nEnter to select · Esc to cancel\n",
    ],
  ];
  for (const [name, pane] of REFUSED) {
    test(`typed-step guard refuses (${name}) → 'typed-abort' and types NOTHING`, async () => {
      const fake = makeFakeTmux({ emptyPaneOnEnter: true });
      fake.setPane(pane);
      await withDrive(fake, async ({ taskId, chunks }) => {
        const ok = await driveAskAnswers(taskId, { steps: TYPED_STEPS, confirmsReview: false });
        expect(ok).toBe("typed-abort");
        const sends = fake.calls().filter((a) => a[0] === "send-keys");
        // Only the three navigation Downs went out — no text, no Enter.
        expect(sends).toHaveLength(3);
        expect(fake.calls().some((a) => a.includes("-l"))).toBe(false);
        expect(chunks.some((c) => c.stream === "status" && c.data.includes("not an empty 'Type something' row"))).toBe(true);
      });
    });
  }

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

// ────────────────────────────────────────────────────────────────────────────
// confirmStartupDialog — 150 ms gap between the arrow(s) and Enter (live-smoke
// finding: a 30 ms Down+Enter pair was accepted by tmux but ignored by claude).
// ────────────────────────────────────────────────────────────────────────────

describe("confirmStartupDialog — key gap over a recorded fake tmux", () => {
  const dialog = (cursorIndex: number, acceptIndex: number) => ({
    name: "trust-folder",
    choices: [{ key: "1", label: "No, exit" }, { key: "2", label: "Yes, I trust this folder" }],
    cursorIndex,
    acceptIndex,
    fingerprint: `fp-${cursorIndex}`,
  });

  test("Down then Enter, at least STARTUP_CONFIRM_KEY_GAP_MS apart", async () => {
    expect(STARTUP_CONFIRM_KEY_GAP_MS).toBe(150);
    const fake = makeFakeTmux({ emptyPaneOnEnter: false });
    await withDrive(fake, async ({ taskId, sessionName }) => {
      expect(await confirmStartupDialog(taskId, sessionName, dialog(0, 1))).toBe(true);
      const keys = fake.times().filter((c) => c.k === "Down" || c.k === "Enter");
      expect(keys.map((c) => c.k)).toEqual(["Down", "Enter"]);
      // Wall-clock gap (process-spawn latency only ever adds to it).
      expect(keys[1]!.t - keys[0]!.t).toBeGreaterThanOrEqual(STARTUP_CONFIRM_KEY_GAP_MS - 20);
    });
  });

  test("cursor already on the accept row → Enter alone (the retry case where only Enter was lost)", async () => {
    const fake = makeFakeTmux({ emptyPaneOnEnter: false });
    await withDrive(fake, async ({ taskId, sessionName }) => {
      expect(await confirmStartupDialog(taskId, sessionName, dialog(1, 1))).toBe(true);
      expect(fake.calls().filter((a) => a[0] === "send-keys")).toEqual([["send-keys", "-t", sessionName, "Enter"]]);
    });
  });
});


// ────────────────────────────────────────────────────────────────────────────
// dismissAskModalForMessage (F-D N1) — over a scripted fake tmux whose pane
// depends on how many `Escape` keys have been sent so far (each element of a
// `COMPOSER_CLEAR_KEYS` send counts).
// ────────────────────────────────────────────────────────────────────────────

interface ScriptedTmux {
  binPath: string;
  logPath: string;
  sendKeys(): string[][];
}

/** `frames`: the pane is the LAST frame whose `minEsc` <= the cumulative number
 *  of `Escape` arguments sent to `send-keys` so far. */
function makeScriptedTmux(frames: Array<{ minEsc: number; pane: string }>): ScriptedTmux {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-dismiss-tmux-"));
  scratchDirs.push(dir);
  const binPath = path.join(dir, "tmux");
  const logPath = path.join(dir, "log.jsonl");
  writeFileSync(
    binPath,
    `#!${process.execPath}\n` +
      `import { appendFileSync, readFileSync, existsSync } from "node:fs";\n` +
      `const argv = process.argv.slice(2);\n` +
      `appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(argv) + "\\n");\n` +
      `if (argv.includes("capture-pane")) {\n` +
      `  const frames = ${JSON.stringify(frames)};\n` +
      `  const lines = readFileSync(${JSON.stringify(logPath)}, "utf8").split("\\n").filter(Boolean).map((l) => JSON.parse(l));\n` +
      `  const esc = lines.filter((a) => a.includes("send-keys")).flat().filter((k) => k === "Escape").length;\n` +
      `  let pane = frames[0].pane;\n` +
      `  for (const f of frames) if (f.minEsc <= esc) pane = f.pane;\n` +
      `  process.stdout.write(pane);\n` +
      `}\n`,
  );
  chmodSync(binPath, 0o755);
  return {
    binPath,
    logPath,
    sendKeys: () => {
      if (!existsSync(logPath)) return [];
      return readFileSync(logPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as string[])
        .map((a) => (a[0] === "-L" ? a.slice(2) : a))
        .filter((a) => a.includes("send-keys"))
        .map((a) => a.slice(a.indexOf("send-keys") + 3)); // drop `send-keys -t <session>`
    },
  };
}

async function withScripted<T>(fake: ScriptedTmux, fn: (taskId: string) => Promise<T>): Promise<T> {
  const prevBin = process.env.AGETOR_TMUX_BIN;
  process.env.AGETOR_TMUX_BIN = fake.binPath;
  const taskId = `dismiss-${Math.random().toString(36).slice(2, 10)}`;
  __forTest.installSession(taskId, path.join(path.dirname(fake.logPath), "s.jsonl"));
  try {
    return await fn(taskId);
  } finally {
    __forTest.uninstallSession(taskId);
    if (prevBin === undefined) delete process.env.AGETOR_TMUX_BIN;
    else process.env.AGETOR_TMUX_BIN = prevBin;
  }
}

const IDLE_STATUS_BAR = "  ⏵⏵ bypass permissions on (shift+tab to cycle)";
const RULE = "─".repeat(80);
const CLEAN_REPL = `\n${RULE}\n❯ \n${RULE}\n${IDLE_STATUS_BAR}\n`;
const DIRTY_REPL = readFileSync(path.join(import.meta.dir, "fixtures/askuserquestion/v284_typed_single.txt"), "utf8");
const MODAL_PANE = TYPE_ROW_PANE;

describe("dismissAskModalForMessage — over a scripted fake tmux", () => {
  test("fixture sanity: the recorded declined-modal pane has draft text in the composer; the clean one does not", () => {
    expect(__forTest.paneShowsComposerText(DIRTY_REPL)).toBe(true);
    expect(__forTest.paneShowsComposerText(CLEAN_REPL)).toBe(false);
    expect(__forTest.paneShowsIdleInputBox(CLEAN_REPL)).toBe(true);
  });

  test("modal gone after one Escape + clean composer → true, exactly one Escape", async () => {
    const fake = makeScriptedTmux([{ minEsc: 0, pane: MODAL_PANE }, { minEsc: 1, pane: CLEAN_REPL }]);
    const res = await withScripted(fake, (taskId) => dismissAskModalForMessage(taskId));
    expect(res).toBe(true);
    expect(fake.sendKeys()).toEqual([["Escape"]]);
  });

  test("modal persisting through the first window → ONE more Escape, then true", async () => {
    const fake = makeScriptedTmux([{ minEsc: 0, pane: MODAL_PANE }, { minEsc: 2, pane: CLEAN_REPL }]);
    const res = await withScripted(fake, (taskId) => dismissAskModalForMessage(taskId));
    expect(res).toBe(true);
    expect(fake.sendKeys()).toEqual([["Escape"], ["Escape"]]);
  });

  test("leftover draft text in the composer → COMPOSER_CLEAR_KEYS sent (one send-keys) and re-verified", async () => {
    // 1 Escape closes the modal but leaves `❯ purple`; the clear pair (esc count 3) empties it.
    const fake = makeScriptedTmux([
      { minEsc: 0, pane: MODAL_PANE },
      { minEsc: 1, pane: DIRTY_REPL },
      { minEsc: 3, pane: CLEAN_REPL },
    ]);
    const res = await withScripted(fake, (taskId) => dismissAskModalForMessage(taskId));
    expect(res).toBe(true);
    expect(fake.sendKeys()).toEqual([["Escape"], [...__forTest.COMPOSER_CLEAR_KEYS]]);
  });

  test("a composer that will not clear → false (after the clear keys were tried once)", async () => {
    const fake = makeScriptedTmux([{ minEsc: 0, pane: MODAL_PANE }, { minEsc: 1, pane: DIRTY_REPL }]);
    const res = await withScripted(fake, (taskId) => dismissAskModalForMessage(taskId));
    expect(res).toBe(false);
    expect(fake.sendKeys()).toEqual([["Escape"], [...__forTest.COMPOSER_CLEAR_KEYS]]);
  });

  test("a bare composer never gets the clear keys (a double Escape there opens the rewind picker)", async () => {
    const fake = makeScriptedTmux([{ minEsc: 0, pane: MODAL_PANE }, { minEsc: 1, pane: CLEAN_REPL }]);
    await withScripted(fake, (taskId) => dismissAskModalForMessage(taskId));
    expect(fake.sendKeys().some((k) => k.length === 2)).toBe(false);
  });

  test("modal never goes away → false after exactly ASK_DISMISS_MAX_ESCAPES Escapes", async () => {
    const fake = makeScriptedTmux([{ minEsc: 0, pane: MODAL_PANE }]);
    const res = await withScripted(fake, (taskId) => dismissAskModalForMessage(taskId));
    expect(res).toBe(false);
    expect(__forTest.ASK_DISMISS_MAX_ESCAPES).toBe(2);
    expect(fake.sendKeys()).toEqual([["Escape"], ["Escape"]]);
  });

  test("an unknown task → false without touching tmux", async () => {
    expect(await dismissAskModalForMessage("no-such-task-" + Math.random())).toBe(false);
  });
});
