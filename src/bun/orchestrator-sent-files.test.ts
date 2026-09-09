import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { GlobalEvent } from "../shared/types.ts";
import { rmTestDataDir } from "./test-data-dir.ts";

// db.ts captures AGETOR_DATA_DIR at first import — set before any import of
// ./db.ts or ./orchestrator.ts (same convention as orchestrator-claude-plan.test.ts).
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-sent-files-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
// Drive claude through the in-process fake (no tmux, no real CLI).
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_TMUX_BIN = "/bin/echo"; // tmux probe in agent-status passes
process.env.AGETOR_CLAUDE_ARGS = "";
// Unique port, distinct from every other *.test.ts file's AGETOR_API_PORT —
// no test here makes an HTTP call, but starting the API server mirrors the
// sibling orchestrator-claude-plan.test.ts setup idiom exactly.
process.env.AGETOR_API_PORT = "4521";

let server: { stop: () => void };
let createTask: typeof import("./orchestrator.ts").createTask;
let startTask: typeof import("./orchestrator.ts").startTask;
let __dispatchChunkForTest: typeof import("./orchestrator.ts").__dispatchChunkForTest;
let subscribeGlobal: typeof import("./orchestrator.ts").subscribeGlobal;
let tasks: typeof import("./db.ts").tasks;
let db: typeof import("./db.ts").db;
let runs: typeof import("./db.ts").runs;

beforeAll(async () => {
  ({ createTask, startTask, __dispatchChunkForTest, subscribeGlobal } = await import("./orchestrator.ts"));
  ({ tasks, db, runs } = await import("./db.ts"));
  const { startApiServer } = await import("./server.ts");
  server = startApiServer() as unknown as { stop: () => void };
});

afterAll(() => {
  server?.stop?.();
  rmTestDataDir(DATA_DIR);
});

async function settle(ms = 60) {
  await new Promise((r) => setTimeout(r, ms));
}

/** A fresh scratch dir per task — never a real repo (isolation: "none" runs
 *  directly in workdir). */
function scratchWorkdir(): string {
  return mkdtempSync(path.join(tmpdir(), "agetor-sent-files-wd-"));
}

async function newClaudeTask(): Promise<{ id: string; workdir: string }> {
  const workdir = scratchWorkdir();
  const created = await createTask({
    title: "sent-files task",
    prompt: "do some work",
    agent: "claude-code",
    workdir,
    isolation: "none",
    taskType: "task",
  });
  if ("error" in created) throw new Error(created.error);
  return { id: created.task.id, workdir };
}

/** Starts the task and returns its fresh runId — the fake claude driver
 *  (AGETOR_CLAUDE_DRIVER=fake) resolves its own canned turn on a short timer
 *  regardless, but every test here dispatches its OWN synthetic chunks
 *  synchronously via `__dispatchChunkForTest`, so it doesn't need to wait on
 *  (or interact with) the fake driver's default response. */
async function startAndGetRunId(id: string): Promise<string> {
  const started = await startTask(id);
  if ("error" in started) throw new Error(started.error);
  if (!("runId" in started)) throw new Error("startTask did not return a runId");
  return started.runId;
}

function toolUse(id: string, name: string, input: unknown): string {
  return JSON.stringify({ id, name, input, serverSide: false });
}

interface FakeAttachment {
  path: string;
  size: number | null;
  isImage: boolean | null;
  mediaType: string | null;
}

function toolResult(
  toolUseId: string,
  content: string,
  isError = false,
  attachments?: FakeAttachment[],
): string {
  // Mirrors claude-tmux.ts's exact emission: `attachments` is present only
  // when non-empty — `JSON.stringify` drops the `undefined` key entirely, so
  // an unrelated tool's tool_result (no attachments field at all) round-trips
  // byte-identically through this helper too.
  return JSON.stringify({
    toolUseId,
    content,
    isError,
    attachments: attachments && attachments.length > 0 ? attachments : undefined,
  });
}

function collectFilesSentEvents(): { events: GlobalEvent[]; stop: () => void } {
  const events: GlobalEvent[] = [];
  const unsubscribe = subscribeGlobal((e) => {
    if (e.kind === "files-sent") events.push(e);
  });
  return { events, stop: unsubscribe };
}

// --- Sent-files detection: delivered pair ----------------------------------

test("a delivered SendUserFile tool_use/tool_result pair persists sentFiles sourced from attachments (relative path resolved under the task's workdir) and fires one files-sent event", async () => {
  const { id, workdir } = await newClaudeTask();
  const runId = await startAndGetRunId(id);
  const { events, stop } = collectFilesSentEvents();
  const before = tasks.get(id)!;

  __dispatchChunkForTest(
    runId,
    id,
    "claude-code",
    "tool_use",
    toolUse("toolu_s1", "SendUserFile", {
      files: ["/abs/a.png", "rel/b.md"],
      caption: "Two files",
      status: "proactive",
    }),
  );
  // Both requested files have a matching attachment here (an attachment can
  // itself carry a relative path — entries are sourced from attachments, so
  // this also exercises relative-path resolution on that source).
  __dispatchChunkForTest(
    runId,
    id,
    "claude-code",
    "tool_result",
    toolResult("toolu_s1", "2 files delivered to user.", false, [
      { path: "/abs/a.png", size: 10, isImage: true, mediaType: "image/png" },
      { path: "rel/b.md", size: 20, isImage: false, mediaType: "text/markdown" },
    ]),
  );
  stop();

  const task = tasks.get(id)!;
  expect(task.sentFiles?.length).toBe(2);
  const byPath = new Map((task.sentFiles ?? []).map((e) => [e.path, e]));

  const a = byPath.get("/abs/a.png");
  expect(a).toBeTruthy();
  expect(a?.size).toBe(10);
  expect(a?.isImage).toBe(true);
  expect(a?.mediaType).toBe("image/png");
  expect(a?.runId).toBe(runId);

  const resolvedB = path.resolve(workdir, "rel/b.md");
  const b = byPath.get(resolvedB);
  expect(b).toBeTruthy();
  expect(b?.size).toBe(20);
  expect(b?.mediaType).toBe("text/markdown");
  expect(b?.isImage).toBe(false);

  expect(events.length).toBe(1);
  expect(events[0]).toMatchObject({
    kind: "files-sent",
    taskId: id,
    runId,
    count: 2,
    caption: "Two files",
    proactive: true,
  });

  // Server-managed delivery state — never bumps updated_at (same rationale
  // as markSeen/markUnread/noteAssistantEvent).
  expect(task.updatedAt).toBe(before.updatedAt);

  await settle();
  db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
});

test("attachments are the authoritative delivered set: a request for 2 files whose attachments only confirm 1 persists 1 entry, count 1", async () => {
  const { id } = await newClaudeTask();
  const runId = await startAndGetRunId(id);
  const { events, stop } = collectFilesSentEvents();

  __dispatchChunkForTest(
    runId,
    id,
    "claude-code",
    "tool_use",
    toolUse("toolu_s1", "SendUserFile", { files: ["/abs/a.png", "/abs/b.md"], caption: null, status: null }),
  );
  __dispatchChunkForTest(
    runId,
    id,
    "claude-code",
    "tool_result",
    // claude's own toolUseResult.attachments only reports one of the two
    // requested paths — only that one should be persisted.
    toolResult("toolu_s1", "2 files delivered to user.", false, [
      { path: "/abs/a.png", size: 10, isImage: true, mediaType: "image/png" },
    ]),
  );
  stop();

  const task = tasks.get(id)!;
  expect(task.sentFiles?.length).toBe(1);
  expect(task.sentFiles?.[0]?.path).toBe("/abs/a.png");
  expect(task.sentFiles?.[0]?.size).toBe(10);

  expect(events.length).toBe(1);
  expect(events[0]).toMatchObject({ count: 1 });

  await settle();
  db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
});

// --- Fix 1: a declined/interrupted (non-error) result is not delivered ------

test("a non-error 'Declined' SendUserFile result (claude-tmux.ts's interrupt rewrite) persists nothing and fires no files-sent event", async () => {
  const { id } = await newClaudeTask();
  const runId = await startAndGetRunId(id);
  const { events, stop } = collectFilesSentEvents();

  __dispatchChunkForTest(
    runId,
    id,
    "claude-code",
    "tool_use",
    toolUse("toolu_s1", "SendUserFile", { files: ["/abs/a.png"], caption: null, status: null }),
  );
  __dispatchChunkForTest(
    runId,
    id,
    "claude-code",
    "tool_result",
    // isError: false — claude-tmux.ts rewrites an interrupted/declined
    // SendUserFile tool_result to a non-error result with exactly this text.
    toolResult("toolu_s1", "Declined — Claude is waiting for your direction.", false),
  );
  stop();

  expect(tasks.get(id)!.sentFiles).toBeNull();
  expect(events.length).toBe(0);

  await settle();
  db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
});

test("dispatching the same delivered pair a second time is idempotent — no duplicate sentFiles rows, though the event fires again", async () => {
  const { id } = await newClaudeTask();
  const runId = await startAndGetRunId(id);
  const { events, stop } = collectFilesSentEvents();

  const dispatchOnce = () => {
    __dispatchChunkForTest(
      runId,
      id,
      "claude-code",
      "tool_use",
      toolUse("toolu_s1", "SendUserFile", { files: ["/abs/a.png"], caption: null, status: "normal" }),
    );
    __dispatchChunkForTest(
      runId,
      id,
      "claude-code",
      "tool_result",
      toolResult("toolu_s1", "1 file delivered to user.", false),
    );
  };

  dispatchOnce();
  expect(tasks.get(id)!.sentFiles?.length).toBe(1);

  dispatchOnce();
  stop();

  expect(tasks.get(id)!.sentFiles?.length).toBe(1);
  expect(events.length).toBe(2);

  await settle();
  db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
});

// --- Errored result: nothing persisted, nothing fired -----------------------

test("an errored SendUserFile result persists nothing and fires no files-sent event", async () => {
  const { id } = await newClaudeTask();
  const runId = await startAndGetRunId(id);
  const { events, stop } = collectFilesSentEvents();

  __dispatchChunkForTest(
    runId,
    id,
    "claude-code",
    "tool_use",
    toolUse("toolu_s1", "SendUserFile", { files: ["/tmp/some-dir"], caption: null, status: null }),
  );
  __dispatchChunkForTest(
    runId,
    id,
    "claude-code",
    "tool_result",
    toolResult(
      "toolu_s1",
      '<tool_use_error>Attachment "/tmp/some-dir" is not a regular file.</tool_use_error>',
      true,
    ),
  );
  stop();

  expect(tasks.get(id)!.sentFiles).toBeNull();
  expect(events.length).toBe(0);

  await settle();
  db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
});

// --- Map-miss fallback: runs.findToolUseEvent -------------------------------

test("map-miss fallback: a tool_use appended straight to the DB (bypassing the handler entirely) still resolves via runs.findToolUseEvent when only its tool_result is dispatched", async () => {
  const { id, workdir } = await newClaudeTask();
  const runId = await startAndGetRunId(id);

  // Bypasses makeChunkHandler entirely, so the in-memory per-run stash never
  // sees this tool_use — simulating an agetor restart / reattach-replay that
  // dropped the stash between the tool_use and its tool_result.
  runs.appendEvent(
    runId,
    "tool_use",
    toolUse("toolu_fallback", "SendUserFile", { files: ["fallback.png"], caption: "Fallback", status: null }),
  );

  const { events, stop } = collectFilesSentEvents();
  __dispatchChunkForTest(
    runId,
    id,
    "claude-code",
    "tool_result",
    toolResult("toolu_fallback", "1 file delivered to user.", false),
  );
  stop();

  const task = tasks.get(id)!;
  expect(task.sentFiles?.length).toBe(1);
  expect(task.sentFiles?.[0]?.path).toBe(path.resolve(workdir, "fallback.png"));
  expect(events.length).toBe(1);
  expect(events[0]).toMatchObject({ count: 1, caption: "Fallback", proactive: false });

  await settle();
  db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
});

test("a tool_result whose text merely resembles a delivery confirmation, with no matching tool_use anywhere, is a no-op", async () => {
  const { id } = await newClaudeTask();
  const runId = await startAndGetRunId(id);
  const { events, stop } = collectFilesSentEvents();

  __dispatchChunkForTest(
    runId,
    id,
    "claude-code",
    "tool_result",
    toolResult("toolu_unrelated", "2 files delivered to user via some other mechanism.", false),
  );
  stop();

  expect(tasks.get(id)!.sentFiles).toBeNull();
  expect(events.length).toBe(0);

  await settle();
  db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
});

// --- Runs for every agent kind, not just claude-code ------------------------

test("sent-files detection is not gated on agent kind — a non-claude chunk shape still resolves", async () => {
  // Uses a claude-kind task purely as a convenient way to get a real run row
  // (the fake driver requires it, same trick orchestrator-claude-plan.test.ts
  // uses for its todo-progress kind-agnostic test), but dispatches the chunk
  // tagged as a different kind to prove detection itself doesn't branch on
  // `kind` — required for fx's synthetic SendUserFile pair to count.
  const { id } = await newClaudeTask();
  const runId = await startAndGetRunId(id);
  const { events, stop } = collectFilesSentEvents();

  __dispatchChunkForTest(
    runId,
    id,
    "fx",
    "tool_use",
    toolUse("call1:sent-files", "SendUserFile", { files: ["/abs/from-fx.png"], caption: null, status: "normal" }),
  );
  __dispatchChunkForTest(
    runId,
    id,
    "fx",
    "tool_result",
    toolResult("call1:sent-files", "1 file delivered to user.", false, [
      { path: "/abs/from-fx.png", size: 5, isImage: true, mediaType: "image/png" },
    ]),
  );
  stop();

  const task = tasks.get(id)!;
  expect(task.sentFiles?.length).toBe(1);
  expect(task.sentFiles?.[0]?.path).toBe("/abs/from-fx.png");
  expect(events.length).toBe(1);

  await settle();
  db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
});

// --- An unrelated chunk never touches sentFiles -----------------------------

test("an unrelated tool_use (no SendUserFile marker) does not touch sentFiles", async () => {
  const { id } = await newClaudeTask();
  const runId = await startAndGetRunId(id);

  __dispatchChunkForTest(runId, id, "claude-code", "tool_use", toolUse("toolu_1", "Read", { file_path: "/tmp/x" }));
  expect(tasks.get(id)!.sentFiles).toBeNull();

  await settle();
  db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
});
