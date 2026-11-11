// Route-level tests for the harness-stack API (T07): CRUD, validation,
// payloads, and the same-stack live-switch guard. A unique port; the data dir
// is set before db/server import.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
/** Every `server.timeout(req, sec)` call the routes made (finding 19 seam). */
const timeoutCalls: { method: string; path: string; sec: number }[] = [];

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
  // Finding 19 seam: record every `server.timeout(req, sec)` call the routes
  // make. The server object is created inside `startApiServer`, so wrap
  // `Bun.serve` for exactly that call and put the real one back.
  const realServe = Bun.serve;
  (Bun as unknown as { serve: unknown }).serve = (opts: Parameters<typeof Bun.serve>[0]) => {
    const s = realServe.call(Bun, opts) as unknown as { timeout: (req: Request, sec: number) => void };
    const real = s.timeout.bind(s);
    s.timeout = (req: Request, sec: number) => {
      timeoutCalls.push({ method: req.method, path: new URL(req.url).pathname, sec });
      return real(req, sec);
    };
    return s as never;
  };
  try {
    server = startApiServer() as unknown as { stop: () => void };
  } finally {
    (Bun as unknown as { serve: unknown }).serve = realServe;
  }
});

afterAll(() => {
  server?.stop();
  restore();
  restoreBins();
  rmTestDataDir(DATA_DIR);
});

async function call(method: string, p: string, body?: unknown, bearer = token) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** A minimal task row; `patch` overrides any field. */
function seedTaskRow(patch: Partial<Task> = {}): string {
  const id = randomUUID();
  db.tasks.insert({
    id,
    title: "server harness test",
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
    column: "ready",
    runId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    hasOpenableRun: false,
    pendingInteractionCount: 0,
    openTerminalCount: 0,
    archivedAt: null,
    ...patch,
  } satisfies Task);
  return id;
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

      // A "Switch to next account" interrupted the same way keeps its label.
      db.tasks.update(taskId, { agent: "api-b" });
      db.tasks.setHarnessState(taskId, {
        stackId,
        position: 1,
        count: 2,
        tried: [],
        pendingSwap: {
          from: "api-a", to: "api-b", reason: "quota", runId, startedAt: Date.now(), manual: true, switchNow: "scheduled",
        },
        allExhausted: null,
        lastMove: null,
      });
      await reconcileHarnessFailover();
      expect(db.tasks.get(taskId)?.harnessState?.lastMove).toMatchObject({ from: "api-a", to: "api-b", reason: "switch-now" });
      expect(db.tasks.get(taskId)?.harnessState?.pendingSwap ?? null).toBeNull();
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

  test("an account edit that brings an orphaned handoff copy back into its root sweeps it (migration 088)", async () => {
    const { mkdirSync, writeFileSync, existsSync } = await import("node:fs");
    const harnessId = `api-orph-${randomUUID().slice(0, 8)}`;
    const home = path.join(db.dataDir, "homes", harnessId);
    const elsewhere = path.join(db.dataDir, "homes", `${harnessId}-moved`);
    mkdirSync(elsewhere, { recursive: true });
    db.harnesses.insert({ id: harnessId, kind: "claude-code", label: harnessId, home: elsewhere, env: {} } as never);
    const sid = "33333333-3333-4333-8333-333333333333";
    const copied = path.join(home, "projects", "p", `${sid}.jsonl`);
    mkdirSync(path.dirname(copied), { recursive: true });
    writeFileSync(copied, "{}\n");
    db.harnessOrphanedCopies.add(harnessId, "claude_session_id", sid, [copied]);
    try {
      const res = await call("PATCH", `/harnesses/${harnessId}`, { home });
      expect(res.status).toBe(200);
      const deadline = Date.now() + 10_000;
      // The record is dropped after the unlink: wait for both.
      while ((existsSync(copied) || db.harnessOrphanedCopies.list({ harnessId }).length > 0) && Date.now() < deadline) {
        await Bun.sleep(20);
      }
      expect(existsSync(copied)).toBe(false);
      expect(db.harnessOrphanedCopies.list({ harnessId })).toEqual([]);
    } finally {
      if (db.harnesses.get(harnessId)) db.harnesses.delete(harnessId);
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Account roots and the CLI path gate (review M7): `..` refused, paths stored
// normalized, a missing root gated by its nearest existing ancestor, and a
// stack save over a root the CLI token cannot reach refused with 403.
// ---------------------------------------------------------------------------

// A directory the probe can search but not read (`-wx`): a missing child of it
// stats as ENOENT (so an `exists` gate passed it), while the directory itself
// answers `denied`, which is what a `nearest-ancestor` gate must find. Root
// ignores permission bits, so these cases are skipped when run as root.
const IS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;

describe("harness account roots and the CLI path gate", () => {
  let lockedParent = "";
  let locked = "";
  let cliToken = "";
  beforeAll(async () => {
    cliToken = (await import("./api-config.ts")).CLI_TOKEN;
    lockedParent = mkdtempSync(path.join(tmpdir(), "agetor-locked-"));
    locked = path.join(lockedParent, "locked");
    mkdirSync(locked);
    chmodSync(locked, 0o300);
  });
  afterAll(() => {
    chmodSync(locked, 0o700);
    rmSync(lockedParent, { recursive: true, force: true });
  });

  test("POST/PATCH /harnesses refuse a `..` segment in home, bin and a config-root env value, and store paths exactly as given", async () => {
    const id = `api-norm-${randomUUID().slice(0, 8)}`;
    const home = path.join(DATA_DIR, "homes", id);
    const dotted = await call("POST", "/harnesses", { id, kind: "claude-code", label: id, home: `${home}/zz/..` });
    expect(dotted.status).toBe(400);
    expect(dotted.body.error).toContain('".."');
    expect(db.harnesses.get(id)).toBeNull();
    const dottedBin = await call("POST", "/harnesses", { id, kind: "claude-code", label: id, bin: "/usr/../bin/claude" });
    expect(dottedBin.status).toBe(400);
    const dottedEnv = await call("POST", "/harnesses", {
      id,
      kind: "codex",
      label: id,
      env: { CODEX_HOME: `${home}/x/../y` },
    });
    expect(dottedEnv.status).toBe(400);
    expect(dottedEnv.body.error).toContain("CODEX_HOME");

    // The stored spelling is the `CLAUDE_CONFIG_DIR` string Claude hashes into
    // its keychain service name, so a trailing `/`, `//` or `.` is kept as
    // given (R-S7): rewriting it would log the account out.
    const created = await call("POST", "/harnesses", {
      id,
      kind: "claude-code",
      label: id,
      home: `${home}//./acct/`,
      env: { CLAUDE_CONFIG_DIR: `${home}/cfg/./`, OTHER: "/keep/./as/given" },
    });
    expect(created.status).toBe(200);
    try {
      expect(created.body.home).toBe(`${home}//./acct/`);
      expect(created.body.env.CLAUDE_CONFIG_DIR).toBe(`${home}/cfg/./`);
      expect(created.body.env.OTHER).toBe("/keep/./as/given");

      const patched = await call("PATCH", `/harnesses/${id}`, { home: `${home}/a/../b` });
      expect(patched.status).toBe(400);
      const patchedEnv = await call("PATCH", `/harnesses/${id}`, { env: { HOME: "~/../other" } });
      expect(patchedEnv.status).toBe(400);
      expect(db.harnesses.get(id)?.home).toBe(`${home}//./acct/`);
      // A label rename that re-sends the same home and env leaves both
      // byte-identical.
      const relabel = await call("PATCH", `/harnesses/${id}`, {
        label: "renamed",
        home: `${home}//./acct/`,
        env: { CLAUDE_CONFIG_DIR: `${home}/cfg/./`, OTHER: "/keep/./as/given" },
      });
      expect(relabel.status).toBe(200);
      expect(db.harnesses.get(id)?.home).toBe(`${home}//./acct/`);
      expect(db.harnesses.get(id)?.env.CLAUDE_CONFIG_DIR).toBe(`${home}/cfg/./`);
      const ok = await call("PATCH", `/harnesses/${id}`, { home: `${home}/b/` });
      expect(ok.status).toBe(200);
      expect(db.harnesses.get(id)?.home).toBe(`${home}/b/`);
    } finally {
      db.harnesses.delete(id);
    }
  }, 60_000);

  test("POST/PATCH /harnesses refuse a relative or `~` config-root env value for every caller; a blank one stays allowed (R-M2)", async () => {
    const id = `api-relenv-${randomUUID().slice(0, 8)}`;
    const bad = ["relative/acct", "./acct", "~", "~/acct", " /leading/space"];
    for (const key of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "HOME"]) {
      for (const value of bad) {
        for (const bearer of [token, cliToken]) {
          const res = await call("POST", "/harnesses", { id, kind: "claude-code", label: id, env: { [key]: value } }, bearer);
          expect(res.status).toBe(400);
          expect(String(res.body.error)).toContain(key);
          expect(String(res.body.error)).toContain("absolute");
        }
      }
    }
    expect(db.harnesses.get(id)).toBeNull();

    // A blank root value counts as unset everywhere and is stored as given;
    // a non-root key is never checked.
    const created = await call(
      "POST",
      "/harnesses",
      { id, kind: "codex", label: id, env: { CODEX_HOME: "  ", OTHER: "relative/ok" } },
      cliToken,
    );
    expect(created.status).toBe(200);
    try {
      expect(created.body.env).toEqual({ CODEX_HOME: "  ", OTHER: "relative/ok" });
      for (const key of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "HOME"]) {
        for (const value of bad) {
          for (const bearer of [token, cliToken]) {
            const res = await call("PATCH", `/harnesses/${id}`, { env: { [key]: value } }, bearer);
            expect(res.status).toBe(400);
            expect(String(res.body.error)).toContain(key);
          }
        }
      }
      expect(db.harnesses.get(id)?.env).toEqual({ CODEX_HOME: "  ", OTHER: "relative/ok" });
    } finally {
      db.harnesses.delete(id);
    }
  }, 60_000);

  test.skipIf(IS_ROOT)("a CLI-token relative env root under a protected folder no longer slips past the gate (R-M2 repro)", async () => {
    const id = `api-relgate-${randomUUID().slice(0, 8)}`;
    db.harnesses.insert({ id, kind: "claude-code", label: id, home: path.join(DATA_DIR, "homes", id), env: {} } as never);
    const prevCwd = process.cwd();
    // The core's cwd sits next to the protected folder, so `locked/acct`
    // resolves under it for every consumer, while no absolute path names it.
    process.chdir(lockedParent);
    try {
      const rel = await call("PATCH", `/harnesses/${id}`, { env: { CLAUDE_CONFIG_DIR: "locked/acct" } }, cliToken);
      expect(rel.status).toBe(400);
      expect(db.harnesses.get(id)?.env).toEqual({});
      // The absolute spelling of the same folder is the gate's 403.
      const abs = await call("PATCH", `/harnesses/${id}`, { env: { CLAUDE_CONFIG_DIR: path.join(locked, "acct") } }, cliToken);
      expect(abs.status).toBe(403);
      expect(abs.body.code).toBe("path-not-accessible");
    } finally {
      process.chdir(prevCwd);
      db.harnesses.delete(id);
    }
  }, 60_000);

  test.skipIf(IS_ROOT)("a missing home or env root under a protected folder is gated by its nearest ancestor for the CLI token; the app is not gated", async () => {
    const id = `api-gate-${randomUUID().slice(0, 8)}`;
    const missingHome = path.join(locked, "missing", "deeper");
    const viaHome = await call("POST", "/harnesses", { id, kind: "claude-code", label: id, home: missingHome }, cliToken);
    expect(viaHome.status).toBe(403);
    expect(viaHome.body.code).toBe("path-not-accessible");
    const viaEnv = await call(
      "POST",
      "/harnesses",
      { id, kind: "claude-code", label: id, env: { CLAUDE_CONFIG_DIR: path.join(locked, "missing") } },
      cliToken,
    );
    expect(viaEnv.status).toBe(403);
    expect(viaEnv.body.code).toBe("path-not-accessible");
    expect(db.harnesses.get(id)).toBeNull();

    // A missing root under a readable folder still passes for the CLI token.
    const fine = await call(
      "POST",
      "/harnesses",
      { id, kind: "claude-code", label: id, home: path.join(DATA_DIR, "homes", id, "not-yet") },
      cliToken,
    );
    expect(fine.status).toBe(200);
    try {
      const patched = await call("PATCH", `/harnesses/${id}`, { home: missingHome }, cliToken);
      expect(patched.status).toBe(403);
      expect(patched.body.code).toBe("path-not-accessible");
      // The app caller (the user in the desktop UI) is never gated.
      const app = await call("PATCH", `/harnesses/${id}`, { home: missingHome });
      expect(app.status).toBe(200);
      expect(db.harnesses.get(id)?.home).toBe(missingHome);
    } finally {
      db.harnesses.delete(id);
    }
  }, 60_000);

  test.skipIf(IS_ROOT)("a CLI-token stack save over a member root it cannot reach is refused with 403; the app caller is unaffected", async () => {
    const id = `api-denied-${randomUUID().slice(0, 8)}`;
    // Stored directly (as the desktop UI may have): the stack route is what
    // must refuse to mirror into it for the CLI token.
    db.harnesses.insert({ id, kind: "claude-code", label: id, home: path.join(locked, id), env: {} } as never);
    let stackId: string | null = null;
    try {
      const refused = await call(
        "POST",
        "/harness-stacks",
        { label: "denied root", kind: "claude-code", members: ["api-a", id], mirrorMode: "safe" },
        cliToken,
      );
      expect(refused.status).toBe(403);
      expect(refused.body.code).toBe("path-not-accessible");
      expect(db.db.query(`SELECT 1 FROM harness_stack_members WHERE harness_id = ?`).get(id)).toBeNull();

      // Readable roots pass for the CLI token…
      const cliOk = await call(
        "POST",
        "/harness-stacks",
        { label: "cli ok", kind: "claude-code", members: ["api-a"], mirrorMode: "safe" },
        cliToken,
      );
      expect(cliOk.status).toBe(201);
      stackId = cliOk.body.stack.id as string;
      // …but a PATCH adding the denied member is refused too.
      const patchRefused = await call("PATCH", `/harness-stacks/${stackId}`, { members: ["api-a", id] }, cliToken);
      expect(patchRefused.status).toBe(403);
      expect(patchRefused.body.code).toBe("path-not-accessible");

      // The app caller saves the same stack.
      const app = await call("PATCH", `/harness-stacks/${stackId}`, { members: ["api-a", id] });
      expect(app.status).toBe(200);
      expect(app.body.stack.members.map((m: { harnessId: string }) => m.harnessId)).toEqual(["api-a", id]);
    } finally {
      if (stackId) await call("DELETE", `/harness-stacks/${stackId}`);
      db.harnesses.delete(id);
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// S5 (contract C9): PATCH /harnesses/:id re-validates a stack member's root.
// ---------------------------------------------------------------------------

describe("PATCH /harnesses/:id on a stack member", () => {
  test("refuses re-pointing a member at another member's config root (also via a symlink), allows its own new root", async () => {
    const ids = ["a", "b"].map((x) => `api-s5-${x}-${randomUUID().slice(0, 6)}`);
    for (const id of ids) {
      const home = path.join(DATA_DIR, "homes", id);
      mkdirSync(home, { recursive: true });
      writeFileSync(path.join(home, ".credentials.json"), "{}");
      db.harnesses.insert({ id, kind: "claude-code", label: id, home, env: {} } as never);
    }
    const created = await call("POST", "/harness-stacks", { label: "s5", kind: "claude-code", members: ids, mirrorMode: "safe" });
    expect(created.status).toBe(201);
    const stackId = created.body.stack.id as string;
    const homeA = path.join(DATA_DIR, "homes", ids[0]!);
    const homeB = path.join(DATA_DIR, "homes", ids[1]!);
    const alias = path.join(DATA_DIR, "homes", `alias-${ids[0]}`);
    symlinkSync(homeA, alias);
    try {
      const direct = await call("PATCH", `/harnesses/${ids[1]}`, { home: homeA });
      expect(direct.status).toBe(400);
      expect(String(direct.body.error)).toContain(ids[0]!);
      const viaLink = await call("PATCH", `/harnesses/${ids[1]}`, { home: alias });
      expect(viaLink.status).toBe(400);
      const viaEnv = await call("PATCH", `/harnesses/${ids[1]}`, { env: { CLAUDE_CONFIG_DIR: homeA } });
      expect(viaEnv.status).toBe(400);
      expect(db.harnesses.get(ids[1]!)?.home).toBe(homeB);
      expect(db.harnesses.get(ids[1]!)?.env).toEqual({});

      const own = path.join(DATA_DIR, "homes", `${ids[1]}-moved`);
      const moved = await call("PATCH", `/harnesses/${ids[1]}`, { home: own });
      expect(moved.status).toBe(200);
      expect(db.harnesses.get(ids[1]!)?.home).toBe(own);
    } finally {
      await call("DELETE", `/harness-stacks/${stackId}`);
      for (const id of ids) db.harnesses.delete(id);
    }
  }, 60_000);
});

// An account edit that moves a backup away from the folder the config mirror
// keeps records and saved originals for is refused until confirmed.
// ---------------------------------------------------------------------------

describe("PATCH /harnesses/:id that would drop the account's mirror records", () => {
  test("refused 409 mirror-records without confirmMirrorDrop (nothing applied); saved with it; never asked when nothing would drop", async () => {
    const ids = ["p", "b", "fresh"].map((x) => `api-md-${x}-${randomUUID().slice(0, 6)}`);
    const homes = ids.map((id) => path.join(DATA_DIR, "homes", id));
    ids.forEach((id, i) => {
      mkdirSync(homes[i]!, { recursive: true });
      db.harnesses.insert({ id, kind: "claude-code", label: `Label ${id}`, home: homes[i]!, env: {} } as never);
    });
    writeFileSync(path.join(homes[0]!, "CLAUDE.md"), "primary\n");
    writeFileSync(path.join(homes[1]!, "CLAUDE.md"), "mine\n");
    const created = await call("POST", "/harness-stacks", { label: "md", kind: "claude-code", members: [ids[0], ids[1]], mirrorMode: "full" });
    expect(created.status).toBe(201);
    const stackId = created.body.stack.id as string;
    try {
      const moved = path.join(DATA_DIR, "homes", `${ids[1]}-moved`);
      mkdirSync(moved, { recursive: true });

      const refused = await call("PATCH", `/harnesses/${ids[1]}`, { home: moved, enabled: false });
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe("mirror-records");
      expect(String(refused.body.error)).toContain(`Label ${ids[1]}`);
      expect(String(refused.body.error)).toContain("config folder");
      expect(String(refused.body.error)).toContain(path.resolve(homes[1]!));
      expect(refused.body.folders[0].what).toBe("config folder");
      expect(refused.body.folders[0].savedOriginals).toBe(1);
      // Nothing of the refused body was applied, the toggle included.
      expect(db.harnesses.get(ids[1]!)?.home).toBe(homes[1]!);
      expect(db.harnesses.get(ids[1]!)?.enabled).toBe(true);

      // An edit that keeps the folders is never asked.
      expect((await call("PATCH", `/harnesses/${ids[1]}`, { label: "renamed" })).status).toBe(200);
      expect((await call("PATCH", `/harnesses/${ids[1]}`, { home: homes[1]! })).status).toBe(200);
      expect((await call("PATCH", `/harnesses/${ids[1]}`, { home: moved, confirmMirrorDrop: "yes" })).status).toBe(400);

      const confirmed = await call("PATCH", `/harnesses/${ids[1]}`, { home: moved, confirmMirrorDrop: true });
      expect(confirmed.status).toBe(200);
      expect(db.harnesses.get(ids[1]!)?.home).toBe(moved);

      // An account with no mirror records re-points without a question.
      const fresh = await call("PATCH", `/harnesses/${ids[2]}`, { home: path.join(DATA_DIR, "homes", `${ids[2]}-moved`) });
      expect(fresh.status).toBe(200);
    } finally {
      await call("DELETE", `/harness-stacks/${stackId}`);
      for (const id of ids) await call("DELETE", `/harnesses/${id}`);
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// M5 server part (contract C3): moving a card out of `blocked` cancels the
// armed all-exhausted retry.
// ---------------------------------------------------------------------------

describe("PATCH /tasks/:id column move off blocked", () => {
  test("cancels the armed retry timer, clears allExhausted, and the timer never fires", async () => {
    const failover = await import("./harness-failover.ts");
    const fired: string[] = [];
    const prev = failover.setHarnessFailoverHooks({
      onAutoRetry: async (taskId) => {
        fired.push(taskId);
      },
      onReconcileSwap: async () => {},
    });
    const at = Date.now() + 400;
    const taskId = seedTaskRow({ column: "blocked" });
    db.tasks.setHarnessState(taskId, {
      stackId: "s-none",
      position: 0,
      tried: ["api-a"],
      pendingSwap: null,
      allExhausted: { at: Date.now(), attempts: 1, max: 3, nextAttemptAt: at, earliestResetAtMs: null, reason: "quota" },
      lastMove: null,
    });
    failover.armAutoRetry(taskId, at);
    try {
      const moved = await call("PATCH", `/tasks/${taskId}`, { column: "ready" });
      expect(moved.status).toBe(200);
      expect(db.tasks.get(taskId)?.column).toBe("ready");
      expect(db.tasks.get(taskId)?.harnessState?.allExhausted ?? null).toBeNull();
      await new Promise((r) => setTimeout(r, 800));
      expect(fired).toEqual([]);
    } finally {
      failover.cancelAutoRetry(taskId);
      failover.setHarnessFailoverHooks(prev);
      db.tasks.delete(taskId);
    }
  }, 30_000);

  test("a PATCH that keeps the card in blocked leaves the armed retry alone", async () => {
    const taskId = seedTaskRow({ column: "blocked" });
    const exhausted = { at: Date.now(), attempts: 1, max: 3, nextAttemptAt: Date.now() + 60_000, earliestResetAtMs: null, reason: "quota" as const };
    db.tasks.setHarnessState(taskId, { stackId: "s-none", position: 0, tried: [], pendingSwap: null, allExhausted: exhausted, lastMove: null });
    try {
      const renamed = await call("PATCH", `/tasks/${taskId}`, { title: "still blocked" });
      expect(renamed.status).toBe(200);
      expect(db.tasks.get(taskId)?.harnessState?.allExhausted).toEqual(exhausted);
    } finally {
      db.tasks.delete(taskId);
    }
  }, 30_000);
});

describe("review S1 / S10 route guards", () => {
  test("PATCH /tasks/:id refuses a prompt that is exactly the hidden continuation wrapper", async () => {
    const { wrapHarnessStackContinuation, isHarnessStackContinuation } = await import("../shared/harness-stack.ts");
    const taskId = seedTaskRow();
    try {
      const hidden = wrapHarnessStackContinuation("do something the user cannot see");
      expect(isHarnessStackContinuation(hidden)).toBe(true);
      const refused = await call("PATCH", `/tasks/${taskId}`, { prompt: hidden });
      expect(refused.status).toBe(400);
      expect(refused.body?.code).toBe("hidden-continuation");
      expect(db.tasks.get(taskId)?.prompt).toBe("p");
      // Merely mentioning the tag stays allowed.
      const mention = "explain what the <harness-stack-continuation> tag is for";
      const ok = await call("PATCH", `/tasks/${taskId}`, { prompt: mention });
      expect(ok.status).toBe(200);
      expect(db.tasks.get(taskId)?.prompt).toBe(mention);
    } finally {
      db.tasks.delete(taskId);
    }
  }, 30_000);

  test("DELETE /harness-stacks/:id clears a task whose account resolves to the stack even when its state names another stack id", async () => {
    const failover = await import("./harness-failover.ts");
    const fired: string[] = [];
    const prev = failover.setHarnessFailoverHooks({
      onAutoRetry: async (taskId) => {
        fired.push(taskId);
      },
      onReconcileSwap: async () => {},
    });
    const created = await call("POST", "/harness-stacks", { label: "S10", kind: "claude-code", members: ["api-a", "api-b"] });
    expect(created.status).toBe(201);
    const stackId = created.body.stack.id as string;
    const at = Date.now() + 400;
    const taskId = seedTaskRow({ column: "blocked", agent: "api-a" });
    // A raw write naming a stale stack id: the stored-id filter alone misses it.
    db.tasks.setHarnessState(taskId, {
      stackId: "an-older-stack",
      position: 0,
      tried: ["api-a", "api-b"],
      pendingSwap: null,
      allExhausted: { at: Date.now(), attempts: 1, max: 3, nextAttemptAt: at, earliestResetAtMs: null, reason: "quota" },
      lastMove: null,
    });
    failover.armAutoRetry(taskId, at);
    try {
      const removed = await call("DELETE", `/harness-stacks/${stackId}`);
      expect(removed.status).toBe(200);
      expect(db.tasks.get(taskId)?.harnessState ?? null).toBeNull();
      await new Promise((r) => setTimeout(r, 800));
      expect(fired).toEqual([]);
    } finally {
      failover.cancelAutoRetry(taskId);
      failover.setHarnessFailoverHooks(prev);
      db.tasks.delete(taskId);
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// N13: the `?limit=` rebuild snapshot's first-load anchor skips the hidden
// continuation agetor sends after a swap.
// ---------------------------------------------------------------------------

describe("rebuild-events anchor", () => {
  test("anchors on the user's last real message, not a hidden harness-stack continuation", async () => {
    const { encodeProjectPath } = await import("./claude-tmux.ts");
    const cwd = path.join(DATA_DIR, `anchor-cwd-${randomUUID().slice(0, 8)}`);
    const sessionId = randomUUID();
    const taskId = seedTaskRow({ workdir: cwd });
    const runId = randomUUID();
    db.runs.insert({
      id: runId, taskId, agent: "api-a", status: "succeeded",
      startedAt: Date.now(), endedAt: Date.now() + 1, exitCode: 0,
      tmuxSession: null, claudeSessionId: sessionId, codexSessionId: null, cursorSessionId: null, geminiSessionId: null, fxSessionId: null,
    });
    const projectDir = path.join(DATA_DIR, "homes", "api-a", "projects", encodeProjectPath(cwd));
    mkdirSync(projectDir, { recursive: true });
    const user = (content: string) => JSON.stringify({ type: "user", uuid: randomUUID(), message: { content } });
    const assistant = (text: string) =>
      JSON.stringify({ type: "assistant", uuid: randomUUID(), message: { content: [{ type: "text", text }] } });
    const continuation = '<pasted_content id="ab12">\n<harness-stack-continuation>\nContinue the task.\n</harness-stack-continuation>\n</pasted_content id="ab12">';
    const lines = [
      user("the user's real message"),
      ...Array.from({ length: 900 }, (_, i) => assistant(`A${i}`)),
      user(continuation),
      ...Array.from({ length: 10 }, (_, i) => assistant(`B${i}`)),
    ];
    writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), lines.join("\n") + "\n");
    try {
      const res = await call("GET", `/runs/${runId}/rebuild-events?limit=800`);
      expect(res.status).toBe(200);
      const events = res.body.events as Array<{ stream: string; data: string }>;
      expect(events[0]).toMatchObject({ stream: "user", data: "the user's real message" });
      expect(res.body.hasMore).toBe(false);
    } finally {
      db.runs.update(runId, { status: "failed" });
      db.tasks.delete(taskId);
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// N3 / CR5: the same-stack switch through PATCH /tasks/:id refuses a task held
// by background agents, and for the CLI token re-gates both members' roots
// (a root re-pointed into a protected folder after the stack save).
// ---------------------------------------------------------------------------

describe("same-stack switch guards on PATCH /tasks/:id", () => {
  test("a task held by running background agents refuses the switch (N3)", async () => {
    const created = await call("POST", "/harness-stacks", { label: "held", kind: "claude-code", members: ["api-a", "api-b"] });
    expect(created.status).toBe(201);
    const stackId = created.body.stack.id as string;
    const runId = randomUUID();
    const taskId = seedTaskRow({ column: "running", runId });
    db.runs.insert({
      id: runId, taskId, agent: "api-a", status: "succeeded",
      startedAt: Date.now(), endedAt: Date.now(), exitCode: 0,
      tmuxSession: null, claudeSessionId: null, codexSessionId: null, cursorSessionId: null, geminiSessionId: null, fxSessionId: null,
    });
    const subagentId = `held-${randomUUID().slice(0, 8)}`;
    db.subagents.insertIfAbsent({
      id: subagentId, taskId, runId, parentKind: "subagent", agentType: "Explore", description: "bg",
      spawnDepth: 1, sourcePath: path.join(DATA_DIR, `${subagentId}.jsonl`), status: "running", startedAt: Date.now(), endedAt: null,
    });
    try {
      const refused = await call("PATCH", `/tasks/${taskId}`, { agent: "api-b" });
      expect(refused.status).toBe(409);
      expect(refused.body.error).toBe("stop the background agents before switching accounts");
      expect(refused.body.code).toBe("background-agents");
      expect(db.tasks.get(taskId)?.agent).toBe("api-a");
      expect(db.tasks.get(taskId)?.harnessState?.pendingSwap ?? null).toBeNull();
    } finally {
      db.subagents.setStatus(subagentId, "completed", Date.now());
      db.tasks.delete(taskId);
      await call("DELETE", `/harness-stacks/${stackId}`);
    }
  }, 60_000);

  test("a FAILED turn whose background agents are still running refuses the switch exactly like a held one (Q1)", async () => {
    const created = await call("POST", "/harness-stacks", { label: "failed-held", kind: "claude-code", members: ["api-a", "api-b"] });
    expect(created.status).toBe(201);
    const stackId = created.body.stack.id as string;
    const runId = randomUUID();
    // An API error ended the turn (card blocked) while a background agent
    // kept running in the REPL.
    const taskId = seedTaskRow({ column: "blocked", runId });
    db.runs.insert({
      id: runId, taskId, agent: "api-a", status: "failed",
      startedAt: Date.now(), endedAt: Date.now(), exitCode: 1,
      tmuxSession: null, claudeSessionId: null, codexSessionId: null, cursorSessionId: null, geminiSessionId: null, fxSessionId: null,
    });
    const subagentId = `failheld-${randomUUID().slice(0, 8)}`;
    db.subagents.insertIfAbsent({
      id: subagentId, taskId, runId, parentKind: "subagent", agentType: "Explore", description: "bg",
      spawnDepth: 1, sourcePath: path.join(DATA_DIR, `${subagentId}.jsonl`), status: "running", startedAt: Date.now(), endedAt: null,
    });
    try {
      const refused = await call("PATCH", `/tasks/${taskId}`, { agent: "api-b" });
      expect(refused.status).toBe(409);
      expect(refused.body.error).toBe("stop the background agents before switching accounts");
      expect(refused.body.code).toBe("background-agents");
      expect(db.tasks.get(taskId)?.agent).toBe("api-a");
      expect(db.tasks.get(taskId)?.harnessState?.pendingSwap ?? null).toBeNull();
    } finally {
      db.subagents.setStatus(subagentId, "completed", Date.now());
      db.tasks.delete(taskId);
      await call("DELETE", `/harness-stacks/${stackId}`);
    }
  }, 60_000);

  test.skipIf(IS_ROOT)("a CLI-token switch re-gates both members' roots: a root re-pointed into a protected folder after the save is refused (CR5)", async () => {
    const cliToken = (await import("./api-config.ts")).CLI_TOKEN;
    const ids = ["a", "b"].map((x) => `api-cr5-${x}-${randomUUID().slice(0, 6)}`);
    const homes = ids.map((id) => path.join(DATA_DIR, "homes", id));
    for (const [i, id] of ids.entries()) {
      mkdirSync(homes[i]!, { recursive: true });
      writeFileSync(path.join(homes[i]!, ".credentials.json"), "{}");
      writeFileSync(path.join(homes[i]!, "settings.json"), JSON.stringify({ theme: "dark" }));
      db.harnesses.insert({ id, kind: "claude-code", label: id, home: homes[i]!, env: {} } as never);
    }
    // Saved through the CLI token while both roots were readable.
    const created = await call("POST", "/harness-stacks", { label: "cr5", kind: "claude-code", members: ids, mirrorMode: "safe" }, cliToken);
    expect(created.status).toBe(201);
    const stackId = created.body.stack.id as string;
    // Then the backup's root is swapped for a symlink into a folder the
    // disclaimed probe cannot read (the stand-in for a TCC-protected one).
    const lockedParent = mkdtempSync(path.join(tmpdir(), "agetor-cr5-"));
    const target = path.join(lockedParent, "acct");
    mkdirSync(target);
    chmodSync(target, 0o300);
    rmSync(homes[1]!, { recursive: true, force: true });
    symlinkSync(target, homes[1]!);
    const taskId = seedTaskRow({ agent: ids[0]! });
    try {
      const into = await call("PATCH", `/tasks/${taskId}`, { agent: ids[1] }, cliToken);
      expect(into.status).toBe(403);
      expect(into.body.code).toBe("path-not-accessible");
      expect(db.tasks.get(taskId)?.agent).toBe(ids[0]);
      expect(db.tasks.get(taskId)?.harnessState?.pendingSwap ?? null).toBeNull();

      // The CURRENT member's root is gated too: switching out of it is refused.
      db.tasks.update(taskId, { agent: ids[1]! });
      const outOf = await call("PATCH", `/tasks/${taskId}`, { agent: ids[0] }, cliToken);
      expect(outOf.status).toBe(403);
      expect(outOf.body.code).toBe("path-not-accessible");
      expect(db.tasks.get(taskId)?.agent).toBe(ids[1]);

      chmodSync(target, 0o700);
      // Nothing was mirrored into the protected target.
      expect(readdirSync(target)).toEqual([]);

      // Readable roots on both sides: the CLI switch goes through.
      const ok = await call("PATCH", `/tasks/${taskId}`, { agent: ids[0] }, cliToken);
      expect(ok.status).toBe(200);
      expect(db.tasks.get(taskId)?.agent).toBe(ids[0]);
    } finally {
      chmodSync(target, 0o700);
      db.tasks.delete(taskId);
      await call("DELETE", `/harness-stacks/${stackId}`);
      for (const id of ids) db.harnesses.delete(id);
      rmSync(lockedParent, { recursive: true, force: true });
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// CR1: server routes that READ an account's claude files use the directory
// claude actually reads (claudeConfigDirFor), which for an account whose only
// root setting is an env-map HOME is `<HOME>/.claude`, not the spawn pin.
// ---------------------------------------------------------------------------

describe("claude file readers follow claudeConfigDirFor", () => {
  test("account-usage and rebuild-events read `<HOME>/.claude` for an env-map-HOME-only account", async () => {
    const prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_CONFIG_DIR;
    const id = `api-envhome-${randomUUID().slice(0, 8)}`;
    const envHome = path.join(DATA_DIR, "envhomes", id);
    mkdirSync(envHome, { recursive: true });
    db.harnesses.insert({ id, kind: "claude-code", label: id, home: null, env: { HOME: envHome } } as never);
    const { encodeProjectPath } = await import("./claude-tmux.ts");
    const cwd = path.join(DATA_DIR, `envhome-cwd-${randomUUID().slice(0, 8)}`);
    const sessionId = randomUUID();
    const taskId = seedTaskRow({ workdir: cwd, agent: id });
    const runId = randomUUID();
    db.runs.insert({
      id: runId, taskId, agent: id, status: "succeeded",
      startedAt: Date.now(), endedAt: Date.now() + 1, exitCode: 0,
      tmuxSession: null, claudeSessionId: sessionId, codexSessionId: null, cursorSessionId: null, geminiSessionId: null, fxSessionId: null,
    });
    const projectDir = path.join(envHome, ".claude", "projects", encodeProjectPath(cwd));
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      path.join(projectDir, `${sessionId}.jsonl`),
      `${JSON.stringify({ type: "user", uuid: randomUUID(), message: { content: "hello from the env-home account" } })}\n`,
    );
    try {
      const usage = await call("GET", `/harnesses/${id}/account-usage`);
      expect(usage.status).toBe(200);
      expect(usage.body.configDir).toBe(path.join(envHome, ".claude"));

      const rebuilt = await call("GET", `/runs/${runId}/rebuild-events`);
      expect(rebuilt.status).toBe(200);
      expect(rebuilt.body.reason).toBeUndefined();
      expect((rebuilt.body.events as Array<{ stream: string; data: string }>).some(
        (e) => e.stream === "user" && e.data === "hello from the env-home account",
      )).toBe(true);
    } finally {
      if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
      db.runs.update(runId, { status: "failed" });
      db.tasks.delete(taskId);
      db.harnesses.delete(id);
    }
  }, 30_000);
});

describe("fix-round routes: cooldown clear, history, preview, restore, switch, concurrency", () => {
  test("DELETE /harnesses/:id/limit-state: 404 for an unknown account; clears all rows or one model's", async () => {
    expect((await call("DELETE", "/harnesses/nope-acct/limit-state")).status).toBe(404);
    const { harnessStacks } = await import("./harness-stacks.ts");
    const base = { reason: "quota" as const, source: "claude-api-error" as const, message: "limit", resetAtMs: Date.now() + 3_600_000 };
    harnessStacks.setLimitState("api-x", base);
    harnessStacks.setLimitState("api-x", { ...base, model: "gpt-x" });
    const rows = (await call("GET", "/harnesses")).body.limitStates as { harnessId: string; model: string | null }[];
    expect(rows.filter((r) => r.harnessId === "api-x").map((r) => r.model).sort()).toEqual([null, "gpt-x"].sort());

    const one = await call("DELETE", "/harnesses/api-x/limit-state?model=%20GPT-X%20");
    expect(one.status).toBe(200);
    expect(one.body.cleared).toBe(true);
    expect((one.body.limitStates as { harnessId: string }[]).filter((r) => r.harnessId === "api-x")).toHaveLength(1);

    const all = await call("DELETE", "/harnesses/api-x/limit-state");
    expect(all.status).toBe(200);
    expect((all.body.limitStates as { harnessId: string }[]).some((r) => r.harnessId === "api-x")).toBe(false);
  });

  test("DELETE /harnesses/:id/limit-state?scope=account clears only the account-wide row; the response carries rearmed", async () => {
    const { harnessStacks } = await import("./harness-stacks.ts");
    const base = { reason: "quota" as const, source: "claude-api-error" as const, message: "limit", resetAtMs: Date.now() + 3_600_000 };
    harnessStacks.setLimitState("api-x", base);
    harnessStacks.setLimitState("api-x", { ...base, model: "gpt-x" });
    const res = await call("DELETE", "/harnesses/api-x/limit-state?scope=account");
    expect(res.status).toBe(200);
    expect(typeof res.body.rearmed).toBe("number");
    const left = (res.body.limitStates as { harnessId: string; model: string | null }[]).filter((r) => r.harnessId === "api-x");
    expect(left.map((r) => r.model)).toEqual(["gpt-x"]);
    await call("DELETE", "/harnesses/api-x/limit-state");
  });

  test("GET /harnesses lists accounts with mirror records; deleting the account drops them", async () => {
    const id = `api-mr-${randomUUID().slice(0, 6)}`;
    const home = path.join(DATA_DIR, "homes", id);
    mkdirSync(home, { recursive: true });
    db.harnesses.insert({ id, kind: "claude-code", label: id, home, env: {} } as never);
    db.db.run(
      `INSERT INTO harness_mirror_provenance (harness_id, stack_id, scope, path, key, preexisted, updated_at)
       VALUES (?, NULL, 'file', 'settings.json', '', 0, ?)`,
      [id, Date.now()],
    );
    const listed = await call("GET", "/harnesses");
    expect(listed.body.mirrorRestorable as string[]).toContain(id);
    expect((await call("DELETE", `/harnesses/${id}`)).status).toBe(204);
    const count = db.db.query("SELECT COUNT(*) AS n FROM harness_mirror_provenance WHERE harness_id = ?").get(id) as { n: number };
    expect(count.n).toBe(0);
    expect((await call("GET", "/harnesses")).body.mirrorRestorable as string[]).not.toContain(id);
  }, 30_000);

  test.skipIf(IS_ROOT)("a CLI-token mirror-preview is path-gated BEFORE validation: a protected root answers 403, not the validator's 400", async () => {
    const cliToken = (await import("./api-config.ts")).CLI_TOKEN;
    const id = `api-mp-${randomUUID().slice(0, 6)}`;
    const home = path.join(DATA_DIR, "homes", id);
    const lockedParent = mkdtempSync(path.join(tmpdir(), "agetor-mp-"));
    const target = path.join(lockedParent, "acct");
    mkdirSync(target);
    chmodSync(target, 0o300);
    symlinkSync(target, home);
    db.harnesses.insert({ id, kind: "claude-code", label: id, home, env: {} } as never);
    try {
      // A duplicate member is a validator blocker (400) if validation ran first.
      const res = await call("POST", "/harness-stacks/mirror-preview", { kind: "claude-code", members: [id, id] }, cliToken);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("path-not-accessible");
      // The app caller is never gated and still gets the validator's answer.
      const app = await call("POST", "/harness-stacks/mirror-preview", { kind: "claude-code", members: [id, id] });
      expect(app.status).toBe(400);
    } finally {
      chmodSync(target, 0o700);
      db.harnesses.delete(id);
    }
  });

  test("GET /harness-stacks/:id/history: 404 unknown, empty page for a fresh stack", async () => {
    expect((await call("GET", "/harness-stacks/nope/history")).status).toBe(404);
    const created = await call("POST", "/harness-stacks", { label: "History", kind: "claude-code", members: ["api-a", "api-b"], mirrorMode: "safe" });
    const id = created.body.stack.id as string;
    const page = await call("GET", `/harness-stacks/${id}/history?limit=9999&before=garbage`);
    expect(page.status).toBe(200);
    expect(page.body).toEqual({ events: [], nextCursor: null });
    await call("DELETE", `/harness-stacks/${id}`);
  }, 60_000);

  test("POST /harness-stacks/mirror-preview validates the draft and answers a preview", async () => {
    expect((await call("POST", "/harness-stacks/mirror-preview", { kind: "gemini", members: [] })).status).toBe(400);
    expect((await call("POST", "/harness-stacks/mirror-preview", { kind: "claude-code", members: "x" })).status).toBe(400);
    expect((await call("POST", "/harness-stacks/mirror-preview", { kind: "claude-code", members: ["api-a"], stackId: "nope" })).status).toBe(404);
    const blocked = await call("POST", "/harness-stacks/mirror-preview", { kind: "claude-code", members: ["api-a", "api-a"] });
    expect(blocked.status).toBe(400);
    expect(Array.isArray(blocked.body.blockers)).toBe(true);
    const ok = await call("POST", "/harness-stacks/mirror-preview", { kind: "claude-code", members: ["api-a", "api-b"], mirrorMode: "safe" });
    expect(ok.status).toBe(200);
    expect(Array.isArray(ok.body.plans)).toBe(true);
    expect(typeof ok.body.overwrites).toBe("boolean");
  }, 60_000);

  test("POST /harnesses/:id/mirror-restore: 404 unknown, 200 with a result for a known account", async () => {
    expect((await call("POST", "/harnesses/nope-acct/mirror-restore")).status).toBe(404);
    const ok = await call("POST", "/harnesses/api-b/mirror-restore");
    expect(ok.status).toBe(200);
    expect(ok.body.harnessId).toBe("api-b");
  }, 60_000);

  test("POST/DELETE /tasks/:id/switch-account: 404 unknown, 409 archived", async () => {
    expect((await call("POST", "/tasks/nope/switch-account")).status).toBe(404);
    expect((await call("DELETE", "/tasks/nope/switch-account")).status).toBe(404);
    const archived = seedTaskRow({ archivedAt: Date.now() });
    const refused = await call("POST", `/tasks/${archived}/switch-account`);
    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({ error: "this task is archived", code: "archived" });
  });

  test("PATCH /harness-stacks/:id with a stale expectedUpdatedAt answers 409 stack-changed with the stored stack", async () => {
    const created = await call("POST", "/harness-stacks", { label: "Concurrent", kind: "claude-code", members: ["api-a", "api-b"], mirrorMode: "safe" });
    const stack = created.body.stack as { id: string; updatedAt: number };
    const fresh = await call("PATCH", `/harness-stacks/${stack.id}`, { label: "Concurrent 2", expectedUpdatedAt: stack.updatedAt });
    expect(fresh.status).toBe(200);
    const stale = await call("PATCH", `/harness-stacks/${stack.id}`, { label: "Concurrent 3", expectedUpdatedAt: stack.updatedAt });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("stack-changed");
    expect(stale.body.stack.label).toBe("Concurrent 2");
    expect((await call("PATCH", `/harness-stacks/${stack.id}`, { expectedUpdatedAt: "x" })).status).toBe(400);
    await call("DELETE", `/harness-stacks/${stack.id}`);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// TT-E (fix round, TT7): every new route's 404 / 409 / happy / CLI-gate shape,
// the stack PATCH concurrency write-nothing guarantee, stack delete (22b),
// harness-delete backups, the cooldown `rearmed` count and the finding-19
// idle-timeout lift.
// ---------------------------------------------------------------------------
describe("TT-E: fix-round routes (shapes, gates, 22b, finding 19)", () => {
  const cleanup: (() => void | Promise<void>)[] = [];
  afterAll(async () => {
    for (const fn of cleanup.reverse()) await fn();
  });

  /** A readable claude-code account with a login file. */
  function makeAccount(tag: string): string {
    const id = `tte-${tag}-${randomUUID().slice(0, 6)}`;
    const home = path.join(DATA_DIR, "homes", id);
    mkdirSync(home, { recursive: true });
    writeFileSync(path.join(home, ".credentials.json"), "{}");
    writeFileSync(path.join(home, "settings.json"), JSON.stringify({ theme: "dark" }));
    db.harnesses.insert({ id, kind: "claude-code", label: id, home, env: {} } as never);
    cleanup.push(() => {
      try {
        db.harnesses.delete(id);
      } catch {}
    });
    return id;
  }

  async function makeStack(members: string[], label = "tte"): Promise<string> {
    const created = await call("POST", "/harness-stacks", { label, kind: "claude-code", members, mirrorMode: "safe" });
    expect(created.status).toBe(201);
    const id = created.body.stack.id as string;
    cleanup.push(async () => {
      await call("DELETE", `/harness-stacks/${id}`);
    });
    return id;
  }

  /** Re-point an account's home at a folder the disclaimed probe cannot read. */
  function lockHome(id: string): () => void {
    const home = path.join(DATA_DIR, "homes", id);
    const parent = mkdtempSync(path.join(tmpdir(), "agetor-tte-"));
    const target = path.join(parent, "acct");
    mkdirSync(target);
    chmodSync(target, 0o300);
    rmSync(home, { recursive: true, force: true });
    symlinkSync(target, home);
    let done = false;
    const unlock = () => {
      if (done) return;
      done = true;
      chmodSync(target, 0o700);
      rmSync(home, { force: true });
      mkdirSync(home, { recursive: true });
      writeFileSync(path.join(home, ".credentials.json"), "{}");
      rmSync(parent, { recursive: true, force: true });
    };
    cleanup.push(unlock);
    return unlock;
  }

  function seedRun(taskId: string, agent: string, status: "running" | "succeeded"): string {
    const runId = randomUUID();
    db.runs.insert({
      id: runId, taskId, agent, status,
      startedAt: Date.now(), endedAt: status === "running" ? null : Date.now(), exitCode: status === "running" ? null : 0,
      tmuxSession: null, claudeSessionId: null, codexSessionId: null, cursorSessionId: null, geminiSessionId: null, fxSessionId: null,
    });
    return runId;
  }

  const statusLines = (runId: string) => db.runs.events(runId).filter((e) => e.stream === "status").map((e) => e.data);
  const exhaustedState = (at: number) => ({ at, attempts: 0, max: 3, nextAttemptAt: at, earliestResetAtMs: null, reason: "quota" as const });
  const baseState = (stackId: string) => ({ stackId, position: 0, count: 2, tried: [] as string[], pendingSwap: null, allExhausted: null, lastMove: null });

  // ---- DELETE /harnesses/:id/limit-state ---------------------------------

  test("limit-state: ?model wins over ?scope=account; mixed-case is normalised; an account-wide-only clear keeps the model row", async () => {
    const id = makeAccount("ls");
    const { harnessStacks } = await import("./harness-stacks.ts");
    const base = { reason: "quota" as const, source: "claude-api-error" as const, message: "m", resetAtMs: Date.now() + 3_600_000 };
    harnessStacks.setLimitState(id, base);
    harnessStacks.setLimitState(id, { ...base, model: "sonnet-x" });
    const res = await call("DELETE", `/harnesses/${id}/limit-state?scope=account&model=SONNET-X`);
    expect(res.status).toBe(200);
    const left = (res.body.limitStates as { harnessId: string; model: string | null }[]).filter((r) => r.harnessId === id);
    // The model param took precedence: only the account-wide row is left.
    expect(left.map((r) => r.model)).toEqual([null]);
    await call("DELETE", `/harnesses/${id}/limit-state`);
    // An unknown model clears nothing but still answers 200.
    expect((await call("DELETE", `/harnesses/${id}/limit-state?model=nope`)).status).toBe(200);
  });

  test("limit-state: `rearmed` counts a blocked task waiting on the cleared account and pulls its retry in; others are untouched", async () => {
    const [a, b, c, d] = ["a", "b", "c", "d"].map((x) => makeAccount(`rm${x}`)) as [string, string, string, string];
    const stack = await makeStack([a, b], "rearm");
    const other = await makeStack([c, d], "rearm-other");
    const { harnessStacks } = await import("./harness-stacks.ts");
    const failover = await import("./harness-failover.ts");
    harnessStacks.setLimitState(b, { reason: "quota", source: "claude-api-error", message: "m", resetAtMs: Date.now() + 36_000_000 });
    const far = Date.now() + 36_000_000;

    const waiting = seedTaskRow({ agent: a, column: "blocked" });
    const noUsable = seedTaskRow({ agent: a, column: "blocked" });
    const otherStack = seedTaskRow({ agent: c, column: "blocked" });
    seedRun(waiting, a, "succeeded");
    db.tasks.setHarnessState(waiting, { ...baseState(stack), allExhausted: exhaustedState(far) });
    db.tasks.setHarnessState(noUsable, { ...baseState(stack), allExhausted: { ...exhaustedState(far), reason: "no-usable-member" as never } });
    db.tasks.setHarnessState(otherStack, { ...baseState(other), allExhausted: exhaustedState(far) });
    for (const t of [waiting, noUsable, otherStack]) failover.armAutoRetry(t, far);
    try {
      // A clear on a member of the OTHER stack re-arms only that stack's waiting task.
      expect((await call("DELETE", `/harnesses/${d}/limit-state`)).body.rearmed).toBe(1);
      expect((await call("DELETE", `/harnesses/${a}/limit-state`)).body.rearmed).toBe(1); // `waiting` only: noUsable is skipped
      const res = await call("DELETE", `/harnesses/${b}/limit-state`);
      expect(res.status).toBe(200);
      expect(res.body.rearmed).toBe(1);
      const after = db.tasks.get(waiting)!.harnessState!.allExhausted!;
      expect(after.nextAttemptAt).toBeLessThan(far);
      expect(after.attempts).toBe(0);
      expect(failover.hasArmedAutoRetry(waiting)).toBe(true);
      expect(db.tasks.get(noUsable)!.harnessState!.allExhausted!.nextAttemptAt).toBe(far);
      expect(statusLines(db.runs.listForTask(waiting)[0]!.id).some((l) => l.includes("cooldown cleared on"))).toBe(true);
      // A second clear with the waiting task already re-armed still counts it (idempotent re-arm).
      expect((await call("DELETE", `/harnesses/${b}/limit-state`)).body.rearmed).toBe(1);
    } finally {
      for (const t of [waiting, noUsable, otherStack]) {
        failover.cancelAutoRetry(t);
        db.tasks.delete(t);
      }
    }
  }, 60_000);

  // ---- GET /harness-stacks/:id/history -----------------------------------

  test("history: pages newest-first by cursor, clamps the limit, treats a bad cursor as the first page", async () => {
    const a = makeAccount("ha");
    const b = makeAccount("hb");
    const stack = await makeStack([a, b], "history");
    const { harnessSwapEvents, SWAP_HISTORY_MAX_LIMIT, SWAP_HISTORY_DEFAULT_LIMIT } = await import("./harness-swap-history.ts");
    const t0 = Date.now() - 10_000;
    const mk = (i: number) => harnessSwapEvents.insert({
      stackId: stack, taskId: null, taskTitle: `t${i}`, fromHarnessId: a, fromLabel: "A", toHarnessId: b, toLabel: "B",
      trigger: "manual", reason: "user", source: null, message: null, model: null, resetsAtMs: null,
      fromRunId: null, toRunId: null, continuation: null, at: t0 + i,
    });
    for (let i = 0; i < 5; i++) mk(i);

    const p1 = await call("GET", `/harness-stacks/${stack}/history?limit=2`);
    expect(p1.status).toBe(200);
    expect(p1.body.events.map((e: { taskTitle: string }) => e.taskTitle)).toEqual(["t4", "t3"]);
    expect(typeof p1.body.nextCursor).toBe("string");
    const p2 = await call("GET", `/harness-stacks/${stack}/history?limit=2&before=${encodeURIComponent(p1.body.nextCursor)}`);
    expect(p2.body.events.map((e: { taskTitle: string }) => e.taskTitle)).toEqual(["t2", "t1"]);
    const p3 = await call("GET", `/harness-stacks/${stack}/history?limit=2&before=${encodeURIComponent(p2.body.nextCursor)}`);
    expect(p3.body.events.map((e: { taskTitle: string }) => e.taskTitle)).toEqual(["t0"]);
    expect(p3.body.nextCursor).toBeNull();

    // Bad, tampered and oversized cursors fall back to the first page.
    for (const bad of ["garbage", Buffer.from("[1]").toString("base64url"), "A".repeat(600)]) {
      const r = await call("GET", `/harness-stacks/${stack}/history?limit=2&before=${encodeURIComponent(bad)}`);
      expect(r.status).toBe(200);
      expect(r.body.events.map((e: { taskTitle: string }) => e.taskTitle)).toEqual(["t4", "t3"]);
    }
    // limit=0 / negative clamp up to 1; a non-number / blank falls back to the default.
    expect((await call("GET", `/harness-stacks/${stack}/history?limit=0`)).body.events).toHaveLength(1);
    expect((await call("GET", `/harness-stacks/${stack}/history?limit=-7`)).body.events).toHaveLength(1);
    expect((await call("GET", `/harness-stacks/${stack}/history?limit=abc`)).body.events).toHaveLength(5);
    expect((await call("GET", `/harness-stacks/${stack}/history?limit=`)).body.events).toHaveLength(5);

    for (let i = 5; i < SWAP_HISTORY_MAX_LIMIT + 5; i++) mk(i);
    const big = await call("GET", `/harness-stacks/${stack}/history?limit=999999`);
    expect(big.body.events).toHaveLength(SWAP_HISTORY_MAX_LIMIT);
    expect(big.body.nextCursor).not.toBeNull();
    expect((await call("GET", `/harness-stacks/${stack}/history`)).body.events).toHaveLength(SWAP_HISTORY_DEFAULT_LIMIT);
    // The history is per stack.
    const c = makeAccount("hc");
    const d = makeAccount("hd");
    const stack2 = await makeStack([c, d], "history2");
    expect((await call("GET", `/harness-stacks/${stack2}/history`)).body.events).toEqual([]);
  }, 60_000);

  // ---- stack PATCH (finding 21) ------------------------------------------

  test("stack PATCH with a stale expectedUpdatedAt answers 409 {code, stack} and writes nothing (members, label, mirror, updatedAt)", async () => {
    const a = makeAccount("ca");
    const b = makeAccount("cb");
    const stack = await makeStack([a, b], "conc");
    const first = (await call("GET", `/harness-stacks/${stack}`)).body.stack as { updatedAt: number };
    const bumped = await call("PATCH", `/harness-stacks/${stack}`, { label: "conc-2", expectedUpdatedAt: first.updatedAt });
    expect(bumped.status).toBe(200);
    // Make sure a rewrite would be visible as a changed timestamp.
    await Bun.sleep(5);
    const before = db.db.query("SELECT label, mirror_mode, updated_at FROM harness_stacks WHERE id = ?").get(stack);
    const beforeMembers = db.db.query("SELECT harness_id, position FROM harness_stack_members WHERE stack_id = ? ORDER BY position").all(stack);

    const stale = await call("PATCH", `/harness-stacks/${stack}`, {
      label: "stale-write", members: [b, a], mirrorMode: "full", expectedUpdatedAt: first.updatedAt,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("stack-changed");
    expect(stale.body.stack.label).toBe("conc-2");
    expect(stale.body.stack.members.map((m: { harnessId: string }) => m.harnessId)).toEqual([a, b]);
    expect(db.db.query("SELECT label, mirror_mode, updated_at FROM harness_stacks WHERE id = ?").get(stack)).toEqual(before as never);
    expect(db.db.query("SELECT harness_id, position FROM harness_stack_members WHERE stack_id = ? ORDER BY position").all(stack)).toEqual(beforeMembers as never);

    // The current timestamp still goes through; an absent one is unchecked.
    const cur = (stale.body.stack as { updatedAt: number }).updatedAt;
    expect((await call("PATCH", `/harness-stacks/${stack}`, { label: "conc-3", expectedUpdatedAt: cur })).status).toBe(200);
    expect((await call("PATCH", `/harness-stacks/${stack}`, { label: "conc-4" })).status).toBe(200);
    expect((await call("PATCH", "/harness-stacks/nope", { label: "x", expectedUpdatedAt: 1 })).status).toBe(404);
  }, 60_000);

  // ---- stack DELETE (22b) ------------------------------------------------

  test("stack DELETE cancels an armed retry and a scheduled switch with status lines, and its history goes with it", async () => {
    const a = makeAccount("da");
    const b = makeAccount("db");
    const stack = await makeStack([a, b], "del22b");
    const failover = await import("./harness-failover.ts");
    const { harnessSwapEvents } = await import("./harness-swap-history.ts");
    const far = Date.now() + 36_000_000;

    const retrying = seedTaskRow({ agent: a, column: "blocked" });
    const retryRun = seedRun(retrying, a, "succeeded");
    db.tasks.update(retrying, { runId: retryRun });
    db.tasks.setHarnessState(retrying, { ...baseState(stack), allExhausted: exhaustedState(far) });
    failover.armAutoRetry(retrying, far);

    const scheduled = seedTaskRow({ agent: a, column: "running" });
    const schedRun = seedRun(scheduled, a, "running");
    db.tasks.update(scheduled, { runId: schedRun });
    db.tasks.setHarnessState(scheduled, { ...baseState(stack), scheduledSwitch: { requestedAt: Date.now() } } as never);

    harnessSwapEvents.insert({
      stackId: stack, taskId: retrying, taskTitle: "x", fromHarnessId: a, fromLabel: "A", toHarnessId: b, toLabel: "B",
      trigger: "limit", reason: "quota", source: null, message: null, model: null, resetsAtMs: null,
      fromRunId: null, toRunId: null, continuation: null,
    });
    expect(harnessSwapEvents.countForStack(stack)).toBe(1);
    try {
      expect(failover.hasArmedAutoRetry(retrying)).toBe(true);
      expect((await call("DELETE", `/harness-stacks/${stack}`)).status).toBe(200);
      expect(failover.hasArmedAutoRetry(retrying)).toBe(false);
      expect(db.tasks.get(retrying)!.harnessState ?? null).toBeNull();
      expect(db.tasks.get(scheduled)!.harnessState ?? null).toBeNull();
      expect(statusLines(retryRun).some((l) => l.includes("automatic account retry cancelled — the stack was deleted"))).toBe(true);
      expect(statusLines(schedRun).some((l) => l.includes("scheduled account switch cancelled — the stack was deleted"))).toBe(true);
      // The history cascades with the stack, and the route is a 404 now.
      expect(harnessSwapEvents.countForStack(stack)).toBe(0);
      expect((await call("GET", `/harness-stacks/${stack}/history`)).status).toBe(404);
    } finally {
      failover.cancelAutoRetry(retrying);
      db.tasks.delete(retrying);
      db.tasks.delete(scheduled);
    }
  }, 60_000);

  test("stack DELETE leaves a task whose account has since moved into another stack alone (N5)", async () => {
    const a = makeAccount("mva");
    const b = makeAccount("mvb");
    const c = makeAccount("mvc");
    const old = await makeStack([a, b], "n5-old");
    const fresh = await makeStack([c], "n5-new");
    const scheduled = seedTaskRow({ agent: a, column: "running" });
    const schedRun = seedRun(scheduled, a, "running");
    db.tasks.update(scheduled, { runId: schedRun });
    const requestedAt = Date.now();
    db.tasks.setHarnessState(scheduled, { ...baseState(old), scheduledSwitch: { requestedAt } } as never);
    try {
      // The account moves to the other stack; the task's state still records
      // the old stack id (nothing has written it since).
      expect((await call("PATCH", `/harness-stacks/${old}`, { members: [b] })).status).toBe(200);
      expect((await call("PATCH", `/harness-stacks/${fresh}`, { members: [c, a] })).status).toBe(200);
      expect(db.tasks.get(scheduled)!.harnessState?.stackId).toBe(old);
      expect((await call("DELETE", `/harness-stacks/${old}`)).status).toBe(200);
      const state = db.tasks.get(scheduled)!.harnessState;
      // Its scheduled switch now belongs to the stack it is in: kept, and the
      // state re-pointed there instead of wiped with the deleted stack.
      expect(state?.scheduledSwitch?.requestedAt).toBe(requestedAt);
      expect(state?.stackId).toBe(fresh);
      expect(statusLines(schedRun).some((l) => l.includes("the stack was deleted"))).toBe(false);
    } finally {
      db.runs.update(schedRun, { status: "failed", endedAt: Date.now(), exitCode: 1 });
      db.tasks.delete(scheduled);
    }
  }, 60_000);

  // ---- harness DELETE removes backups ------------------------------------

  test("harness DELETE removes the account's mirror backups and provenance; `mirrorRestorable` stops listing it", async () => {
    const id = makeAccount("bk");
    // The backup store lives under the db singleton's data dir (the first
    // test file to import db.ts wins in a full `bun test` run), not this
    // file's DATA_DIR.
    const dir = path.join(db.dataDir, "mirror-backups", id);
    mkdirSync(path.join(dir, "files"), { recursive: true, mode: 0o700 });
    writeFileSync(path.join(dir, "files", "settings.json"), "{}", { mode: 0o600 });
    const keep = path.join(db.dataDir, "mirror-backups", `${id}-sibling`);
    mkdirSync(keep, { recursive: true });
    writeFileSync(path.join(keep, "x"), "1");
    db.db.run(
      `INSERT INTO harness_mirror_provenance (harness_id, stack_id, scope, path, key, preexisted, backup_ref, updated_at)
       VALUES (?, NULL, 'file', 'settings.json', '', 1, ?, ?)`,
      [id, `${id}/files/settings.json`, Date.now()],
    );
    cleanup.push(() => rmSync(keep, { recursive: true, force: true }));
    expect((await call("GET", "/harnesses")).body.mirrorRestorable as string[]).toContain(id);
    expect((await call("DELETE", `/harnesses/${id}`)).status).toBe(204);
    expect(readdirSyncSafe(dir)).toBeNull();
    // A sibling account's backups are untouched.
    expect(readdirSync(keep)).toEqual(["x"]);
    expect((await call("GET", "/harnesses")).body.mirrorRestorable as string[]).not.toContain(id);
  }, 30_000);

  // ---- mirror-preview / mirror-restore: scope + gates --------------------

  test.skipIf(IS_ROOT)("mirror-preview: the gate runs before validation and before any stackId lookup that reads a root; the CLI token otherwise reaches the validator and the dry run", async () => {
    const cliToken = (await import("./api-config.ts")).CLI_TOKEN;
    const a = makeAccount("pa");
    const b = makeAccount("pb");
    const stack = await makeStack([a, b], "pv");
    // Readable roots: the CLI token gets the same answers as the app.
    const ok = await call("POST", "/harness-stacks/mirror-preview", { kind: "claude-code", members: [a, b], mirrorMode: "safe", stackId: stack }, cliToken);
    expect(ok.status).toBe(200);
    expect(Array.isArray(ok.body.plans)).toBe(true);
    expect((await call("POST", "/harness-stacks/mirror-preview", { kind: "claude-code", members: [a, a] }, cliToken)).status).toBe(400);
    expect((await call("POST", "/harness-stacks/mirror-preview", { kind: "claude-code", members: [a], stackId: "nope" }, cliToken)).status).toBe(404);

    const unlock = lockHome(b);
    const before = db.db.query("SELECT COUNT(*) AS n FROM harness_mirror_provenance").get();
    // A validator-invalid body (duplicate member, mixed kinds are 400s) must still be 403.
    for (const members of [[a, b], [b, b], [b]]) {
      const res = await call("POST", "/harness-stacks/mirror-preview", { kind: "claude-code", members }, cliToken);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("path-not-accessible");
    }
    // The dry run wrote nothing.
    expect(db.db.query("SELECT COUNT(*) AS n FROM harness_mirror_provenance").get()).toEqual(before as never);
    // The app caller is never gated.
    expect((await call("POST", "/harness-stacks/mirror-preview", { kind: "claude-code", members: [b, b] })).status).toBe(400);
    unlock();
  }, 60_000);

  test.skipIf(IS_ROOT)("mirror-restore: 403 path-not-accessible for the CLI token on a protected root, nothing restored; the app is not gated; readable → 200", async () => {
    const cliToken = (await import("./api-config.ts")).CLI_TOKEN;
    const a = makeAccount("ra");
    const unlock = lockHome(a);
    const sentinel = path.join(db.dataDir, "mirror-backups", a);
    const denied = await call("POST", `/harnesses/${a}/mirror-restore`, undefined, cliToken);
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe("path-not-accessible");
    expect(readdirSyncSafe(sentinel)).toBeNull();
    unlock();
    const ok = await call("POST", `/harnesses/${a}/mirror-restore`, undefined, cliToken);
    expect(ok.status).toBe(200);
    expect(ok.body.harnessId).toBe(a);
    // A kind-alias or label is resolved by getByIdOrKind; an unknown id is a 404 even for the CLI.
    expect((await call("POST", "/harnesses/zzz-none/mirror-restore", undefined, cliToken)).status).toBe(404);
  }, 60_000);

  // ---- switch-account ----------------------------------------------------

  test("switch-account: 409 shapes (not-in-stack, no-usable-member with reasons, background-agents, busy) and no state is written", async () => {
    const a = makeAccount("sa");
    const b = makeAccount("sb");
    const stack = await makeStack([a, b], "sw409");
    const { harnessStacks } = await import("./harness-stacks.ts");
    const orch = await import("./orchestrator.ts");

    // Outside any stack.
    const lone = seedTaskRow({ agent: "api-x" });
    const noStack = await call("POST", `/tasks/${lone}/switch-account`);
    expect(noStack.status).toBe(409);
    expect(noStack.body.code).toBe("not-in-stack");
    expect(typeof noStack.body.error).toBe("string");

    // Every other member cooling: refused up front with per-member reasons.
    const t = seedTaskRow({ agent: a });
    harnessStacks.setLimitState(b, { reason: "quota", source: "claude-api-error", message: "m", resetAtMs: Date.now() + 3_600_000 });
    try {
      const cooling = await call("POST", `/tasks/${t}/switch-account`);
      expect(cooling.status).toBe(409);
      expect(cooling.body.code).toBe("no-usable-member");
      expect(Array.isArray(cooling.body.reasons)).toBe(true);
      expect(cooling.body.reasons.length).toBeGreaterThan(0);
      expect(JSON.stringify(cooling.body.reasons)).toContain(b);
      expect(db.tasks.get(t)!.agent).toBe(a);
      expect(db.tasks.get(t)!.harnessState?.scheduledSwitch ?? null).toBeNull();
    } finally {
      harnessStacks.clearLimitState(b);
    }

    // Background agents hold the task.
    const held = seedTaskRow({ agent: a, column: "running" });
    const heldRun = seedRun(held, a, "succeeded");
    db.tasks.update(held, { runId: heldRun });
    const subId = `tte-${randomUUID().slice(0, 8)}`;
    db.subagents.insertIfAbsent({
      id: subId, taskId: held, runId: heldRun, parentKind: "subagent", agentType: "Explore", description: "bg",
      spawnDepth: 1, sourcePath: path.join(DATA_DIR, `${subId}.jsonl`), status: "running", startedAt: Date.now(), endedAt: null,
    });
    const bg = await call("POST", `/tasks/${held}/switch-account`);
    expect(bg.status).toBe(409);
    expect(bg.body.code).toBe("background-agents");
    expect(db.tasks.get(held)!.agent).toBe(a);
    db.subagents.setStatus(subId, "completed", Date.now());

    // Another switch already holds the claim.
    expect(orch.claimTaskForAccountSwitch(t)).toBe(true);
    try {
      const busy = await call("POST", `/tasks/${t}/switch-account`);
      expect(busy.status).toBe(409);
      expect(busy.body.code).toBe("busy");
    } finally {
      orch.releaseTaskAccountSwitch(t);
    }
    for (const id of [lone, t, held]) db.tasks.delete(id);
    expect(stack).toBeTruthy();
  }, 60_000);

  test("switch-account: a FAILED turn whose background agents still run is refused background-agents, like a held one (Q1)", async () => {
    const a = makeAccount("fa");
    const b = makeAccount("fb");
    await makeStack([a, b], "swfail");
    const t = seedTaskRow({ agent: a, column: "blocked" });
    const runId = randomUUID();
    db.runs.insert({
      id: runId, taskId: t, agent: a, status: "failed",
      startedAt: Date.now(), endedAt: Date.now(), exitCode: 1,
      tmuxSession: null, claudeSessionId: null, codexSessionId: null, cursorSessionId: null, geminiSessionId: null, fxSessionId: null,
    });
    db.tasks.update(t, { runId });
    const subId = `tte-${randomUUID().slice(0, 8)}`;
    db.subagents.insertIfAbsent({
      id: subId, taskId: t, runId, parentKind: "subagent", agentType: "Explore", description: "bg",
      spawnDepth: 1, sourcePath: path.join(DATA_DIR, `${subId}.jsonl`), status: "running", startedAt: Date.now(), endedAt: null,
    });
    try {
      const bg = await call("POST", `/tasks/${t}/switch-account`);
      expect(bg.status).toBe(409);
      expect(bg.body.code).toBe("background-agents");
      expect(db.tasks.get(t)!.agent).toBe(a);
      expect(db.tasks.get(t)!.harnessState?.pendingSwap ?? null).toBeNull();
      expect(db.tasks.get(t)!.harnessState?.scheduledSwitch ?? null).toBeNull();
    } finally {
      db.subagents.setStatus(subId, "completed", Date.now());
      db.tasks.delete(t);
    }
  }, 60_000);

  test("switch-account: a Cancel while the switch is being applied answers 409 busy and leaves the request alone (N2)", async () => {
    const a = makeAccount("ca");
    const b = makeAccount("cb");
    const stackId = await makeStack([a, b], "swbusy");
    const orch = await import("./orchestrator.ts");
    const t = seedTaskRow({ agent: a });
    const runId = seedRun(t, a, "succeeded");
    db.tasks.update(t, { runId });
    db.tasks.setHarnessState(t, { ...baseState(stackId), scheduledSwitch: { requestedAt: Date.now() } });
    // The scheduled switch is being applied: its account-switch claim is held.
    expect(orch.claimTaskForAccountSwitch(t)).toBe(true);
    try {
      const busy = await call("DELETE", `/tasks/${t}/switch-account`);
      expect(busy.status).toBe(409);
      expect(busy.body.code).toBe("busy");
      expect(busy.body.error).toBe("the switch is already under way");
      expect(db.tasks.get(t)!.harnessState?.scheduledSwitch).toBeTruthy();
      expect(statusLines(runId).some((l) => l.includes("cancelled"))).toBe(false);
    } finally {
      orch.releaseTaskAccountSwitch(t);
      // The claim release applies the still-scheduled switch: let it finish
      // before the row goes.
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline && db.tasks.get(t)?.harnessState?.scheduledSwitch) await Bun.sleep(15);
      while (Date.now() < deadline && orch.isAccountSwitchUnderway(t)) await Bun.sleep(15);
      db.tasks.delete(t);
    }
  }, 60_000);

  test("switch-account: an idle task moves to the next member now; a live turn schedules it; DELETE cancels with a status line (and is a no-op when nothing is scheduled)", async () => {
    const a = makeAccount("ia");
    const b = makeAccount("ib");
    await makeStack([a, b], "swok");

    const idle = seedTaskRow({ agent: a });
    const moved = await call("POST", `/tasks/${idle}/switch-account`);
    expect(moved.status).toBe(200);
    expect(moved.body.status).toBe("switched");
    expect(moved.body.task.agent).toBe(b);
    expect(db.tasks.get(idle)!.agent).toBe(b);

    const live = seedTaskRow({ agent: a, column: "running" });
    const liveRun = seedRun(live, a, "running");
    db.tasks.update(live, { runId: liveRun });
    const sched = await call("POST", `/tasks/${live}/switch-account`);
    expect(sched.status).toBe(200);
    expect(sched.body.status).toBe("scheduled");
    expect(sched.body.task.harnessState.scheduledSwitch.requestedAt).toBeGreaterThan(0);
    expect(db.tasks.get(live)!.agent).toBe(a);
    // A repeat request does not stack a second schedule.
    const again = await call("POST", `/tasks/${live}/switch-account`);
    expect(again.body.status).toBe("scheduled");
    expect(statusLines(liveRun).filter((l) => l.includes("scheduled for the end of this turn"))).toHaveLength(1);

    const cancelled = await call("DELETE", `/tasks/${live}/switch-account`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.cancelled).toBe(true);
    expect(cancelled.body.task.harnessState?.scheduledSwitch ?? null).toBeNull();
    expect(statusLines(liveRun).some((l) => l.includes("scheduled account switch cancelled"))).toBe(true);
    const noop = await call("DELETE", `/tasks/${live}/switch-account`);
    expect(noop.status).toBe(200);
    expect(noop.body.cancelled).toBe(false);
    expect(statusLines(liveRun).filter((l) => l.includes("scheduled account switch cancelled"))).toHaveLength(1);
    for (const id of [idle, live]) db.tasks.delete(id);
  }, 60_000);

  test.skipIf(IS_ROOT)("switch-account: the CLI token is path-gated on the task's account AND every other member (403 path-not-accessible, nothing moved); DELETE touches no files and is not gated", async () => {
    const cliToken = (await import("./api-config.ts")).CLI_TOKEN;
    const a = makeAccount("ga");
    const b = makeAccount("gb");
    await makeStack([a, b], "swgate");
    const unlock = lockHome(b);
    const t = seedTaskRow({ agent: a });
    try {
      const denied = await call("POST", `/tasks/${t}/switch-account`, undefined, cliToken);
      expect(denied.status).toBe(403);
      expect(denied.body.code).toBe("path-not-accessible");
      expect(db.tasks.get(t)!.agent).toBe(a);
      expect(db.tasks.get(t)!.harnessState?.scheduledSwitch ?? null).toBeNull();
      // Refusals that need no file (archived) come before the gate; the cancel route has no gate.
      expect((await call("DELETE", `/tasks/${t}/switch-account`, undefined, cliToken)).status).toBe(200);
      // A task OUTSIDE the stack whose own root is locked is gated on that root.
      const loneId = (() => {
        const id = makeAccount("gl");
        lockHome(id);
        return id;
      })();
      const lone = seedTaskRow({ agent: loneId });
      const loneDenied = await call("POST", `/tasks/${lone}/switch-account`, undefined, cliToken);
      expect(loneDenied.status).toBe(403);
      db.tasks.delete(lone);
      unlock();
      const ok = await call("POST", `/tasks/${t}/switch-account`, undefined, cliToken);
      expect(ok.status).toBe(200);
      expect(ok.body.status).toBe("switched");
    } finally {
      db.tasks.delete(t);
    }
  }, 60_000);

  // ---- finding 19: the idle timeout is lifted -----------------------------

  test("finding 19: a same-stack PATCH, switch-account, preview and restore lift the idle timeout (timeout(req, 0)); a plain PATCH does not", async () => {
    const a = makeAccount("ta");
    const b = makeAccount("tb");
    const stack = await makeStack([a, b], "timeouts");
    const hits = (method: string, p: string) => timeoutCalls.filter((c) => c.method === method && c.path === p);

    const t = seedTaskRow({ agent: a });
    const patchPath = `/tasks/${t}`;
    // A plain PATCH never reaches the lift.
    expect((await call("PATCH", patchPath, { title: "renamed" })).status).toBe(200);
    expect(hits("PATCH", patchPath)).toHaveLength(0);
    // The same-stack switch does, and with 0 (no idle cap).
    const sw = await call("PATCH", patchPath, { agent: b });
    expect(sw.status).toBe(200);
    expect(db.tasks.get(t)!.agent).toBe(b);
    expect(hits("PATCH", patchPath).map((c) => c.sec)).toEqual([0]);

    const t2 = seedTaskRow({ agent: a });
    expect((await call("POST", `/tasks/${t2}/switch-account`)).status).toBe(200);
    expect(hits("POST", `/tasks/${t2}/switch-account`).map((c) => c.sec)).toEqual([0]);

    expect((await call("POST", "/harness-stacks/mirror-preview", { kind: "claude-code", members: [a, b], stackId: stack })).status).toBe(200);
    expect(hits("POST", "/harness-stacks/mirror-preview").map((c) => c.sec)).toContain(0);
    expect((await call("POST", `/harnesses/${a}/mirror-restore`)).status).toBe(200);
    expect(hits("POST", `/harnesses/${a}/mirror-restore`).map((c) => c.sec)).toEqual([0]);
    for (const id of [t, t2]) db.tasks.delete(id);
  }, 60_000);
});

/** `readdirSync`, or null when the directory is absent. */
function readdirSyncSafe(dir: string): string[] | null {
  try {
    return readdirSync(dir);
  } catch {
    return null;
  }
}
