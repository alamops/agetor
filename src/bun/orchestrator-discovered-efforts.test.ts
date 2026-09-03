import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { plantFakeCodexAppServer } from "./test-codex-app-server.ts";
import { rmTestDataDir } from "./test-data-dir.ts";

/**
 * TEST-5 (docs/plans/add-gpt-6-astra.md) — pins the two bun-side consumers
 * of discovered efforts that IMPL-5 wired up in `orchestrator.ts`/`server.ts`:
 *
 *   - `createTask`'s default-effort computation (orchestrator.ts:3585-3590):
 *     `supportedEfforts(kind, model, getDiscoveredEfforts(kind, model, harness.id))`,
 *     then "kind default if offered, else strongest offered, else null".
 *   - the PATCH `/tasks/:id` null-clear guard (server.ts:3532-3563): same
 *     discovered-then-curated `supportedEfforts` call, still NULL-CLEAR-ONLY
 *     (a non-null effort id is never validated against the set).
 *
 * Discovery itself (`discoverCodex`, `parseCodexModelList`, `getDiscoveredEfforts`'s
 * harness-then-kind lookup) is pinned by agent-discovery.test.ts — this file
 * only proves the two *consumers* read that state correctly, via
 * `refreshKindModels("codex")` + the shared `plantFakeCodexAppServer` stub
 * (see its own doc comment: shared by agent-discovery.test.ts,
 * model-discovery.test.ts and this file).
 *
 * Mirrors src/bun/orchestrator-codex.test.ts's harness (mkdtemp AGETOR_DATA_DIR
 * set before any db.ts import, `isolation: "none"` so no real git worktrees
 * are created in this shared checkout) for the createTask-only cases, and
 * src/bun/agent-models-endpoint.test.ts's harness (startApiServer on a
 * dedicated port, bearer-token fetch) for the PATCH-guard-over-HTTP case.
 */

// db.ts captures AGETOR_DATA_DIR at first import — set before any bun-side
// module is touched (same convention as orchestrator-codex.test.ts /
// task-unread.test.ts). A dedicated port avoids colliding with any other
// test file's server in the same `bun test` run (4597 isn't claimed by any
// existing *-endpoint.test.ts file as of this writing).
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-discovered-efforts-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_API_PORT = "4597";

const BASE = "http://127.0.0.1:4597";

let tasks: typeof import("./db.ts").tasks;
let createTask: typeof import("./orchestrator.ts").createTask;
let refreshKindModels: typeof import("./agent-discovery.ts").refreshKindModels;
let discoveryTesting: typeof import("./agent-discovery.ts").__testing;
let server: { stop: () => void } | null = null;
let token: string;
let prevCodexBinEnv: string | undefined;

beforeAll(async () => {
  ({ tasks } = await import("./db.ts"));
  ({ createTask } = await import("./orchestrator.ts"));
  const discovery = await import("./agent-discovery.ts");
  refreshKindModels = discovery.refreshKindModels;
  discoveryTesting = discovery.__testing;
  const { startApiServer, API_TOKEN } = await import("./server.ts");
  server = startApiServer() as unknown as { stop: () => void };
  token = API_TOKEN;

  // `checkHarness`/`startTask` gate on `harness.enabled`, but neither
  // `createTask` nor the PATCH `/tasks/:id` route this file exercises does
  // (verified by reading both — no `.enabled` read in `createTask`'s body,
  // and server.ts's PATCH handler only reads `.enabled` from the harness
  // PATCH route, not the task one). Both `codex` and `gemini` ship disabled
  // by default (migrations 016 / 037), so this file deliberately does NOT
  // flip them on — it doubles as a pin that a disabled harness still works
  // for task creation and effort-guard editing, only `startTask` gates on
  // enablement.
  prevCodexBinEnv = process.env.AGETOR_CODEX_BIN;
});

afterAll(() => {
  discoveryTesting.resetForTests();
  if (prevCodexBinEnv === undefined) delete process.env.AGETOR_CODEX_BIN;
  else process.env.AGETOR_CODEX_BIN = prevCodexBinEnv;
  server?.stop?.();
  // Same convention as orchestrator-codex.test.ts / task-unread.test.ts:
  // this file's tasks live in its own throwaway mkdtemp DB, so nothing
  // deletes them individually. `rmTestDataDir` is still the correct call
  // per CLAUDE.md's Persistence rules — it refuses (no-op) whenever
  // agetor.sqlite still lives there (the common case when this file runs
  // standalone, since db.ts opens it here as the first-imported file).
  rmTestDataDir(DATA_DIR);
});

/** Scope an env var override to one async block, restoring it afterwards —
 *  mirrors agent-discovery.test.ts's identically-named local helper (not
 *  exported from that file, so duplicated here rather than reached into). */
async function withEnvOverride(name: string, value: string, run: () => Promise<void>): Promise<void> {
  const prev = process.env[name];
  process.env[name] = value;
  try {
    await run();
  } finally {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  }
}

function authedFetch(p: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${BASE}${p}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

/* ── Case 1: discovery empty — createTask falls back to the curated table ── */

test("createTask (codex, discovery empty): unknown model id falls back to gpt-6-astra's curated effort set, defaulting to 'high'", async () => {
  discoveryTesting.resetForTests();
  const created = await createTask({
    title: "case1-unknown-model",
    prompt: "p",
    agent: "codex",
    model: "gpt-9-test",
    workdir: process.cwd(),
    isolation: "none",
    taskType: "task",
  });
  if ("error" in created) throw new Error(created.error);
  expect(created.task.model).toBe("gpt-9-test");
  // supportedEfforts("codex", "gpt-9-test", null) — unknown key falls back to
  // MODEL_EFFORT_SUPPORT.codex[DEFAULT_MODEL.codex] (Astra's curated set,
  // which includes "high" == DEFAULT_EFFORT.codex).
  expect(created.task.effort).toBe("high");
});

test("createTask (codex, discovery empty): no model given → DEFAULT_MODEL.codex ('gpt-6-astra'), effort 'high'", async () => {
  discoveryTesting.resetForTests();
  const created = await createTask({
    title: "case1-no-model",
    prompt: "p",
    agent: "codex",
    workdir: process.cwd(),
    isolation: "none",
    taskType: "task",
  });
  if ("error" in created) throw new Error(created.error);
  expect(created.task.model).toBe("gpt-6-astra");
  expect(created.task.effort).toBe("high");
});

/* ── Case 2: discovery populated via refreshKindModels("codex") — the
      discovered set wins over the curated fallback ── */

test("createTask (codex, discovered efforts without 'high'): defaults to the strongest offered id, canonical order (medium over low)", async () => {
  discoveryTesting.resetForTests();
  const bin = plantFakeCodexAppServer({
    pages: [[{ id: "gpt-9-test", efforts: ["low", "medium"] }]],
  });
  await withEnvOverride("AGETOR_CODEX_BIN", bin, async () => {
    await refreshKindModels("codex");
  });

  const created = await createTask({
    title: "case2-no-high",
    prompt: "p",
    agent: "codex",
    model: "gpt-9-test",
    workdir: process.cwd(),
    isolation: "none",
    taskType: "task",
  });
  if ("error" in created) throw new Error(created.error);
  // Discovered set {low, medium} filtered into EFFORT_OPTIONS' canonical
  // (highest → lowest) order is [medium, low]; DEFAULT_EFFORT.codex ("high")
  // isn't offered, so the strongest offered id wins.
  expect(created.task.effort).toBe("medium");
});

test("createTask (codex, discovered efforts including 'high'): the kind default wins when it's among the offered ids", async () => {
  discoveryTesting.resetForTests();
  const bin = plantFakeCodexAppServer({
    pages: [[{ id: "gpt-9-test", efforts: ["low", "high", "ultra"] }]],
  });
  await withEnvOverride("AGETOR_CODEX_BIN", bin, async () => {
    await refreshKindModels("codex");
  });

  const created = await createTask({
    title: "case2-with-high",
    prompt: "p",
    agent: "codex",
    model: "gpt-9-test",
    workdir: process.cwd(),
    isolation: "none",
    taskType: "task",
  });
  if ("error" in created) throw new Error(created.error);
  expect(created.task.effort).toBe("high");
});

test("createTask (codex, discovered efforts present): an explicit input.effort is stored verbatim, bypassing the default computation entirely", async () => {
  discoveryTesting.resetForTests();
  const bin = plantFakeCodexAppServer({
    pages: [[{ id: "gpt-9-test", efforts: ["low", "high", "ultra"] }]],
  });
  await withEnvOverride("AGETOR_CODEX_BIN", bin, async () => {
    await refreshKindModels("codex");
  });

  const created = await createTask({
    title: "case2-explicit-effort",
    prompt: "p",
    agent: "codex",
    model: "gpt-9-test",
    effort: "ultra",
    workdir: process.cwd(),
    isolation: "none",
    taskType: "task",
  });
  if ("error" in created) throw new Error(created.error);
  expect(created.task.effort).toBe("ultra");
});

/* ── Case 3: the PATCH /tasks/:id null-clear guard, over real HTTP ── */

test("PATCH /tasks/:id (codex, discovered efforts): clearing effort (null) is rejected with 400 'cannot be cleared'", async () => {
  discoveryTesting.resetForTests();
  const bin = plantFakeCodexAppServer({
    pages: [[{ id: "gpt-9-test", efforts: ["low", "medium"] }]],
  });
  await withEnvOverride("AGETOR_CODEX_BIN", bin, async () => {
    await refreshKindModels("codex");
  });

  const created = await createTask({
    title: "case3-clear-guard",
    prompt: "p",
    agent: "codex",
    model: "gpt-9-test",
    workdir: process.cwd(),
    isolation: "none",
    taskType: "task",
  });
  if ("error" in created) throw new Error(created.error);

  const res = await authedFetch(`/tasks/${created.task.id}`, {
    method: "PATCH",
    body: JSON.stringify({ effort: null }),
  });
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error: string };
  expect(body.error).toBe(`effort cannot be cleared for model "gpt-9-test"`);

  // The row itself must be untouched by the rejected patch.
  const stillHas = tasks.get(created.task.id);
  expect(stillHas?.effort).toBe("medium");
});

test("PATCH /tasks/:id (codex, discovered efforts): a non-null effort id is never validated against the discovered/curated set — 'none' isn't offered anywhere, but the PATCH still succeeds", async () => {
  discoveryTesting.resetForTests();
  const bin = plantFakeCodexAppServer({
    pages: [[{ id: "gpt-9-test", efforts: ["low", "medium"] }]],
  });
  await withEnvOverride("AGETOR_CODEX_BIN", bin, async () => {
    await refreshKindModels("codex");
  });

  const created = await createTask({
    title: "case3-unvalidated-effort",
    prompt: "p",
    agent: "codex",
    model: "gpt-9-test",
    workdir: process.cwd(),
    isolation: "none",
    taskType: "task",
  });
  if ("error" in created) throw new Error(created.error);

  // "none" is in neither the discovered set ({low, medium}) nor the curated
  // Astra-fallback set ({ultra, max, xhigh, high, medium, low}) that
  // "gpt-9-test" would otherwise resolve to — proving the guard really only
  // blocks the null-clear case, not arbitrary non-null ids.
  const res = await authedFetch(`/tasks/${created.task.id}`, {
    method: "PATCH",
    body: JSON.stringify({ effort: "none" }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { effort: string | null };
  expect(body.effort).toBe("none");
  expect(tasks.get(created.task.id)?.effort).toBe("none");
});

test("PATCH /tasks/:id (codex, discovery empty): the curated table alone still blocks a null-clear", async () => {
  discoveryTesting.resetForTests();
  const created = await createTask({
    title: "case3-discovery-empty",
    prompt: "p",
    agent: "codex",
    workdir: process.cwd(),
    isolation: "none",
    taskType: "task",
  });
  if ("error" in created) throw new Error(created.error);
  expect(created.task.model).toBe("gpt-6-astra");

  const res = await authedFetch(`/tasks/${created.task.id}`, {
    method: "PATCH",
    body: JSON.stringify({ effort: null }),
  });
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error: string };
  expect(body.error).toBe(`effort cannot be cleared for model "gpt-6-astra"`);
});

/* ── Case 4: an unlisted gemini model id, no discovery ── */

test("createTask (gemini, unlisted model id, no discovery): stores effort null — the intentional post-fix behavior change (was 'high')", async () => {
  discoveryTesting.resetForTests();
  // Neither createTask nor the PATCH route reads harness.enabled (only
  // startTask does — see the beforeAll comment above), so the built-in
  // gemini harness being disabled by default (migration 037) doesn't need
  // to be worked around here.
  const created = await createTask({
    title: "case4-gemini-unlisted",
    prompt: "p",
    agent: "gemini",
    model: "gemini-9-test",
    workdir: process.cwd(),
    isolation: "none",
    taskType: "task",
  });
  if ("error" in created) throw new Error(created.error);
  expect(created.task.model).toBe("gemini-9-test");
  // supportedEfforts("gemini", "gemini-9-test", null): unknown key falls
  // back to MODEL_EFFORT_SUPPORT.gemini[DEFAULT_MODEL.gemini], which is []
  // (gemini has no per-invocation effort flag for any curated model) — so
  // `support.length === 0` and createTask stores null, not
  // DEFAULT_EFFORT.gemini. Before this fix, an *unlisted* id read `undefined`
  // from the curated table (failing the old direct `Array.isArray` check)
  // and fell all the way through to DEFAULT_EFFORT.gemini ("high") instead —
  // see orchestrator.ts's "Deliberate side effect" comment on createTask.
  expect(created.task.effort).toBeNull();
});
