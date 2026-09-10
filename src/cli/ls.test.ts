import { test, expect, mock, afterAll, beforeEach, afterEach } from "bun:test";
import type { AgetorClient } from "./api-client.ts";
import type { Task, TaskFxRecovery } from "../shared/types.ts";

/**
 * `cmdLs` (commands/ls.ts) reaches for a client via `getClient(flags)`,
 * internally — same mocking idiom `files.test.ts`/`resume.test.ts` use: mock
 * `./context.ts` (for `getClient`) and `./output.ts` (to capture `out()`).
 * `ls.ts`'s `needsCell` helper isn't exported, so this suite drives it
 * indirectly through `cmdLs`'s rendered table and asserts on the "needs"
 * column text of the printed rows — the `c.*` color wrappers are mocked to
 * plain identity functions (mirroring `files.test.ts`) so the printed text
 * has no ANSI codes to strip.
 *
 * Both mocked modules are snapshotted before mocking and restored in
 * `afterAll` — `mock.module` overwrites the module record in place (Bun's
 * documented behavior for already-loaded modules), and other test files in
 * the same `bun test` process import these same modules.
 */

import * as realContext from "./context.ts";
import * as realOutput from "./output.ts";

const realContextSnapshot = { ...realContext };
const realOutputSnapshot = { ...realOutput };

let currentClient: AgetorClient | null = null;
const outputs: string[] = [];

mock.module("./context.ts", () => ({
  ...realContextSnapshot,
  getClient: async () => {
    if (!currentClient) throw new Error("no fake client set for this test");
    return currentClient;
  },
}));

mock.module("./output.ts", () => ({
  ...realOutputSnapshot,
  c: {
    dim: (s: string) => s,
    bold: (s: string) => s,
    red: (s: string) => s,
    green: (s: string) => s,
    yellow: (s: string) => s,
    cyan: (s: string) => s,
    gray: (s: string) => s,
    magenta: (s: string) => s,
    blue: (s: string) => s,
  },
  out: (msg = "") => {
    outputs.push(msg);
  },
  errln: () => {},
}));

afterAll(() => {
  mock.module("./context.ts", () => realContextSnapshot);
  mock.module("./output.ts", () => realOutputSnapshot);
});

const { cmdLs } = await import("./commands/ls.ts");

const flags = { json: false, plain: true, noDaemon: true } as unknown as Parameters<typeof cmdLs>[1];

function pausedFxRecovery(autoResume: TaskFxRecovery["autoResume"] = null): TaskFxRecovery {
  return {
    state: "paused",
    runId: "run-1",
    pausedAt: Date.now(),
    autoResume,
    autoResumeCount: 0,
  };
}

function task(over: Partial<Task>): Task {
  return {
    id: "t1",
    title: "T",
    prompt: "p",
    agent: "fx",
    column: "ready",
    workdir: "/tmp",
    isolation: "none",
    taskType: "task",
    archivedAt: null,
    pendingInteractionCount: 0,
    hasOpenableRun: false,
    ...over,
  } as unknown as Task;
}

function makeClient(tasks: Task[]): AgetorClient {
  return { listTasks: async () => tasks } as unknown as AgetorClient;
}

/** The rendered table is a single multi-line string pushed once via `out()`.
 *  Split into lines (skipping the header) so each test can find "its" row —
 *  every test here uses exactly one task, so the sole data row suffices. */
function dataRowLine(): string {
  expect(outputs).toHaveLength(1);
  const lines = outputs[0]!.split("\n");
  // lines[0] is the header row ("" id title agent column needs).
  expect(lines.length).toBeGreaterThanOrEqual(2);
  return lines[1]!;
}

beforeEach(() => {
  outputs.length = 0;
});

// Real Date.now is monkey-patched (not `spyOn`, to keep this file dependency-
// free) for the countdown-text tests below — always restored in `afterEach`
// so it can never leak into a sibling test/file in the same `bun test`
// process.
const realDateNow = Date.now;
afterEach(() => {
  Date.now = realDateNow;
});

test("needs column: no pending interactions, no fx pause -> empty needs cell", async () => {
  currentClient = makeClient([task({ pendingInteractionCount: 0 })]);
  await cmdLs([], flags);

  const row = dataRowLine();
  // No "!" or "⏸" marker anywhere on the row.
  expect(row).not.toContain("!");
  expect(row).not.toContain("⏸");
});

test("needs column: pendingInteractionCount only -> '! N', no pause hint", async () => {
  currentClient = makeClient([task({ pendingInteractionCount: 3 })]);
  await cmdLs([], flags);

  const row = dataRowLine();
  expect(row).toContain("! 3");
  expect(row).not.toContain("⏸");
});

test("needs column: fx task paused, no auto-resume timer -> '⏸ paused'", async () => {
  currentClient = makeClient([
    task({ agent: "fx", column: "ready", fxRecovery: pausedFxRecovery(null) }),
  ]);
  await cmdLs([], flags);

  const row = dataRowLine();
  expect(row).toContain("⏸ paused");
  expect(row).not.toContain("⏸ auto");
  expect(row).not.toContain("!");
});

test("needs column: fx task paused with a pending auto-resume timer -> '⏸ auto m:ss'", async () => {
  const now = 1_000_000;
  Date.now = () => now;
  currentClient = makeClient([
    task({
      agent: "fx",
      column: "ready",
      fxRecovery: pausedFxRecovery({ at: now + 118_000, attempt: 1, max: 3, delaySec: 120 }),
    }),
  ]);
  await cmdLs([], flags);

  const row = dataRowLine();
  // 118s remaining -> 1:58 (fxAutoResumeCountdownText: floor(118/60)=1, 118%60=58).
  expect(row).toContain("⏸ auto 1:58");
  expect(row).not.toContain("⏸ paused");
});

test("needs column: '0:07' just under a minute remaining, seconds zero-padded", async () => {
  const now = 1_000_000;
  Date.now = () => now;
  currentClient = makeClient([
    task({
      agent: "fx",
      column: "ready",
      fxRecovery: pausedFxRecovery({ at: now + 7_000, attempt: 2, max: 3, delaySec: 120 }),
    }),
  ]);
  await cmdLs([], flags);

  const row = dataRowLine();
  expect(row).toContain("⏸ auto 0:07");
});

test("needs column: pendingInteractionCount AND paused (no timer) -> '! N ⏸ paused', space-joined", async () => {
  currentClient = makeClient([
    task({
      agent: "fx",
      column: "ready",
      pendingInteractionCount: 2,
      fxRecovery: pausedFxRecovery(null),
    }),
  ]);
  await cmdLs([], flags);

  const row = dataRowLine();
  expect(row).toContain("! 2 ⏸ paused");
});

test("needs column: pendingInteractionCount AND paused-with-timer -> '! N ⏸ auto m:ss', space-joined", async () => {
  const now = 1_000_000;
  Date.now = () => now;
  currentClient = makeClient([
    task({
      agent: "fx",
      column: "ready",
      pendingInteractionCount: 1,
      fxRecovery: pausedFxRecovery({ at: now + 65_000, attempt: 1, max: 3, delaySec: 120 }),
    }),
  ]);
  await cmdLs([], flags);

  const row = dataRowLine();
  expect(row).toContain("! 1 ⏸ auto 1:05");
});

test("needs column: fxRecovery paused but column is 'running' -> isTaskFxPaused is false, no pause hint (matches the board card's own gate)", async () => {
  currentClient = makeClient([
    task({ agent: "fx", column: "running", fxRecovery: pausedFxRecovery(null) }),
  ]);
  await cmdLs([], flags);

  const row = dataRowLine();
  expect(row).not.toContain("⏸");
});

test("needs column: fxRecovery null -> no pause hint", async () => {
  currentClient = makeClient([task({ agent: "fx", column: "ready", fxRecovery: null })]);
  await cmdLs([], flags);

  const row = dataRowLine();
  expect(row).not.toContain("⏸");
});

test("needs column: fxRecovery undefined (legacy fixture, field never set) -> no pause hint", async () => {
  currentClient = makeClient([task({ agent: "fx", column: "ready" })]);
  await cmdLs([], flags);

  const row = dataRowLine();
  expect(row).not.toContain("⏸");
});

// Code-review check (the "⏸ is double-width in most terminals" finding that
// required a `pauseW` fix in the TUI's `Dashboard.tsx`): `table()` pads every
// column using a plain, non-wcwidth-aware `.length`, which under-measures a
// row's own "needs" text by one cell whenever the pause glyph is present.
// Unlike the TUI's fixed-width row, that miscount has nothing to overflow
// into here — "needs" is the table's LAST column (`table()`'s `fmt()`
// immediately `.trimEnd()`s its padding) and the title column's budget
// (`truncate(t.title, 44)`) is a fixed constant, not derived from the needs
// cell's width the way the TUI row's `titleMax` is. These two tests pin
// that: alignment of every column BEFORE "needs" holds regardless of the
// glyph, and the countdown text itself is never chopped short.
test("needs column: table alignment before 'needs' is unaffected by the pause hint's double-width ⏸ glyph — 'needs' is the table's last, trimmed column", async () => {
  const now = 1_000_000;
  Date.now = () => now;
  currentClient = makeClient([
    task({ id: "aaaa1111", title: "No hint", agent: "fx", column: "ready" }),
    task({
      id: "bbbb2222",
      title: "Has hint",
      agent: "fx",
      column: "ready",
      fxRecovery: pausedFxRecovery({ at: now + 65_000, attempt: 1, max: 3, delaySec: 120 }),
    }),
  ]);
  await cmdLs([], flags);

  expect(outputs).toHaveLength(1);
  const lines = outputs[0]!.split("\n");
  expect(lines.length).toBe(3); // header + 2 rows
  const [, rowA, rowB] = lines;
  // The "column" cell ("ready") must start at the same character offset on
  // both rows — the pause hint lives only in the trailing "needs" column, so
  // its (miscounted) width must never shift anything that precedes it.
  const colIdxA = rowA!.indexOf("ready");
  const colIdxB = rowB!.indexOf("ready");
  expect(colIdxA).toBeGreaterThan(0);
  expect(colIdxA).toBe(colIdxB);
  // The countdown text itself renders in full — not chopped short the way an
  // undercounted width budget chopped Dashboard.tsx's TaskRow countdown.
  expect(rowB).toContain("⏸ auto 1:05");
});

test("needs column: a long title truncates identically with or without the pause hint present — the title budget (fixed 44 chars) never consults the needs cell's width", async () => {
  const now = 1_000_000;
  Date.now = () => now;
  const longTitle = "X".repeat(60);
  currentClient = makeClient([
    task({
      id: "cccc3333",
      title: longTitle,
      agent: "fx",
      column: "ready",
      fxRecovery: pausedFxRecovery({ at: now + 65_000, attempt: 1, max: 3, delaySec: 120 }),
    }),
  ]);
  await cmdLs([], flags);

  const row = dataRowLine();
  // truncate(s, 44): 43 chars kept + an ellipsis, unchanged whether or not
  // the row also carries a pause hint.
  expect(row).toContain("X".repeat(43) + "…");
  expect(row).not.toContain("X".repeat(44));
  expect(row).toContain("⏸ auto 1:05");
});
