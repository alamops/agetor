import { test, expect, beforeEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
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

/** Insert a Task row pointing at a fresh temp directory so the JSON-file
 *  backed allow-rule helpers can find and write `.claude/settings.local.json`.
 *  Returns the resolved cwd for assertions. */
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
  });
  return cwd;
}

test("registerApproval resolves with the answer answerApproval was called with", async () => {
  const { registerApproval, answerApproval } = await import("./interactions.ts");
  const { id, answer } = registerApproval({
    taskId: "t1",
    runId: "r1",
    toolName: "Bash",
    toolInput: { command: "ls" },
  });
  expect(answerApproval(id, { decision: "allow" })).toBe(true);
  await expect(answer).resolves.toEqual({ decision: "allow" });
});

test("answerApproval with remember=true persists a rule (default-derive: bash_exact)", async () => {
  const cwd = await makeTaskWithCwd("t2");
  const { registerApproval, answerApproval, lookupAllowRule } = await import("./interactions.ts");
  const { id, answer } = registerApproval({
    taskId: "t2",
    runId: "r1",
    toolName: "Bash",
    toolInput: { command: "npm test" },
  });
  // No explicit `entry` on the answer → server falls back to the
  // most-specific scope for the tool (bash_exact).
  answerApproval(id, { decision: "allow", remember: true });
  await answer;

  // The rule should be written to <cwd>/.claude/settings.local.json as a
  // native claude permission entry.
  const settings = JSON.parse(readFileSync(path.join(cwd, ".claude", "settings.local.json"), "utf8"));
  expect(settings.permissions.allow).toContain("Bash(npm test)");

  // And subsequent lookups should hit it.
  expect(lookupAllowRule({ taskId: "t2", toolName: "Bash", toolInput: { command: "npm test" } })).toBe("allow");
  // A different Bash command must NOT auto-allow (bash_exact, not prefix).
  expect(lookupAllowRule({ taskId: "t2", toolName: "Bash", toolInput: { command: "npm install" } })).toBeNull();
  // A different tool must NOT auto-allow.
  expect(lookupAllowRule({ taskId: "t2", toolName: "Edit", toolInput: { file_path: "/foo" } })).toBeNull();
  // A different task with no settings file → null.
  expect(lookupAllowRule({ taskId: "other-task", toolName: "Bash", toolInput: { command: "npm test" } })).toBeNull();
});

test("answerApproval honors an explicit entry from the granularity chooser", async () => {
  const cwd = await makeTaskWithCwd("t2b");
  const { registerApproval, answerApproval, lookupAllowRule } = await import("./interactions.ts");
  const { id, answer } = registerApproval({
    taskId: "t2b",
    runId: "r1",
    toolName: "Bash",
    toolInput: { command: "git status" },
  });
  // User picked "All git *" in the chooser; UI sent the entry verbatim.
  answerApproval(id, { decision: "allow", remember: true, entry: "Bash(git *)" });
  await answer;

  const settings = JSON.parse(readFileSync(path.join(cwd, ".claude", "settings.local.json"), "utf8"));
  expect(settings.permissions.allow).toContain("Bash(git *)");
  // Prefix matches any `git ...` (word boundary; `gitleaks` does NOT match).
  expect(lookupAllowRule({ taskId: "t2b", toolName: "Bash", toolInput: { command: "git log" } })).toBe("allow");
  expect(lookupAllowRule({ taskId: "t2b", toolName: "Bash", toolInput: { command: "gitleaks scan" } })).toBeNull();
});

test("answerApproval with decision='deny' does NOT save a rule, even with remember=true", async () => {
  const cwd = await makeTaskWithCwd("t3");
  const { registerApproval, answerApproval, lookupAllowRule } = await import("./interactions.ts");
  const { id } = registerApproval({
    taskId: "t3",
    runId: "r1",
    toolName: "Bash",
    toolInput: { command: "rm something" },
  });
  answerApproval(id, { decision: "deny", remember: true });
  // No settings file should be created.
  expect(existsSync(path.join(cwd, ".claude", "settings.local.json"))).toBe(false);
  expect(lookupAllowRule({ taskId: "t3", toolName: "Bash", toolInput: { command: "rm something" } })).toBeNull();
});

test("saveAllowRule preserves pre-existing user entries when merging", async () => {
  const cwd = await makeTaskWithCwd("t-merge");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(path.join(cwd, ".claude"), { recursive: true });
  // Seed a pre-existing user-authored permissions.allow + unrelated key.
  writeFileSync(
    path.join(cwd, ".claude", "settings.local.json"),
    JSON.stringify({
      permissions: { allow: ["Bash(ls *)"] },
      customUserKey: { keep: "this" },
    }, null, 2),
  );

  const { saveAllowRule } = await import("./interactions.ts");
  saveAllowRule({ taskId: "t-merge", toolName: "Bash", toolInput: { command: "npm test" } });

  const settings = JSON.parse(readFileSync(path.join(cwd, ".claude", "settings.local.json"), "utf8"));
  expect(settings.permissions.allow).toEqual(["Bash(ls *)", "Bash(npm test)"]);
  expect(settings.customUserKey).toEqual({ keep: "this" });
});

test("saveAllowRule is idempotent — repeated saves of the same entry dedupe", async () => {
  const cwd = await makeTaskWithCwd("t-dedupe");
  const { saveAllowRule } = await import("./interactions.ts");
  saveAllowRule({ taskId: "t-dedupe", toolName: "Bash", toolInput: { command: "npm test" } });
  saveAllowRule({ taskId: "t-dedupe", toolName: "Bash", toolInput: { command: "npm test" } });
  saveAllowRule({ taskId: "t-dedupe", toolName: "Bash", toolInput: { command: "npm test" } });
  const settings = JSON.parse(readFileSync(path.join(cwd, ".claude", "settings.local.json"), "utf8"));
  expect(settings.permissions.allow).toEqual(["Bash(npm test)"]);
});

test("registerQuestion resolves with selected + custom from answerQuestion", async () => {
  const { registerQuestion, answerQuestion } = await import("./interactions.ts");
  const { id, answer } = registerQuestion({
    taskId: "t1",
    runId: "r1",
    question: "Which page?",
    choices: ["A", "B", "C"],
  });
  answerQuestion(id, { selected: ["B"], custom: "actually maybe X" });
  await expect(answer).resolves.toEqual({ selected: ["B"], custom: "actually maybe X" });
});

test("cancelPendingForTask resolves every pending interaction (approval + question) with cancel reason", async () => {
  const { registerApproval, registerQuestion, cancelPendingForTask, __testing } = await import("./interactions.ts");
  const a = registerApproval({ taskId: "tCancel", runId: "r1", toolName: "Bash", toolInput: {} });
  const q = registerQuestion({ taskId: "tCancel", runId: "r1", question: "huh?" });
  expect(__testing.approvalsSize()).toBe(1);
  expect(__testing.questionsSize()).toBe(1);

  cancelPendingForTask("tCancel", "bye");
  await expect(a.answer).resolves.toEqual({ decision: "deny", reason: "bye" });
  await expect(q.answer).resolves.toEqual({ selected: [], custom: "bye" });
  expect(__testing.approvalsSize()).toBe(0);
  expect(__testing.questionsSize()).toBe(0);
});

test("cancelPendingForTask leaves other tasks' interactions untouched", async () => {
  const { registerApproval, cancelPendingForTask, answerApproval } = await import("./interactions.ts");
  const keep = registerApproval({ taskId: "tA", runId: "r1", toolName: "Bash", toolInput: {} });
  const drop = registerApproval({ taskId: "tB", runId: "r1", toolName: "Bash", toolInput: {} });
  cancelPendingForTask("tB", "stop");
  await expect(drop.answer).resolves.toEqual({ decision: "deny", reason: "stop" });
  // 'keep' still pending → answerable:
  expect(answerApproval(keep.id, { decision: "allow" })).toBe(true);
  await expect(keep.answer).resolves.toEqual({ decision: "allow" });
});

test("listPendingForTask returns approvals + questions in createdAt order", async () => {
  const { registerApproval, registerQuestion, listPendingForTask } = await import("./interactions.ts");
  const a = registerApproval({ taskId: "tList", runId: "r1", toolName: "Bash", toolInput: {} });
  await new Promise((r) => setTimeout(r, 5));
  const q = registerQuestion({ taskId: "tList", runId: "r1", question: "?" });
  const pending = listPendingForTask("tList");
  expect(pending.map((p) => p.id)).toEqual([a.id, q.id]);
});

test("makeHookResponse shapes allow/deny per the documented hook contract", async () => {
  const { makeHookResponse } = await import("./interactions.ts");
  expect(makeHookResponse({ decision: "allow" })).toEqual({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
  });
  expect(makeHookResponse({ decision: "deny", reason: "no thanks" })).toEqual({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "no thanks",
    },
  });
});

test("setBroadcaster receives newly registered interactions", async () => {
  const { setBroadcaster, registerApproval } = await import("./interactions.ts");
  const seen: string[] = [];
  setBroadcaster((req) => {
    if (req.kind === "approval") seen.push(`approval:${req.toolName}`);
    else if (req.kind === "question") seen.push(`question:${req.question}`);
    else if (req.kind === "ask_questions") seen.push(`ask_questions:${req.questions.length}`);
    else if (req.kind === "plan_approval") seen.push(`plan_approval`);
  });
  registerApproval({ taskId: "tBroad", runId: "r1", toolName: "Edit", toolInput: {} });
  expect(seen.length).toBe(1);
  expect(seen[0]).toBe("approval:Edit");
});

test("safe-tools list contains the documented read-only set", async () => {
  const { SAFE_TOOLS } = await import("./interactions.ts");
  for (const t of ["Read", "LS", "Glob", "Grep", "NotebookRead"]) {
    expect(SAFE_TOOLS.has(t)).toBe(true);
  }
  expect(SAFE_TOOLS.has("Bash")).toBe(false);
});

/* ── AskUserQuestion intercept (claude built-in tool) ───────────────── */

test("registerAskQuestions resolves with the answers from answerAskQuestions", async () => {
  const { registerAskQuestions, answerAskQuestions } = await import("./interactions.ts");
  const { id, answer } = registerAskQuestions({
    taskId: "tA",
    runId: "rA",
    questions: [
      { question: "Q1?", options: [{ label: "A" }, { label: "B" }] },
      { question: "Q2?", multiSelect: true, options: [{ label: "X" }, { label: "Y" }] },
    ],
  });
  expect(answerAskQuestions(id, {
    answers: [{ selected: ["A"] }, { selected: ["X", "Y"], custom: "plus this" }],
  })).toBe(true);
  const a = await answer;
  expect(a.answers).toHaveLength(2);
  expect(a.answers[0]!.selected).toEqual(["A"]);
  expect(a.answers[1]!.selected).toEqual(["X", "Y"]);
  expect(a.answers[1]!.custom).toBe("plus this");
});

test("formatAskQuestionsReason produces claude's canonical 'User has answered' format", async () => {
  const { registerAskQuestions, formatAskQuestionsReason } = await import("./interactions.ts");
  const { req } = registerAskQuestions({
    taskId: "tF",
    runId: "rF",
    questions: [
      { question: "Granularity?", options: [{ label: "per-asset" }, { label: "per-instance" }] },
    ],
  });
  const reason = formatAskQuestionsReason(req, {
    answers: [{ selected: ["per-instance"] }],
  });
  expect(reason).toContain(`"Granularity?"="per-instance"`);
  expect(reason).toContain("User has answered your questions");
});

test("formatAskQuestionsReason combines selected + custom into one value", async () => {
  const { registerAskQuestions, formatAskQuestionsReason } = await import("./interactions.ts");
  const { req } = registerAskQuestions({
    taskId: "tF2",
    runId: "rF2",
    questions: [{ question: "What?", options: [{ label: "X" }, { label: "Y" }] }],
  });
  expect(
    formatAskQuestionsReason(req, { answers: [{ selected: ["X"], custom: "and also Z" }] }),
  ).toContain(`"What?"="X, and also Z"`);
});

/* ── ExitPlanMode intercept (claude built-in tool) ──────────────────── */

test("registerPlanApproval resolves with the choice from answerPlanApproval", async () => {
  const { registerPlanApproval, answerPlanApproval } = await import("./interactions.ts");
  const { id, answer } = registerPlanApproval({
    taskId: "tP",
    runId: "rP",
    plan: "# Plan body",
  });
  expect(answerPlanApproval(id, { choice: "approve_implement" })).toBe(true);
  expect((await answer).choice).toBe("approve_implement");
});

test("formatPlanApprovalReason maps each choice to a distinct natural-language instruction", async () => {
  const { formatPlanApprovalReason } = await import("./interactions.ts");
  const impl = formatPlanApprovalReason({ choice: "approve_implement" });
  const ask = formatPlanApprovalReason({ choice: "approve_ask" });
  const reject = formatPlanApprovalReason({ choice: "reject", revision: "use option B instead" });
  expect(impl).toContain("auto-accept");
  expect(ask).toContain("confirm before");
  expect(reject).toContain("option B instead");
  expect(impl).not.toEqual(ask);
  expect(impl).not.toEqual(reject);
});

test("cancelPendingForTask resolves ask_questions + plan_approval entries", async () => {
  const {
    registerAskQuestions, registerPlanApproval, cancelPendingForTask,
  } = await import("./interactions.ts");
  const q = registerAskQuestions({
    taskId: "tC", runId: "rC",
    questions: [{ question: "?", options: [{ label: "A" }] }],
  });
  const p = registerPlanApproval({ taskId: "tC", runId: "rC", plan: "P" });
  cancelPendingForTask("tC", "cancelled by user");
  const qa = await q.answer;
  expect(qa.answers[0]!.custom).toBe("cancelled by user");
  const pa = await p.answer;
  expect(pa.choice).toBe("reject");
  expect(pa.revision).toBe("cancelled by user");
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
  const { registerApproval, registerTmuxPrompt, listPendingForTask } = await import("./interactions.ts");
  registerApproval({ taskId: "tM", runId: "rM", toolName: "Edit", toolInput: {} });
  registerTmuxPrompt({
    taskId: "tM", runId: "rM",
    paneText: "?", choices: [{ key: "1", label: "Y" }], fingerprint: "fp",
  });
  const kinds = listPendingForTask("tM").map((r) => r.kind).sort();
  expect(kinds).toEqual(["approval", "tmux_prompt"]);
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
    registerApproval, answerApproval,
    registerTmuxPrompt, answerTmuxPrompt,
    cancelPendingForTask,
  } = await import("./interactions.ts");
  const seen: Array<{ id: string; kind: string }> = [];
  setResolvedBroadcaster((r) => { seen.push({ id: r.id, kind: r.kind }); });

  const a = registerApproval({ taskId: "tR", runId: "rR", toolName: "Bash", toolInput: {} });
  answerApproval(a.id, { decision: "allow" });
  await a.answer;

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
  expect(seen.map((s) => s.kind)).toEqual(["approval", "tmux_prompt", "tmux_prompt"]);
  expect(seen.map((s) => s.id)).toEqual([a.id, t.id, t2.id]);
});
