import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { __testing, atTheMac, clearWebviewPresence, onPresenceChange, presence, setAppAttached, setNativeWindowFocus, setWebviewPresence } from "./presence.ts";

let now = 1_000_000;
beforeEach(() => {
  now = 1_000_000;
  __testing.reset(() => now);
});
afterEach(() => __testing.reset());

describe("presence", () => {
  test("S8: a closed window no longer selects a task, so its notifications are not skipped", () => {
    setAppAttached(true);
    setWebviewPresence({ focused: true, selectedTaskId: "t1", view: "run-panel" });
    setNativeWindowFocus(false);
    clearWebviewPresence();
    expect(presence()).toMatchObject({ selectedTaskId: null, view: null, focused: false });
  });

  test("a core with no window says: not focused, nothing selected, no app", () => {
    expect(presence()).toEqual({ focused: false, selectedTaskId: null, view: null, lastFocusedAt: null, appAttached: false });
    expect(atTheMac()).toBe(false);
  });

  test("the webview report sets focus, the selected task and the view", () => {
    setAppAttached(true);
    setWebviewPresence({ focused: true, selectedTaskId: "t1", view: "run-panel" });
    expect(presence()).toMatchObject({ focused: true, selectedTaskId: "t1", view: "run-panel", appAttached: true });
  });

  test("native focus overrides the webview once a native event has been seen", () => {
    setAppAttached(true);
    setWebviewPresence({ focused: true, selectedTaskId: null, view: null });
    setNativeWindowFocus(false);
    expect(presence().focused).toBe(false);
    // a later webview 'focused' report no longer wins
    setWebviewPresence({ focused: true, selectedTaskId: null, view: null });
    expect(presence().focused).toBe(false);
    setNativeWindowFocus(true);
    expect(presence().focused).toBe(true);
  });

  test("lastFocusedAt follows focus and keeps ticking while focused", () => {
    setAppAttached(true);
    setNativeWindowFocus(true);
    now += 5000;
    expect(presence().lastFocusedAt).toBe(now);
    setNativeWindowFocus(false);
    const left = now;
    now += 60_000;
    expect(presence().lastFocusedAt).toBe(left);
  });

  test("atTheMac: focused, or focused within two minutes; a core with no app is always away", () => {
    setNativeWindowFocus(true);
    expect(atTheMac()).toBe(false); // no app attached
    setAppAttached(true);
    expect(atTheMac()).toBe(true);
    setNativeWindowFocus(false);
    now += 119_000;
    expect(atTheMac()).toBe(true);
    now += 2000;
    expect(atTheMac()).toBe(false);
  });

  test("detaching the app clears focus and selection", () => {
    setAppAttached(true);
    setNativeWindowFocus(true);
    setWebviewPresence({ focused: true, selectedTaskId: "t", view: "pipeline" });
    setAppAttached(false);
    expect(presence()).toMatchObject({ focused: false, selectedTaskId: null, view: null, appAttached: false });
  });

  test("listeners hear changes and one throwing does not stop the rest", () => {
    const seen: string[] = [];
    onPresenceChange(() => {
      throw new Error("boom");
    });
    const off = onPresenceChange((p) => seen.push(String(p.selectedTaskId)));
    setWebviewPresence({ focused: false, selectedTaskId: "a", view: "run-panel" });
    off();
    setWebviewPresence({ focused: false, selectedTaskId: "b", view: "run-panel" });
    expect(seen).toEqual(["a"]);
  });

  test("the view is dropped when nothing is selected", () => {
    setWebviewPresence({ focused: true, selectedTaskId: null, view: "pipeline" });
    expect(presence().view).toBeNull();
  });
});
