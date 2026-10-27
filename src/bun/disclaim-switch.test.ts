import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getDisclaimSwitch, setDisclaimSwitch } from "./disclaim.ts";
import {
  applyDisclaimPreferenceWrite,
  initDisclaimSwitch,
  type DisclaimSwitchDeps,
} from "./disclaim-switch.ts";

// bun runs every test file in one process, so save and restore the shared
// in-memory switch around each test.
let saved = true;
beforeEach(() => {
  saved = getDisclaimSwitch();
  setDisclaimSwitch(true);
});
afterEach(() => {
  setDisclaimSwitch(saved);
});

function makeDeps(
  stored: string | null,
  extra: Partial<DisclaimSwitchDeps> = {},
): DisclaimSwitchDeps & { writes: string[]; logs: string[] } {
  const writes: string[] = [];
  const logs: string[] = [];
  return {
    readPref: () => stored,
    writePref: (v) => void writes.push(v),
    log: (m) => void logs.push(m),
    ...extra,
    writes,
    logs,
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("initDisclaimSwitch (app)", () => {
  test("stored off: switch stays on until confirmKeepOff resolves, keep-off turns it off", async () => {
    const d = deferred<boolean>();
    const deps = makeDeps("false", { confirmKeepOff: () => d.promise });
    const run = initDisclaimSwitch("app", deps);
    await Promise.resolve();
    expect(getDisclaimSwitch()).toBe(true);
    d.resolve(true);
    await run;
    expect(getDisclaimSwitch()).toBe(false);
    expect(deps.writes).toEqual([]);
  });

  test("stored off: 'turn it back on' keeps it on and writes \"true\"", async () => {
    const deps = makeDeps("false", { confirmKeepOff: () => false });
    await initDisclaimSwitch("app", deps);
    expect(getDisclaimSwitch()).toBe(true);
    expect(deps.writes).toEqual(["true"]);
  });

  test("stored off: a throwing confirm fails closed and logs", async () => {
    const deps = makeDeps("false", {
      confirmKeepOff: () => {
        throw new Error("no window");
      },
    });
    await initDisclaimSwitch("app", deps);
    expect(getDisclaimSwitch()).toBe(true);
    expect(deps.writes).toEqual([]);
    expect(deps.logs.length).toBe(1);
    expect(deps.logs[0]).toContain("no window");
  });

  test("stored off: a rejecting confirm fails closed and logs", async () => {
    const deps = makeDeps("false", {
      confirmKeepOff: () => Promise.reject(new Error("boom")),
    });
    await initDisclaimSwitch("app", deps);
    expect(getDisclaimSwitch()).toBe(true);
    expect(deps.logs.length).toBe(1);
  });

  test("stored off with no confirmKeepOff stays on and logs", async () => {
    const deps = makeDeps("false");
    await initDisclaimSwitch("app", deps);
    expect(getDisclaimSwitch()).toBe(true);
    expect(deps.logs.length).toBe(1);
    expect(deps.writes).toEqual([]);
  });

  test("a failing writePref after 'turn it back on' is logged, switch stays on", async () => {
    const deps = makeDeps("false", {
      confirmKeepOff: () => false,
      writePref: () => {
        throw new Error("readonly db");
      },
    });
    await initDisclaimSwitch("app", deps);
    expect(getDisclaimSwitch()).toBe(true);
    expect(deps.logs.some((l) => l.includes("readonly db"))).toBe(true);
  });

  test.each([null, "true", "", "off", "FALSE"])(
    "stored %p: on, no dialog, no write",
    async (stored) => {
      let asked = false;
      const deps = makeDeps(stored, {
        confirmKeepOff: () => {
          asked = true;
          return true;
        },
      });
      await initDisclaimSwitch("app", deps);
      expect(getDisclaimSwitch()).toBe(true);
      expect(asked).toBe(false);
      expect(deps.writes).toEqual([]);
    },
  );

  test("re-init resets a previously-off switch to on before deciding", async () => {
    setDisclaimSwitch(false);
    await initDisclaimSwitch("app", makeDeps(null));
    expect(getDisclaimSwitch()).toBe(true);
  });

  test("an unreadable preference stays on and logs", async () => {
    const deps = makeDeps(null, {
      readPref: () => {
        throw new Error("db locked");
      },
    });
    await initDisclaimSwitch("app", deps);
    expect(getDisclaimSwitch()).toBe(true);
    expect(deps.logs.length).toBe(1);
  });
});

describe("initDisclaimSwitch (headless)", () => {
  test("stored off: stays on, logs exactly once, never asks", async () => {
    let asked = false;
    const deps = makeDeps("false", {
      confirmKeepOff: () => {
        asked = true;
        return true;
      },
    });
    await initDisclaimSwitch("headless", deps);
    expect(getDisclaimSwitch()).toBe(true);
    expect(asked).toBe(false);
    expect(deps.logs.length).toBe(1);
    expect(deps.logs[0]).toContain("headless");
    expect(deps.writes).toEqual([]);
  });

  test("stored on / missing: on, no log", async () => {
    for (const stored of [null, "true"]) {
      const deps = makeDeps(stored);
      await initDisclaimSwitch("headless", deps);
      expect(getDisclaimSwitch()).toBe(true);
      expect(deps.logs).toEqual([]);
    }
  });
});

describe("applyDisclaimPreferenceWrite", () => {
  test("app + off value turns the switch off immediately", () => {
    const logs: string[] = [];
    applyDisclaimPreferenceWrite("app", "false", (m) => logs.push(m));
    expect(getDisclaimSwitch()).toBe(false);
    expect(logs).toEqual([]);
  });

  test("app + on value turns the switch back on", () => {
    setDisclaimSwitch(false);
    applyDisclaimPreferenceWrite("app", "true", () => {});
    expect(getDisclaimSwitch()).toBe(true);
  });

  test("headless + off value stays on and logs", () => {
    const logs: string[] = [];
    applyDisclaimPreferenceWrite("headless", "false", (m) => logs.push(m));
    expect(getDisclaimSwitch()).toBe(true);
    expect(logs.length).toBe(1);
  });

  test("headless + on value stays on without logging", () => {
    const logs: string[] = [];
    applyDisclaimPreferenceWrite("headless", "true", (m) => logs.push(m));
    expect(getDisclaimSwitch()).toBe(true);
    expect(logs).toEqual([]);
  });
});
