// Route-level tests for the harness-stack API (T07): CRUD, validation,
// payloads, and the same-stack live-switch guard. A unique port; the data dir
// is set before db/server import.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Task } from "../shared/types.ts";
import { rmTestDataDir } from "./test-data-dir.ts";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-server-stacks-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_API_PORT = "4625";

// `GET /harnesses` probes every registered harness (built-in rows included),
// so pin every kind to a trivial binary: otherwise the route spawns whatever
// real CLIs happen to be installed on the machine and the test competes with
// the whole parallel suite for its budget. Installed in `beforeAll` and
// restored in `afterAll` so the overrides cannot leak into later files in the
// same `bun test` process.
const PINNED_BIN_ENVS = [
  "AGETOR_CLAUDE_BIN",
  "AGETOR_CODEX_BIN",
  "AGETOR_CURSOR_BIN",
  "AGETOR_GEMINI_BIN",
  "AGETOR_FX_BIN",
  "AGETOR_ANTIGRAVITY_BIN",
  "AGETOR_OPENCODE_BIN",
  "AGETOR_COPILOT_BIN",
  "AGETOR_TMUX_BIN",
] as const;
let restoreBins = (): void => {};

const BASE = "http://127.0.0.1:4625";
let token = "";
let server: { stop: () => void } | null = null;
let db: typeof import("./db.ts");
let restore: () => void;

beforeAll(async () => {
  const saved = new Map(PINNED_BIN_ENVS.map((key) => [key, process.env[key]] as const));
  for (const key of PINNED_BIN_ENVS) process.env[key] = "/bin/echo";
  restoreBins = () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  db = await import("./db.ts");
  restore = (await import("./test-harness-state.ts")).snapshotHarnessState();
  const { startApiServer } = await import("./server.ts");
  token = (await import("./api-config.ts")).API_TOKEN;
  for (const [id, kind] of [["api-a", "claude-code"], ["api-b", "claude-code"], ["api-x", "codex"]] as const) {
    const home = path.join(DATA_DIR, "homes", id);
    mkdirSync(home, { recursive: true });
    writeFileSync(path.join(home, ".credentials.json"), "{}");
    db.harnesses.insert({ id, kind, label: id, home, env: {} } as never);
  }
  server = startApiServer() as unknown as { stop: () => void };
});

afterAll(() => {
  server?.stop();
  restore();
  restoreBins();
  rmTestDataDir(DATA_DIR);
});

async function call(method: string, p: string, body?: unknown) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe("harness-stacks routes", () => {
  test("create → get → patch → delete", async () => {
    const created = await call("POST", "/harness-stacks", {
      label: "API train",
      kind: "claude-code",
      members: ["api-a", "api-b"],
      mirrorMode: "safe",
    });
    expect(created.status).toBe(201);
    const id = created.body.stack.id as string;
    expect(created.body.stack.members.map((m: { harnessId: string }) => m.harnessId)).toEqual(["api-a", "api-b"]);
    expect(created.body.mirror).toBeTruthy();

    const got = await call("GET", `/harness-stacks/${id}`);
    expect(got.status).toBe(200);
    expect(got.body.stack.id).toBe(id);

    const patched = await call("PATCH", `/harness-stacks/${id}`, { members: ["api-b", "api-a"] });
    expect(patched.status).toBe(200);
    expect(patched.body.stack.members.map((m: { harnessId: string }) => m.harnessId)).toEqual(["api-b", "api-a"]);

    const list = await call("GET", "/harness-stacks");
    expect(list.body.stacks.some((s: { id: string }) => s.id === id)).toBe(true);
    expect(Array.isArray(list.body.limitStates)).toBe(true);

    const removed = await call("DELETE", `/harness-stacks/${id}`);
    expect(removed.status).toBe(200);
    expect((await call("GET", `/harness-stacks/${id}`)).status).toBe(404);
    // The default 5 s budget is tight for a route that mirrors config between
    // two temp homes while the whole suite runs in parallel; the assertion is
    // about behavior, not latency.
  }, 60_000);

  test("validation returns 400 with blockers", async () => {
    const mixed = await call("POST", "/harness-stacks", {
      label: "bad",
      kind: "claude-code",
      members: ["api-a", "api-x"],
    });
    expect(mixed.status).toBe(400);
    expect(mixed.body.blockers.map((b: { code: string }) => b.code)).toContain("mixed-kinds");

    const missing = await call("POST", "/harness-stacks", { label: "bad" });
    expect(missing.status).toBe(400);
  }, 60_000);

  test("/harnesses carries stacks and limitStates", async () => {
    const created = await call("POST", "/harness-stacks", { label: "payload", kind: "claude-code", members: ["api-a"] });
    const id = created.body.stack.id as string;
    // `/harnesses` is the probe fan-out route: give it room under load.
    const payload = await call("GET", "/harnesses");
    expect(payload.status).toBe(200);
    expect(payload.body.stacks.some((s: { id: string }) => s.id === id)).toBe(true);
    expect(Array.isArray(payload.body.limitStates)).toBe(true);
    await call("DELETE", `/harness-stacks/${id}`);
  }, 60_000);

  test("a live run refuses a manual switch between accounts of the same stack", async () => {
    const created = await call("POST", "/harness-stacks", {
      label: "switch guard",
      kind: "claude-code",
      members: ["api-a", "api-b"],
      mirrorMode: "safe",
    });
    const stackId = created.body.stack.id as string;
    const taskId = randomUUID();
    const runId = randomUUID();
    db.tasks.insert({
      id: taskId,
      title: "switch guard",
      prompt: "p",
      agent: "api-a",
      workdir: DATA_DIR,
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
      speed: "off",
      maxMode: false,
      opencodeServer: "shared",
      references: [],
      backlog: [],
      plans: [],
      draft: null,
      column: "running",
      runId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      hasOpenableRun: false,
      pendingInteractionCount: 0,
      openTerminalCount: 0,
      archivedAt: null,
    } satisfies Task);
    db.runs.insert({
      id: runId,
      taskId,
      agent: "api-a",
      status: "running",
      startedAt: Date.now(),
      endedAt: null,
      exitCode: null,
      tmuxSession: null,
      claudeSessionId: null,
      codexSessionId: null,
      cursorSessionId: null,
      geminiSessionId: null,
      fxSessionId: null,
    });

    try {
      const refused = await call("PATCH", `/tasks/${taskId}`, { agent: "api-b" });
      expect(refused.status).toBe(409);
      expect(refused.body.error).toBe("stop the run before switching accounts");
      // No side effect: the task still points at the account it was running on.
      expect(db.tasks.get(taskId)?.agent).toBe("api-a");

      // Once the run settles the same switch is allowed (the guard is about
      // killing a live run, not about the stack). Seed a transcript so the
      // switch has a conversation to copy: the PATCH must AWAIT that copy
      // (review S3), so by the time the response arrives the handoff and the
      // manual-switch marker are already persisted — not still in flight.
      const sessionId = randomUUID();
      db.runs.update(runId, { status: "succeeded", endedAt: Date.now(), exitCode: 0, claudeSessionId: sessionId });
      const { encodeProjectPath } = await import("./claude-tmux.ts");
      const projectDir = path.join(DATA_DIR, "homes", "api-a", "projects", encodeProjectPath(DATA_DIR));
      mkdirSync(projectDir, { recursive: true, mode: 0o700 });
      writeFileSync(
        path.join(projectDir, `${sessionId}.jsonl`),
        `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "hello" }] } })}\n`,
        { mode: 0o600 },
      );
      const allowed = await call("PATCH", `/tasks/${taskId}`, { agent: "api-b" });
      expect(allowed.status).toBe(200);
      expect(db.tasks.get(taskId)?.agent).toBe("api-b");
      expect(db.tasks.get(taskId)?.harnessState?.lastMove).toMatchObject({
        from: "api-a",
        to: "api-b",
        reason: "manual-switch",
      });
      // The persisted intent is cleared once the copy and state write landed.
      expect(db.tasks.get(taskId)?.harnessState?.pendingSwap ?? null).toBeNull();
      // The response is the post-reconcile row, so the header note is present
      // on the very first paint instead of waiting for a refetch.
      expect(allowed.body.harnessState?.lastMove?.reason).toBe("manual-switch");
      expect(db.harnessSessionHandoffs.get(taskId, "api-b", "claude_session_id")?.sessionId).toBe(sessionId);
    } finally {
      db.runs.update(runId, { status: "failed", endedAt: Date.now(), exitCode: 1 });
      db.tasks.delete(taskId);
      await call("DELETE", `/harness-stacks/${stackId}`);
    }
  }, 60_000);

  test("a crash mid-manual-switch is completed at boot (R15-S3)", async () => {
    const { reconcileHarnessFailover } = await import("./orchestrator.ts");
    const { encodeProjectPath } = await import("./claude-tmux.ts");
    const created = await call("POST", "/harness-stacks", {
      label: "manual crash",
      kind: "claude-code",
      members: ["api-a", "api-b"],
      mirrorMode: "safe",
    });
    const stackId = created.body.stack.id as string;
    const taskId = randomUUID();
    const runId = randomUUID();
    const sessionId = randomUUID();
    const baseTask = {
      id: taskId,
      title: "manual crash",
      prompt: "p",
      workdir: DATA_DIR,
      isolation: "none" as const,
      taskType: "task" as const,
      branch: null,
      branchSource: "created" as const,
      worktreePath: null,
      baseRef: null,
      prUrl: null,
      mode: null,
      model: null,
      effort: null,
      speed: "off" as const,
      maxMode: false,
      opencodeServer: "shared" as const,
      references: [],
      backlog: [],
      plans: [],
      draft: null,
      column: "ready" as const,
      runId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      hasOpenableRun: false,
      pendingInteractionCount: 0,
      openTerminalCount: 0,
      archivedAt: null,
    };
    try {
      // The route committed `agent: api-b` and crashed before the transcript
      // copy: the persisted intent is what boot reconcile reads.
      db.tasks.insert({ ...baseTask, agent: "api-b" } satisfies Task);
      db.runs.insert({
        id: runId,
        taskId,
        agent: "api-a",
        status: "succeeded",
        startedAt: Date.now(),
        endedAt: Date.now(),
        exitCode: 0,
        tmuxSession: null,
        claudeSessionId: sessionId,
        codexSessionId: null,
        cursorSessionId: null,
        geminiSessionId: null,
        fxSessionId: null,
      });
      db.tasks.setHarnessState(taskId, {
        stackId,
        position: 1,
        count: 2,
        tried: [],
        pendingSwap: { from: "api-a", to: "api-b", reason: "quota", runId, startedAt: Date.now(), manual: true },
        allExhausted: null,
        lastMove: null,
      });
      const projectDir = path.join(DATA_DIR, "homes", "api-a", "projects", encodeProjectPath(DATA_DIR));
      mkdirSync(projectDir, { recursive: true, mode: 0o700 });
      writeFileSync(
        path.join(projectDir, `${sessionId}.jsonl`),
        `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "hello" }] } })}\n`,
        { mode: 0o600 },
      );

      await reconcileHarnessFailover();

      // The conversation was copied onto the account the row already names,
      // and the move is recorded exactly like a live manual switch.
      expect(db.harnessSessionHandoffs.get(taskId, "api-b", "claude_session_id")?.sessionId).toBe(sessionId);
      const state = db.tasks.get(taskId)?.harnessState;
      expect(state?.pendingSwap ?? null).toBeNull();
      expect(state?.lastMove).toMatchObject({ from: "api-a", to: "api-b", reason: "manual-switch" });
      expect(db.tasks.get(taskId)?.agent).toBe("api-b");

      // The row update never landed: drop the intent, keep the account, and
      // do not copy anything (nothing was lost).
      db.tasks.update(taskId, { agent: "api-a" });
      db.harnessSessionHandoffs.deleteOne(taskId, "api-b", "claude_session_id");
      db.tasks.setHarnessState(taskId, {
        stackId,
        position: 0,
        count: 2,
        tried: [],
        pendingSwap: { from: "api-a", to: "api-b", reason: "quota", runId, startedAt: Date.now(), manual: true },
        allExhausted: null,
        lastMove: null,
      });
      await reconcileHarnessFailover();
      expect(db.tasks.get(taskId)?.agent).toBe("api-a");
      expect(db.tasks.get(taskId)?.harnessState?.pendingSwap ?? null).toBeNull();
      expect(db.harnessSessionHandoffs.get(taskId, "api-b", "claude_session_id")).toBeNull();
    } finally {
      db.harnessSessionHandoffs.deleteOne(taskId, "api-b", "claude_session_id");
      db.runs.update(runId, { status: "failed", endedAt: Date.now(), exitCode: 1 });
      db.tasks.delete(taskId);
      await call("DELETE", `/harness-stacks/${stackId}`);
    }
  }, 60_000);

  test("a refused harness delete keeps the copied handoff session files (R7-M1)", async () => {
    // A live stacked task's transcript is a copied handoff file owned by the
    // destination account. DELETE used to unlink it (and drop the handoff row)
    // BEFORE the in-use guard refused the request — destroying the live task's
    // conversation while answering 409. Guard first, then clean up.
    const { mkdirSync, writeFileSync, existsSync } = await import("node:fs");
    const harnessId = `api-del-${randomUUID().slice(0, 8)}`;
    const home = path.join(DATA_DIR, "homes", harnessId);
    mkdirSync(home, { recursive: true });
    db.harnesses.insert({ id: harnessId, kind: "claude-code", label: harnessId, home, env: {} } as never);

    const taskId = randomUUID();
    db.tasks.insert({
      id: taskId,
      title: "holds a handoff copy",
      prompt: "p",
      agent: harnessId,
      workdir: DATA_DIR,
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
      speed: "off",
      maxMode: false,
      opencodeServer: "shared",
      references: [],
      backlog: [],
      plans: [],
      draft: null,
      column: "ready",
      runId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      archivedAt: null,
      hasOpenableRun: false,
      pendingInteractionCount: 0,
      openTerminalCount: 0,
    } satisfies Task);
    const copied = path.join(home, "projects", "p", "s.jsonl");
    mkdirSync(path.dirname(copied), { recursive: true });
    writeFileSync(copied, "{}\n");
    db.harnessSessionHandoffs.upsert({
      taskId,
      harnessId,
      columnName: "claude_session_id",
      sessionId: "s",
      copiedPaths: [copied],
      createdAt: Date.now(),
    });

    try {
      const refused = await call("DELETE", `/harnesses/${harnessId}`);
      expect(refused.status).toBe(409);
      expect(existsSync(copied)).toBe(true);
      expect(db.harnessSessionHandoffs.get(taskId, harnessId, "claude_session_id")).not.toBeNull();

      // Once the task no longer references the harness, the same delete
      // succeeds and the copy is cleaned up. (Deleting the task itself would
      // cascade the handoff row away — the task-delete path owns that file
      // cleanup, not this route.)
      db.tasks.update(taskId, { agent: "claude-code" });
      const removed = await call("DELETE", `/harnesses/${harnessId}`);
      expect(removed.status).toBe(204);
      expect(existsSync(copied)).toBe(false);
      expect(db.harnessSessionHandoffs.get(taskId, harnessId, "claude_session_id")).toBeNull();
      expect(db.harnesses.get(harnessId)).toBeNull();
    } finally {
      db.tasks.delete(taskId);
      if (db.harnesses.get(harnessId)) db.harnesses.delete(harnessId);
    }
  }, 60_000);
});
