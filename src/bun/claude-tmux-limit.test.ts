/**
 * Claude's pane usage-limit notice (harness stacks, review B1).
 *
 * The notice is only a failover signal on a stack task WITH a backup. A lone
 * account must stay inert: the turn keeps running while claude auto-continues,
 * exactly as before stacks existed (plan §2.2). These tests drive the real
 * `scrapeOnce` tick against a synthetic pane so the gate is exercised end to
 * end, not just as a predicate.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// claude-tmux.ts imports db.ts transitively; the data dir must exist first.
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-claude-limit-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;

// Static imports are evaluated before the env assignment above, so the db
// opener would miss the temp data dir (and warn). Import after it instead.
const { __forTest } = await import("./claude-tmux.ts");
const { HARNESS_LIMIT_STATUS_PREFIX } = await import("../shared/types.ts");
const { parseClaudeResetNotice } = await import("../shared/harness-limits.ts");
const { rmTestDataDir } = await import("./test-data-dir.ts");

const LIMIT_PANE = [
  "● Working on the task…",
  "",
  "  Usage limit reached · continuing automatically at 8am",
  "",
  "  esc to interrupt",
].join("\n");

const PLAIN_PANE = [
  "● Working on the task…",
  "",
  "  esc to interrupt",
].join("\n");

type CaptureFn = Parameters<typeof __forTest.setCaptureScrapePane>[0];
let previousCapture: CaptureFn | null = null;

function installPane(text: string): void {
  previousCapture = __forTest.setCaptureScrapePane(async () => ({
    ok: true,
    stdout: text,
    stderr: "",
  }));
}

/** Stand-in for the real tmux reader: no live session. */
const NO_SESSION: CaptureFn = async () => ({ ok: false, stdout: "", stderr: "" });

beforeAll(() => {
  previousCapture = __forTest.setCaptureScrapePane(NO_SESSION);
});

afterEach(() => {
  __forTest.setCaptureScrapePane(previousCapture ?? NO_SESSION);
});

afterAll(() => {
  rmTestDataDir(DATA_DIR);
});

function paneState(taskId: string, harnessFailover: boolean) {
  const state = __forTest.installSession(taskId, path.join(DATA_DIR, "session.jsonl"));
  state.harnessFailover = harnessFailover;
  const chunks: Array<{ stream: string; data: string }> = [];
  let resolved = false;
  const done = __forTest.pushTurnSlot(state, (stream, data) => {
    chunks.push({ stream, data });
  });
  void done.then(() => {
    resolved = true;
  });
  return { state, chunks, isResolved: () => resolved };
}

describe("claude pane usage-limit notice", () => {
  test("detects the live notice without matching prose about limits", () => {
    expect(__forTest.paneShowsHarnessLimitNotice(LIMIT_PANE)).toBe(true);
    expect(__forTest.paneShowsHarnessLimitNotice("I checked the usage limit docs.")).toBe(false);
  });

  test("prose that mentions limits far apart is not the live notice", () => {
    const prose = [
      "● Working on the task…",
      "",
      "  I checked the usage limit docs after the last run.",
      "  Nothing else to report.",
      "",
      "  The guide says the quota resets at midnight UTC.",
      "",
      "  esc to interrupt",
    ].join("\n");
    expect(__forTest.paneShowsHarnessLimitNotice(prose)).toBe(false);
    // A genuinely wrapped notice still matches within its own rows.
    expect(__forTest.paneShowsHarnessLimitNotice(
      ["  Usage limit · continuing", "  automatically at 8am"].join("\n"),
    )).toBe(true);
  });

  test("one-line prose about the reset time is not the live notice (R-M1)", () => {
    // Regression: the old detail regex accepted `resets at`, so this ordinary
    // assistant sentence matched on the same row and failed a healthy turn.
    for (const prose of [
      "  The usage limit resets at 8am.",
      "  usage limit resets at 8am",
      "  Usage limit resets at 8am — I'll retry afterwards",
      "⏺ Usage limit resets at 8am, per the plan.",
      "  I reached the usage limit yesterday.",
    ]) {
      expect(__forTest.paneShowsHarnessLimitNotice(prose)).toBe(false);
    }
    // The provider's real notice wording still matches, including a wrapped row.
    expect(__forTest.paneShowsHarnessLimitNotice(
      "  Usage limit reached · continuing automatically at 8am · esc to cancel",
    )).toBe(true);
    expect(__forTest.paneShowsHarnessLimitNotice(
      "  Usage limit reached · continuing shortly · esc to cancel",
    )).toBe(true);
  });

  test("a wrapped notice keeps its reset time in the stored message", () => {
    const wrapped = [
      "  Usage limit reached · continuing",
      "  automatically at 8am · esc to cancel",
    ].join("\n");
    const text = __forTest.harnessLimitNoticeText(wrapped);
    expect(text).toContain("continuing automatically at 8am");
    // The reset survives the wrap and is the instant the cooldown uses.
    expect(parseClaudeResetNotice(text, 0)).not.toBeNull();
    const now = new Date(2026, 0, 1, 7, 0, 0, 0).getTime(); // 7am local
    expect(parseClaudeResetNotice(text, now)).toBe(now + 60 * 60 * 1000);
  });

  test("stores only the notice line, not the whole pane tail", () => {
    const text = __forTest.harnessLimitNoticeText(LIMIT_PANE);
    expect(text).toContain("Usage limit");
    expect(text).not.toContain("Working on the task");
    expect(text.length).toBeLessThanOrEqual(300);
  });

  test("a notice quoted in the scrollback is not the live notice (R7-S3)", () => {
    // The detector used to scan the whole 40-row capture, so the user pasting
    // the notice text (or a tool result quoting it) could settle a perfectly
    // healthy stacked turn and burn a backup. Only the live bottom chrome —
    // the hint slot directly above the input box — counts.
    const healthy = [
      "● Earlier turn:",
      "  Usage limit reached · continuing automatically at 8am · esc to cancel",
      ...Array.from({ length: 20 }, (_, i) => `  tool output row ${i}`),
      "",
      "✻ Working… (2m 52s · ↓ 12.1k tokens)",
      "⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt · ← 1 agent",
    ].join("\n");
    expect(__forTest.paneShowsHarnessLimitNotice(healthy)).toBe(false);
    expect(__forTest.harnessLimitNoticeText(healthy)).toBe("");

    // The same notice in the live hint slot still matches, even with a long
    // transcript above it.
    const live = [
      ...Array.from({ length: 20 }, (_, i) => `  tool output row ${i}`),
      "",
      "          Usage limit reached · continuing automatically at 8am · esc to cancel",
      "────────────────────────────────────────────────────────────────────────────────",
      "❯",
      "────────────────────────────────────────────────────────────────────────────────",
      "  ⏵⏵ auto mode on (shift+tab to cycle) · ← 1 agent",
    ].join("\n");
    expect(__forTest.paneShowsHarnessLimitNotice(live)).toBe(true);
  });

  test("a stack task with a backup settles the turn and emits the failover signal", async () => {
    installPane(LIMIT_PANE);
    const { state, chunks, isResolved } = paneState("t-limit-stack", true);
    try {
      await __forTest.scrapeOnce(state);
      const signal = chunks.find((c) => c.stream === "status" && c.data.startsWith(HARNESS_LIMIT_STATUS_PREFIX));
      expect(signal).toBeTruthy();
      expect(chunks.some((c) => c.stream === "status" && c.data === "turn complete")).toBe(true);
      expect(state.turnQueue).toHaveLength(0);
      expect(isResolved()).toBe(true);
    } finally {
      __forTest.uninstallSession("t-limit-stack");
    }
  });

  test("a lone account stays inert — the turn keeps running (no signal, no settle)", async () => {
    installPane(LIMIT_PANE);
    const { state, chunks, isResolved } = paneState("t-limit-lone", false);
    try {
      await __forTest.scrapeOnce(state);
      expect(chunks.some((c) => c.stream === "status" && c.data.startsWith(HARNESS_LIMIT_STATUS_PREFIX))).toBe(false);
      expect(chunks.some((c) => c.stream === "status" && c.data === "turn complete")).toBe(false);
      expect(state.turnQueue).toHaveLength(1);
      expect(isResolved()).toBe(false);
    } finally {
      __forTest.uninstallSession("t-limit-lone");
    }
  });

  test("the gate is false while claude is writing and after one signal per turn", () => {
    const base = {
      harnessFailover: true,
      turnInFlight: true,
      limitSignaledThisTurn: false,
      claudeIsWriting: false,
      paneShowsNotice: true,
    };
    expect(__forTest.shouldSignalHarnessLimit(base)).toBe(true);
    expect(__forTest.shouldSignalHarnessLimit({ ...base, claudeIsWriting: true })).toBe(false);
    expect(__forTest.shouldSignalHarnessLimit({ ...base, limitSignaledThisTurn: true })).toBe(false);
    expect(__forTest.shouldSignalHarnessLimit({ ...base, harnessFailover: false })).toBe(false);
    expect(__forTest.shouldSignalHarnessLimit({ ...base, paneShowsNotice: false })).toBe(false);
  });

  test("one-line prose about a reset never settles a stacked turn (R-M1)", async () => {
    const prosePane = [
      "● Working on the task…",
      "",
      "  The usage limit resets at 8am — I'll retry afterwards.",
      "",
      "  esc to interrupt",
    ].join("\n");
    installPane(prosePane);
    const { state, chunks, isResolved } = paneState("t-limit-prose", true);
    try {
      await __forTest.scrapeOnce(state);
      expect(chunks.some((c) => c.stream === "status" && c.data.startsWith(HARNESS_LIMIT_STATUS_PREFIX))).toBe(false);
      expect(chunks.some((c) => c.stream === "status" && c.data === "turn complete")).toBe(false);
      expect(state.turnQueue).toHaveLength(1);
      expect(isResolved()).toBe(false);
    } finally {
      __forTest.uninstallSession("t-limit-prose");
    }
  });

  test("a quoted notice in the scrollback never settles a stacked turn (R7-S3)", async () => {
    const scrollbackPane = [
      "● Earlier turn:",
      "  Usage limit reached · continuing automatically at 8am · esc to cancel",
      ...Array.from({ length: 20 }, (_, i) => `  tool output row ${i}`),
      "",
      "✻ Working… (2m 52s · ↓ 12.1k tokens)",
      "⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt · ← 1 agent",
    ].join("\n");
    installPane(scrollbackPane);
    const { state, chunks, isResolved } = paneState("t-limit-scrollback", true);
    try {
      await __forTest.scrapeOnce(state);
      expect(chunks.some((c) => c.stream === "status" && c.data.startsWith(HARNESS_LIMIT_STATUS_PREFIX))).toBe(false);
      expect(chunks.some((c) => c.stream === "status" && c.data === "turn complete")).toBe(false);
      expect(state.turnQueue).toHaveLength(1);
      expect(isResolved()).toBe(false);
    } finally {
      __forTest.uninstallSession("t-limit-scrollback");
    }
  });

  test("the notice becomes no card on a plain pane (control case)", async () => {
    installPane(PLAIN_PANE);
    const { state, chunks } = paneState("t-limit-plain", true);
    try {
      await __forTest.scrapeOnce(state);
      expect(chunks.some((c) => c.data.startsWith(HARNESS_LIMIT_STATUS_PREFIX))).toBe(false);
      expect(state.turnQueue).toHaveLength(1);
    } finally {
      __forTest.uninstallSession("t-limit-plain");
    }
  });
});
