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
