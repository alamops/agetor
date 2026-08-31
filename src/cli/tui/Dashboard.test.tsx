import { test, expect, mock, afterAll } from "bun:test";
import { render } from "ink-testing-library";
import { Dashboard } from "./Dashboard.tsx";
import type { AgetorClient, CoreInfo } from "../api-client.ts";
import type { Task, RunEvent } from "../../shared/types.ts";
import { commitPushPrompt, FX_USAGE_STATUS_PREFIX, PERMISSION_MODE_STATUS_PREFIX } from "../../shared/types.ts";

// Snapshot the real `sse.ts` exports before mocking so the mock can be
// reverted after this file's tests finish — `mock.module` overwrites the
// module record in place, and other test files in the same `bun test`
// process (anything importing "../sse.ts" transitively) must see the real
// implementation again once we're done here.
import * as realSse from "../sse.ts";
const realSseSnapshot = { ...realSse };

// Captures the most recently opened `/tasks/:id/events` subscription so a
// test can push synthetic RunEvents straight into useCoalescedStream without
// a live daemon. The `/events` global-toast subscription (useGlobalEvents) is
// acknowledged with a no-op handle and never driven — no test here needs it.
let onTaskEvents: ((e: RunEvent) => void) | null = null;

mock.module("../sse.ts", () => ({
  ...realSseSnapshot,
  streamSse: (pathname: string, onEvent: (e: unknown) => void) => {
    if (pathname.startsWith("/tasks/") && pathname.includes("/events")) {
      onTaskEvents = onEvent as (e: RunEvent) => void;
    }
    return { close: () => {} };
  },
}));

afterAll(() => {
  mock.module("../sse.ts", () => realSseSnapshot);
});

const ENTER = "\r";
const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const core = { kind: "cli-daemon", port: 4317, token: "x", version: "0", pid: 1, startedAt: 0 } as unknown as CoreInfo;

function task(over: Partial<Task>): Task {
  return {
    id: "t", title: "T", column: "backlog", runId: null,
    pendingInteractionCount: 0, archivedAt: null, hasOpenableRun: false,
    ...over,
  } as unknown as Task;
}

// Smoke test: the whole tree mounts (header, empty board, footer hints, and the
// SSE hooks) without throwing. dataDir points nowhere so discoverCore returns
// null and the streams just back off harmlessly; unmount() tears them down.
test("Dashboard mounts the header, empty state, and the new key hints", async () => {
  const client = { listTasks: async () => [] } as unknown as AgetorClient;
  const { lastFrame, unmount } = render(
    <Dashboard client={client} core={core} dataDir="/nonexistent-agetor-test" />,
  );
  await wait();
  const frame = lastFrame() ?? "";
  expect(frame).toContain("Agetor");
  expect(frame).toContain("no tasks");
  expect(frame).toContain("m msg");
  expect(frame).toContain("c commit");
  expect(frame).toContain("g answer");
  unmount();
});

// Regression: the compose target is pinned by id on entry, so a background
// re-sort can't redirect the message to whatever task slid into the cursor row.
test("compose pins the target task even when the board re-sorts under the cursor", async () => {
  const sends: Array<{ runId: string; line: string }> = [];
  let calls = 0;
  const client = {
    // Poll 1: A running (row 0). Poll 2+: A finished → done (sorts last), so B
    // (blocked) slides into row 0 — sorted[sel] now points at B, not A.
    listTasks: async () => {
      calls++;
      return calls <= 1
        ? [task({ id: "taskA", column: "running", runId: "runA", title: "A" }), task({ id: "taskB", column: "blocked", runId: "runB", title: "B" })]
        : [task({ id: "taskA", column: "done", runId: "runA", title: "A" }), task({ id: "taskB", column: "blocked", runId: "runB", title: "B" })];
    },
    getRuns: async () => [],
    sendInput: async (runId: string, line: string) => {
      sends.push({ runId, line });
      return { delivered: true };
    },
    listProjectFiles: async () => ({ files: [], truncated: false }),
  } as unknown as AgetorClient;

  const { stdin, unmount } = render(
    <Dashboard client={client} core={core} dataDir="/nonexistent-agetor-test" />,
  );
  await wait(90); // first poll → taskA at row 0, selected
  stdin.write("m"); // pin taskA, enter compose
  await wait(1700); // second poll re-sorts: row 0 is now taskB
  stdin.write("hello");
  await wait(40);
  stdin.write(ENTER);
  await wait(80);
  expect(sends).toEqual([{ runId: "runA", line: "hello" }]);
  unmount();
});

test("the 'c' key sends the canned commit & push prompt to the selected task", async () => {
  const sends: Array<{ runId: string; line: string }> = [];
  const taskA = task({
    id: "taskA", column: "review", runId: "runA", hasOpenableRun: true, title: "A",
    branch: "feature/a", taskType: "task",
  });
  const client = {
    listTasks: async () => [taskA],
    getRuns: async () => [],
    sendInput: async (runId: string, line: string) => {
      sends.push({ runId, line });
      return { delivered: true };
    },
  } as unknown as AgetorClient;

  const { stdin, unmount } = render(
    <Dashboard client={client} core={core} dataDir="/nonexistent-agetor-test" />,
  );
  await wait(90);
  stdin.write("c");
  await wait(80);
  expect(sends).toEqual([{ runId: "runA", line: commitPushPrompt(taskA) }]);
  // The prompt must be nomenclature-aware (derived from the branch prefix), not
  // a stale constant — guards the CLI against drifting from the webview.
  expect(sends[0]!.line).toContain(`"feature:"`);
  expect(sends[0]!.line).toContain(`git push -u origin 'feature/a'`);
  unmount();
});

test("the 'c' key commits even while the task is running (mid-turn commit folds into the run)", async () => {
  const sends: Array<{ runId: string; line: string }> = [];
  const taskR = task({ id: "taskR", column: "running", runId: "runR", title: "R" });
  const client = {
    listTasks: async () => [taskR],
    getRuns: async () => [],
    sendInput: async (runId: string, line: string) => {
      sends.push({ runId, line });
      return { delivered: true };
    },
  } as unknown as AgetorClient;

  const { stdin, unmount } = render(
    <Dashboard client={client} core={core} dataDir="/nonexistent-agetor-test" />,
  );
  await wait(90);
  stdin.write("c");
  await wait(80);
  expect(sends).toEqual([{ runId: "runR", line: commitPushPrompt(taskR) }]);
  unmount();
});

test("event stream: an fx_permission interaction renders generically, sentinel status chunks are suppressed, a plain status renders", async () => {
  onTaskEvents = null;
  const taskA = task({ id: "taskA", column: "running", runId: "runA", title: "A" });
  const client = { listTasks: async () => [taskA] } as unknown as AgetorClient;

  const { lastFrame, unmount } = render(
    <Dashboard client={client} core={core} dataDir="/nonexistent-agetor-test" />,
  );
  await wait(90); // first poll selects taskA and opens the /tasks/taskA/events subscription
  expect(onTaskEvents).not.toBeNull();

  const base = { runId: "runA", taskId: "taskA" };
  const push = onTaskEvents!;
  push({ ...base, stream: "interaction", data: JSON.stringify({ kind: "fx_permission" }), ts: 1 });
  push({ ...base, stream: "status", data: `${FX_USAGE_STATUS_PREFIX}{"used":1,"size":2}`, ts: 2 });
  push({ ...base, stream: "status", data: `${PERMISSION_MODE_STATUS_PREFIX}auto`, ts: 3 });
  push({ ...base, stream: "status", data: "plain status text", ts: 4 });
  await wait(80); // let useCoalescedStream's 33ms flush interval commit the batch

  const frame = lastFrame() ?? "";
  // The interaction row is the same generic "press g" line regardless of
  // interaction kind — unlike logs.ts, the dashboard doesn't special-case fx.
  expect(frame).toContain("needs answer — press g");
  expect(frame).not.toContain("answer in the app");
  // Internal-only sentinel status chunks never reach the transcript.
  expect(frame).not.toContain(FX_USAGE_STATUS_PREFIX);
  expect(frame).not.toContain(PERMISSION_MODE_STATUS_PREFIX);
  // A plain status line still renders.
  expect(frame).toContain("plain status text");
  unmount();
});

// ── @ file autocomplete wiring (compose mode → Composer's fileEntries) ──────

test("opening the composer fetches the task's project-file listing and feeds the @ popover", async () => {
  const taskA = task({ id: "taskA", column: "review", runId: "runA", title: "A" });
  const client = {
    listTasks: async () => [taskA],
    getRuns: async () => [],
    listProjectFiles: async () => ({ files: ["README.md", "src/bun/db.ts"], truncated: false }),
    sendInput: async () => ({ delivered: true }),
  } as unknown as AgetorClient;

  const { stdin, lastFrame, unmount } = render(
    <Dashboard client={client} core={core} dataDir="/nonexistent-agetor-test" />,
  );
  await wait(90);
  stdin.write("m"); // enter compose — fires the listProjectFiles fetch
  await wait(80);
  stdin.write("@RE");
  await wait(80);
  const frame = lastFrame() ?? "";
  expect(frame).toContain("README.md");
  expect(frame).toContain("tab/enter accept");
  unmount();
});

test("a send whose reply carries unresolvedRefs surfaces a one-line warning after the ok status", async () => {
  const taskA = task({ id: "taskA", column: "review", runId: "runA", title: "A" });
  const client = {
    listTasks: async () => [taskA],
    getRuns: async () => [],
    listProjectFiles: async () => ({ files: [], truncated: false }),
    sendInput: async () => ({ delivered: true, unresolvedRefs: ["@nope.txt", "@also-missing"] }),
  } as unknown as AgetorClient;

  const { stdin, lastFrame, unmount } = render(
    <Dashboard client={client} core={core} dataDir="/nonexistent-agetor-test" />,
  );
  await wait(90);
  stdin.write("m");
  await wait(80);
  stdin.write("hello");
  await wait(40);
  stdin.write(ENTER);
  await wait(80);
  const frame = lastFrame() ?? "";
  expect(frame).toContain("→ sent");
  expect(frame).toContain("2 @ refs won't resolve");
  expect(frame).toContain("@nope.txt");
  unmount();
});

test("an unresolved ref matching a discovered extension is exempted — no ⚠ at all", async () => {
  const taskA = task({ id: "taskA", column: "review", runId: "runA", title: "A", agent: "claude-code", workdir: "/repo", branch: null });
  const client = {
    listTasks: async () => [taskA],
    getRuns: async () => [],
    listProjectFiles: async () => ({ files: [], truncated: false }),
    agentDiscovery: async () => ({ commands: [], extensions: [{ name: "github", insert: "@github" }] }),
    sendInput: async () => ({ delivered: true, unresolvedRefs: ["@github"] }),
  } as unknown as AgetorClient;

  const { stdin, lastFrame, unmount } = render(
    <Dashboard client={client} core={core} dataDir="/nonexistent-agetor-test" />,
  );
  await wait(90);
  stdin.write("m");
  await wait(80);
  stdin.write("hello");
  await wait(40);
  stdin.write(ENTER);
  await wait(80);
  const frame = lastFrame() ?? "";
  expect(frame).toContain("→ sent");
  expect(frame).not.toContain("⚠");
  unmount();
});

test("a discovered-extension mention is filtered out but a real typo alongside it still warns", async () => {
  const taskA = task({ id: "taskA", column: "review", runId: "runA", title: "A", agent: "claude-code", workdir: "/repo", branch: null });
  const client = {
    listTasks: async () => [taskA],
    getRuns: async () => [],
    listProjectFiles: async () => ({ files: [], truncated: false }),
    agentDiscovery: async () => ({ commands: [], extensions: [{ name: "github", insert: "@github" }] }),
    sendInput: async () => ({ delivered: true, unresolvedRefs: ["@github", "@nope.txt"] }),
  } as unknown as AgetorClient;

  const { stdin, lastFrame, unmount } = render(
    <Dashboard client={client} core={core} dataDir="/nonexistent-agetor-test" />,
  );
  await wait(90);
  stdin.write("m");
  await wait(80);
  stdin.write("hello");
  await wait(40);
  stdin.write(ENTER);
  await wait(80);
  const frame = lastFrame() ?? "";
  expect(frame).toContain("→ sent");
  expect(frame).toContain("1 @ ref won't resolve");
  expect(frame).toContain("@nope.txt");
  expect(frame).not.toContain("@github");
  unmount();
});

// ── @ file autocomplete: scope-keyed listing cache (worktree materializing mid-compose) ──

test("the file-listing cache is keyed by scope, not task id — a scope change mid-compose refetches", async () => {
  let calls = 0;
  const seenScopes: Array<{ dir: string; ref?: string | null }> = [];
  // Same task id throughout; only its resolved scope changes (pre-run
  // {workdir, baseRef} → post-worktree {worktreePath}), mimicking a worktree
  // materializing while the composer stays open.
  let materialized = false;
  const taskA = () =>
    task({
      id: "taskA", column: "ready", runId: null, title: "A",
      workdir: "/repo", isolation: "worktree", baseRef: "main", branchSource: "created", branch: null,
      worktreePath: materialized ? "/repo-worktree" : null,
    });
  const client = {
    listTasks: async () => [taskA()],
    listProjectFiles: async (scope: { dir: string; ref?: string | null }) => {
      calls++;
      seenScopes.push(scope);
      return { files: [], truncated: false };
    },
  } as unknown as AgetorClient;

  const { stdin, unmount } = render(
    <Dashboard client={client} core={core} dataDir="/nonexistent-agetor-test" />,
  );
  await wait(90);
  stdin.write("m"); // compose opens — fetches the pre-run scope {dir: workdir, ref: baseRef}
  await wait(80);
  expect(calls).toBe(1);
  expect(seenScopes[0]).toEqual({ dir: "/repo", ref: "main" });

  materialized = true; // next poll's listTasks() reports the worktree path
  await wait(1700); // let the 1.5s poll pick up the new task snapshot
  expect(calls).toBe(2); // scope changed → refetched, not served from the stale cache
  expect(seenScopes[1]).toEqual({ dir: "/repo-worktree" });
  unmount();
});

test("a cached listing is invalidated when the task's column changes (run settles) — same scope refetches", async () => {
  let calls = 0;
  // Scope stays constant (worktree already materialized); only the column
  // flips, mimicking the agent's run settling while the composer stays open.
  let column: "running" | "review" = "running";
  const taskA = () =>
    task({
      id: "taskA", column: column, runId: column === "running" ? "runA" : null, title: "A",
      workdir: "/repo", isolation: "worktree", baseRef: "main", branchSource: "created", branch: null,
      worktreePath: "/repo-worktree",
    });
  const client = {
    listTasks: async () => [taskA()],
    listProjectFiles: async () => {
      calls++;
      return { files: [], truncated: false };
    },
  } as unknown as AgetorClient;

  const { stdin, unmount } = render(
    <Dashboard client={client} core={core} dataDir="/nonexistent-agetor-test" />,
  );
  await wait(90);
  stdin.write("m"); // compose opens — fetches under column "running"
  await wait(80);
  expect(calls).toBe(1);

  column = "review"; // the run settles; the agent may have written files
  await wait(1700); // let the 1.5s poll deliver the column transition
  expect(calls).toBe(2); // same scope key, stale column → refetched
  unmount();
});

// ── 's' start path: unresolvedRefs surfaces a ⚠ in the started status ───────

test("the 's' start path surfaces ⚠ in the started status when startTask returns unresolvedRefs", async () => {
  const taskA = task({ id: "taskA", column: "ready", runId: null, title: "A", hasOpenableRun: false });
  const client = {
    listTasks: async () => [taskA],
    // No `agentDiscovery` stub here on purpose — this task was never composed
    // to, so the discovery cache isn't warmed; `getExtensionNames` must fetch
    // (and fail open, since the stub client has no such method) rather than
    // block the "started" status.
    startTask: async () => ({ runId: "runA", unresolvedRefs: ["@nope.txt"] }),
  } as unknown as AgetorClient;

  const { stdin, lastFrame, unmount } = render(
    <Dashboard client={client} core={core} dataDir="/nonexistent-agetor-test" />,
  );
  await wait(90);
  stdin.write("s");
  await wait(80);
  const frame = lastFrame() ?? "";
  expect(frame).toContain("▸ started");
  expect(frame).toContain("1 @ ref won't resolve");
  expect(frame).toContain("@nope.txt");
  unmount();
});

test("the 's' start path shows a plain started status when there are no unresolvedRefs", async () => {
  const taskA = task({ id: "taskA", column: "ready", runId: null, title: "A", hasOpenableRun: false });
  const client = {
    listTasks: async () => [taskA],
    startTask: async () => ({ runId: "runA" }),
  } as unknown as AgetorClient;

  const { stdin, lastFrame, unmount } = render(
    <Dashboard client={client} core={core} dataDir="/nonexistent-agetor-test" />,
  );
  await wait(90);
  stdin.write("s");
  await wait(80);
  const frame = lastFrame() ?? "";
  expect(frame).toContain("▸ started");
  expect(frame).not.toContain("⚠");
  unmount();
});
