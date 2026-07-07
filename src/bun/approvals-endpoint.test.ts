import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Top-level: db.ts captures AGETOR_DATA_DIR at first import. Set both the
// data dir and an isolated API port BEFORE any sibling test in the same
// process imports server.ts / db.ts.
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-approvals-endpoint-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_API_PORT = "4411";

let server: { stop: () => void } | null = null;
let token: string;
const url = (p: string) => `http://127.0.0.1:4411${p}`;

beforeAll(async () => {
  await import("./db.ts");
  const { startApiServer, API_TOKEN } = await import("./server.ts");
  server = startApiServer() as unknown as { stop: () => void };
  token = API_TOKEN;
});

afterAll(() => {
  server?.stop?.();
});

/* ── /ask-questions scraper-sourced answering (no PreToolUse hook) ──────── */

async function seedScrapedAskQuestions(args: {
  taskId: string;
  questions: { question: string; multiSelect?: boolean; options: { label: string }[] }[];
}): Promise<{ id: string }> {
  const cwd = mkdtempSync(path.join(tmpdir(), `agetor-askq-${args.taskId}-`));
  const { tasks } = await import("./db.ts");
  tasks.insert({
    id: args.taskId, title: args.taskId, prompt: "", column: "running",
    agent: "claude-code", workdir: cwd, isolation: "none", taskType: "task",
    branch: null, worktreePath: null, baseRef: null, mode: null,
    model: "opus-4.7", effort: null, references: [], backlog: [], runId: "run-askq",
    createdAt: Date.now(), updatedAt: Date.now(), hasOpenableRun: false,
    pendingInteractionCount: 0, openTerminalCount: 0, archivedAt: null,
  });
  const { registerScrapedAskQuestions } = await import("./interactions.ts");
  const req = registerScrapedAskQuestions({
    taskId: args.taskId, runId: "run-askq", questions: args.questions, fingerprint: `fp-${args.taskId}`,
  });
  return { id: req.id };
}

test("POST /ask-questions — scraper-sourced drive answer resolves the card", async () => {
  const { __testing } = await import("./interactions.ts");
  __testing.reset();
  const { id } = await seedScrapedAskQuestions({
    taskId: "t-askq-drive",
    questions: [{ question: "Pick", multiSelect: false, options: [{ label: "Red" }, { label: "Green" }] }],
  });
  const res = await fetch(url(`/ask-questions/${id}/answer`), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ answers: [{ selected: ["Green"] }] }),
  });
  expect(res.status).toBe(200);
  // No live tmux session in the test → the keystrokes can't actually land,
  // but the route must still drop the card (it resolves unconditionally).
  const { listPendingForTask } = await import("./interactions.ts");
  expect(listPendingForTask("t-askq-drive")).toHaveLength(0);
});

test("POST /ask-questions — scraper-sourced custom-text answer resolves the card (message path)", async () => {
  const { __testing } = await import("./interactions.ts");
  __testing.reset();
  const { id } = await seedScrapedAskQuestions({
    taskId: "t-askq-msg",
    questions: [{ question: "Pick", multiSelect: false, options: [{ label: "Red" }] }],
  });
  const res = await fetch(url(`/ask-questions/${id}/answer`), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ answers: [{ selected: [], custom: "Magenta" }] }),
  });
  expect(res.status).toBe(200);
  const { listPendingForTask } = await import("./interactions.ts");
  expect(listPendingForTask("t-askq-msg")).toHaveLength(0);
});

test("POST /ask-questions — unknown id returns ok:false (no hook-sourced cards exist)", async () => {
  // There is no PreToolUse hook any more, so the only ask cards are
  // scraper-sourced. An id that matches no pending scraper card has nothing
  // to drive — the route reports ok:false rather than blocking on a promise.
  const { __testing } = await import("./interactions.ts");
  __testing.reset();
  const res = await fetch(url(`/ask-questions/does-not-exist/answer`), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ answers: [{ selected: ["B"] }] }),
  });
  expect(res.status).toBe(200);
  expect((await res.json()).ok).toBe(false);
});
