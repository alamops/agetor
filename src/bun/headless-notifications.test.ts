/**
 * The pure policy of src/bun/headless-notifications.ts. The expected titles,
 * bodies and kinds are the ones the webview raises (src/mainview/lib/toasts.ts
 * via App.tsx's global-event handler): "Waiting on you", "Task succeeded",
 * "Task failed" (+ " — agetor restarted while running" for an orphaned run),
 * "API error — retry", "Session ended", "Message not delivered", "N files sent
 * to you". Pinning them here keeps a headless notification reading exactly like
 * an app one.
 *
 * Imports `headless-notifications.ts`, which reaches `db.ts` through its
 * installer's imports, so AGETOR_DATA_DIR is pointed at a scratch dir before
 * the dynamic import (house rule: db.ts opens and migrates on module load).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { GlobalEvent, PipelineBlock, PipelineBlockKind, PipelineRunStatus } from "../shared/types.ts";
import { rmTestDataDir } from "./test-data-dir.ts";

let dataDir = "";
let prevDataDir: string | undefined;
let headlessNotificationFor: typeof import("./headless-notifications.ts").headlessNotificationFor;
let isHeadlessNotificationsEnabled: typeof import("./headless-notifications.ts").isHeadlessNotificationsEnabled;

let createHeadlessNotificationHandler: typeof import("./headless-notifications.ts").createHeadlessNotificationHandler;
let decideOwedPipelineAlert: typeof import("./headless-notifications.ts").decideOwedPipelineAlert;

beforeAll(async () => {
  prevDataDir = process.env.AGETOR_DATA_DIR;
  dataDir = mkdtempSync(path.join(tmpdir(), "agetor-headless-notif-"));
  process.env.AGETOR_DATA_DIR = dataDir;
  const mod = await import("./headless-notifications.ts");
  headlessNotificationFor = mod.headlessNotificationFor;
  isHeadlessNotificationsEnabled = mod.isHeadlessNotificationsEnabled;
  createHeadlessNotificationHandler = mod.createHeadlessNotificationHandler;
  decideOwedPipelineAlert = mod.decideOwedPipelineAlert;
});

afterAll(() => {
  if (prevDataDir === undefined) delete process.env.AGETOR_DATA_DIR;
  else process.env.AGETOR_DATA_DIR = prevDataDir;
  rmTestDataDir(dataDir);
});

const TASKS: Record<string, { title: string; agent?: string; pipelineName?: string }> = {
  t1: { title: "Fix bug", agent: "claude-code" },
  bare: { title: "No agent" },
  p1: { title: "Ship it", pipelineName: "Pipe" },
  s1: { title: "Pipe · Review", agent: "codex" },
  s2: { title: "Unprefixed step", agent: "codex" },
};
const lookup = (id: string) => TASKS[id] ?? null;
const f = (ev: GlobalEvent, ctx?: { prevPipelineStatus?: PipelineRunStatus | null }) =>
  headlessNotificationFor(ev, lookup, ctx);

describe("interaction", () => {
  test("pending → Waiting on you, naming the task and its harness", () => {
    expect(
      f({ kind: "interaction", taskId: "t1", runId: "r", state: "pending", interactionId: "i", ts: 1 }),
    ).toEqual({ title: "Waiting on you", body: "Fix bug · claude-code", taskId: "t1", kind: "waiting" });
  });

  test("a task with no agent is named by its title alone", () => {
    expect(
      f({ kind: "interaction", taskId: "bare", runId: "r", state: "pending", interactionId: "i", ts: 1 })?.body,
    ).toBe("No agent");
  });

  test("a resolved interaction posts nothing", () => {
    expect(
      f({ kind: "interaction", taskId: "t1", runId: "r", state: "resolved", interactionId: "i", ts: 1 }),
    ).toBeNull();
  });

  test("a hidden step is retargeted at its parent: parent title, step name in the body, parent id", () => {
    expect(
      f({
        kind: "interaction", taskId: "s1", runId: "r", state: "pending", interactionId: "i", ts: 1,
        pipelineParentId: "p1",
      }),
    ).toEqual({ title: "Waiting on you", body: "Ship it · Review", taskId: "p1", kind: "waiting" });
  });

  test("a step title without the pipeline-name prefix is used whole", () => {
    expect(
      f({
        kind: "interaction", taskId: "s2", runId: "r", state: "pending", interactionId: "i", ts: 1,
        pipelineParentId: "p1",
      })?.body,
    ).toBe("Ship it · Unprefixed step");
  });

  test("an unknown parent falls back to the event's pipelineParentTitle, then a short id", () => {
    const base = {
      kind: "interaction", taskId: "s1", runId: "r", state: "pending", interactionId: "i", ts: 1,
      pipelineParentId: "gone-parent-id",
    } as const;
    expect(f({ ...base, pipelineParentTitle: "Carried title" } as GlobalEvent)?.body).toStartWith("Carried title");
    const fallback = f(base as GlobalEvent);
    expect(fallback?.taskId).toBe("gone-parent-id");
    expect(fallback?.body).toStartWith("Pipeline gone-pa");
  });

  test("an unknown task is named by a short id", () => {
    expect(
      f({ kind: "interaction", taskId: "abcdefghij", runId: "r", state: "pending", interactionId: "i", ts: 1 })?.body,
    ).toBe("Task abcdefg");
  });
});

describe("run-status", () => {
  const rs = (status: string, extra: object = {}) =>
    f({ kind: "run-status", taskId: "t1", runId: "r", status, ts: 1, ...extra } as GlobalEvent);

  test("succeeded → Task succeeded", () => {
    expect(rs("succeeded")).toEqual({
      title: "Task succeeded", body: "Fix bug · claude-code", taskId: "t1", kind: "succeeded",
    });
  });

  test("failed → Task failed", () => {
    expect(rs("failed")).toEqual({
      title: "Task failed", body: "Fix bug · claude-code", taskId: "t1", kind: "failed",
    });
  });

  test("orphaned → Task failed with the restart reason", () => {
    expect(rs("orphaned")).toEqual({
      title: "Task failed",
      body: "Fix bug · claude-code — agetor restarted while running",
      taskId: "t1",
      kind: "failed",
    });
  });

  test("cancelled is silent (the user asked for it)", () => {
    expect(rs("cancelled")).toBeNull();
  });

  test("a hidden step's own settle never notifies", () => {
    for (const status of ["succeeded", "failed", "orphaned"]) {
      expect(
        f({ kind: "run-status", taskId: "s1", runId: "r", status, ts: 1, pipelineParentId: "p1" } as GlobalEvent),
      ).toBeNull();
    }
  });
});

describe("column", () => {
  const col = (reason: string | undefined, extra: object = {}, column = "blocked") =>
    f({ kind: "column", taskId: "t1", runId: null, column, prev: "running", ts: 1, reason, ...extra } as GlobalEvent);

  test("blocked by reason maps to the webview's heading and kind", () => {
    expect(col("api-error")).toEqual({
      title: "API error — retry", body: "Fix bug · claude-code", taskId: "t1", kind: "api-error",
    });
    expect(col("session-died")).toMatchObject({ title: "Session ended", kind: "session-ended" });
    expect(col("unknown-command")).toMatchObject({ title: "Message not delivered", kind: "unknown-command" });
  });

  test("approval and an unset reason are the generic blocked → Waiting on you", () => {
    expect(col("approval")).toMatchObject({ title: "Waiting on you", kind: "blocked" });
    expect(col(undefined)).toMatchObject({ title: "Waiting on you", kind: "blocked" });
  });

  test("a pipeline parent's reason:\"pipeline\" block with no question behind it posts \"Pipeline needs you\"", () => {
    expect(col("pipeline", { taskId: "p1" })).toEqual({
      title: "Waiting on you", body: "Ship it · Pipeline needs you", taskId: "p1", kind: "blocked",
    });
  });

  test("...and stays silent while a step's question already holds the parent's notification", () => {
    expect(
      headlessNotificationFor(
        { kind: "column", taskId: "p1", runId: null, column: "blocked", prev: "running", ts: 1, reason: "pipeline" } as GlobalEvent,
        lookup,
        { hasPendingQuestion: true },
      ),
    ).toBeNull();
  });

  test("a hidden step's own blocked transition is silent", () => {
    expect(col("api-error", { pipelineParentId: "p1" })).toBeNull();
    expect(col(undefined, { pipelineParentId: "p1" })).toBeNull();
  });

  test("only the blocked column notifies", () => {
    expect(col(undefined, {}, "review")).toBeNull();
    expect(col(undefined, {}, "running")).toBeNull();
    expect(col("api-error", {}, "ready")).toBeNull();
  });
});

describe("files-sent", () => {
  const fs = (count: number, caption: string | null, extra: object = {}) =>
    f({ kind: "files-sent", taskId: "t1", runId: "r", count, caption, proactive: false, ts: 1, ...extra } as GlobalEvent);

  test("singular and plural titles", () => {
    expect(fs(1, null)).toEqual({ title: "1 file sent to you", body: "Fix bug · claude-code", taskId: "t1", kind: "files-sent" });
    expect(fs(2, null)?.title).toBe("2 files sent to you");
  });

  test("the caption's first line is appended to the body", () => {
    expect(fs(2, "hi\nthere")?.body).toBe("Fix bug · claude-code — hi");
  });

  test("a blank caption adds nothing", () => {
    expect(fs(2, "  \nsecond")?.body).toBe("Fix bug · claude-code");
  });

  test("a long caption is cut at 120 characters with an ellipsis", () => {
    const body = fs(1, "x".repeat(200))?.body ?? "";
    expect(body).toBe(`Fix bug · claude-code — ${"x".repeat(120)}…`);
  });

  test("a hidden step's files are retargeted at the parent", () => {
    expect(fs(1, null, { taskId: "s1", pipelineParentId: "p1" })).toEqual({
      title: "1 file sent to you", body: "Ship it · Review", taskId: "p1", kind: "files-sent",
    });
  });
});

describe("pipeline", () => {
  const pl = (status: PipelineRunStatus, prev?: PipelineRunStatus | null) =>
    f({ kind: "pipeline", taskId: "p1", status, activeStepIds: [], stepCount: 2, ts: 1 }, { prevPipelineStatus: prev });

  test("done is notified on the transition into it", () => {
    expect(pl("done", "running")).toEqual({
      title: "Task succeeded", body: "Ship it · Pipeline finished", taskId: "p1", kind: "pipeline-finished",
    });
    expect(pl("done", null)?.kind).toBe("pipeline-finished");
    expect(pl("done")?.kind).toBe("pipeline-finished");
  });

  test("a repeat of done is not notified again", () => {
    expect(pl("done", "done")).toBeNull();
  });

  test("other statuses never notify here", () => {
    for (const s of ["running", "blocked", "cancelled", "idle"] as PipelineRunStatus[]) {
      expect(pl(s, "running")).toBeNull();
    }
  });
});

describe("events that never notify", () => {
  test("update / send-failed / fx-auto-resume", () => {
    expect(f({ kind: "update", taskId: "t1", ts: 1 } as unknown as GlobalEvent)).toBeNull();
    expect(
      f({ kind: "send-failed", taskId: "t1", reason: "x", savedToBacklog: true, ts: 1 } as unknown as GlobalEvent),
    ).toBeNull();
    expect(f({ kind: "fx-auto-resume", taskId: "t1", ts: 1 } as unknown as GlobalEvent)).toBeNull();
  });
});

describe("isHeadlessNotificationsEnabled", () => {
  const darwin = process.platform === "darwin";

  test("=0 turns it off anywhere", () => {
    expect(isHeadlessNotificationsEnabled({ AGETOR_HEADLESS_NOTIFICATIONS: "0" })).toBe(false);
    expect(isHeadlessNotificationsEnabled({ AGETOR_HEADLESS_NOTIFICATIONS: "0", NODE_ENV: "production" })).toBe(false);
  });

  test("=1 forces it on (macOS only), even under NODE_ENV=test", () => {
    expect(isHeadlessNotificationsEnabled({ AGETOR_HEADLESS_NOTIFICATIONS: "1", NODE_ENV: "test" })).toBe(darwin);
  });

  test("unset under NODE_ENV=test is off", () => {
    expect(isHeadlessNotificationsEnabled({ NODE_ENV: "test" })).toBe(false);
  });

  test("unset otherwise is on (macOS only)", () => {
    expect(isHeadlessNotificationsEnabled({})).toBe(darwin);
    expect(isHeadlessNotificationsEnabled({ NODE_ENV: "production" })).toBe(darwin);
  });
});

describe("stateful handler: \"Pipeline needs you\" for a block with no step question", () => {
  type Row = {
    column?: string;
    archivedAt?: number | null;
    pipelineRun?: { status: PipelineRunStatus; blocked: PipelineBlock[] } | null;
  };
  function harness(rows: Record<string, Row> = {}) {
    const posted: Array<{ title: string; body: string; taskId: string; kind?: string }> = [];
    const handle = createHeadlessNotificationHandler({
      lookup,
      readTask: (id) => (rows[id] ?? null) as ReturnType<Parameters<typeof createHeadlessNotificationHandler>[0]["readTask"]>,
      post: (n) => { posted.push(n as (typeof posted)[number]); },
    });
    return { posted, handle, rows };
  }
  const blockedCol = (taskId = "p1"): GlobalEvent =>
    ({ kind: "column", taskId, runId: null, column: "blocked", prev: "running", ts: 1, reason: "pipeline" }) as GlobalEvent;
  const ask = (state: "pending" | "resolved", id: string, step = "s1"): GlobalEvent =>
    ({ kind: "interaction", taskId: step, runId: "r", state, interactionId: id, ts: 1, pipelineParentId: "p1" }) as GlobalEvent;

  test("a pipeline-reason block with nothing pending posts once; the pipeline event that follows does not re-post", () => {
    const { posted, handle } = harness({ p1: { column: "blocked", pipelineRun: { status: "blocked", blocked: [{ taskId: "s1", stepId: "a", kind: "step-failed", message: "x" }] } } });
    handle(blockedCol());
    handle({ kind: "pipeline", taskId: "p1", status: "blocked", activeStepIds: [], stepCount: 1, ts: 2 } as GlobalEvent);
    expect(posted).toEqual([
      { title: "Waiting on you", body: "Ship it · Pipeline needs you", taskId: "p1", kind: "blocked" },
    ]);
  });

  test("a block raised while a step's question is pending is owed: silent now, raised once the question is answered and the run is still blocked", () => {
    const { posted, handle, rows } = harness({ p1: { column: "blocked", pipelineRun: { status: "blocked", blocked: [{ taskId: null, stepId: "a", kind: "step-cap", message: "cap" }] } } });
    handle(ask("pending", "i1"));
    expect(posted.map((p) => p.body)).toEqual(["Ship it · Review"]); // the retargeted question
    handle(blockedCol());
    expect(posted).toHaveLength(1); // silent: the question holds the slot
    handle(ask("resolved", "i1"));
    expect(posted.map((p) => p.body)).toEqual(["Ship it · Review", "Ship it · Pipeline needs you"]);
    // not raised twice
    handle({ kind: "pipeline", taskId: "p1", status: "blocked", activeStepIds: [], stepCount: 1, ts: 3 } as GlobalEvent);
    expect(posted).toHaveLength(2);
    expect(rows.p1).toBeDefined();
  });

  test("the owed alert is dropped when the run left blocked by the time the question is answered", () => {
    const { posted, handle, rows } = harness({ p1: { column: "blocked", pipelineRun: { status: "blocked", blocked: [{ taskId: "s1", stepId: "a", kind: "step-blocked", message: "waiting" }] } } });
    handle(ask("pending", "i1"));
    handle(blockedCol());
    rows.p1 = { column: "running", pipelineRun: { status: "running", blocked: [] } };
    handle(ask("resolved", "i1"));
    expect(posted).toHaveLength(1);
  });

  test("an answered question's own step-blocked block does not trigger the alert (it lasts until the step runs again)", () => {
    const { posted, handle } = harness({ p1: { column: "blocked", pipelineRun: { status: "blocked", blocked: [{ taskId: "s1", stepId: "a", kind: "step-blocked", message: "waiting" }] } } });
    handle(ask("pending", "i1"));
    handle(blockedCol());
    handle(ask("resolved", "i1"));
    expect(posted).toHaveLength(1);
  });

  test("a step question arriving on an already-blocked run owes the alert it displaces", () => {
    const { posted, handle } = harness({ p1: { column: "blocked", pipelineRun: { status: "blocked", blocked: [{ taskId: null, stepId: "a", kind: "join-incomplete", message: "j" }] } } });
    handle(ask("pending", "i1"));
    handle(ask("resolved", "i1"));
    expect(posted.map((p) => p.body)).toEqual(["Ship it · Review", "Ship it · Pipeline needs you"]);
  });

  test("a step running again ends the answered-question exemption for its block", () => {
    const { posted, handle } = harness({ p1: { column: "blocked", pipelineRun: { status: "blocked", blocked: [{ taskId: "s1", stepId: "a", kind: "step-blocked", message: "waiting" }] } } });
    handle(ask("pending", "i1"));
    handle(blockedCol());
    handle(ask("resolved", "i1"));
    expect(posted).toHaveLength(1);
    handle({ kind: "column", taskId: "s1", runId: null, column: "running", prev: "blocked", ts: 4, pipelineParentId: "p1" } as GlobalEvent);
    handle({ kind: "pipeline", taskId: "p1", status: "blocked", activeStepIds: [], stepCount: 1, ts: 5 } as GlobalEvent);
    // The exemption ended, and s1's row is not running: its (still recorded) block now counts.
    expect(posted.map((p) => p.body)).toEqual(["Ship it · Review", "Ship it · Pipeline needs you"]);
  });
});

describe("decideOwedPipelineAlert", () => {
  const blocked = (b: Array<{ taskId: string | null; kind: PipelineBlockKind }>) => ({
    pipelineRun: { status: "blocked" as PipelineRunStatus, blocked: b.map((x) => ({ ...x, stepId: null, message: "" })) },
  });
  const never = () => false;

  test("drop for a missing, archived or no-longer-blocked parent", () => {
    expect(decideOwedPipelineAlert(new Set(), null, never)).toBe("drop");
    expect(decideOwedPipelineAlert(new Set(), { archivedAt: 1, ...blocked([{ taskId: null, kind: "step-cap" }]) }, never)).toBe("drop");
    expect(decideOwedPipelineAlert(new Set(), { pipelineRun: { status: "running", blocked: [] } }, never)).toBe("drop");
  });

  test("raise for a run-level block or an unanswered task block; wait when only answered/running steps block", () => {
    expect(decideOwedPipelineAlert(new Set(), blocked([{ taskId: null, kind: "step-cap" }]), never)).toBe("raise");
    expect(decideOwedPipelineAlert(new Set(), blocked([{ taskId: "s1", kind: "handoff-missing" }]), never)).toBe("raise");
    expect(decideOwedPipelineAlert(new Set(["s1"]), blocked([{ taskId: "s1", kind: "step-blocked" }]), never)).toBe("wait");
    expect(decideOwedPipelineAlert(new Set(), blocked([{ taskId: "s1", kind: "step-failed" }]), (id) => id === "s1")).toBe("wait");
    // an answered question only exempts a step-blocked block, not a real failure
    expect(decideOwedPipelineAlert(new Set(["s1"]), blocked([{ taskId: "s1", kind: "step-failed" }]), never)).toBe("raise");
  });
});
