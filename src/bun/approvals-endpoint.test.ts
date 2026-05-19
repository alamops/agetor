import { test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
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

/** Insert a task pointing at a fresh temp workdir + register a pending
 *  approval directly on the in-process registry, then return everything
 *  the test needs to drive `/approvals/:id/answer`. */
async function seedPendingApproval(args: {
  taskId: string;
  toolName: string;
  toolInput: unknown;
}): Promise<{ approvalId: string; cwd: string }> {
  const cwd = mkdtempSync(path.join(tmpdir(), `agetor-approvals-task-${args.taskId}-`));
  const { tasks } = await import("./db.ts");
  tasks.insert({
    id: args.taskId,
    title: args.taskId,
    prompt: "",
    column: "running",
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
    runId: "run-1",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    hasOpenableRun: false,
    pendingInteractionCount: 0,
  });
  const { registerApproval } = await import("./interactions.ts");
  const { id } = registerApproval({
    taskId: args.taskId,
    runId: "run-1",
    toolName: args.toolName,
    toolInput: args.toolInput,
  });
  return { approvalId: id, cwd };
}

test("/approvals/:id/answer forwards explicit `entry` to permissions.allow", async () => {
  const { approvalId, cwd } = await seedPendingApproval({
    taskId: "t-endpoint-explicit",
    toolName: "Bash",
    toolInput: { command: "git status" },
  });

  // UI sends a broader scope than the most-specific default (the chooser's
  // "All git *" option). The server must persist this verbatim, NOT
  // re-derive a narrower bash_exact.
  const res = await fetch(url(`/approvals/${approvalId}/answer`), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ decision: "allow", remember: true, entry: "Bash(git *)" }),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });

  const settings = JSON.parse(readFileSync(path.join(cwd, ".claude", "settings.local.json"), "utf8"));
  expect(settings.permissions.allow).toContain("Bash(git *)");
  expect(settings.permissions.allow).not.toContain("Bash(git status)");
});

test("/approvals/:id/answer with remember=true and no `entry` falls back to most-specific", async () => {
  const { approvalId, cwd } = await seedPendingApproval({
    taskId: "t-endpoint-default",
    toolName: "Bash",
    toolInput: { command: "npm test" },
  });

  const res = await fetch(url(`/approvals/${approvalId}/answer`), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ decision: "allow", remember: true }),
  });
  expect(res.status).toBe(200);

  const settings = JSON.parse(readFileSync(path.join(cwd, ".claude", "settings.local.json"), "utf8"));
  // Default-derive picks bash_exact for Bash → the exact command verbatim.
  expect(settings.permissions.allow).toEqual(["Bash(npm test)"]);
});

test("/approvals/:id/answer with decision=deny does NOT write any settings file", async () => {
  const { approvalId, cwd } = await seedPendingApproval({
    taskId: "t-endpoint-deny",
    toolName: "Bash",
    toolInput: { command: "rm -rf /" },
  });

  // Even with remember=true + an entry, deny never saves an allow-rule.
  const res = await fetch(url(`/approvals/${approvalId}/answer`), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ decision: "deny", remember: true, entry: "Bash(rm *)" }),
  });
  expect(res.status).toBe(200);
  expect(existsSync(path.join(cwd, ".claude", "settings.local.json"))).toBe(false);
});

test("/approvals/:id/answer rejects invalid decision values", async () => {
  const { approvalId } = await seedPendingApproval({
    taskId: "t-endpoint-bad",
    toolName: "Bash",
    toolInput: { command: "ls" },
  });
  const res = await fetch(url(`/approvals/${approvalId}/answer`), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ decision: "maybe" }),
  });
  expect(res.status).toBe(400);
});

/** Build a task with a saved Edit allow-rule + install a fake claude-tmux
 *  SessionState so getCurrentPermissionMode returns whatever the test
 *  sets. Returns the cwd + the state handle so the test can flip
 *  permissionMode mid-run. */
async function seedTaskWithSavedRule(args: {
  taskId: string;
  ruleEntry: string;
}): Promise<{ cwd: string; state: { permissionMode: string | null } }> {
  const cwd = mkdtempSync(path.join(tmpdir(), `agetor-plan-mode-${args.taskId}-`));
  const { tasks } = await import("./db.ts");
  tasks.insert({
    id: args.taskId,
    title: args.taskId,
    prompt: "",
    column: "running",
    agent: "claude-code",
    workdir: cwd,
    isolation: "none",
    branch: null,
    worktreePath: null,
    baseRef: null,
    mode: "plan",
    model: "opus-4.7",
    effort: null,
    references: [],
    runId: "run-plan",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    hasOpenableRun: false,
    pendingInteractionCount: 0,
  });
  // Pre-write the allow-rule directly to the task's settings file so the
  // route's lookupAllowRule call hits "allow" — same shape we'd get if the
  // user had previously clicked "Allow always" on an Edit card.
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(path.join(cwd, ".claude"), { recursive: true });
  writeFileSync(
    path.join(cwd, ".claude", "settings.local.json"),
    JSON.stringify({ permissions: { allow: [args.ruleEntry] } }),
  );
  // Stand up a fake claude-tmux session so getCurrentPermissionMode has
  // something to read. The test mutates `state.permissionMode` between
  // sub-cases.
  const { __forTest } = await import("./claude-tmux.ts");
  const jsonl = path.join(cwd, "session.jsonl");
  writeFileSync(jsonl, "");
  const state = __forTest.installSession(args.taskId, jsonl);
  return { cwd, state };
}

test("POST /approvals — saved Edit rule still auto-allows in non-plan mode (regression guard)", async () => {
  // Reset before this test — prior sibling tests in the same process may
  // have left pending approvals that would skew the assertion below.
  const { __testing: pre } = await import("./interactions.ts");
  pre.reset();
  const { state } = await seedTaskWithSavedRule({
    taskId: "t-saved-rule-auto",
    ruleEntry: "Edit(/tmp/**)",
  });
  // `acceptEdits` is the mode that proves the saved-rule path: it isn't
  // plan (so the saved-rule fast-path isn't skipped) and it isn't
  // auto/bypass (so the auto-mode fast-path doesn't preempt it). If we
  // used `auto` here the new auto-mode fast-path would short-circuit
  // before lookupAllowRule runs and the test would silently stop
  // exercising what its name claims.
  state.permissionMode = "acceptEdits";
  const res = await fetch(url(`/approvals?taskId=t-saved-rule-auto`), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      tool_name: "Edit",
      tool_input: { file_path: "/tmp/x", old_string: "a", new_string: "b" },
    }),
  });
  // Fast path → instant 200 with "allow" decision; no pending interaction.
  expect(res.status).toBe(200);
  const body = await res.json() as { hookSpecificOutput?: { permissionDecision?: string } };
  expect(body.hookSpecificOutput?.permissionDecision).toBe("allow");
  const { __testing } = await import("./interactions.ts");
  expect(__testing.approvalsSize()).toBe(0);
});

test("POST /approvals — plan mode skips the saved-rule fast-path and registers an approval", async () => {
  const { state } = await seedTaskWithSavedRule({
    taskId: "t-saved-rule-plan",
    ruleEntry: "Edit(/tmp/**)",
  });
  state.permissionMode = "plan";
  const { __testing } = await import("./interactions.ts");
  __testing.reset();
  // Don't await — the route blocks until the interaction answers, which
  // is the *point*: in plan mode we want to surface to the UI, not
  // short-circuit. Race the fetch against a short delay; the registry
  // size assertion proves the interaction landed.
  const pending = fetch(url(`/approvals?taskId=t-saved-rule-plan`), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      tool_name: "Edit",
      tool_input: { file_path: "/tmp/y", old_string: "c", new_string: "d" },
    }),
  });
  // Give the server a tick to register before we assert.
  await new Promise((r) => setTimeout(r, 50));
  expect(__testing.approvalsSize()).toBe(1);
  // Resolve via the answer endpoint so the awaiting fetch settles and
  // doesn't leak across tests.
  const { listPendingForTask, answerApproval } = await import("./interactions.ts");
  const list = listPendingForTask("t-saved-rule-plan");
  expect(list[0]?.kind).toBe("approval");
  if (list[0]?.kind === "approval") {
    answerApproval(list[0].id, { decision: "allow" });
  }
  const res = await pending;
  expect(res.status).toBe(200);
});

test("POST /approvals — plan mode still fast-paths read-only tools (Read)", async () => {
  const { state } = await seedTaskWithSavedRule({
    taskId: "t-saved-rule-plan-read",
    ruleEntry: "Edit(/tmp/**)",
  });
  state.permissionMode = "plan";
  const res = await fetch(url(`/approvals?taskId=t-saved-rule-plan-read`), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ tool_name: "Read", tool_input: { file_path: "/etc/hosts" } }),
  });
  // SAFE_TOOLS short-circuit still applies — Read is read-only, plan mode
  // doesn't care.
  expect(res.status).toBe(200);
  const body = await res.json() as { hookSpecificOutput?: { permissionDecision?: string } };
  expect(body.hookSpecificOutput?.permissionDecision).toBe("allow");
});

test("POST /approvals — auto mode auto-allows arbitrary Bash without registering an approval", async () => {
  // Regression: when a task was launched in `ask` mode and the user later
  // PATCHes the mode to `auto`, the FULL hook matcher is still installed
  // from spawn time so every PreToolUse lands on /approvals. Auto mode
  // means "let claude's classifier decide" — we must not surface routine
  // Bash as an approval card.
  const { __testing: pre } = await import("./interactions.ts");
  pre.reset();
  const { state } = await seedTaskWithSavedRule({
    taskId: "t-auto-bash",
    ruleEntry: "Edit(/tmp/**)", // unrelated, just satisfies the seed helper
  });
  state.permissionMode = "auto";
  const res = await fetch(url(`/approvals?taskId=t-auto-bash`), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "git diff HEAD -- file.tsx | tail -90" },
    }),
  });
  expect(res.status).toBe(200);
  const body = await res.json() as { hookSpecificOutput?: { permissionDecision?: string } };
  expect(body.hookSpecificOutput?.permissionDecision).toBe("allow");
  const { __testing } = await import("./interactions.ts");
  expect(__testing.approvalsSize()).toBe(0);
});

test("POST /approvals — bypassPermissions mode auto-allows arbitrary Bash too", async () => {
  const { __testing: pre } = await import("./interactions.ts");
  pre.reset();
  const { state } = await seedTaskWithSavedRule({
    taskId: "t-bypass-bash",
    ruleEntry: "Edit(/tmp/**)",
  });
  state.permissionMode = "bypassPermissions";
  const res = await fetch(url(`/approvals?taskId=t-bypass-bash`), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ tool_name: "Bash", tool_input: { command: "rm -rf /tmp/x" } }),
  });
  expect(res.status).toBe(200);
  const body = await res.json() as { hookSpecificOutput?: { permissionDecision?: string } };
  expect(body.hookSpecificOutput?.permissionDecision).toBe("allow");
  const { __testing } = await import("./interactions.ts");
  expect(__testing.approvalsSize()).toBe(0);
});

test("POST /approvals — auto mode still intercepts AskUserQuestion (modal-deadlock prevention)", async () => {
  // ALWAYS_INTERCEPT must hold regardless of mode — AskUserQuestion's
  // tmux-internal modal would deadlock the run if we auto-allowed.
  const { __testing: pre } = await import("./interactions.ts");
  pre.reset();
  const { state } = await seedTaskWithSavedRule({
    taskId: "t-auto-ask",
    ruleEntry: "Edit(/tmp/**)",
  });
  state.permissionMode = "auto";
  const pending = fetch(url(`/approvals?taskId=t-auto-ask`), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      tool_name: "AskUserQuestion",
      tool_input: { questions: [{ question: "pick one", header: "x", multiSelect: false, options: [{ label: "a" }, { label: "b" }] }] },
    }),
  });
  await new Promise((r) => setTimeout(r, 50));
  const { __testing, listPendingForTask, answerAskQuestions } = await import("./interactions.ts");
  expect(__testing.askQuestionsSize()).toBe(1);
  // Drain so the fetch settles without leaking into sibling tests.
  const list = listPendingForTask("t-auto-ask");
  if (list[0]?.kind === "ask_questions") {
    answerAskQuestions(list[0].id, { answers: [{ selected: ["a"] }] });
  }
  const res = await pending;
  expect(res.status).toBe(200);
});
