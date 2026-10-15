import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, mkdirSync, mkdtempSync, openSync, rmSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { rmTestDataDir } from "./test-data-dir.ts";

/* ────────────────────────────────────────────────────────────────────────── *
 * Chunked transcript reads (docs/plans/non-blocking-session-restore.md, TT2
 * follow-up). `tailFile` and the main-JSONL scan read what was appended in
 * bounded chunks (`TAIL_READ_CHUNK_BYTES`) instead of one read of the whole
 * delta, so the cooperative first cycle can yield MID-file. These tests shrink
 * the chunk to a few hundred bytes (`__forTest.setReadChunkBytes`) and prove:
 *  • correctness — every line persisted exactly once across chunk boundaries,
 *    a line straddling a boundary, multi-byte characters cut by a boundary, a
 *    single line longer than a chunk, a partial trailing line left for later;
 *  • yielding — with `__forTest.setJobSliceMs(0)` each slice stops after one
 *    chunk, so a sampler running between slices sees a transcript half-ingested
 *    and sees the main scan pick up bytes written AFTER the first chunk was
 *    read (impossible if the file were read in one go);
 *  • robustness — a transcript deleted mid-drain never throws out of the job.
 * ────────────────────────────────────────────────────────────────────────── */

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-chunked-data-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
// Transcripts never live under the data dir (cleanup must not touch the sqlite).
const FIXTURE_DIR = mkdtempSync(path.join(tmpdir(), "agetor-chunked-fixture-"));

/** Small enough that every fixture below spans many chunks. */
const CHUNK = 300;

const createdTaskIds: string[] = [];

beforeAll(async () => {
  await import("./db.ts");
});

afterEach(async () => {
  const { detachWatcherFor, __forTest } = await import("./claude-subagents.ts");
  const { db } = await import("./db.ts");
  __forTest.setReadChunkBytes(null);
  __forTest.setJobSliceMs(null);
  for (const id of createdTaskIds) {
    try { detachWatcherFor(id); } catch { /* best-effort */ }
    try { db.run(`DELETE FROM tasks WHERE id = ?`, [id]); } catch { /* best-effort */ }
  }
  createdTaskIds.length = 0;
});

afterAll(() => {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
  rmTestDataDir(DATA_DIR);
});

/** A task + an already-terminal run + a `<session>/subagents/` layout (same
 *  shape as `claude-subagents-yield.test.ts`). */
async function seed() {
  const { tasks, runs } = await import("./db.ts");
  const taskId = `task-chunked-${randomUUID()}`;
  const runId = `run-chunked-${randomUUID()}`;
  createdTaskIds.push(taskId);
  const now = Date.now();
  tasks.insert({
    id: taskId, title: "t", prompt: "p", column: "review", agent: "claude-code",
    workdir: "/tmp", isolation: "none", taskType: "task", branch: null, branchSource: "created",
    worktreePath: null, baseRef: null, mode: null, model: null, effort: null,
    fast: false, maxMode: false, references: [], backlog: [], plans: [], draft: null, runId,
    prUrl: null,
    hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0,
    archivedAt: null, createdAt: now, updatedAt: now,
  });
  runs.insert({
    id: runId, taskId, agent: "claude-code", status: "succeeded", startedAt: now,
    endedAt: now, exitCode: 0, tmuxSession: null, claudeSessionId: null, codexSessionId: null,
    cursorSessionId: null, geminiSessionId: null, fxSessionId: null,
  });
  const sessionId = randomUUID();
  const proj = path.join(FIXTURE_DIR, "projects", randomUUID());
  const subagentsDir = path.join(proj, sessionId, "subagents");
  mkdirSync(subagentsDir, { recursive: true });
  return { taskId, runId, jsonlPath: path.join(proj, `${sessionId}.jsonl`), subagentsDir, now };
}

/** One claude-shaped sidechain assistant line (no trailing newline). */
function sidechainLine(uuid: string, text: string): string {
  return JSON.stringify({
    type: "assistant", isSidechain: true, uuid,
    message: { role: "assistant", stop_reason: null, content: [{ type: "text", text }] },
  });
}

/** `count` lines `<prefix>-<n>`, each newline-terminated, with varying lengths
 *  and multi-byte text so chunk boundaries land mid-line and mid-character. */
function sidechainLines(prefix: string, count: number, start = 0): string {
  const out: string[] = [];
  for (let n = start; n < start + count; n++) {
    out.push(sidechainLine(`${prefix}-${n}`, `line ${n} ${"é日本語🙂".repeat(n % 7)} ${"x".repeat((n * 37) % 120)}`));
  }
  return out.join("\n") + "\n";
}

async function subagentEvents(taskId: string, subagentId: string): Promise<{ line_uuid: string | null; data: string }[]> {
  const { db } = await import("./db.ts");
  return db.query<{ line_uuid: string | null; data: string }, [string, string]>(
    `SELECT e.line_uuid, e.data FROM run_events e JOIN runs r ON r.id = e.run_id
     WHERE r.task_id = ? AND e.subagent_id = ? ORDER BY e.id`,
  ).all(taskId, subagentId);
}

/** Every expected uuid present exactly once, nothing else, no mangled text. */
async function expectExactlyOnce(taskId: string, subagentId: string, expected: string[]): Promise<void> {
  const rows = await subagentEvents(taskId, subagentId);
  expect(rows.map((r) => r.line_uuid)).toEqual(expected);
  for (const r of rows) expect(r.data.includes("�")).toBe(false);
}

function uuids(prefix: string, count: number, start = 0): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}-${start + i}`);
}

/** True when `p` has already resolved (microtasks drained, then one loop turn). */
async function isResolved(p: Promise<unknown>): Promise<boolean> {
  return Promise.race([
    p.then(() => true, () => true),
    new Promise<boolean>((resolve) => setImmediate(() => resolve(false))),
  ]);
}

/** Run `sample` once per loop turn until `p` resolves (the cooperative job
 *  yields with `setImmediate`, so this interleaves with its slices). */
async function sampleUntil(p: Promise<unknown>, sample: () => void | Promise<void>): Promise<void> {
  while (!(await isResolved(p))) await sample();
}

test("manual mode: a transcript spanning many chunks is ingested exactly once — boundary-straddling lines, cut multi-byte characters, a line longer than a chunk", async () => {
  const { attachSubagentWatcher, __forTest } = await import("./claude-subagents.ts");
  __forTest.setReadChunkBytes(CHUNK);
  const { taskId, jsonlPath, subagentsDir } = await seed();
  const agentId = "c1aaaaaaaaaa";
  const file = path.join(subagentsDir, `agent-${agentId}.jsonl`);
  const huge = sidechainLine("c1-huge", `big ${"日本語".repeat(2000)} end`); // ≈18 KB, 60× the chunk
  writeFileSync(file, sidechainLines("c1", 40) + huge + "\n" + sidechainLines("c1", 10, 40));
  expect(huge.length).toBeGreaterThan(CHUNK * 10);

  const w = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
  w.pump(Date.now());
  await expectExactlyOnce(taskId, agentId, [...uuids("c1", 40), "c1-huge", ...uuids("c1", 10, 40)]);
  const hugeRow = (await subagentEvents(taskId, agentId)).find((r) => r.line_uuid === "c1-huge")!;
  expect(hugeRow.data.includes("日本語".repeat(2000))).toBe(true);

  // Steady state: a partial trailing line (no newline yet, longer than a chunk,
  // cut mid-character) is left alone, and completed later without duplicating
  // anything or mangling the character.
  const tailBytes = Buffer.from(sidechainLine("c1-tail", `tail ${"🙂".repeat(400)}`) + "\n", "utf8");
  const cut = 1001; // inside a 4-byte emoji (the JSON prefix is ASCII, then 4-byte runs)
  expect((tailBytes[cut]! & 0xc0) === 0x80).toBe(true); // a UTF-8 continuation byte
  appendFileSync(file, sidechainLines("c1", 30, 50));
  appendFileSync(file, tailBytes.subarray(0, cut));
  w.pump(Date.now());
  await expectExactlyOnce(taskId, agentId, [...uuids("c1", 40), "c1-huge", ...uuids("c1", 40, 40)]);
  appendFileSync(file, tailBytes.subarray(cut));
  w.pump(Date.now());
  await expectExactlyOnce(taskId, agentId, [...uuids("c1", 40), "c1-huge", ...uuids("c1", 40, 40), "c1-tail"]);
  w.detach();
});

test("manual mode: a transcript that is one single line longer than a chunk is ingested", async () => {
  const { attachSubagentWatcher, __forTest } = await import("./claude-subagents.ts");
  __forTest.setReadChunkBytes(CHUNK);
  const { taskId, jsonlPath, subagentsDir } = await seed();
  const agentId = "c2bbbbbbbbbb";
  writeFileSync(path.join(subagentsDir, `agent-${agentId}.jsonl`), sidechainLine("c2-only", "z".repeat(50_000)) + "\n");

  const w = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
  w.pump(Date.now());
  await expectExactlyOnce(taskId, agentId, ["c2-only"]);
  w.detach();
});

test("production mode: the first cycle yields mid-file (one chunk per slice) and still ingests every line exactly once", async () => {
  const { attachSubagentWatcher, __forTest } = await import("./claude-subagents.ts");
  __forTest.setReadChunkBytes(CHUNK);
  __forTest.setJobSliceMs(0);
  const { taskId, jsonlPath, subagentsDir } = await seed();
  const agentId = "c3cccccccccc";
  const total = 120;
  writeFileSync(path.join(subagentsDir, `agent-${agentId}.jsonl`), sidechainLines("c3", total));

  const w = attachSubagentWatcher({ taskId, jsonlPath });
  const seen = new Set<number>();
  await sampleUntil(w.settled, async () => {
    seen.add((await subagentEvents(taskId, agentId)).length);
  });
  // Partial counts observed between slices: the file was NOT processed in the
  // single step it took before reads were chunked (which would only ever
  // show 0 and then `total`).
  const partial = [...seen].filter((c) => c > 0 && c < total);
  expect(partial.length).toBeGreaterThan(5);
  await expectExactlyOnce(taskId, agentId, uuids("c3", total));
  w.detach();
});

test("production mode: a transcript deleted mid-drain never throws out of the first cycle, and the next file is still ingested", async () => {
  const { attachSubagentWatcher, __forTest } = await import("./claude-subagents.ts");
  const { subagents } = await import("./db.ts");
  __forTest.setReadChunkBytes(CHUNK);
  __forTest.setJobSliceMs(0);
  const { taskId, runId, jsonlPath, subagentsDir, now } = await seed();

  // Rehydrated rows are tailed in `listForTask` (started_at) order: the big
  // file first, the small one after it.
  const bigId = "c4dddddddddd";
  const smallId = "c4eeeeeeeeee";
  const bigFile = path.join(subagentsDir, `agent-${bigId}.jsonl`);
  const smallFile = path.join(subagentsDir, `agent-${smallId}.jsonl`);
  writeFileSync(bigFile, sidechainLines("c4big", 200));
  writeFileSync(smallFile, sidechainLines("c4small", 5));
  const row = (id: string, sourcePath: string, i: number) => ({
    id, taskId, runId, parentKind: "subagent" as const, agentType: "general-purpose",
    description: id, spawnDepth: 1, sourcePath, toolUseId: null,
    status: "completed" as const, startedAt: now - 10_000 + i, endedAt: now - 5_000,
  });
  subagents.insertIfAbsent(row(bigId, bigFile, 0));
  subagents.insertIfAbsent(row(smallId, smallFile, 1));

  const w = attachSubagentWatcher({ taskId, jsonlPath });
  let deletedAt = -1;
  await sampleUntil(w.settled, async () => {
    if (deletedAt !== -1) return;
    const n = (await subagentEvents(taskId, bigId)).length;
    if (n > 0) { unlinkSync(bigFile); deletedAt = n; }
  });
  expect(deletedAt).toBeGreaterThan(0);
  expect(deletedAt).toBeLessThan(200);
  // The drain stopped where the file vanished — no throw, no duplicates…
  const big = await subagentEvents(taskId, bigId);
  expect(big.length).toBeLessThan(200);
  expect(new Set(big.map((r) => r.line_uuid)).size).toBe(big.length);
  // …and the cycle carried on to the next file.
  await expectExactlyOnce(taskId, smallId, uuids("c4small", 5));
  w.detach();
});

/** A main-session `user` line carrying the `tool_result` for `toolUseId`,
 *  padded with `pad` characters of result text. */
function toolResultLine(toolUseId: string, pad: number): string {
  return JSON.stringify({
    type: "user",
    uuid: `main-${randomUUID()}`,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: `done ${"r".repeat(pad)}` }] },
  });
}

function mainFiller(count: number): string {
  const out: string[] = [];
  for (let n = 0; n < count; n++) {
    out.push(JSON.stringify({ type: "assistant", uuid: `fill-${n}`, message: { role: "assistant", content: [{ type: "text", text: `filler ${n} ${"ü".repeat(n % 9)}` }] } }));
  }
  return out.join("\n") + "\n";
}

test("production mode: the main-JSONL scan reads chunk by chunk — it settles tool_results past chunk boundaries, inside an over-chunk line, and in bytes written after its first chunk was read", async () => {
  const { attachSubagentWatcher, __forTest } = await import("./claude-subagents.ts");
  const { subagents } = await import("./db.ts");
  __forTest.setReadChunkBytes(CHUNK);
  __forTest.setJobSliceMs(0);
  const { taskId, runId, jsonlPath, subagentsDir, now } = await seed();

  const ids = { a: "c5aaaaaaaaaa", b: "c5bbbbbbbbbb", c: "c5cccccccccc" };
  const toolUse = { a: "toolu_c5a", b: "toolu_c5b", c: "toolu_c5c" };
  let i = 0;
  for (const k of ["a", "b", "c"] as const) {
    subagents.insertIfAbsent({
      id: ids[k], taskId, runId, parentKind: "subagent", agentType: "general-purpose",
      description: k, spawnDepth: 1, sourcePath: path.join(subagentsDir, `agent-${ids[k]}.jsonl`),
      toolUseId: toolUse[k], status: "running", startedAt: now - 10_000 + i++, endedAt: null,
    });
  }

  // A's receipt sits in the first chunk; C's is one line ~20 chunks long in
  // the middle; B's slot at the very end is a same-length placeholder that the
  // test overwrites only after A has settled, i.e. after the scan read its
  // first chunk. A scan that read the file in one go would never see it.
  const bLine = toolResultLine(toolUse.b, 40);
  const placeholder = JSON.stringify({ type: "assistant", uuid: "placeholder", pad: "" });
  const paddedPlaceholder = placeholder.slice(0, -2) + "p".repeat(bLine.length - placeholder.length) + '"}';
  expect(paddedPlaceholder.length).toBe(bLine.length);
  const head = toolResultLine(toolUse.a, 10) + "\n" + mainFiller(60);
  const cLine = toolResultLine(toolUse.c, CHUNK * 20);
  const body = head + cLine + "\n" + mainFiller(60);
  writeFileSync(jsonlPath, body + paddedPlaceholder + "\n");

  const w = attachSubagentWatcher({ taskId, jsonlPath });
  let patched = false;
  await sampleUntil(w.settled, () => {
    if (!patched && subagents.get(ids.a)!.status === "completed") {
      // In place, same length — the file size never changes.
      const fd = openSync(jsonlPath, "r+");
      try { writeSync(fd, bLine, Buffer.byteLength(body, "utf8"), "utf8"); } finally { closeSync(fd); }
      patched = true;
      expect(subagents.get(ids.b)!.status).toBe("running");
    }
  });
  expect(patched).toBe(true);
  expect(subagents.get(ids.a)!.status).toBe("completed");
  expect(subagents.get(ids.c)!.status).toBe("completed");
  expect(subagents.get(ids.b)!.status).toBe("completed");
  w.detach();
});
