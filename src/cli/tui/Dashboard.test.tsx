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

// --- userMessageLines rendering (src/shared/user-message.ts) --------------
// `EventLine`'s "user" case renders one `UserPlainLine` per `userMessageLines`
// entry; ink-testing-library's fake stdout reports 100 columns and isn't a
// TTY (so chalk/ink emit no ANSI color codes into `lastFrame()`), which is
// why these assert on plain substrings rather than stripping escape codes.

test("event stream: an ordinary user event still renders you› <text>, unchanged", async () => {
  onTaskEvents = null;
  const taskA = task({ id: "taskA", column: "running", runId: "runA", title: "A" });
  const client = { listTasks: async () => [taskA] } as unknown as AgetorClient;

  const { lastFrame, unmount } = render(
    <Dashboard client={client} core={core} dataDir="/nonexistent-agetor-test" />,
  );
  await wait(90);
  expect(onTaskEvents).not.toBeNull();

  onTaskEvents!({ runId: "runA", taskId: "taskA", stream: "user", data: "hello there", ts: 1 });
  await wait(80);

  const frame = lastFrame() ?? "";
  expect(frame).toContain("you› hello there");
  unmount();
});

test("event stream: a forked-skill-launch user event renders cmd›/skill› lines with no raw tags", async () => {
  onTaskEvents = null;
  const taskA = task({ id: "taskA", column: "running", runId: "runA", title: "A" });
  const client = { listTasks: async () => [taskA] } as unknown as AgetorClient;

  const { lastFrame, unmount } = render(
    <Dashboard client={client} core={core} dataDir="/nonexistent-agetor-test" />,
  );
  await wait(90);
  expect(onTaskEvents).not.toBeNull();

  const data =
    "<local-command-stdout>Running in the background as @code-review</local-command-stdout>\n" +
    '<forked-skill-launch>{"agentId":"a7db6829e09d1ba9b","skillName":"code-review","description":"/code-review"}</forked-skill-launch>';
  onTaskEvents!({ runId: "runA", taskId: "taskA", stream: "user", data, ts: 1 });
  await wait(80);

  const frame = lastFrame() ?? "";
  expect(frame).toContain("cmd› Running in the background as @code-review");
  expect(frame).toContain("skill› /code-review launched in background (agent a7db6829)");
  expect(frame).not.toContain("<forked-skill-launch");
  expect(frame).not.toContain("<local-command-stdout");
  unmount();
});

test("event stream: a bash-input/bash-stdout/bash-stderr pair renders sh›/err› with no out› line", async () => {
  onTaskEvents = null;
  const taskA = task({ id: "taskA", column: "running", runId: "runA", title: "A" });
  const client = { listTasks: async () => [taskA] } as unknown as AgetorClient;

  const { lastFrame, unmount } = render(
    <Dashboard client={client} core={core} dataDir="/nonexistent-agetor-test" />,
  );
  await wait(90);
  expect(onTaskEvents).not.toBeNull();

  const base = { runId: "runA", taskId: "taskA" };
  const push = onTaskEvents!;
  push({ ...base, stream: "user", data: "<bash-input>supabase db push --linked</bash-input>", ts: 1 });
  push({
    ...base, stream: "user",
    data: "<bash-stdout></bash-stdout><bash-stderr>(eval):1: command not found: supabase\n</bash-stderr>",
    ts: 2,
  });
  await wait(80);

  const frame = lastFrame() ?? "";
  expect(frame).toContain("sh› $ supabase db push --linked");
  expect(frame).toContain("err› (eval):1: command not found: supabase");
  expect(frame).not.toContain("out›");
  unmount();
});

test("event stream: a user-typed <context> tag renders context› followed by you› on the next line", async () => {
  onTaskEvents = null;
  const taskA = task({ id: "taskA", column: "running", runId: "runA", title: "A" });
  const client = { listTasks: async () => [taskA] } as unknown as AgetorClient;

  const { lastFrame, unmount } = render(
    <Dashboard client={client} core={core} dataDir="/nonexistent-agetor-test" />,
  );
  await wait(90);
  expect(onTaskEvents).not.toBeNull();

  onTaskEvents!({
    runId: "runA", taskId: "taskA", stream: "user",
    data: "<context>\nWe migrate X\n</context>\n\nPlease do Y", ts: 1,
  });
  await wait(80);

  // Multi-line user events render as multiple frame lines — one per
  // `userMessageLines` entry — so pin their relative order, not just presence.
  const lines = (lastFrame() ?? "").split("\n");
  const contextIdx = lines.findIndex((l) => l.includes("context› We migrate X"));
  const youIdx = lines.findIndex((l) => l.includes("you› Please do Y"));
  expect(contextIdx).toBeGreaterThanOrEqual(0);
  expect(youIdx).toBe(contextIdx + 1);
  unmount();
});
