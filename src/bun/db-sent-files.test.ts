import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { SentFileEntry, Task } from "../shared/types.ts";
import { rmTestDataDir } from "./test-data-dir.ts";

// Top-level: db.ts captures AGETOR_DATA_DIR at first import — see the same
// convention repeated across every sibling *.test.ts that imports db.ts
// (task-unread.test.ts, task-events.test.ts, …). A beforeAll would race with
// whichever test file's import wins the module-cache race in `bun test`'s
// single process.
const dataDir = mkdtempSync(path.join(tmpdir(), "agetor-db-sent-files-"));
process.env.AGETOR_DATA_DIR = dataDir;

let db: typeof import("./db.ts").db;
let tasks: typeof import("./db.ts").tasks;
let runs: typeof import("./db.ts").runs;

beforeAll(async () => {
  ({ db, tasks, runs } = await import("./db.ts"));
});

afterAll(() => {
  rmTestDataDir(dataDir);
});

// Minimal hand-built Task fixture — mirrors task-unread.test.ts's
// makeTaskRow. `sentFiles`/`todoProgress`/`unread` are deliberately omitted:
// all are optional, server-managed fields that `db.ts` always populates on
// read (see their doc comments in shared/types.ts).
function makeTaskRow(taskId: string): Task {
  return {
    id: taskId,
    title: "t",
    prompt: "p",
    agent: "claude-code",
    workdir: "/tmp",
    isolation: "none",
    taskType: "task",
    branch: null,
    branchSource: "created",
    worktreePath: null,
    baseRef: null,
    prUrl: null,
    mode: null,
    model: null,
    effort: null,
    fast: false,
    maxMode: false,
    references: [],
    backlog: [],
    plans: [],
    draft: null,
    column: "ready",
    runId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    hasOpenableRun: false,
    pendingInteractionCount: 0,
    openTerminalCount: 0,
    archivedAt: null,
  };
}

function makeRun(taskId: string): string {
  const runId = randomUUID();
  runs.insert({
    id: runId,
    taskId,
    agent: "claude-code",
    status: "running",
    startedAt: Date.now(),
    endedAt: null,
    exitCode: null,
    tmuxSession: "agetor-test-sent-files",
    claudeSessionId: null,
    codexSessionId: null,
    cursorSessionId: null,
    geminiSessionId: null,
    fxSessionId: null,
  });
  return runId;
}

function sentFileRow(taskId: string) {
  return db
    .query<{ sent_files: string | null }, [string]>(`SELECT sent_files FROM tasks WHERE id = ?`)
    .get(taskId);
}

function entry(overrides: Partial<SentFileEntry> & { path: string; sentAt: number; runId: string }): SentFileEntry {
  return {
    size: null,
    mediaType: null,
    isImage: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Migration 050 recorded.
// ---------------------------------------------------------------------------

test("migration 050_sent_files is recorded in _migrations", () => {
  const row = db
    .query<{ id: string }, [string]>(`SELECT id FROM _migrations WHERE id = ?`)
    .get("050_sent_files");
  expect(row?.id).toBe("050_sent_files");
});

// ---------------------------------------------------------------------------
// 2. Fresh task has sentFiles === null.
// ---------------------------------------------------------------------------

test("a fresh task has sentFiles === null", () => {
  const taskId = randomUUID();
  const inserted = tasks.insert(makeTaskRow(taskId));
  try {
    expect(inserted.sentFiles).toBeNull();
    expect(tasks.get(taskId)?.sentFiles).toBeNull();
    expect(sentFileRow(taskId)?.sent_files).toBeNull();
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

// ---------------------------------------------------------------------------
// 3. tasks.mergeSentFiles round-trips, dedupes by path (latest sentAt wins
//    within one incoming batch), and leaves updated_at byte-identical.
// ---------------------------------------------------------------------------

test("mergeSentFiles round-trips through tasks.get(...).sentFiles, dedupes by path with latest sentAt winning, and never bumps updatedAt", async () => {
  const taskId = randomUUID();
  const inserted = tasks.insert(makeTaskRow(taskId));
  const originalUpdatedAt = inserted.updatedAt;
  const runId = makeRun(taskId);
  try {
    // Two distinct files land in one delivery.
    const first = tasks.mergeSentFiles(taskId, [
      entry({ path: "/tmp/a.png", size: 100, mediaType: "image/png", isImage: true, sentAt: 1000, runId }),
      entry({ path: "/tmp/b.md", size: 42, mediaType: "text/markdown", isImage: false, sentAt: 1001, runId }),
    ]);
    expect(first?.sentFiles).toEqual([
      entry({ path: "/tmp/a.png", size: 100, mediaType: "image/png", isImage: true, sentAt: 1000, runId }),
      entry({ path: "/tmp/b.md", size: 42, mediaType: "text/markdown", isImage: false, sentAt: 1001, runId }),
    ]);
    expect(tasks.get(taskId)?.sentFiles).toEqual(first?.sentFiles ?? null);

    // A second batch redelivers a.png (dedupe-by-path with the SAME incoming
    // batch also carrying two entries for the same path — the later sentAt
    // one must win) and adds a brand-new file.
    const second = tasks.mergeSentFiles(taskId, [
      entry({ path: "/tmp/a.png", size: 999, mediaType: "image/png", isImage: true, sentAt: 2000, runId }),
      entry({ path: "/tmp/a.png", size: 111, mediaType: "image/png", isImage: true, sentAt: 3000, runId }),
      entry({ path: "/tmp/c.txt", size: 7, mediaType: "text/plain", isImage: false, sentAt: 2500, runId }),
    ]);
    const byPath = new Map((second?.sentFiles ?? []).map((e) => [e.path, e]));
    // a.png: the latest-sentAt entry from the incoming batch (3000, size 111)
    // wins over both the earlier incoming duplicate and the original entry.
    expect(byPath.get("/tmp/a.png")).toEqual(
      entry({ path: "/tmp/a.png", size: 111, mediaType: "image/png", isImage: true, sentAt: 3000, runId }),
    );
    // b.md survives untouched from the first merge.
    expect(byPath.get("/tmp/b.md")).toEqual(
      entry({ path: "/tmp/b.md", size: 42, mediaType: "text/markdown", isImage: false, sentAt: 1001, runId }),
    );
    // c.txt is the newly added file.
    expect(byPath.get("/tmp/c.txt")).toEqual(
      entry({ path: "/tmp/c.txt", size: 7, mediaType: "text/plain", isImage: false, sentAt: 2500, runId }),
    );
    expect(second?.sentFiles?.length).toBe(3);

    // Sorted by sentAt ascending (mergeSentFiles's documented contract).
    const sentAts = (second?.sentFiles ?? []).map((e) => e.sentAt);
    expect(sentAts).toEqual([...sentAts].sort((a, b) => a - b));

    // Round-trips identically via a fresh tasks.get.
    expect(tasks.get(taskId)?.sentFiles).toEqual(second?.sentFiles ?? null);

    // Never bumps updated_at — server-managed delivery state, not a task
    // mutation (same rationale as markSeen/markUnread/noteAssistantEvent).
    await new Promise((r) => setTimeout(r, 5));
    expect(tasks.get(taskId)?.updatedAt).toBe(originalUpdatedAt);
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

test("mergeSentFiles with an empty incoming array is a no-op that still returns the current Task", () => {
  const taskId = randomUUID();
  tasks.insert(makeTaskRow(taskId));
  const runId = makeRun(taskId);
  try {
    tasks.mergeSentFiles(taskId, [entry({ path: "/tmp/a.png", sentAt: 1, runId })]);
    const before = tasks.get(taskId)?.sentFiles;

    const result = tasks.mergeSentFiles(taskId, []);
    expect(result?.sentFiles).toEqual(before ?? null);
    expect(tasks.get(taskId)?.sentFiles).toEqual(before ?? null);
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

test("mergeSentFiles returns null for an unknown task id", () => {
  expect(tasks.mergeSentFiles("does-not-exist", [entry({ path: "/tmp/a.png", sentAt: 1, runId: randomUUID() })])).toBeNull();
});

// ---------------------------------------------------------------------------
// 4. A generic tasks.update on an unrelated field leaves sentFiles intact.
// ---------------------------------------------------------------------------

test("a generic tasks.update (e.g. title change) does not clobber sentFiles", () => {
  const taskId = randomUUID();
  tasks.insert(makeTaskRow(taskId));
  const runId = makeRun(taskId);
  try {
    tasks.mergeSentFiles(taskId, [entry({ path: "/tmp/a.png", size: 10, mediaType: "image/png", isImage: true, sentAt: 1, runId })]);
    const before = tasks.get(taskId)?.sentFiles;
    expect(before?.length).toBe(1);

    const updated = tasks.update(taskId, { title: "renamed" });
    expect(updated?.title).toBe("renamed");
    expect(updated?.sentFiles).toEqual(before ?? null);
    expect(tasks.get(taskId)?.sentFiles).toEqual(before ?? null);
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

// ---------------------------------------------------------------------------
// 5. parseSentFiles bounds — exercised indirectly through tasks.get, the
//    same idiom orchestrator-claude-plan.test.ts uses for parseTodoProgress
//    (parseSentFiles isn't exported; a direct raw-column UPDATE + read-back
//    is the seam).
// ---------------------------------------------------------------------------

test("garbage/malformed sent_files JSON falls back to null or drops only the malformed items", () => {
  const taskId = randomUUID();
  tasks.insert(makeTaskRow(taskId));
  const runId = randomUUID();
  try {
    // Malformed JSON entirely.
    db.run(`UPDATE tasks SET sent_files = ? WHERE id = ?`, ["not json at all {{{", taskId]);
    expect(tasks.get(taskId)?.sentFiles).toBeNull();

    // Valid JSON, but not an array.
    db.run(`UPDATE tasks SET sent_files = ? WHERE id = ?`, [JSON.stringify({ path: "/tmp/a.png" }), taskId]);
    expect(tasks.get(taskId)?.sentFiles).toBeNull();

    // Empty string.
    db.run(`UPDATE tasks SET sent_files = ? WHERE id = ?`, ["", taskId]);
    expect(tasks.get(taskId)?.sentFiles).toBeNull();

    // An array of malformed items only — every item dropped, but the
    // well-formed *array* still yields [] rather than null.
    db.run(
      `UPDATE tasks SET sent_files = ? WHERE id = ?`,
      [
        JSON.stringify([
          { path: "", sentAt: 1, runId }, // empty path
          { path: "/tmp/a.png", sentAt: "not a number", runId }, // bad sentAt
          { path: "/tmp/b.png", sentAt: 1 }, // missing runId
          { path: 123, sentAt: 1, runId }, // non-string path
          "just a string", // not even an object
          null,
        ]),
        taskId,
      ],
    );
    expect(tasks.get(taskId)?.sentFiles).toEqual([]);

    // A mix of one well-formed entry (with sparse optional fields defaulting
    // to null) alongside malformed ones — only the good one survives.
    db.run(
      `UPDATE tasks SET sent_files = ? WHERE id = ?`,
      [
        JSON.stringify([
          { path: "/tmp/good.png", sentAt: 500, runId, size: -5, mediaType: 42, isImage: "yes" },
          { path: "", sentAt: 1, runId },
        ]),
        taskId,
      ],
    );
    expect(tasks.get(taskId)?.sentFiles).toEqual([
      { path: "/tmp/good.png", sentAt: 500, runId, size: null, mediaType: null, isImage: null },
    ]);
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

// ---------------------------------------------------------------------------
// 6. runs.findToolUseEvent.
// ---------------------------------------------------------------------------

test("findToolUseEvent finds an appended tool_use event by id, returns null for an unknown id, and returns null for a hostile id containing %", () => {
  const taskId = randomUUID();
  tasks.insert(makeTaskRow(taskId));
  const runId = makeRun(taskId);
  try {
    const toolUseData = JSON.stringify({
      id: "toolu_sent_files_1",
      name: "SendUserFile",
      input: { files: ["/tmp/a.png"], caption: null, status: "normal", display: null },
      serverSide: false,
    });
    runs.appendEvent(runId, "tool_use", toolUseData, "line-tool-use-1");
    // A second, unrelated tool_use on the same run — makes sure the LIMIT 5 /
    // JSON-confirm path picks the right row rather than the most recent one.
    runs.appendEvent(
      runId,
      "tool_use",
      JSON.stringify({ id: "toolu_unrelated", name: "Bash", input: {}, serverSide: false }),
      "line-tool-use-2",
    );

    const found = runs.findToolUseEvent(runId, "toolu_sent_files_1");
    expect(found).not.toBeNull();
    expect(found?.data).toBe(toolUseData);
    expect(typeof found?.id).toBe("number");

    expect(runs.findToolUseEvent(runId, "toolu_does_not_exist")).toBeNull();

    // Hostile id containing a SQL LIKE wildcard — rejected up front, never
    // even queried (would otherwise widen the match).
    expect(runs.findToolUseEvent(runId, "toolu_%")).toBeNull();
    expect(runs.findToolUseEvent(runId, 'toolu_"injected')).toBeNull();
    expect(runs.findToolUseEvent(runId, "toolu_under_score")).toBeNull();
    expect(runs.findToolUseEvent(runId, "toolu_back\\slash")).toBeNull();
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});
