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
import type { GlobalEvent, PipelineRunStatus } from "../shared/types.ts";
import { rmTestDataDir } from "./test-data-dir.ts";

let dataDir = "";
let prevDataDir: string | undefined;
let headlessNotificationFor: typeof import("./headless-notifications.ts").headlessNotificationFor;
let isHeadlessNotificationsEnabled: typeof import("./headless-notifications.ts").isHeadlessNotificationsEnabled;

beforeAll(async () => {
  prevDataDir = process.env.AGETOR_DATA_DIR;
  dataDir = mkdtempSync(path.join(tmpdir(), "agetor-headless-notif-"));
  process.env.AGETOR_DATA_DIR = dataDir;
  const mod = await import("./headless-notifications.ts");
  headlessNotificationFor = mod.headlessNotificationFor;
  isHeadlessNotificationsEnabled = mod.isHeadlessNotificationsEnabled;
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

  test("a pipeline parent's reason:\"pipeline\" block is silent (its step's question already notified)", () => {
    expect(col("pipeline")).toBeNull();
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
