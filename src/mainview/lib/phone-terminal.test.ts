import { afterEach, describe, expect, test } from "bun:test";
import type { AppEvent } from "../../shared/types.ts";
import { remoteActionToast } from "./remote-access-store.ts";
import {
  applyPhoneTerminalEvent, getPhoneTerminal, reducePhoneTerminal, resetPhoneTerminalsForTests, seedPhoneTerminalState, seedPhoneTerminals, subscribePhoneTerminals,
  type PhoneTerminalState,
} from "./phone-terminal.ts";

type Ev = Extract<AppEvent, { type: "phone_terminal" }>;
const ev = (over: Partial<Ev> = {}): Ev => ({ type: "phone_terminal", taskId: "t1", deviceId: "d1", deviceName: "Ana's iPhone", attached: true, since: 100, ts: 100, ...over });
const empty: PhoneTerminalState = new Map();
afterEach(() => resetPhoneTerminalsForTests());

describe("the reducer", () => {
  test("an attach sets the entry; a detach by the same phone clears it", () => {
    const a = reducePhoneTerminal(empty, ev());
    expect(a.get("t1")).toEqual({ taskId: "t1", deviceId: "d1", deviceName: "Ana's iPhone", since: 100 });
    expect(reducePhoneTerminal(a, ev({ attached: false })).has("t1")).toBe(false);
  });
  test("another phone replacing the first: the first one's late detach does not clear the second", () => {
    const first = reducePhoneTerminal(empty, ev());
    const second = reducePhoneTerminal(first, ev({ deviceId: "d2", deviceName: "Ben's Pixel", since: 200 }));
    expect(second.get("t1")?.deviceName).toBe("Ben's Pixel");
    expect(reducePhoneTerminal(second, ev({ attached: false })).get("t1")?.deviceId).toBe("d2");
  });
  test("a repeat of the same attach, and a detach with nothing attached, change nothing (same object, so no re-render)", () => {
    const a = reducePhoneTerminal(empty, ev());
    expect(reducePhoneTerminal(a, ev())).toBe(a);
    expect(reducePhoneTerminal(empty, ev({ attached: false }))).toBe(empty);
  });
  test("each task is independent", () => {
    const s = reducePhoneTerminal(reducePhoneTerminal(empty, ev()), ev({ taskId: "t2", deviceId: "d9" }));
    expect([...s.keys()].sort()).toEqual(["t1", "t2"]);
    expect(reducePhoneTerminal(s, ev({ attached: false })).has("t2")).toBe(true);
  });
});

describe("the store", () => {
  test("a banner only for the task that has a phone: switching tasks shows the other task's own state", () => {
    applyPhoneTerminalEvent(ev());
    expect(getPhoneTerminal("t1")?.deviceName).toBe("Ana's iPhone");
    expect(getPhoneTerminal("t2")).toBeNull();
  });
  test("subscribers hear a change, and not a no-op", () => {
    let n = 0;
    const off = subscribePhoneTerminals(() => void n++);
    applyPhoneTerminalEvent(ev());
    applyPhoneTerminalEvent(ev());
    applyPhoneTerminalEvent(ev({ attached: false }));
    off();
    applyPhoneTerminalEvent(ev());
    expect(n).toBe(2);
  });
  test("the startup snapshot fills what no live event has spoken about, and never overrides one that has", () => {
    applyPhoneTerminalEvent(ev({ taskId: "t1", attached: false })); // an event: t1 detached
    seedPhoneTerminals([
      { taskId: "t1", deviceId: "d1", deviceName: "stale", since: 1 },
      { taskId: "t2", deviceId: "d2", deviceName: "Ben's Pixel", since: 2 },
    ]);
    expect(getPhoneTerminal("t1")).toBeNull();
    expect(getPhoneTerminal("t2")?.deviceName).toBe("Ben's Pixel");
  });
  test("seedPhoneTerminalState is pure", () => {
    const s = seedPhoneTerminalState([{ taskId: "t1", deviceId: "d1", deviceName: "A", since: 1 }]);
    expect(s.get("t1")?.deviceName).toBe("A");
  });
});

describe("the toasts for remote actions", () => {
  const act = (action: Extract<AppEvent, { type: "remote_action" }>["action"]) =>
    remoteActionToast({ type: "remote_action", taskId: "t1", deviceName: "Ana's iPhone", action, ts: 1 });
  test("each action reads as a sentence naming the phone", () => {
    expect(act("plan-approved")).toBe("Plan approved from Ana's iPhone");
    expect(act("card-allowed")).toBe("Allowed from Ana's iPhone");
    expect(act("gate-decided")).toBe("Review decided from Ana's iPhone");
    expect(act("auto-mode-approved")).toBe("Auto mode approved from Ana's iPhone");
    expect(act("terminal-attached")).toBe("Ana's iPhone attached to a terminal");
    expect(act("device-paired")).toBe("Ana's iPhone was paired");
    expect(act("device-revoked")).toBe("Ana's iPhone was revoked");
  });
});
