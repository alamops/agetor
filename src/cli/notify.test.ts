import { test, expect } from "bun:test";
import { notifyFor, eventPipelineParentId, osNotify, type OsNotifyDeps } from "./notify.ts";
import { buildTaskNotifierPostArgs } from "../bun/notifier.ts";
import type { GlobalEvent } from "../shared/types.ts";

const T = "task-abc-12345";

test("notifyFor fires for this task's terminal + blocked states only", () => {
  expect(notifyFor({ kind: "run-status", taskId: T, runId: "r", status: "succeeded", ts: 1 }, T)?.title).toContain("succeeded");
  expect(notifyFor({ kind: "run-status", taskId: T, runId: "r", status: "failed", ts: 1 }, T)?.title).toContain("failed");
  const blocked = notifyFor({ kind: "column", taskId: T, runId: "r", column: "blocked", prev: "running", ts: 1, reason: "api-error" }, T);
  expect(blocked?.title).toContain("needs you");
  expect(blocked?.body).toContain("API error");
  // cancelled is user-initiated → no notify
  expect(notifyFor({ kind: "run-status", taskId: T, runId: "r", status: "cancelled", ts: 1 }, T)).toBeNull();
  // a non-blocked column transition → no notify
  expect(notifyFor({ kind: "column", taskId: T, runId: "r", column: "review", prev: "running", ts: 1 }, T)).toBeNull();
});

test("notifyFor ignores events for other tasks", () => {
  expect(notifyFor({ kind: "run-status", taskId: "other-task", runId: "r", status: "succeeded", ts: 1 }, T)).toBeNull();
  expect(notifyFor({ kind: "column", taskId: "other-task", runId: "r", column: "blocked", prev: "running", ts: 1 }, T)).toBeNull();
});

// m3 review fix (docs/plans/pipelines.md D11): a hidden pipeline step task's
// own terminal/blocked events are suppressed even for a caller watching that
// exact task id (e.g. `agetor logs <stepTaskId> --notify`) — the parent's
// own column/pipeline-run transitions cover the same information at the
// level a step id, an implementation detail, isn't meaningful outside.
test("notifyFor: opts.hidden suppresses every notification for this task, even a terminal/blocked one", () => {
  expect(
    notifyFor({ kind: "run-status", taskId: T, runId: "r", status: "succeeded", ts: 1 }, T, { hidden: true }),
  ).toBeNull();
  expect(
    notifyFor(
      { kind: "column", taskId: T, runId: "r", column: "blocked", prev: "running", ts: 1, reason: "api-error" },
      T,
      { hidden: true },
    ),
  ).toBeNull();
});

// Cross-agent contract (a): the orchestrator stamps `pipelineParentId` on a
// step task's own events — read straight off the event, so a step that
// settles before the caller ever learned it was a step is still suppressed.
test("notifyFor: an event carrying pipelineParentId is suppressed even without opts.hidden", () => {
  const stamped = { kind: "run-status", taskId: T, runId: "r", status: "succeeded", ts: 1, pipelineParentId: "parent-1" } as unknown as GlobalEvent;
  expect(notifyFor(stamped, T)).toBeNull();
  const blocked = { kind: "column", taskId: T, runId: "r", column: "blocked", prev: "running", ts: 1, pipelineParentId: "parent-1" } as unknown as GlobalEvent;
  expect(notifyFor(blocked, T)).toBeNull();
});

test("eventPipelineParentId: reads a non-empty string stamp, null otherwise (older core / null / empty)", () => {
  expect(eventPipelineParentId({ kind: "run-status", taskId: T, runId: "r", status: "succeeded", ts: 1 })).toBeNull();
  expect(eventPipelineParentId({ kind: "run-status", taskId: T, runId: "r", status: "succeeded", ts: 1, pipelineParentId: null } as unknown as GlobalEvent)).toBeNull();
  expect(eventPipelineParentId({ kind: "run-status", taskId: T, runId: "r", status: "succeeded", ts: 1, pipelineParentId: "" } as unknown as GlobalEvent)).toBeNull();
  expect(eventPipelineParentId({ kind: "run-status", taskId: T, runId: "r", status: "succeeded", ts: 1, pipelineParentId: "p1" } as unknown as GlobalEvent)).toBe("p1");
});

test("notifyFor: opts.hidden: false (or omitted) behaves exactly as before", () => {
  expect(
    notifyFor({ kind: "run-status", taskId: T, runId: "r", status: "succeeded", ts: 1 }, T, { hidden: false })?.title,
  ).toContain("succeeded");
});

test("notifyFor: kinds per run status", () => {
  const status = (s: "succeeded" | "failed" | "orphaned") =>
    notifyFor({ kind: "run-status", taskId: T, runId: "r", status: s, ts: 1 }, T)?.kind;
  expect(status("succeeded")).toBe("succeeded");
  expect(status("failed")).toBe("failed");
  expect(status("orphaned")).toBe("failed");
});

test("notifyFor: a blocked column's kind follows its reason", () => {
  const blocked = (reason?: "api-error" | "approval" | "session-died" | "unknown-command" | "pipeline") =>
    notifyFor({ kind: "column", taskId: T, runId: "r", column: "blocked", prev: "running", ts: 1, reason }, T)?.kind;
  expect(blocked("api-error")).toBe("api-error");
  expect(blocked("session-died")).toBe("session-ended");
  expect(blocked("unknown-command")).toBe("unknown-command");
  expect(blocked("approval")).toBe("blocked");
  expect(blocked("pipeline")).toBe("blocked");
  expect(blocked(undefined)).toBe("blocked");
});

// --- osNotify ---------------------------------------------------------------
// Every seam is faked: a test must never ring a real bell, spawn a real
// helper or run osascript.

interface Trace {
  log: string[];
  spawned: string[][];
  osascript: Array<[string, string]>;
  deps: OsNotifyDeps;
}

function trace(over: Partial<OsNotifyDeps> = {}): Trace {
  const t: Trace = { log: [], spawned: [], osascript: [], deps: {} };
  t.deps = {
    bell: () => t.log.push("bell"),
    resolveBin: () => "/fake/notifier",
    spawn: async (argv) => {
      t.log.push("spawn");
      t.spawned.push(argv);
      return 0;
    },
    osascript: (title, body) => {
      t.log.push("osascript");
      t.osascript.push([title, body]);
    },
    ...over,
  };
  return t;
}

const N = { title: "Agetor — succeeded", body: "task-abc", taskId: T, kind: "succeeded" as const };

test("osNotify: the core accepting the post means no helper spawn and no osascript", async () => {
  const posted: unknown[] = [];
  const t = trace({
    notifyCore: async (i) => {
      posted.push(i);
    },
  });
  await osNotify(N, t.deps);
  expect(posted).toEqual([N]);
  expect(t.log).toEqual(["bell"]);
});

test("osNotify: a core error falls back to the installed helper with the shared argv", async () => {
  const t = trace({
    notifyCore: async () => {
      throw new Error("501");
    },
  });
  await osNotify(N, t.deps);
  expect(t.log).toEqual(["bell", "spawn"]);
  expect(t.spawned).toEqual([
    [
      "/fake/notifier",
      ...buildTaskNotifierPostArgs({ title: N.title, body: N.body, taskId: T, kind: "succeeded" }),
    ],
  ]);
});

test("osNotify: no notifyCore goes straight to the helper", async () => {
  const t = trace();
  await osNotify(N, t.deps);
  expect(t.log).toEqual(["bell", "spawn"]);
});

test("osNotify: no installed helper falls back to osascript", async () => {
  const t = trace({
    resolveBin: () => null,
    notifyCore: async () => {
      throw new Error("cannot reach core");
    },
  });
  await osNotify(N, t.deps);
  expect(t.log).toEqual(["bell", "osascript"]);
  expect(t.osascript).toEqual([[N.title, N.body]]);
});

test("osNotify: a helper that exits non-zero (not 2) or throws falls through to osascript", async () => {
  for (const spawn of [async () => 1, async () => null, async () => Promise.reject(new Error("boom"))]) {
    const t = trace({ spawn });
    await osNotify(N, t.deps);
    expect(t.log).toEqual(["bell", "osascript"]);
  }
});

test("osNotify: helper exit 2 (permission denied) does not fall back to osascript", async () => {
  const t = trace({ spawn: async () => 2 });
  await osNotify(N, t.deps);
  expect(t.log).toEqual(["bell"]);
});

test("osNotify: without a task id it goes straight to osascript (no core, no helper)", async () => {
  let coreCalls = 0;
  const t = trace({
    notifyCore: async () => {
      coreCalls++;
    },
  });
  await osNotify({ title: "t", body: "b" }, t.deps);
  expect(coreCalls).toBe(0);
  expect(t.log).toEqual(["bell", "osascript"]);
});

test("osNotify: the bell rings first and always, even when every path fails; it never rejects", async () => {
  const t = trace({
    notifyCore: async () => {
      throw new Error("down");
    },
    resolveBin: () => {
      throw new Error("no resolver");
    },
    osascript: () => {
      t.log.push("osascript");
      throw new Error("no osascript");
    },
  });
  await expect(osNotify(N, t.deps)).resolves.toBeUndefined();
  expect(t.log[0]).toBe("bell");
  expect(t.log).toEqual(["bell", "osascript"]);

  const throwingBell = trace({
    bell: () => {
      throw new Error("no tty");
    },
  });
  await expect(osNotify(N, throwingBell.deps)).resolves.toBeUndefined();
  expect(throwingBell.log).toEqual(["spawn"]);
});

test("osNotify: direct helper posts are serialized per process (the second waits for the first's exit)", async () => {
  const exits: Array<(code: number) => void> = [];
  const t = trace({
    spawn: (argv) => {
      t.log.push(`spawn:${argv[argv.indexOf("--message") + 1]}`);
      return new Promise<number>((resolve) => exits.push(resolve));
    },
  });
  const first = osNotify({ ...N, body: "first" }, t.deps);
  const second = osNotify({ ...N, body: "second" }, t.deps);
  await new Promise((r) => setTimeout(r, 20));
  expect(t.log.filter((l) => l.startsWith("spawn"))).toEqual(["spawn:first"]);
  exits[0]!(0);
  await first;
  await new Promise((r) => setTimeout(r, 20));
  expect(t.log.filter((l) => l.startsWith("spawn"))).toEqual(["spawn:first", "spawn:second"]);
  exits[1]!(0);
  await second;
});
