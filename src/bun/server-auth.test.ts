import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-server-auth-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
// Use a different port so we don't fight any running dev instance.
process.env.AGETOR_API_PORT = "4399";

let server: { stop: () => void; port: number };
let token: string;

beforeAll(async () => {
  await import("./db.ts");
  const { startApiServer, API_TOKEN } = await import("./server.ts");
  server = startApiServer() as unknown as { stop: () => void; port: number };
  token = API_TOKEN;
});

afterAll(() => {
  server?.stop?.();
});

const url = (p: string) => `http://127.0.0.1:4399${p}`;

test("/health responds unauthenticated", async () => {
  const res = await fetch(url("/health"));
  expect(res.status).toBe(200);
});

test("a request without a token is rejected with 401", async () => {
  const res = await fetch(url("/tasks"));
  expect(res.status).toBe(401);
});

test("a request with a wrong token is rejected with 401", async () => {
  const res = await fetch(url("/tasks"), {
    headers: { authorization: "Bearer not-the-real-token" },
  });
  expect(res.status).toBe(401);
});

test("a request with the correct bearer token succeeds", async () => {
  const res = await fetch(url("/tasks"), {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
});

test("a request with the token in the query string succeeds (SSE fallback)", async () => {
  const res = await fetch(url(`/tasks?token=${encodeURIComponent(token)}`));
  expect(res.status).toBe(200);
});

test("/agent-commands requires a known agent kind", async () => {
  const res = await fetch(url("/agent-commands?agent=nope"), {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(400);
});

test("/approvals rejects unauthenticated POSTs", async () => {
  const res = await fetch(url("/approvals?taskId=any"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool_name: "Bash" }),
  });
  expect(res.status).toBe(401);
});

test("/questions rejects unauthenticated POSTs", async () => {
  const res = await fetch(url("/questions?taskId=any"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question: "?" }),
  });
  expect(res.status).toBe(401);
});

test("/agent-commands returns an array for a known agent", async () => {
  const res = await fetch(url("/agent-commands?agent=claude-code"), {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(Array.isArray(body)).toBe(true);
});

test("PATCH ignores server-managed fields and only writes the allow-listed ones", async () => {
  // Seed a task we can poke at.
  const created = await fetch(url("/tasks"), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      title: "t",
      prompt: "p",
      agent: "claude-code",
      workdir: process.cwd(),
      isolation: "none",
    }),
  });
  expect(created.status).toBe(200);
  const task = await created.json();

  // Try to set fields that should NOT be patchable, plus a couple that should.
  const patched = await fetch(url(`/tasks/${task.id}`), {
    method: "PATCH",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      title: "renamed",
      column: "review",
      branch: "/etc/passwd",
      worktreePath: "/etc/passwd",
      baseRef: "deadbeef",
      runId: "fake-run",
      id: "different-id",
      isolation: "worktree",
    }),
  });
  expect(patched.status).toBe(200);
  const after = await patched.json();
  expect(after.id).toBe(task.id);                 // id can't be overridden
  expect(after.title).toBe("renamed");            // allowed
  expect(after.column).toBe("review");            // allowed
  expect(after.branch).toBeNull();                // not in allow-list, stayed null
  expect(after.worktreePath).toBeNull();          // not in allow-list
  expect(after.baseRef).toBeNull();               // not in allow-list
  expect(after.runId).toBeNull();                 // not in allow-list
  expect(after.isolation).toBe("none");           // not in allow-list, stayed
});

test("PATCH /harnesses/:id accepts `enabled` on a built-in (carve-out from immutability)", async () => {
  // Sanity: claude-code starts enabled.
  const before = await fetch(url("/harnesses/claude-code"), {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(before.status).toBe(200);
  expect((await before.json()).enabled).toBe(true);

  const patched = await fetch(url("/harnesses/claude-code"), {
    method: "PATCH",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ enabled: false }),
  });
  expect(patched.status).toBe(200);
  expect((await patched.json()).enabled).toBe(false);

  // Re-enable so the surrounding tests (which use claude-code as the agent)
  // keep working.
  const reenable = await fetch(url("/harnesses/claude-code"), {
    method: "PATCH",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ enabled: true }),
  });
  expect(reenable.status).toBe(200);
});

test("PATCH /harnesses/:id rejects mixed enabled+config on built-in without partial-applying", async () => {
  // Mixed body on a built-in must be a single 400 — and the `enabled` flag
  // must NOT have been mutated as a side effect.
  const res = await fetch(url("/harnesses/claude-code"), {
    method: "PATCH",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ enabled: false, label: "Renamed" }),
  });
  expect(res.status).toBe(400);

  const after = await fetch(url("/harnesses/claude-code"), {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(after.status).toBe(200);
  const harness = await after.json();
  expect(harness.enabled).toBe(true);
  expect(harness.label).toBe("Claude Code");
});

test("GET /harnesses/:id/usage reports running task ids and total count", async () => {
  // Seed two tasks pointing at claude-code so the usage probe has something
  // to count. They live in `backlog` (not running), so `runningTaskIds`
  // should stay empty even with `totalTaskCount > 0`.
  for (let i = 0; i < 2; i++) {
    const created = await fetch(url("/tasks"), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        title: `usage-probe-${i}`,
        prompt: "p",
        agent: "claude-code",
        workdir: process.cwd(),
        isolation: "none",
      }),
    });
    expect(created.status).toBe(200);
  }

  const res = await fetch(url("/harnesses/claude-code/usage"), {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.harnessId).toBe("claude-code");
  expect(body.totalTaskCount).toBeGreaterThanOrEqual(2);
  expect(Array.isArray(body.runningTaskIds)).toBe(true);
});

test("PATCH /tasks/:id rejects an unknown harness id with 400", async () => {
  // Create a task we can patch.
  const created = await fetch(url("/tasks"), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      title: "t",
      prompt: "p",
      agent: "claude-code",
      workdir: process.cwd(),
      isolation: "none",
    }),
  });
  expect(created.status).toBe(200);
  const task = await created.json();

  // Bogus harness id → 400, no mutation. The kanban relies on this so a
  // typo can't strand a task with an unresolvable agent value.
  const bad = await fetch(url(`/tasks/${task.id}`), {
    method: "PATCH",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ agent: "does-not-exist" }),
  });
  expect(bad.status).toBe(400);
  const body = await bad.json();
  expect(body.error).toContain("unknown harness");

  // Built-in id still works (the same PATCH that was failing before).
  const ok = await fetch(url(`/tasks/${task.id}`), {
    method: "PATCH",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ agent: "codex" }),
  });
  expect(ok.status).toBe(200);
  const after = await ok.json();
  expect(after.agent).toBe("codex");
});

// Codex is paused — the server matches the UI's "Coming soon" lock so a
// stale client (or a curl) can't sneak past it. Both branches (create with
// kind=codex, re-enable an existing codex row) return 400.

test("POST /harnesses with kind=codex is rejected (coming soon)", async () => {
  const res = await fetch(url("/harnesses"), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      id: "codex-new",
      kind: "codex",
      label: "Codex (new)",
    }),
  });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error.toLowerCase()).toContain("coming soon");
});

test("PATCH /harnesses/codex enabled=true is rejected (coming soon)", async () => {
  const res = await fetch(url("/harnesses/codex"), {
    method: "PATCH",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ enabled: true }),
  });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error.toLowerCase()).toContain("coming soon");

  // Disabling is still allowed — the lock is one-directional.
  const off = await fetch(url("/harnesses/codex"), {
    method: "PATCH",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ enabled: false }),
  });
  expect(off.status).toBe(200);
});
