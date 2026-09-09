import { test, expect, mock, afterAll } from "bun:test";
import { render } from "ink-testing-library";
import { Dashboard, buildSentFilesLines, buildFxRecoveryLines } from "./Dashboard.tsx";
import { eventKey } from "./useCoalescedStream.ts";
import type { AgetorClient, CoreInfo } from "../api-client.ts";
import type { Task, RunEvent } from "../../shared/types.ts";
import {
  commitPushPrompt,
  FX_RECOVERY_STATUS_PREFIX,
  FX_USAGE_STATUS_PREFIX,
  PERMISSION_MODE_STATUS_PREFIX,
} from "../../shared/types.ts";

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
// The footer's right-hand status text lives beside a hint string
// (`↑/↓ select · s run · x stop · m msg · c commit · g answer · r resume ·
// q quit`) inside ink-testing-library's fixed 100-column fake stdout — a
// long status (e.g. an "N @ ref(s) won't resolve: …" warning) can wrap onto
// a second frame line mid-word, splitting a `toContain` needle across the
// newline. Collapse all whitespace runs (including the wrap's embedded
// newline) to a single space before asserting on any such needle so the
// assertion holds regardless of exactly where ink wraps.
const flatten = (s: string) => s.replace(/\s+/g, " ");
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
  // Resume affordance for a paused fx recovery (docs/plans/
  // fix-fx-harness-rate-limit.md §3.5/T6) — present in the default (nav)
  // mode's footer legend regardless of whether anything is actually resumable.
  expect(frame).toContain("r resume");
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

test("event stream: a SendUserFile tool_use renders 📎 sending…, then folds its tool_result into 📎 sent … (size) with no ↳ result line", async () => {
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
  push({
    ...base, stream: "tool_use",
    data: JSON.stringify({
      id: "toolu_1", name: "SendUserFile",
      input: { files: ["/tmp/a.png", "/tmp/b.md"], caption: "here", status: "normal" },
    }),
    ts: 1,
  });
  await wait(80);

  let frame = lastFrame() ?? "";
  expect(frame).toContain("📎 sending 2 files: a.png, b.md");
  expect(frame).not.toContain("▸ SendUserFile");

  push({
    ...base, stream: "tool_result",
    data: JSON.stringify({
      toolUseId: "toolu_1",
      content: "2 files delivered to user.\n  /tmp/a.png → file_uuid: abc\n  /tmp/b.md → file_uuid: def",
      isError: false,
      attachments: [
        { path: "/tmp/a.png", size: 2048, isImage: true, media_type: "image/png" },
        { path: "/tmp/b.md", size: null, isImage: false, media_type: null },
      ],
    }),
    ts: 2,
  });
  await wait(80);

  frame = lastFrame() ?? "";
  expect(frame).toContain("📎 sent 2 files: a.png (2.0 KB), b.md");
  expect(frame).not.toContain("↳ result");
  unmount();
});

// `buildSentFilesLines` is the perf fix's exported primitive-prop builder
// (Dashboard.tsx): `EventLine` takes a `sentLine: string | null | undefined`
// prop instead of the old whole-window Map, specifically so an unrelated
// line's prop stays the SAME primitive (`undefined`) across two calls even
// though the returned Map is a fresh object each time and the input array
// grew (a coalesced flush always appends). ink-testing-library's `lastFrame()`
// only exposes rendered text, not React element/prop identity, so this
// asserts the primitive-shape contract the memo fix actually depends on
// directly against the exported helper, rather than through a live render.
test("buildSentFilesLines: an unrelated event's entry stays absent (undefined) across a flush that only appends", () => {
  const before: RunEvent[] = [
    { runId: "r", taskId: "t", stream: "assistant", data: "hello", ts: 1 },
    { runId: "r", taskId: "t", stream: "tool_use", data: JSON.stringify({ id: "toolu_x", name: "Bash", input: { command: "ls" } }), ts: 2 },
    { runId: "r", taskId: "t", stream: "tool_result", data: JSON.stringify({ toolUseId: "toolu_x", content: "ok" }), ts: 3 },
  ];
  const appended: RunEvent[] = [
    ...before,
    { runId: "r", taskId: "t", stream: "status", data: "another status line", ts: 4 },
  ];

  const linesBefore = buildSentFilesLines(before);
  const linesAfter = buildSentFilesLines(appended);

  // Two distinct Map objects (never the same reference)...
  expect(linesBefore).not.toBe(linesAfter);
  // ...but every unrelated event's value is the identical `undefined`
  // primitive in both — exactly what lets `EventLine`'s shallow memo bail
  // out for these lines despite the Map's own identity changing.
  for (const e of before) {
    expect(linesBefore.get(eventKey(e))).toBeUndefined();
    expect(linesAfter.get(eventKey(e))).toBeUndefined();
  }
  // The newly appended, also-unrelated line is absent too, not merely `null`.
  expect(linesAfter.has(eventKey(appended[appended.length - 1]!))).toBe(false);
});

test("buildSentFilesLines: a SendUserFile tool_use formats a stable 📎 string and its paired tool_result maps to null", () => {
  const toolUse: RunEvent = {
    runId: "r", taskId: "t", stream: "tool_use",
    data: JSON.stringify({ id: "toolu_1", name: "SendUserFile", input: { files: ["/tmp/a.png"] } }),
    ts: 1,
  };
  const toolResult: RunEvent = {
    runId: "r", taskId: "t", stream: "tool_result",
    data: JSON.stringify({ toolUseId: "toolu_1", content: "1 file delivered to user.\n  /tmp/a.png → file_uuid: abc", isError: false }),
    ts: 2,
  };
  const unrelated: RunEvent = { runId: "r", taskId: "t", stream: "assistant", data: "hi", ts: 3 };

  const lines = buildSentFilesLines([toolUse, toolResult, unrelated]);
  expect(lines.get(eventKey(toolUse))).toBe("📎 sent 1 file: a.png");
  expect(lines.get(eventKey(toolResult))).toBeNull();
  expect(lines.has(eventKey(unrelated))).toBe(false);
});

// ── fx-recovery sentinel rendering + Resume (docs/plans/
// fix-fx-harness-rate-limit.md §3.5/T6) ─────────────────────────────────────

function fxRecoveryEvent(runId: string, payload: Record<string, unknown>, ts: number): RunEvent {
  return {
    runId, taskId: "t", stream: "status",
    data: `${FX_RECOVERY_STATUS_PREFIX}${JSON.stringify(payload)}`,
    ts,
  };
}

test("buildFxRecoveryLines: only the LAST active sentinel per run maps to text; every other sentinel row maps to null; non-sentinel events are absent", () => {
  const runAActive1 = fxRecoveryEvent("runA", { state: "active", message: "attempt 1/3" }, 1);
  const runAActive2 = fxRecoveryEvent("runA", { state: "active", message: "attempt 2/3" }, 2);
  const runAActive3 = fxRecoveryEvent("runA", { state: "active", message: "attempt 3/3" }, 3);
  const runAPaused = fxRecoveryEvent("runA", { state: "paused", message: "paused on run A" }, 4);
  const runBActive = fxRecoveryEvent("runB", { state: "active", message: "run B attempt 1/1" }, 5);
  const unrelated: RunEvent = { runId: "runA", taskId: "t", stream: "assistant", data: "hello", ts: 6 };

  const lines = buildFxRecoveryLines([runAActive1, runAActive2, runAActive3, runAPaused, runBActive, unrelated]);

  // Every sentinel row for run A maps to `null` except the LAST active one.
  expect(lines.get(eventKey(runAActive1))).toBeNull();
  expect(lines.get(eventKey(runAActive2))).toBeNull();
  expect(lines.get(eventKey(runAActive3))).toBe("attempt 3/3");
  expect(lines.get(eventKey(runAPaused))).toBeNull();
  // A different run tracks its own "last active" independently.
  expect(lines.get(eventKey(runBActive))).toBe("run B attempt 1/1");
  // A non-recovery event is absent from the map entirely, not merely `null`.
  expect(lines.has(eventKey(unrelated))).toBe(false);
});

test("buildFxRecoveryLines: a replayed active sentinel is never eligible to become the run's latest-active line — only a later LIVE active sentinel gets text", () => {
  const replayedActive = fxRecoveryEvent("runA", { state: "active", message: "stale replayed attempt", replayed: true }, 1);
  const replayedPaused = fxRecoveryEvent("runA", { state: "paused", message: "stale replayed pause", replayed: true }, 2);
  const liveActive = fxRecoveryEvent("runA", { state: "active", message: "live attempt 1/3" }, 3);

  const lines = buildFxRecoveryLines([replayedActive, replayedPaused, liveActive]);

  expect(lines.get(eventKey(replayedActive))).toBeNull();
  expect(lines.get(eventKey(replayedPaused))).toBeNull();
  expect(lines.get(eventKey(liveActive))).toBe("live attempt 1/3");
});

test("buildFxRecoveryLines: a run whose events are ALL replayed sentinels shows no text at all", () => {
  const replayedActive1 = fxRecoveryEvent("runA", { state: "active", message: "replayed attempt 1", replayed: true }, 1);
  const replayedActive2 = fxRecoveryEvent("runA", { state: "active", message: "replayed attempt 2", replayed: true }, 2);
  const replayedPaused = fxRecoveryEvent("runA", { state: "paused", message: "replayed pause", replayed: true }, 3);

  const lines = buildFxRecoveryLines([replayedActive1, replayedActive2, replayedPaused]);

  expect(lines.get(eventKey(replayedActive1))).toBeNull();
  expect(lines.get(eventKey(replayedActive2))).toBeNull();
  expect(lines.get(eventKey(replayedPaused))).toBeNull();
});

test("event stream: fx-recovery — the detail pane shows only the LATEST active notice per run and hides the older ones", async () => {
  onTaskEvents = null;
  const taskA = task({ id: "taskA", column: "running", runId: "runA", title: "A" });
  const client = { listTasks: async () => [taskA] } as unknown as AgetorClient;

  const { lastFrame, unmount } = render(
    <Dashboard client={client} core={core} dataDir="/nonexistent-agetor-test" />,
  );
  await wait(90);
  expect(onTaskEvents).not.toBeNull();

  const push = onTaskEvents!;
  push(fxRecoveryEvent("runA", { state: "active", message: "retry attempt one" }, 1));
  push(fxRecoveryEvent("runA", { state: "active", message: "retry attempt two" }, 2));
  push(fxRecoveryEvent("runA", { state: "active", message: "retry attempt three (latest)" }, 3));
  await wait(80);

  const frame = lastFrame() ?? "";
  expect(frame).toContain("retry attempt three (latest)");
  expect(frame).not.toContain("retry attempt one");
  expect(frame).not.toContain("retry attempt two");
  // The raw sentinel prefix itself never leaks into the transcript.
  expect(frame).not.toContain(FX_RECOVERY_STATUS_PREFIX);
  unmount();
});

test("event stream: a resumable paused fx-recovery sentinel on the newest run shows the '⚠ paused — press r to resume' header hint when the task isn't running", async () => {
  onTaskEvents = null;
  const taskA = task({ id: "taskA", column: "ready", runId: null, title: "A" });
  const client = { listTasks: async () => [taskA] } as unknown as AgetorClient;

  const { lastFrame, unmount } = render(
    <Dashboard client={client} core={core} dataDir="/nonexistent-agetor-test" />,
  );
  await wait(90);
  expect(onTaskEvents).not.toBeNull();

  onTaskEvents!(fxRecoveryEvent("runA", { state: "paused", requiredAction: "continue_later", message: "⚠ Rate limited" }, 1));
  await wait(80);

  expect(lastFrame() ?? "").toContain("⚠ paused — press r to resume");
  unmount();
});

test("event stream: the resume hint is hidden while the task is running, even with a resumable paused sentinel on the newest run", async () => {
  onTaskEvents = null;
  const taskA = task({ id: "taskA", column: "running", runId: "runA", title: "A" });
  const client = { listTasks: async () => [taskA] } as unknown as AgetorClient;

  const { lastFrame, unmount } = render(
    <Dashboard client={client} core={core} dataDir="/nonexistent-agetor-test" />,
  );
  await wait(90);
  expect(onTaskEvents).not.toBeNull();

  onTaskEvents!(fxRecoveryEvent("runA", { state: "paused", requiredAction: "continue_later", message: "⚠ Rate limited" }, 1));
  await wait(80);

  expect(lastFrame() ?? "").not.toContain("press r to resume");
  unmount();
});

test("event stream: the resume hint is hidden on a 'review' task even with a resumable paused sentinel on the newest run (a resumed turn can succeed while fx's replayed 'paused' update is still the last one on record)", async () => {
  onTaskEvents = null;
  const taskA = task({ id: "taskA", column: "review", runId: null, title: "A" });
  const client = { listTasks: async () => [taskA] } as unknown as AgetorClient;

  const { lastFrame, unmount } = render(
    <Dashboard client={client} core={core} dataDir="/nonexistent-agetor-test" />,
  );
  await wait(90);
  expect(onTaskEvents).not.toBeNull();

  onTaskEvents!(fxRecoveryEvent("runA", { state: "paused", requiredAction: "continue_later", message: "⚠ Rate limited" }, 1));
  await wait(80);

  // Only `column === "ready"` (the column a failed fx settle leaves the
  // card in) shows the hint — `review` never does, regardless of what the
  // last recorded recovery sentinel says.
  expect(lastFrame() ?? "").not.toContain("press r to resume");
  unmount();
});

test("event stream: the resume hint is hidden once the newest run's last recovery sentinel is 'recovered', not 'paused'", async () => {
  onTaskEvents = null;
  const taskA = task({ id: "taskA", column: "review", runId: null, title: "A" });
  const client = { listTasks: async () => [taskA] } as unknown as AgetorClient;

  const { lastFrame, unmount } = render(
    <Dashboard client={client} core={core} dataDir="/nonexistent-agetor-test" />,
  );
  await wait(90);
  expect(onTaskEvents).not.toBeNull();

  const push = onTaskEvents!;
  push(fxRecoveryEvent("runA", { state: "paused", requiredAction: "continue_later", message: "⚠ Rate limited" }, 1));
  push(fxRecoveryEvent("runA", { state: "recovered", message: "✓ recovered · succeeded on attempt 2/3" }, 2));
  await wait(80);

  expect(lastFrame() ?? "").not.toContain("press r to resume");
  unmount();
});

test("the 'r' key resumes a paused fx response for the selected task and shows the resuming status", async () => {
  const taskA = task({ id: "taskAbcdefgh12345", column: "ready", runId: null, title: "A" });
  const seenIds: string[] = [];
  const client = {
    listTasks: async () => [taskA],
    resumeFxRecovery: async (id: string) => {
      seenIds.push(id);
      return { ok: true, runId: "run12345678abcd" };
    },
  } as unknown as AgetorClient;

  const { stdin, lastFrame, unmount } = render(
    <Dashboard client={client} core={core} dataDir="/nonexistent-agetor-test" />,
  );
  await wait(90);
  stdin.write("r");
  await wait(80);

  expect(seenIds).toEqual([taskA.id]);
  // Same footer wrap/interleaving as the "@ ref won't resolve" status tests
  // above (see `flatten`'s doc comment): assert the two halves that each
  // stay contiguous on their own physical line rather than the single joined
  // phrase, so this doesn't depend on exactly where ink wraps the footer.
  const frame = flatten(lastFrame() ?? "");
  expect(frame).toContain(`▸ resuming ${taskA.id.slice(0, 8)} (run`);
  expect(frame).toContain(`${"run12345678abcd".slice(0, 8)})`);
  unmount();
});

test("the 'r' key shows '! <message>' when resumeFxRecovery rejects", async () => {
  const taskA = task({ id: "taskA", column: "ready", runId: null, title: "A" });
  const client = {
    listTasks: async () => [taskA],
    resumeFxRecovery: async () => {
      throw new Error("no paused fx response to resume");
    },
  } as unknown as AgetorClient;

  const { stdin, lastFrame, unmount } = render(
    <Dashboard client={client} core={core} dataDir="/nonexistent-agetor-test" />,
  );
  await wait(90);
  stdin.write("r");
  await wait(80);

  // Same footer wrap/interleaving as above — "! no paused fx response to
  // resume" is unique enough on its own (the "!" marker plus this specific
  // wording can't be confused with the hint's own "r resume" token) that
  // checking its un-wrapped prefix is sufficient without needing the
  // trailing "resume" too.
  const frame = flatten(lastFrame() ?? "");
  expect(frame).toContain("! no paused fx response to");
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
  const frame = flatten(lastFrame() ?? "");
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
  const frame = flatten(lastFrame() ?? "");
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

// ── @ remote search fallback (truncated listing → server-side search, CLAUDE.md §12) ──

test("a truncated listing wires the composer's remoteSearch, which is invoked with a q param after typing", async () => {
  const taskA = task({ id: "taskA", column: "review", runId: "runA", title: "A" });
  const seenQueries: Array<{ dir: string; q?: string | null; limit?: number }> = [];
  const client = {
    listTasks: async () => [taskA],
    getRuns: async () => [],
    sendInput: async () => ({ delivered: true }),
    listProjectFiles: async (scope: { dir: string; ref?: string | null; q?: string | null; limit?: number }) => {
      if (scope.q !== undefined) {
        seenQueries.push(scope);
        return { files: ["deep/remote-match.ts"], truncated: true };
      }
      // Initial (untruncated-signature) fetch on compose-open: report the
      // listing itself as truncated so the composer switches to remote search.
      return { files: ["README.md"], truncated: true };
    },
  } as unknown as AgetorClient;

  const { stdin, lastFrame, unmount } = render(
    <Dashboard client={client} core={core} dataDir="/nonexistent-agetor-test" />,
  );
  await wait(90);
  stdin.write("m"); // enter compose — fires the truncated listProjectFiles fetch
  await wait(80);
  // Two chars — `remoteSearch` never fires below `MIN_REMOTE_QUERY_LEN`
  // (Composer.tsx), so this must clear that floor to exercise the wiring.
  stdin.write("@xy");
  await wait(300); // let the composer's 200ms remoteSearch debounce fire
  const frame = lastFrame() ?? "";
  expect(seenQueries.length).toBeGreaterThan(0);
  expect(seenQueries[0]!.q).toBe("xy");
  expect(seenQueries[0]!.limit).toBe(5);
  expect(frame).toContain("deep/remote-match.ts");
  unmount();
});

test("a remote search failure keeps the local rows instead of blanking the popover", async () => {
  const taskA = task({ id: "taskA", column: "review", runId: "runA", title: "A" });
  const client = {
    listTasks: async () => [taskA],
    getRuns: async () => [],
    sendInput: async () => ({ delivered: true }),
    listProjectFiles: async (scope: { dir: string; ref?: string | null; q?: string | null }) => {
      if (scope.q !== undefined) throw new Error("network down");
      // Initial (untruncated-signature) fetch on compose-open: report the
      // listing itself as truncated so the composer switches to remote
      // search, with a local match for "xy" so we can tell it survived.
      return { files: ["deep/xylophone.ts"], truncated: true };
    },
  } as unknown as AgetorClient;

  const { stdin, lastFrame, unmount } = render(
    <Dashboard client={client} core={core} dataDir="/nonexistent-agetor-test" />,
  );
  await wait(90);
  stdin.write("m"); // enter compose — fires the truncated listProjectFiles fetch
  await wait(80);
  stdin.write("@xy");
  await wait(300); // let the composer's 200ms remoteSearch debounce fire and reject
  const frame = lastFrame() ?? "";
  // A `null` answer (composeRemoteSearch's catch) must not blank the
  // popover — the local suggestAtEntries row still renders.
  expect(frame).toContain("deep/xylophone.ts");
  unmount();
});

test("an untruncated listing never wires remoteSearch — no q-carrying call is ever made", async () => {
  const taskA = task({ id: "taskA", column: "review", runId: "runA", title: "A" });
  const seenQueries: Array<{ q?: string | null }> = [];
  const client = {
    listTasks: async () => [taskA],
    getRuns: async () => [],
    sendInput: async () => ({ delivered: true }),
    listProjectFiles: async (scope: { dir: string; ref?: string | null; q?: string | null }) => {
      if (scope.q !== undefined) seenQueries.push(scope);
      return { files: ["README.md"], truncated: false };
    },
  } as unknown as AgetorClient;

  const { stdin, lastFrame, unmount } = render(
    <Dashboard client={client} core={core} dataDir="/nonexistent-agetor-test" />,
  );
  await wait(90);
  stdin.write("m");
  await wait(80);
  stdin.write("@RE");
  await wait(300);
  const frame = lastFrame() ?? "";
  expect(seenQueries.length).toBe(0);
  expect(frame).toContain("README.md");
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
  const frame = flatten(lastFrame() ?? "");
  expect(frame).toContain("▸ started");
  // The footer's hint text grew (`· r resume`) and, at ink-testing-library's
  // fixed 100-column frame width, this status now wraps onto a second
  // physical line whose left column is the WRAPPED HINT REMAINDER ("r resume
  // · q quit") — so after wrap the raw text reads "…won't" / "r resume · q
  // quit resolve: …", with hint text spliced between the two halves of the
  // phrase. `flatten`'s whitespace collapse alone can't bridge that (it's
  // not a whitespace-only gap), so assert the two halves that each stay
  // contiguous on their own line instead of the single joined phrase.
  expect(frame).toContain("1 @ ref won't");
  expect(frame).toContain("resolve: @nope.txt");
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
