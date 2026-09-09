import { test, expect, beforeAll, afterAll } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Top-level: db.ts captures AGETOR_DATA_DIR at first import. Set it, the fx
// fake driver, and an isolated API port BEFORE any sibling test in the same
// process imports server.ts / db.ts / orchestrator.ts — same convention as
// fx-permissions-endpoint.test.ts / server-auth.test.ts.
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-fx-resume-endpoint-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
// Drive fx through the in-process fake (no ACP child process, no real CLI) —
// same rationale as orchestrator-fx.test.ts.
process.env.AGETOR_FX_DRIVER = "fake";
process.env.AGETOR_API_PORT = "4413";

// `checkHarness`'s fx-only availability probe additionally requires the
// binary's `--help` output contain "coding agent" (disambiguating Vercel's
// fx from the unrelated npm JSON-viewer CLI of the same name) — a bare
// `/bin/echo` doesn't satisfy that, so plant a tiny stub, same as
// orchestrator-fx.test.ts. `status --json` is left unimplemented (falls
// through to `exit 0` with empty stdout), which the real `checkHarness`
// treats as fail-open `loggedIn: null` — never blocks a run.
const fxBinDir = mkdtempSync(path.join(tmpdir(), "agetor-fx-resume-fakebin-"));
const fxBinPath = path.join(fxBinDir, "fx");
writeFileSync(
  fxBinPath,
  [
    "#!/bin/sh",
    'if [ "$1" = "--help" ]; then',
    '  echo "Fast, native coding agent for the terminal"',
    "  exit 0",
    "fi",
    'if [ "$1" = "--version" ]; then',
    '  echo "0.0.4-fake"',
    "  exit 0",
    "fi",
    "exit 0",
    "",
  ].join("\n"),
);
chmodSync(fxBinPath, 0o755);
process.env.AGETOR_FX_BIN = fxBinPath;

const BASE = "http://127.0.0.1:4413";

let server: { stop: () => void };
let token: string;
let createTask: typeof import("./orchestrator.ts").createTask;
let startTask: typeof import("./orchestrator.ts").startTask;
let runs: typeof import("./db.ts").runs;
let harnesses: typeof import("./db.ts").harnesses;
let FAKE_FX_RECOVERY_PROMPT_MARKER: string;

beforeAll(async () => {
  ({ createTask, startTask } = await import("./orchestrator.ts"));
  ({ runs, harnesses } = await import("./db.ts"));
  ({ FAKE_FX_RECOVERY_PROMPT_MARKER } = await import("./agents.ts"));
  harnesses.setEnabled("fx", true);
  const { startApiServer, API_TOKEN } = await import("./server.ts");
  server = startApiServer() as unknown as { stop: () => void };
  token = API_TOKEN;
});

afterAll(() => {
  server?.stop?.();
});

async function settle(ms = 30) {
  await new Promise((r) => setTimeout(r, ms));
}

/** Poll `runs.get(runId)` until its status leaves "running" — mirrors
 *  orchestrator-fx.test.ts's helper of the same name: the fake storm's
 *  terminal chunk lands at ~1.5s, the "continue" scenario's at ~15ms. */
async function waitForRunSettled(runId: string, timeoutMs = 5000) {
  const start = Date.now();
  for (;;) {
    const r = runs.get(runId);
    if (r && r.status !== "running") return r;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for run ${runId} to settle (last status: ${r?.status ?? "missing"})`);
    }
    await settle();
  }
}

/** A fresh scratch dir per task — never a real repo, and never this repo's
 *  own worktree (isolation: "none" means the cwd IS the workdir). Mirrors
 *  orchestrator-cursor-plan.test.ts's `scratchWorkdir`. */
function scratchWorkdir(): string {
  return mkdtempSync(path.join(tmpdir(), "agetor-fx-resume-wd-"));
}

/** Creates a real fx task through the orchestrator (not over HTTP — same
 *  "same module functions the orchestrator tests use" allowance the task
 *  brief calls out) so the /fx-resume route under test has a real task row,
 *  real run rows, and a real fx session id to gate against. */
async function newFxTask(promptSuffix = ""): Promise<string> {
  const created = await createTask({
    title: "fx resume endpoint task",
    prompt: `hit the gateway limit${promptSuffix}`,
    agent: "fx",
    mode: "yolo",
    workdir: scratchWorkdir(),
    isolation: "none",
    taskType: "task",
  });
  if ("error" in created) throw new Error(created.error);
  return created.task.id;
}

function fxResume(taskId: string): Promise<Response> {
  return fetch(`${BASE}/tasks/${taskId}/fx-resume`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  });
}

test("POST /tasks/:id/fx-resume — unknown task id → 404 {error}, with CORS headers on the error response", async () => {
  const res = await fxResume("does-not-exist-task-id");
  expect(res.status).toBe(404);
  const body = await res.json();
  expect(typeof body.error).toBe("string");
  // CORS is applied even on an error response — `corsHeaders(req)` is passed
  // to every `json(...)` call in the route, including the 404/400/409 paths
  // below, not just the 200 happy path.
  expect(res.headers.get("access-control-allow-origin")).toBeTruthy();
});

test("POST /tasks/:id/fx-resume — without a bearer token → 401, with CORS headers still present", async () => {
  const res = await fetch(`${BASE}/tasks/does-not-exist-task-id/fx-resume`, { method: "POST" });
  expect(res.status).toBe(401);
  expect(res.headers.get("access-control-allow-origin")).toBeTruthy();
});

test("POST /tasks/:id/fx-resume — a real fx task with no paused run (an ordinary succeeded turn) → 400 {error: 'no paused fx response to resume'}", async () => {
  // No FAKE_FX_RECOVERY_PROMPT_MARKER — the fake driver's default fx turn:
  // a short ordinary reply that resolves succeeded.
  const taskId = await newFxTask();
  const started = await startTask(taskId);
  if ("error" in started) throw new Error(started.error);
  const runId = "runId" in started ? started.runId : "";
  const run = await waitForRunSettled(runId);
  expect(run.status).toBe("succeeded");

  const res = await fxResume(taskId);
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error).toBe("no paused fx response to resume");
});

test("POST /tasks/:id/fx-resume — happy path: paused storm → 200 {ok:true, runId}; an immediate second POST is gated", async () => {
  const taskId = await newFxTask(` ${FAKE_FX_RECOVERY_PROMPT_MARKER}`);
  const started = await startTask(taskId);
  if ("error" in started) throw new Error(started.error);
  const firstRunId = "runId" in started ? started.runId : "";

  // The fake storm's terminal `paused` chunk lands at ~1.5s.
  const firstRun = await waitForRunSettled(firstRunId, 5000);
  expect(firstRun.status).toBe("failed");

  const res = await fxResume(taskId);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(typeof body.runId).toBe("string");
  expect(body.runId).not.toBe(firstRunId);

  // Fire a second POST immediately, with no delay. By the time our `await`
  // above sees the first response, the route's own `fxResumesInFlight`
  // per-task claim has already been released (it's freed in a `finally`
  // wrapped around the same `await resumeFxRecovery(taskId)` this test just
  // awaited) — so the second request reaches `resumeFxRecovery` itself,
  // where the just-spawned "continue" run (its ~15ms fake resolve hasn't
  // landed yet — a same-process loopback round-trip is faster than that) is
  // still registered active. That's resumeFxRecovery's OWN in-flight gate:
  // 409 "a turn is already in flight for this task" — confirmed
  // deterministic across repeated local runs. The looser `[400, 409]`
  // assertion below still covers the theoretical alternative (the continue
  // turn settles first, so the gate that fires is instead "latest run
  // succeeded" → 400 "no paused fx response to resume") in case CI timing
  // ever differs from local.
  const second = await fxResume(taskId);
  expect([400, 409]).toContain(second.status);
  const secondBody = await second.json();
  expect(typeof secondBody.error).toBe("string");
  if (second.status === 409) {
    expect(secondBody.error).toMatch(/already in flight/);
  } else {
    expect(secondBody.error).toBe("no paused fx response to resume");
  }

  // Drain the continue turn so its timers don't leak into a later test.
  await waitForRunSettled(body.runId, 3000);
});
