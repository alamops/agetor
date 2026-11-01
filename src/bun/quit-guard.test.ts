import { beforeEach, describe, expect, test } from "bun:test";
import type { AppEvent } from "../shared/types.ts";
import {
  armForceQuit,
  broadcastAppEvent,
  consumeForceQuit,
  consumeQuitCompletely,
  hasAppEventListeners,
  requestQuitCompletely,
  subscribeAppEvents,
} from "./quit-guard.ts";

// quit-guard.ts holds the one-shot flags `before-quit` reads (index.ts): the
// force-quit bypass the confirm dialog arms (`POST /app/force-quit`, plus the
// quit-launch gate's re-issue), and the "Quit Agetor Completely" menu flag.
// Module state is shared by every file in one `bun test` process, so each test
// starts by draining both flags.

beforeEach(() => {
  consumeForceQuit();
  consumeQuitCompletely();
});

describe("force-quit flag", () => {
  test("is unarmed by default", () => {
    expect(consumeForceQuit()).toBeNull();
  });

  test("armed plain, it allows exactly one quit and reports completely: false", () => {
    expect(armForceQuit()).toBe(true);
    expect(consumeForceQuit()).toEqual({ completely: false });
    expect(consumeForceQuit()).toBeNull();
  });

  test("armed completely, the one quit it allows carries completely: true", () => {
    expect(armForceQuit({ completely: true })).toBe(true);
    expect(consumeForceQuit()).toEqual({ completely: true });
    expect(consumeForceQuit()).toBeNull();
  });

  test("a second arm while armed is a no-op that neither upgrades nor downgrades the mode", () => {
    expect(armForceQuit({ completely: false })).toBe(true);
    expect(armForceQuit({ completely: true })).toBe(false);
    expect(consumeForceQuit()).toEqual({ completely: false });

    expect(armForceQuit({ completely: true })).toBe(true);
    expect(armForceQuit({ completely: false })).toBe(false);
    expect(armForceQuit()).toBe(false);
    expect(consumeForceQuit()).toEqual({ completely: true });
  });

  test("consuming resets the mode: a later plain arm is not a complete quit", () => {
    armForceQuit({ completely: true });
    consumeForceQuit();
    expect(armForceQuit()).toBe(true);
    expect(consumeForceQuit()).toEqual({ completely: false });
  });

  test("only `completely === true` counts — a truthy non-boolean does not", () => {
    armForceQuit({ completely: 1 as unknown as boolean });
    expect(consumeForceQuit()).toEqual({ completely: false });
  });
});

describe("quit-completely menu flag", () => {
  test("is a one-shot, independent of the force-quit bypass", () => {
    expect(consumeQuitCompletely()).toBe(false);
    requestQuitCompletely();
    // It does not let a quit through on its own: the confirm still applies.
    expect(consumeForceQuit()).toBeNull();
    expect(consumeQuitCompletely()).toBe(true);
    // A cancelled quit must not turn the next plain Cmd+Q into a complete one.
    expect(consumeQuitCompletely()).toBe(false);
  });

  test("repeated requests still yield one complete quit", () => {
    requestQuitCompletely();
    requestQuitCompletely();
    expect(consumeQuitCompletely()).toBe(true);
    expect(consumeQuitCompletely()).toBe(false);
  });
});

describe("app events", () => {
  test("subscribers get every broadcast until they unsubscribe; hasAppEventListeners follows them", () => {
    const before = hasAppEventListeners();
    const seen: AppEvent[] = [];
    const off = subscribeAppEvents((e) => seen.push(e));
    expect(hasAppEventListeners()).toBe(true);
    const ev = {
      type: "quit_request",
      runningRunCount: 1,
      runningTaskTitles: ["t"],
      backgroundArmed: true,
      completely: false,
      ts: 1,
    } as AppEvent;
    broadcastAppEvent(ev);
    expect(seen).toEqual([ev]);
    off();
    broadcastAppEvent(ev);
    expect(seen).toHaveLength(1);
    expect(hasAppEventListeners()).toBe(before);
  });
});
