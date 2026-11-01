import { describe, expect, test } from "bun:test";
import {
  runRemoteAccessBox,
  type MessageBoxOptions,
  type RemoteAccessBackground,
} from "./remote-access-box.ts";
import type { BackgroundStatus } from "../shared/types.ts";

// The box is the only way to turn remote access on, so these tests pin both
// what each branch writes and the exact native-box shape the user answers.

function status(over: Partial<BackgroundStatus> = {}): BackgroundStatus {
  return {
    state: "off",
    registration: "notRegistered",
    label: "com.example.agetor.test",
    supervisorPid: null,
    corePid: null,
    remoteAccess: false,
    ...over,
  };
}

interface Fixture {
  run: () => Promise<void>;
  boxes: MessageBoxOptions[];
  calls: string[];
  logs: string[];
}

function fixture(opts: {
  remoteEnabled: boolean;
  /** Status `getBackgroundStatus({fresh:true})` reports. */
  current?: BackgroundStatus;
  /** What `turnOnBackground()` returns (or throws when given an Error). */
  turnOn?: BackgroundStatus | Error;
  /** Queued button answers for successive boxes. */
  answers?: number[];
  showThrows?: boolean;
  /** What `startBackgroundNow()` returns (or throws when given an Error). Absent = not injected. */
  startNow?: BackgroundStatus | Error;
  /** Statuses for the 2nd, 3rd… `getBackgroundStatus` call (the last one repeats). */
  later?: BackgroundStatus[];
}): Fixture {
  const boxes: MessageBoxOptions[] = [];
  const calls: string[] = [];
  const logs: string[] = [];
  const answers = [...(opts.answers ?? [])];
  let statusReads = 0;
  const background: RemoteAccessBackground = {
    getBackgroundStatus: async (o) => {
      calls.push(`getBackgroundStatus:${o?.fresh ? "fresh" : "cached"}`);
      const n = statusReads++;
      if (n > 0 && opts.later && opts.later.length > 0) {
        return opts.later[Math.min(n - 1, opts.later.length - 1)]!;
      }
      return opts.current ?? status();
    },
    turnOnBackground: async () => {
      calls.push("turnOnBackground");
      if (opts.turnOn instanceof Error) throw opts.turnOn;
      return opts.turnOn ?? status({ state: "running", registration: "enabled" });
    },
    getRemoteAccess: () => ({ enabled: opts.remoteEnabled, preview: true }),
    setRemoteAccessOff: () => {
      calls.push("setRemoteAccessOff");
    },
    setRemoteAccessOnFromNativeBox: () => {
      calls.push("setRemoteAccessOnFromNativeBox");
    },
  };
  if (opts.startNow !== undefined) {
    background.startBackgroundNow = async () => {
      calls.push("startBackgroundNow");
      if (opts.startNow instanceof Error) throw opts.startNow;
      return opts.startNow as BackgroundStatus;
    };
  }
  return {
    boxes,
    calls,
    logs,
    run: () =>
      runRemoteAccessBox({
        background,
        showMessageBox: async (o) => {
          boxes.push(o);
          if (opts.showThrows) throw new Error("native panel failed");
          return { response: answers.shift() ?? 1 };
        },
        openLoginItems: async () => {
          calls.push("openLoginItems");
        },
        log: (m) => logs.push(m),
        hostWaitMs: 1_000,
        hostPollMs: 100,
        sleep: async () => {
          calls.push("sleep");
        },
      }),
  };
}

describe("runRemoteAccessBox: off", () => {
  test("Turn On with background off: registers the background host, then turns remote on", async () => {
    const f = fixture({ remoteEnabled: false, answers: [0] });
    await f.run();

    expect(f.boxes).toHaveLength(1);
    const box = f.boxes[0]!;
    expect(box.title).toBe("Remote access (preview)");
    expect(box.type).toBe("question");
    expect(box.buttons).toEqual(["Turn On", "Cancel"]);
    expect(box.defaultId).toBe(1);
    expect(box.cancelId).toBe(1);
    expect(box.detail).toContain("preview");

    expect(f.calls).toEqual([
      "getBackgroundStatus:fresh",
      "turnOnBackground",
      "setRemoteAccessOnFromNativeBox",
    ]);
  });

  test("background already enabled: no turnOn call, remote turns on", async () => {
    const f = fixture({
      remoteEnabled: false,
      current: status({ state: "running", registration: "enabled" }),
      answers: [0],
    });
    await f.run();
    expect(f.calls).toEqual(["getBackgroundStatus:fresh", "setRemoteAccessOnFromNativeBox"]);
    expect(f.boxes).toHaveLength(1);
  });

  test("Cancel changes nothing", async () => {
    const f = fixture({ remoteEnabled: false, answers: [1] });
    await f.run();
    expect(f.boxes).toHaveLength(1);
    expect(f.calls).toEqual(["getBackgroundStatus:fresh"]);
  });

  test("registration fails: remote stays off and an error box shows the reason", async () => {
    const f = fixture({
      remoteEnabled: false,
      answers: [0],
      turnOn: status({
        state: "off",
        registration: "notRegistered",
        detail: "the helper said no",
      }),
    });
    await f.run();

    expect(f.calls).not.toContain("setRemoteAccessOnFromNativeBox");
    expect(f.boxes).toHaveLength(2);
    const err = f.boxes[1]!;
    expect(err.type).toBe("error");
    expect(err.title).toBe("Remote access (preview)");
    expect(err.message).toContain("Remote access stays off");
    expect(err.detail).toBe("the helper said no");
    expect(err.buttons).toEqual(["OK"]);
    expect(err.defaultId).toBe(0);
    expect(err.cancelId).toBe(0);
  });

  test("registration fails without a detail: falls back to a generic reason", async () => {
    const f = fixture({
      remoteEnabled: false,
      answers: [0],
      turnOn: status({ state: "off", registration: "notFound" }),
    });
    await f.run();
    expect(f.calls).not.toContain("setRemoteAccessOnFromNativeBox");
    expect(f.boxes[1]!.detail).toBe("macOS did not enable the login item.");
  });

  test("registration turning unavailable during turn-on reports the unavailable reason", async () => {
    const f = fixture({
      remoteEnabled: false,
      answers: [0],
      turnOn: status({ state: "unavailable", registration: null, unavailableReason: "unsigned" }),
    });
    await f.run();
    expect(f.calls).not.toContain("setRemoteAccessOnFromNativeBox");
    expect(f.boxes[1]!.type).toBe("error");
    expect(f.boxes[1]!.detail).toBe("Unavailable in unsigned builds.");
  });

  test("requiresApproval: a second box offers Open Login Items; choosing it opens them, remote stays off", async () => {
    const f = fixture({
      remoteEnabled: false,
      answers: [0, 0],
      turnOn: status({ state: "needs-approval", registration: "requiresApproval" }),
    });
    await f.run();

    expect(f.boxes).toHaveLength(2);
    const second = f.boxes[1]!;
    expect(second.type).toBe("warning");
    expect(second.title).toBe("Remote access (preview)");
    expect(second.buttons).toEqual(["Open Login Items", "OK"]);
    expect(second.defaultId).toBe(0);
    expect(second.cancelId).toBe(1);
    expect(second.detail).toContain("Login Items");

    expect(f.calls).toContain("openLoginItems");
    expect(f.calls).not.toContain("setRemoteAccessOnFromNativeBox");
  });

  test("needs-approval state alone (registration not requiresApproval) also takes the approval box; OK does not open settings", async () => {
    const f = fixture({
      remoteEnabled: false,
      answers: [0, 1],
      turnOn: status({ state: "needs-approval", registration: "notRegistered" }),
    });
    await f.run();
    expect(f.boxes).toHaveLength(2);
    expect(f.boxes[1]!.buttons).toEqual(["Open Login Items", "OK"]);
    expect(f.calls).not.toContain("openLoginItems");
    expect(f.calls).not.toContain("setRemoteAccessOnFromNativeBox");
  });

  test("background already awaiting approval: the second box shows without a turnOn call", async () => {
    // Registration is not "enabled", so turnOn is attempted by the box; the
    // approval state it returns drives the second box.
    const f = fixture({
      remoteEnabled: false,
      current: status({ state: "needs-approval", registration: "requiresApproval" }),
      answers: [0, 1],
      turnOn: status({ state: "needs-approval", registration: "requiresApproval" }),
    });
    await f.run();
    expect(f.boxes[1]!.buttons).toEqual(["Open Login Items", "OK"]);
  });

  test("unavailable: one explanation box with only OK, and nothing else is called", async () => {
    const f = fixture({
      remoteEnabled: false,
      current: status({ state: "unavailable", registration: null, unavailableReason: "dev-build" }),
    });
    await f.run();

    expect(f.boxes).toHaveLength(1);
    const box = f.boxes[0]!;
    expect(box.type).toBe("info");
    expect(box.title).toBe("Remote access (preview)");
    expect(box.buttons).toEqual(["OK"]);
    expect(box.defaultId).toBe(0);
    expect(box.cancelId).toBe(0);
    expect(box.detail).toContain("Unavailable in development builds.");
    expect(f.calls).toEqual(["getBackgroundStatus:fresh"]);
  });

  test("unavailable with a helper error appends the helper's own detail", async () => {
    const f = fixture({
      remoteEnabled: false,
      current: status({
        state: "unavailable",
        registration: null,
        unavailableReason: "helper-failed",
        detail: "exit 3",
      }),
    });
    await f.run();
    expect(f.boxes[0]!.detail).toContain("Couldn't read the login-item status. exit 3");
  });
});

describe("runRemoteAccessBox: the host must actually be coming up", () => {
  const stopped = status({ state: "stopped", registration: "enabled", detail: "Stopped until the next login." });
  const starting = status({ state: "starting", registration: "enabled" });
  const running = status({ state: "running", registration: "enabled" });

  test("regression: a freshly registered item whose supervisor hasn't reported yet is waited for, not abandoned", async () => {
    // turnOnBackground answers `stopped` (supervisor state file not written yet);
    // the supervisor shows up on the second poll.
    const f = fixture({ remoteEnabled: false, answers: [0], turnOn: stopped, later: [stopped, starting] });
    await f.run();
    expect(f.calls).toEqual([
      "getBackgroundStatus:fresh",
      "turnOnBackground",
      "sleep",
      "getBackgroundStatus:fresh",
      "sleep",
      "getBackgroundStatus:fresh",
      "setRemoteAccessOnFromNativeBox",
    ]);
    expect(f.boxes).toHaveLength(1);
  });

  test("a host that is already starting after turn-on needs no wait", async () => {
    const f = fixture({ remoteEnabled: false, answers: [0], turnOn: starting });
    await f.run();
    expect(f.calls).toEqual(["getBackgroundStatus:fresh", "turnOnBackground", "setRemoteAccessOnFromNativeBox"]);
  });

  test("enabled but stopped: the host is started instead of failing, then remote turns on", async () => {
    const f = fixture({ remoteEnabled: false, answers: [0], current: stopped, startNow: starting });
    await f.run();
    expect(f.calls).toEqual(["getBackgroundStatus:fresh", "startBackgroundNow", "setRemoteAccessOnFromNativeBox"]);
    expect(f.calls).not.toContain("turnOnBackground");
  });

  test("enabled but stopped and the host never comes up: remote stays off with an explaining error box", async () => {
    const f = fixture({ remoteEnabled: false, answers: [0], current: stopped, startNow: stopped });
    await f.run();
    expect(f.calls).not.toContain("setRemoteAccessOnFromNativeBox");
    expect(f.calls.filter((c) => c === "sleep").length).toBeGreaterThan(0);
    expect(f.boxes).toHaveLength(2);
    const err = f.boxes[1]!;
    expect(err.type).toBe("error");
    expect(err.message).toContain("background host didn't start");
    expect(err.detail).toContain("did not start");
  });

  test("startBackgroundNow throwing (raced, already running) falls back to the fresh status", async () => {
    const f = fixture({
      remoteEnabled: false,
      answers: [0],
      current: stopped,
      startNow: new Error("already running"),
      later: [running],
    });
    await f.run();
    expect(f.calls).toContain("setRemoteAccessOnFromNativeBox");
    expect(f.logs[0]).toContain("already running");
  });

  test("a host that is running or parked turns remote on without starting anything", async () => {
    for (const state of ["running", "parked"] as const) {
      const f = fixture({ remoteEnabled: false, answers: [0], current: status({ state, registration: "enabled" }), startNow: starting });
      await f.run();
      expect(f.calls).toEqual(["getBackgroundStatus:fresh", "setRemoteAccessOnFromNativeBox"]);
    }
  });
});

describe("runRemoteAccessBox: on", () => {
  test("Turn Off switches remote access off and nothing else", async () => {
    const f = fixture({ remoteEnabled: true, answers: [0] });
    await f.run();

    expect(f.boxes).toHaveLength(1);
    const box = f.boxes[0]!;
    expect(box.title).toBe("Remote access is on (preview)");
    expect(box.type).toBe("question");
    expect(box.buttons).toEqual(["Turn Off", "Keep On"]);
    expect(box.defaultId).toBe(1);
    expect(box.cancelId).toBe(1);
    expect(f.calls).toEqual(["setRemoteAccessOff"]);
  });

  test("Keep On changes nothing", async () => {
    const f = fixture({ remoteEnabled: true, answers: [1] });
    await f.run();
    expect(f.calls).toEqual([]);
  });
});

describe("runRemoteAccessBox: failures", () => {
  test("a throwing native box is logged, never thrown, and never turns remote on", async () => {
    const f = fixture({ remoteEnabled: false, showThrows: true });
    await f.run();
    expect(f.calls).not.toContain("setRemoteAccessOnFromNativeBox");
    expect(f.logs).toHaveLength(1);
    expect(f.logs[0]).toContain("native panel failed");
  });

  test("turnOnBackground throwing leaves remote off", async () => {
    const f = fixture({ remoteEnabled: false, answers: [0], turnOn: new Error("register exploded") });
    await f.run();
    expect(f.calls).not.toContain("setRemoteAccessOnFromNativeBox");
    expect(f.logs[0]).toContain("register exploded");
  });
});
