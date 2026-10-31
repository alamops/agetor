import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { rmTestDataDir } from "./test-data-dir.ts";

const dataDir = mkdtempSync(path.join(tmpdir(), "agetor-db-cursor-ask-"));
process.env.AGETOR_DATA_DIR = dataDir;

let insertCursorAsk: typeof import("./db.ts").insertCursorAsk;
let resolveCursorAsk: typeof import("./db.ts").resolveCursorAsk;
let listOpenCursorAsks: typeof import("./db.ts").listOpenCursorAsks;
let db: typeof import("./db.ts").db;

beforeAll(async () => {
  ({ db, insertCursorAsk, resolveCursorAsk, listOpenCursorAsks } = await import("./db.ts"));
});

afterAll(() => {
  rmTestDataDir(dataDir);
});

test("insert once, resolve, and list only unresolved rows", () => {
  insertCursorAsk({
    taskId: "t1",
    toolCallId: "call-1",
    runId: "r1",
    payload: { title: "Pick", questions: [{ id: "q", prompt: "Which?" }] },
    createdAt: 10,
  });
  insertCursorAsk({
    taskId: "t1",
    toolCallId: "call-2",
    runId: "r1",
    payload: { questions: [] },
    createdAt: 20,
  });
  const openFor = (taskId: string) => listOpenCursorAsks().filter((row) => row.taskId === taskId);
  expect(openFor("t1").map((row) => row.toolCallId)).toEqual(["call-1", "call-2"]);
  resolveCursorAsk("t1", "call-1", "answered");
  const open = openFor("t1");
  expect(open.map((row) => row.toolCallId)).toEqual(["call-2"]);
  expect(open[0]?.outcome).toBeNull();
});

test("a second insert does not clobber a resolved row", () => {
  insertCursorAsk({
    taskId: "t2",
    toolCallId: "call-kept",
    runId: "r-old",
    payload: { questions: [{ id: "q", prompt: "keep me" }] },
    createdAt: 1,
  });
  resolveCursorAsk("t2", "call-kept", "skipped");
  insertCursorAsk({
    taskId: "t2",
    toolCallId: "call-kept",
    runId: "r-new",
    payload: { questions: [{ id: "q", prompt: "replaced" }] },
    createdAt: 99,
  });
  const row = db.query<{ run_id: string; outcome: string; payload_json: string }, [string, string]>(
    `SELECT run_id, outcome, payload_json FROM cursor_asks WHERE task_id = ? AND tool_call_id = ?`,
  ).get("t2", "call-kept");
  expect(row?.run_id).toBe("r-old");
  expect(row?.outcome).toBe("skipped");
  expect(row?.payload_json).toContain("keep me");
  expect(listOpenCursorAsks().some((open) => open.toolCallId === "call-kept")).toBe(false);
});
