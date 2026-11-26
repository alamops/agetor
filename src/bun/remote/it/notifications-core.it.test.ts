// TS3: the notification cutover in the core (grill D5, docs/architecture/notifications.md): ONE decision for the OS and the phone, from the same
// events and the window's presence. An app-mode core with a recording OS sink posts once per qualifying event; the webview's presence (the task
// open in the window, or a focused window) suppresses the OS post; the phone sink decides for itself.
import { afterEach, describe, expect, test } from "bun:test";
import type { GlobalEvent, Task } from "../../../shared/types.ts";
import { installNotificationPolicy, type NotificationDecision, type NotificationSink } from "../../notification-policy.ts";
import * as presence from "../../presence.ts";

afterEach(() => {
  presence.setNativeWindowFocus(false);
  presence.setWebviewPresence({ focused: false, selectedTaskId: null, view: null });
  presence.setAppAttached(true);
});

function rig() {
  const rows = new Map<string, Task | null>([["t1", { id: "t1", title: "Fix it", agent: "claude-code" } as unknown as Task]]);
  const policy = installNotificationPolicy({ subscribe: () => () => {}, loadRows: async () => rows });
  const os: NotificationDecision[] = [];
  const osRemoved: string[] = [];
  const phone: NotificationDecision[] = [];
  const osSink: NotificationSink = { id: "os", deliver: (d) => void os.push(d), remove: (r) => void osRemoved.push(r.taskId) };
  const phoneSink: NotificationSink = { id: "phone", deliver: (d) => void phone.push(d) };
  policy.registerSink(osSink);
  policy.registerSink(phoneSink);
  const waiting = (id: string): GlobalEvent => ({ kind: "interaction", taskId: "t1", runId: "r", state: "pending", interactionId: id, ts: Date.now() } as GlobalEvent);
  return { policy, os, osRemoved, phone, waiting };
}

describe("the core decides once", () => {
  test("an unfocused app with the task not open: the OS posts once and the phone is offered the same decision", async () => {
    const r = rig();
    await r.policy.handleEvent(r.waiting("i1"));
    expect(r.os).toHaveLength(1);
    expect(r.os[0]).toMatchObject({ kind: "waiting", urgency: "needs-you" });
    expect(r.phone).toHaveLength(1);
    expect(r.phone[0]!.notification.taskId).toBe("t1");
  });

  test("the webview's presence suppresses the OS post: the task is open in the window (the in-app toast covers it), and the phone still gets it", async () => {
    const r = rig();
    presence.setWebviewPresence({ focused: true, selectedTaskId: "t1", view: "run-panel" });
    presence.setNativeWindowFocus(true);
    await r.policy.handleEvent(r.waiting("i1"));
    expect(r.os).toHaveLength(0);
    expect(r.phone).toHaveLength(1);
  });

  test("a focused window with another task open clears the task's older OS entry instead of posting", async () => {
    const r = rig();
    presence.setNativeWindowFocus(true);
    presence.setWebviewPresence({ focused: true, selectedTaskId: "other", view: "run-panel" });
    await r.policy.handleEvent(r.waiting("i1"));
    expect(r.os).toHaveLength(0);
    expect(r.osRemoved).toContain("t1");
  });

  test("a sink that throws does not stop the other", async () => {
    const r = rig();
    r.policy.registerSink({ id: "phone", deliver: () => { throw new Error("push down"); } });
    await r.policy.handleEvent(r.waiting("i1"));
    expect(r.os).toHaveLength(1);
  });

  test("a headless core has no window: presence says away, so every qualifying event posts", async () => {
    presence.setAppAttached(false);
    const r = rig();
    await r.policy.handleEvent(r.waiting("i1"));
    expect(r.os).toHaveLength(1);
  });
});
