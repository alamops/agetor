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
