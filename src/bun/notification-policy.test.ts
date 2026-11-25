import { describe, expect, test } from "bun:test";
import type { GlobalEvent, Task } from "../shared/types.ts";
import { NOTIFICATION_KINDS, type NotificationKind } from "../shared/os-notification.ts";
import { FocusedForcedPosts } from "../shared/focused-forced-posts.ts";
import { decideOsAction, installNotificationPolicy, type NotificationDecision, type NotificationSink } from "./notification-policy.ts";
import type { NotificationMeta } from "./notification-events.ts";
import type { Presence } from "./presence.ts";

function fakePresence(initial: Partial<Presence> = {}) {
  let state: Presence = { focused: false, selectedTaskId: null, view: null, lastFocusedAt: null, appAttached: true, ...initial };
  const listeners = new Set<(p: Presence) => void>();
  return {
    api: {
      presence: () => state,
      onPresenceChange: (fn: (p: Presence) => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    },
    set(p: Partial<Presence>) {
      state = { ...state, ...p };
      for (const l of listeners) l(state);
    },
  };
}

function setup(initial: Partial<Presence> = {}) {
  const pres = fakePresence(initial);
  const rows = new Map<string, Task | null>([["t1", { id: "t1", title: "Fix the thing", agent: "claude-code" } as unknown as Task]]);
  let emit: (ev: GlobalEvent) => void = () => {};
  const policy = installNotificationPolicy({
    subscribe: (fn) => {
      emit = fn;
      return () => {};
    },
    loadRows: async () => rows,
    presence: pres.api,
  });
  const os: { posts: NotificationDecision[]; removes: string[] } = { posts: [], removes: [] };
  const phone: NotificationDecision[] = [];
  const osSink: NotificationSink = { id: "os", deliver: (d) => void os.posts.push(d), remove: (r) => void os.removes.push(r.taskId) };
  const phoneSink: NotificationSink = { id: "phone", deliver: (d) => void phone.push(d) };
  policy.registerSink(osSink);
  policy.registerSink(phoneSink);
  return { policy, pres, os, phone, emit: async (ev: GlobalEvent) => { emit(ev); await policy.handleEvent({ kind: "tasks-changed" } as unknown as GlobalEvent); } };
}

describe("decideOsAction", () => {
  const cases: Array<{ name: string; selected: boolean; focused: boolean; meta: NotificationMeta; want: string }> = [
    { name: "unfocused, not selected", selected: false, focused: false, meta: {}, want: "post" },
    { name: "focused, not selected", selected: false, focused: true, meta: {}, want: "clear" },
    { name: "unfocused, selected", selected: true, focused: false, meta: {}, want: "skip" },
    { name: "focused, selected", selected: true, focused: true, meta: {}, want: "skip" },
    { name: "unfocused, selected, exempt kind", selected: true, focused: false, meta: { whenSelected: true }, want: "post" },
    { name: "focused, selected, exempt kind", selected: true, focused: true, meta: { whenSelected: true }, want: "clear" },
    { name: "focused, forced", selected: false, focused: true, meta: { force: true }, want: "post" },
    { name: "focused, selected, forced and exempt", selected: true, focused: true, meta: { force: true, whenSelected: true }, want: "post" },
  ];
  for (const c of cases) {
    test(c.name, () => {
      const got = decideOsAction("t1", c.meta, { focused: c.focused, selectedTaskId: c.selected ? "t1" : "other" }, new FocusedForcedPosts());
      expect(got).toBe(c.want as never);
    });
  }
  test("a forced post made while focused is kept by the next focused event, until the task is opened", () => {
    const f = new FocusedForcedPosts();
    expect(decideOsAction("t1", { force: true }, { focused: true, selectedTaskId: null }, f)).toBe("post");
    expect(decideOsAction("t1", {}, { focused: true, selectedTaskId: null }, f)).toBe("keep");
  });
  test("a notification with no task always posts", () => {
    expect(decideOsAction(undefined, {}, { focused: true, selectedTaskId: "x" }, new FocusedForcedPosts())).toBe("post");
  });
});

describe("installNotificationPolicy: every kind x {focused, unfocused} x {selected, not}", () => {
  // The kinds each event shape produces; all of NOTIFICATION_KINDS are covered through `post` (the CLI path) below.
  for (const kind of NOTIFICATION_KINDS) {
    const exempt = kind === "waiting" || kind === "files-sent" || kind === "harness-swap";
    for (const focused of [false, true]) {
      for (const selected of [false, true]) {
        test(`${kind} focused=${focused} selected=${selected}`, async () => {
          const t = setup({ focused, selectedTaskId: selected ? "t1" : null });
          const meta: NotificationMeta = exempt ? { whenSelected: true } : {};
          t.policy.post({ title: "x", body: "y", taskId: "t1", kind: kind as NotificationKind }, meta);
          const posts = t.os.posts.length;
          const clears = t.os.removes.length;
          if (selected && !exempt) expect([posts, clears]).toEqual([0, 0]);
          else if (focused) expect([posts, clears]).toEqual([0, 1]);
          else expect([posts, clears]).toEqual([1, 0]);
          // The phone sink always hears it and decides for itself.
          expect(t.phone.length).toBe(1);
        });
      }
    }
  }
});

describe("installNotificationPolicy: events", () => {
  test("a succeeded run posts once when unfocused, and is silent when its task is open", async () => {
    const t = setup();
    await t.emit({ kind: "run-status", taskId: "t1", runId: "r", status: "succeeded" } as unknown as GlobalEvent);
    expect(t.os.posts.map((p) => p.notification.title)).toEqual(["Task succeeded"]);
    t.pres.set({ selectedTaskId: "t1" });
    await t.emit({ kind: "run-status", taskId: "t1", runId: "r2", status: "succeeded" } as unknown as GlobalEvent);
    expect(t.os.posts.length).toBe(1);
  });

  test("a pending question posts even when its task is open, and clears nothing", async () => {
    const t = setup({ selectedTaskId: "t1" });
    await t.emit({ kind: "interaction", taskId: "t1", interactionId: "i1", state: "pending" } as unknown as GlobalEvent);
    expect(t.os.posts.map((p) => p.notification.kind)).toEqual(["waiting"]);
  });

  test("a focused window clears the older entry instead of posting", async () => {
    const t = setup({ focused: true });
    await t.emit({ kind: "run-status", taskId: "t1", runId: "r", status: "failed" } as unknown as GlobalEvent);
    expect(t.os.posts).toEqual([]);
    expect(t.os.removes).toEqual(["t1"]);
  });

  test("a proactive files-sent posts while focused, and the next focused event keeps it until the task is opened", async () => {
    const t = setup({ focused: true });
    await t.emit({ kind: "files-sent", taskId: "t1", count: 2, caption: null, proactive: true } as unknown as GlobalEvent);
    expect(t.os.posts.map((p) => p.notification.kind)).toEqual(["files-sent"]);
    await t.emit({ kind: "run-status", taskId: "t1", runId: "r", status: "succeeded" } as unknown as GlobalEvent);
    expect(t.os.removes).toEqual([]);
    t.pres.set({ selectedTaskId: "t1" });
    t.pres.set({ selectedTaskId: null });
    await t.emit({ kind: "run-status", taskId: "t1", runId: "r2", status: "succeeded" } as unknown as GlobalEvent);
    expect(t.os.removes).toEqual(["t1"]);
  });

  test("a headless core (no window, nothing selected) posts every qualifying event", async () => {
    const t = setup({ focused: false, selectedTaskId: null, appAttached: false });
    await t.emit({ kind: "run-status", taskId: "t1", runId: "r", status: "failed" } as unknown as GlobalEvent);
    await t.emit({ kind: "column", taskId: "t1", column: "blocked", reason: "api-error" } as unknown as GlobalEvent);
    expect(t.os.posts.map((p) => p.notification.kind)).toEqual(["failed", "api-error"]);
  });

  test("remove fans out to every sink that has one and forgets forced protection", async () => {
    const t = setup({ focused: true });
    await t.emit({ kind: "files-sent", taskId: "t1", count: 1, caption: null, proactive: true } as unknown as GlobalEvent);
    t.policy.remove({ taskId: "t1" });
    expect(t.os.removes).toEqual(["t1"]);
    await t.emit({ kind: "run-status", taskId: "t1", runId: "r", status: "succeeded" } as unknown as GlobalEvent);
    expect(t.os.removes).toEqual(["t1", "t1"]);
  });

  test("a sink that throws does not stop the others, and disposed policies hear nothing", async () => {
    const t = setup();
    t.policy.registerSink({ id: "phone", deliver: () => { throw new Error("push down"); } });
    t.policy.post({ title: "x", taskId: "t1", kind: "failed" });
    expect(t.os.posts.length).toBe(1);
    t.policy.dispose();
    t.policy.post({ title: "x", taskId: "t1", kind: "failed" });
    expect(t.os.posts.length).toBe(1);
  });
});
