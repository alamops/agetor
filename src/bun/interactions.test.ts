import { test, expect, beforeEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Top-level: db.ts captures AGETOR_DATA_DIR at first import. `beforeAll`
// would run AFTER any sibling test that already imported db.ts in this
// process, falling back to ~/.agetor and polluting the user's real db.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-int-"));

/** Allow-rules are now stored agetor-wide at `<dataDir>/settings.local.json`,
 *  not per-task. Tests share this single file across cases — wipe between
 *  tests so a leftover rule from one case can't auto-allow in the next.
 *
 *  Resolved lazily from `db.ts`'s `dataDir` export (rather than the env var)
 *  because Bun's test runner shares one process across files: if a sibling
 *  file imported `db.ts` first, `dataDir` is frozen to *that* file's env,
 *  not ours. Trusting `dataDir` always agrees with what `interactions.ts`
 *  actually writes to. */
async function globalAllowFile(): Promise<string> {
  const { dataDir } = await import("./db.ts");
  return path.join(dataDir, "settings.local.json");
}

beforeEach(async () => {
  const { __testing } = await import("./interactions.ts");
  __testing.reset();
  const file = await globalAllowFile();
  if (existsSync(file)) rmSync(file);
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
    pendingInteractionCount: 0,
    openTerminalCount: 0,
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

  // The rule should be written to the agetor-global settings file as a
  // native claude permission entry — NOT to the task cwd anymore. That's
  // what makes the next task auto-allow the same call.
  const settings = JSON.parse(readFileSync(await globalAllowFile(), "utf8"));
  expect(settings.permissions.allow).toContain("Bash(npm test)");
  expect(existsSync(path.join(cwd, ".claude", "settings.local.json"))).toBe(false);

  // And subsequent lookups should hit it.
  expect(lookupAllowRule({ taskId: "t2", toolName: "Bash", toolInput: { command: "npm test" } })).toBe("allow");
  // A different Bash command must NOT auto-allow (bash_exact, not prefix).
  expect(lookupAllowRule({ taskId: "t2", toolName: "Bash", toolInput: { command: "npm install" } })).toBeNull();
  // A different tool must NOT auto-allow.
  expect(lookupAllowRule({ taskId: "t2", toolName: "Edit", toolInput: { file_path: "/foo" } })).toBeNull();
  // A different task (even one that doesn't exist) auto-allows — that's
  // the cross-task share guarantee.
  expect(lookupAllowRule({ taskId: "other-task", toolName: "Bash", toolInput: { command: "npm test" } })).toBe("allow");
});

test("answerApproval honors an explicit entry from the granularity chooser", async () => {
  await makeTaskWithCwd("t2b");
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

  const settings = JSON.parse(readFileSync(await globalAllowFile(), "utf8"));
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
  // Neither the global settings file nor the legacy per-task one should be created.
  expect(existsSync(await globalAllowFile())).toBe(false);
  expect(existsSync(path.join(cwd, ".claude", "settings.local.json"))).toBe(false);
  expect(lookupAllowRule({ taskId: "t3", toolName: "Bash", toolInput: { command: "rm something" } })).toBeNull();
});

test("saveAllowRule preserves pre-existing entries in the global file when merging", async () => {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(path.dirname(await globalAllowFile()), { recursive: true });
  // Seed a pre-existing permissions.allow + unrelated user-authored key.
  writeFileSync(
    await globalAllowFile(),
    JSON.stringify({
      permissions: { allow: ["Bash(ls *)"] },
      customUserKey: { keep: "this" },
    }, null, 2),
  );

  await makeTaskWithCwd("t-merge");
  const { saveAllowRule } = await import("./interactions.ts");
  saveAllowRule({ taskId: "t-merge", toolName: "Bash", toolInput: { command: "npm test" } });

  const settings = JSON.parse(readFileSync(await globalAllowFile(), "utf8"));
  expect(settings.permissions.allow).toEqual(["Bash(ls *)", "Bash(npm test)"]);
  expect(settings.customUserKey).toEqual({ keep: "this" });
});

test("saveAllowRule is idempotent — repeated saves of the same entry dedupe", async () => {
  await makeTaskWithCwd("t-dedupe");
  const { saveAllowRule } = await import("./interactions.ts");
  saveAllowRule({ taskId: "t-dedupe", toolName: "Bash", toolInput: { command: "npm test" } });
  saveAllowRule({ taskId: "t-dedupe", toolName: "Bash", toolInput: { command: "npm test" } });
  saveAllowRule({ taskId: "t-dedupe", toolName: "Bash", toolInput: { command: "npm test" } });
  const settings = JSON.parse(readFileSync(await globalAllowFile(), "utf8"));
  expect(settings.permissions.allow).toEqual(["Bash(npm test)"]);
});

test("saved allow-rule applies across tasks — saving on task A auto-allows on task B", async () => {
  await makeTaskWithCwd("t-share-A");
  await makeTaskWithCwd("t-share-B");
  const { saveAllowRule, lookupAllowRule } = await import("./interactions.ts");
  // Approve on A.
  saveAllowRule({ taskId: "t-share-A", toolName: "Bash", toolInput: { command: "git status" } });
  // Lookup on B (different cwd) matches the same global rule.
  expect(lookupAllowRule({
    taskId: "t-share-B", toolName: "Bash", toolInput: { command: "git status" },
  })).toBe("allow");
});

test("lookupAllowRule still honors legacy per-task .claude/settings.local.json (back-compat)", async () => {
  const cwd = await makeTaskWithCwd("t-legacy");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(path.join(cwd, ".claude"), { recursive: true });
  // Pretend an older agetor build saved a per-task rule here.
  writeFileSync(
    path.join(cwd, ".claude", "settings.local.json"),
    JSON.stringify({ permissions: { allow: ["Bash(legacy-cmd)"] } }, null, 2),
  );
  const { lookupAllowRule } = await import("./interactions.ts");
  expect(lookupAllowRule({
    taskId: "t-legacy", toolName: "Bash", toolInput: { command: "legacy-cmd" },
  })).toBe("allow");
  // …but it's scoped to that task — a different task can't see it via the
  // legacy file (only via the global file).
  await makeTaskWithCwd("t-legacy-sibling");
  expect(lookupAllowRule({
    taskId: "t-legacy-sibling", toolName: "Bash", toolInput: { command: "legacy-cmd" },
  })).toBeNull();
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

test("tasks.get / tasks.list expose pendingInteractionCount reflecting open interactions", async () => {
  await makeTaskWithCwd("tCount");
  const { tasks } = await import("./db.ts");
  const {
    registerApproval, registerQuestion, registerAskQuestions, registerPlanApproval,
    answerApproval, answerQuestion,
  } = await import("./interactions.ts");

  // No interactions yet → 0.
  expect(tasks.get("tCount")!.pendingInteractionCount).toBe(0);

  // One of each kind from the four in-memory maps; counter should reflect all.
  const ap = registerApproval({ taskId: "tCount", runId: "r1", toolName: "Bash", toolInput: { command: "ls" } });
  registerQuestion({ taskId: "tCount", runId: "r1", question: "?" });
  registerAskQuestions({
    taskId: "tCount", runId: "r1",
    questions: [{ question: "?", options: [{ label: "A" }] }],
  });
  registerPlanApproval({ taskId: "tCount", runId: "r1", plan: "P" });
  expect(tasks.get("tCount")!.pendingInteractionCount).toBe(4);
  // And the same count surfaces via tasks.list (the kanban's polling path).
  const fromList = tasks.list().find((t) => t.id === "tCount");
  expect(fromList?.pendingInteractionCount).toBe(4);

  // Answering removes the entry from its map and decrements the count.
  answerApproval(ap.id, { decision: "allow" });
  await ap.answer;
  expect(tasks.get("tCount")!.pendingInteractionCount).toBe(3);

  // Counter is scoped to the task: a sibling task with no interactions reads 0.
  await makeTaskWithCwd("tCountSibling");
  expect(tasks.get("tCountSibling")!.pendingInteractionCount).toBe(0);

  // Answer the bare question too; counter keeps dropping.
  const q2 = registerQuestion({ taskId: "tCount", runId: "r1", question: "?" });
  expect(tasks.get("tCount")!.pendingInteractionCount).toBe(4);
  answerQuestion(q2.id, { selected: ["ok"] });
  await q2.answer;
  expect(tasks.get("tCount")!.pendingInteractionCount).toBe(3);
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
