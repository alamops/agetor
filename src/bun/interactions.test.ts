import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Top-level: db.ts captures AGETOR_DATA_DIR at first import. `beforeAll`
// would run AFTER any sibling test that already imported db.ts in this
// process, falling back to ~/.agetor and polluting the user's real db.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-int-"));

beforeEach(async () => {
  const { __testing } = await import("./interactions.ts");
  __testing.reset();
});

/** Insert a Task row pointing at a fresh temp directory so the
 *  pendingInteractionCount surfacing path has a real row to read. Returns
 *  the resolved cwd for assertions. */
async function makeTaskWithCwd(id: string): Promise<string> {
  const cwd = mkdtempSync(path.join(tmpdir(), `agetor-int-task-${id}-`));
  const { tasks } = await import("./db.ts");
  tasks.insert({
    id,
    title: id,
    prompt: "",
    column: "backlog",
    agent: "claude-code",
    workdir: cwd,
    isolation: "none",
    taskType: "task",
    branch: null,
    worktreePath: null,
    baseRef: null,
    mode: null,
    model: "opus-4.7",
    effort: null,
    references: [],
    runId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    hasOpenableRun: false,
    pendingInteractionCount: 0,
    openTerminalCount: 0,
    archivedAt: null,
  });
  return cwd;
}

/** Convenience wrapper so the generic-machinery tests below read cleanly —
 *  registers a tmux_prompt with a single Yes choice. */
async function makePrompt(taskId: string, runId: string, fingerprint: string) {
  const { registerTmuxPrompt } = await import("./interactions.ts");
  return registerTmuxPrompt({
    taskId, runId,
    paneText: "?", choices: [{ key: "1", label: "Yes" }], fingerprint,
  });
}

test("cancelPendingForTask resolves every pending interaction with the sentinel", async () => {
  const { cancelPendingForTask, __testing } = await import("./interactions.ts");
  const p = await makePrompt("tCancel", "r1", "fp-cancel");
  expect(__testing.tmuxPromptsSize()).toBe(1);

  cancelPendingForTask("tCancel", "bye");
  await expect(p.answer).resolves.toEqual({ key: "__cancelled__" });
  expect(__testing.tmuxPromptsSize()).toBe(0);
});

test("cancelPendingForTask leaves other tasks' interactions untouched", async () => {
  const { cancelPendingForTask, answerTmuxPrompt } = await import("./interactions.ts");
  const keep = await makePrompt("tA", "r1", "fp-keep");
  const drop = await makePrompt("tB", "r1", "fp-drop");
  cancelPendingForTask("tB", "stop");
  await expect(drop.answer).resolves.toEqual({ key: "__cancelled__" });
  // 'keep' still pending → answerable:
  expect(answerTmuxPrompt(keep.id, { key: "1" })).toBe(true);
  await expect(keep.answer).resolves.toEqual({ key: "1" });
});

test("listPendingForTask returns interactions in createdAt order", async () => {
  const { listPendingForTask } = await import("./interactions.ts");
  const q1 = await makePrompt("tList", "r1", "fp-1");
  await new Promise((r) => setTimeout(r, 5));
  const q2 = await makePrompt("tList", "r1", "fp-2");
  const pending = listPendingForTask("tList");
  expect(pending.map((p) => p.id)).toEqual([q1.id, q2.id]);
});

test("setBroadcaster receives newly registered interactions", async () => {
  const { setBroadcaster, registerScrapedAskQuestions } = await import("./interactions.ts");
  const seen: string[] = [];
  setBroadcaster((req) => {
    if (req.kind === "ask_questions") seen.push(`ask_questions:${req.questions.length}`);
    else if (req.kind === "tmux_prompt") seen.push(`tmux_prompt`);
  });
  registerScrapedAskQuestions({
    taskId: "tBroad", runId: "r1",
    questions: [{ question: "Which?", options: [{ label: "A" }] }],
    fingerprint: "fp-broad",
  });
  expect(seen.length).toBe(1);
  expect(seen[0]).toBe("ask_questions:1");
});

/* ── AskUserQuestion scraper-sourced ────────────────────────────────── */

test("registerScrapedAskQuestions broadcasts a scraper-sourced card and lists it as pending", async () => {
  const { registerScrapedAskQuestions, listPendingForTask, countPendingForTask, setBroadcaster } =
    await import("./interactions.ts");
  const seen: string[] = [];
  setBroadcaster((req) => seen.push(req.kind));
  const req = registerScrapedAskQuestions({
    taskId: "tS",
    runId: "rS",
    questions: [{ question: "Pick", options: [{ label: "A" }, { label: "B" }] }],
    fingerprint: "fp-1",
  });
  expect(req.source).toBe("scraper");
  expect(req.fingerprint).toBe("fp-1");
  expect(seen).toEqual(["ask_questions"]);
  expect(countPendingForTask("tS")).toBe(1);
  expect(listPendingForTask("tS").map((r) => r.id)).toContain(req.id);
});

test("getAskQuestionsById returns the request with its questions + source", async () => {
  const { registerScrapedAskQuestions, getAskQuestionsById } = await import("./interactions.ts");
  const req = registerScrapedAskQuestions({
    taskId: "tS2",
    runId: "rS2",
    questions: [{ question: "Pick", multiSelect: true, options: [{ label: "A" }] }],
    fingerprint: "fp-2",
  });
  const got = getAskQuestionsById(req.id);
  expect(got?.source).toBe("scraper");
  expect(got?.questions[0]!.question).toBe("Pick");
  expect(getAskQuestionsById("missing")).toBeNull();
});

test("findScrapedAskQuestionsByFingerprint locates the pending card (scraper dedup gate)", async () => {
  const { registerScrapedAskQuestions, findScrapedAskQuestionsByFingerprint } =
    await import("./interactions.ts");
  const req = registerScrapedAskQuestions({
    taskId: "tS3", runId: "rS3",
    questions: [{ question: "Q", options: [{ label: "A" }] }],
    fingerprint: "fp-3",
  });
  expect(findScrapedAskQuestionsByFingerprint("tS3", "fp-3")?.id).toBe(req.id);
  expect(findScrapedAskQuestionsByFingerprint("tS3", "other")).toBeNull();
  expect(findScrapedAskQuestionsByFingerprint("otherTask", "fp-3")).toBeNull();
});

test("activeAskQuestionsForTask powers the registration gate (don't double-register)", async () => {
  const { registerScrapedAskQuestions, activeAskQuestionsForTask } = await import("./interactions.ts");
  expect(activeAskQuestionsForTask("tS4")).toHaveLength(0);
  registerScrapedAskQuestions({
    taskId: "tS4", runId: "rS4",
    questions: [{ question: "Q", options: [{ label: "A" }] }],
    fingerprint: "fp-4",
  });
  expect(activeAskQuestionsForTask("tS4")).toHaveLength(1);
  // A different task's cards never leak into the gate.
  expect(activeAskQuestionsForTask("tS4-other")).toHaveLength(0);
});

test("resolveScrapedAskQuestions removes the card and broadcasts the resolution", async () => {
  const { registerScrapedAskQuestions, resolveScrapedAskQuestions, countPendingForTask, setResolvedBroadcaster } =
    await import("./interactions.ts");
  const resolved: string[] = [];
  setResolvedBroadcaster((r) => resolved.push(r.id));
  const req = registerScrapedAskQuestions({
    taskId: "tS5", runId: "rS5",
    questions: [{ question: "Q", options: [{ label: "A" }] }],
    fingerprint: "fp-5",
  });
  expect(resolveScrapedAskQuestions(req.id)).toBe(true);
  expect(countPendingForTask("tS5")).toBe(0);
  expect(resolved).toEqual([req.id]);
  // Idempotent: a second resolve is a no-op.
  expect(resolveScrapedAskQuestions(req.id)).toBe(false);
});

test("cancelPendingForTask also clears a scraper-sourced card (uniform teardown)", async () => {
  const { registerScrapedAskQuestions, cancelPendingForTask, countPendingForTask } =
    await import("./interactions.ts");
  registerScrapedAskQuestions({
    taskId: "tS6", runId: "rS6",
    questions: [{ question: "Q", options: [{ label: "A" }] }],
    fingerprint: "fp-6",
  });
  expect(countPendingForTask("tS6")).toBe(1);
  cancelPendingForTask("tS6", "cancelled");
  expect(countPendingForTask("tS6")).toBe(0);
});

test("cancelPendingForTask resolves ask_questions entries", async () => {
  const { registerScrapedAskQuestions, cancelPendingForTask, countPendingForTask } =
    await import("./interactions.ts");
  registerScrapedAskQuestions({
    taskId: "tC", runId: "rC",
    questions: [{ question: "?", options: [{ label: "A" }] }],
    fingerprint: "fp-c",
  });
  expect(countPendingForTask("tC")).toBe(1);
  cancelPendingForTask("tC", "cancelled by user");
  expect(countPendingForTask("tC")).toBe(0);
});

test("tasks.get / tasks.list expose pendingInteractionCount reflecting open interactions", async () => {
  await makeTaskWithCwd("tCount");
  const { tasks } = await import("./db.ts");
  const {
    registerScrapedAskQuestions, registerTmuxPrompt, answerTmuxPrompt,
  } = await import("./interactions.ts");

  // No interactions yet → 0.
  expect(tasks.get("tCount")!.pendingInteractionCount).toBe(0);

  // One of each remaining kind from the in-memory maps; counter reflects all.
  registerScrapedAskQuestions({
    taskId: "tCount", runId: "r1",
    questions: [{ question: "?", options: [{ label: "A" }] }],
    fingerprint: "fp-tCount",
  });
  const t = registerTmuxPrompt({
    taskId: "tCount", runId: "r1",
    paneText: "Do you want to proceed?",
    choices: [{ key: "1", label: "Yes" }, { key: "2", label: "No" }],
    fingerprint: "fp-count",
  });
  expect(tasks.get("tCount")!.pendingInteractionCount).toBe(2);
  // And the same count surfaces via tasks.list (the kanban's polling path).
  const fromList = tasks.list().find((t) => t.id === "tCount");
  expect(fromList?.pendingInteractionCount).toBe(2);

  // Answering removes the entry from its map and decrements the count.
  answerTmuxPrompt(t.id, { key: "1" });
  await t.answer;
  expect(tasks.get("tCount")!.pendingInteractionCount).toBe(1);

  // Counter is scoped to the task: a sibling task with no interactions reads 0.
  await makeTaskWithCwd("tCountSibling");
  expect(tasks.get("tCountSibling")!.pendingInteractionCount).toBe(0);
});

test("registerTmuxPrompt + answerTmuxPrompt round-trips a key", async () => {
  const { registerTmuxPrompt, answerTmuxPrompt, __testing } = await import("./interactions.ts");
  expect(__testing.tmuxPromptsSize()).toBe(0);
  const { id, answer } = registerTmuxPrompt({
    taskId: "tT", runId: "rT",
    paneText: "Do you want to proceed?",
    choices: [{ key: "1", label: "Yes" }, { key: "2", label: "No" }],
    fingerprint: "abc123",
  });
  expect(__testing.tmuxPromptsSize()).toBe(1);
  expect(answerTmuxPrompt(id, { key: "1" })).toBe(true);
  await expect(answer).resolves.toEqual({ key: "1" });
  expect(__testing.tmuxPromptsSize()).toBe(0);
});

test("findTmuxPromptByFingerprint hits only the same task + fingerprint", async () => {
  const { registerTmuxPrompt, findTmuxPromptByFingerprint } = await import("./interactions.ts");
  registerTmuxPrompt({
    taskId: "tA", runId: "r1",
    paneText: "x", choices: [{ key: "1", label: "Y" }], fingerprint: "fp-A",
  });
  registerTmuxPrompt({
    taskId: "tB", runId: "r1",
    paneText: "x", choices: [{ key: "1", label: "Y" }], fingerprint: "fp-B",
  });
  expect(findTmuxPromptByFingerprint("tA", "fp-A")?.fingerprint).toBe("fp-A");
  expect(findTmuxPromptByFingerprint("tA", "fp-B")).toBeNull();   // wrong task
  expect(findTmuxPromptByFingerprint("tB", "fp-A")).toBeNull();   // wrong fp
});

test("listPendingForTask returns tmux_prompt entries alongside other kinds", async () => {
  const { registerScrapedAskQuestions, registerTmuxPrompt, listPendingForTask } = await import("./interactions.ts");
  registerScrapedAskQuestions({
    taskId: "tM", runId: "rM",
    questions: [{ question: "?", options: [{ label: "A" }] }],
    fingerprint: "fp-ask",
  });
  registerTmuxPrompt({
    taskId: "tM", runId: "rM",
    paneText: "?", choices: [{ key: "1", label: "Y" }], fingerprint: "fp",
  });
  const kinds = listPendingForTask("tM").map((r) => r.kind).sort();
  expect(kinds).toEqual(["ask_questions", "tmux_prompt"]);
});

test("cancelPendingForTask resolves tmux_prompt entries with the sentinel", async () => {
  const { registerTmuxPrompt, cancelPendingForTask } = await import("./interactions.ts");
  const { answer } = registerTmuxPrompt({
    taskId: "tX", runId: "rX",
    paneText: "x", choices: [{ key: "1", label: "Y" }], fingerprint: "fp-X",
  });
  cancelPendingForTask("tX", "task deleted");
  await expect(answer).resolves.toEqual({ key: "__cancelled__" });
});

test("registerTmuxPrompt rejects reserved sentinel keys", async () => {
  const { registerTmuxPrompt } = await import("./interactions.ts");
  expect(() => registerTmuxPrompt({
    taskId: "t-sentinel", runId: "r1",
    paneText: "?",
    choices: [{ key: "__external__", label: "External" }],
    fingerprint: "fp-sentinel",
  })).toThrow(/reserved/);
});

test("answer* paths emit on the resolved broadcaster", async () => {
  const {
    setResolvedBroadcaster,
    registerScrapedAskQuestions, resolveScrapedAskQuestions,
    registerTmuxPrompt, answerTmuxPrompt,
    cancelPendingForTask,
  } = await import("./interactions.ts");
  const seen: Array<{ id: string; kind: string }> = [];
  setResolvedBroadcaster((r) => { seen.push({ id: r.id, kind: r.kind }); });

  const q = registerScrapedAskQuestions({
    taskId: "tR", runId: "rR",
    questions: [{ question: "?", options: [{ label: "A" }] }],
    fingerprint: "fp-rq",
  });
  resolveScrapedAskQuestions(q.id);

  const t = registerTmuxPrompt({
    taskId: "tR", runId: "rR",
    paneText: "x", choices: [{ key: "1", label: "Y" }], fingerprint: "fp-r",
  });
  answerTmuxPrompt(t.id, { key: "1" });
  await t.answer;

  // cancellation path should fan out too
  const t2 = registerTmuxPrompt({
    taskId: "tR", runId: "rR",
    paneText: "x", choices: [{ key: "1", label: "Y" }], fingerprint: "fp-r2",
  });
  cancelPendingForTask("tR", "test");
  await t2.answer;

  // Expect three resolution emissions in order.
  expect(seen.map((s) => s.kind)).toEqual(["ask_questions", "tmux_prompt", "tmux_prompt"]);
  expect(seen.map((s) => s.id)).toEqual([q.id, t.id, t2.id]);
});
