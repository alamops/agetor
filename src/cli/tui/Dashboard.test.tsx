import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { Dashboard } from "./Dashboard.tsx";
import type { AgetorClient, CoreInfo } from "../api-client.ts";
import type { Task } from "../../shared/types.ts";
import { commitPushPrompt } from "../../shared/types.ts";

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
