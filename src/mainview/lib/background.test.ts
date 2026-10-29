import { afterEach, describe, expect, test } from "bun:test";
import type { BackgroundState, BackgroundStatus, BackgroundUnavailableReason } from "../../shared/types.ts";
import {
  backgroundCopy,
  publishBackgroundStatus,
  subscribeBackgroundStatus,
  UNAVAILABLE_REASON_TEXT,
} from "./background.ts";

const status = (state: BackgroundState, extra: Partial<BackgroundStatus> = {}): BackgroundStatus => ({
  state,
  registration: state === "unavailable" ? null : "enabled",
  label: state === "unavailable" ? null : "com.example.agetor",
  supervisorPid: null,
  corePid: null,
  remoteAccess: false,
  ...extra,
});

describe("backgroundCopy — available states", () => {
  test("running", () => {
    expect(backgroundCopy(status("running"))).toEqual({
      label: "On — running in the background",
      detail: "Tasks keep running when you quit the app.",
      toggleEnabled: true,
      toggleChecked: true,
      actions: [],
    });
  });

  test("parked — the label is exactly the plan's wording", () => {
    const c = backgroundCopy(status("parked"));
    expect(c.label).toBe("On, parked while the app is open");
    expect(c.detail).toContain("takes over when you quit the app");
    expect(c).toMatchObject({ toggleEnabled: true, toggleChecked: true, actions: [] });
  });

  test("starting", () => {
    expect(backgroundCopy(status("starting"))).toMatchObject({
      label: "On — starting…",
      toggleEnabled: true,
      toggleChecked: true,
      actions: [],
    });
  });

  test("stopped offers Start now", () => {
    expect(backgroundCopy(status("stopped"))).toMatchObject({
      label: "On — stopped, starts again at next login",
      toggleEnabled: true,
      toggleChecked: true,
      actions: ["start-now"],
    });
  });

  test("needs-approval offers Login Items and the switch reads on (it is registered)", () => {
    expect(backgroundCopy(status("needs-approval"))).toMatchObject({
      label: "Needs approval in System Settings › Login Items",
      toggleEnabled: true,
      toggleChecked: true,
      actions: ["open-login-items"],
    });
  });

  test("off is the only available state whose switch reads off", () => {
    expect(backgroundCopy(status("off"))).toEqual({
      label: "Off",
      detail: null,
      toggleEnabled: true,
      toggleChecked: false,
      actions: [],
    });
    const others: BackgroundState[] = ["running", "parked", "starting", "stopped", "needs-approval"];
    for (const s of others) expect(backgroundCopy(status(s)).toggleChecked).toBe(true);
  });

  test("a status detail overrides the default explanation line", () => {
    expect(backgroundCopy(status("running", { detail: "Core pid 42" })).detail).toBe("Core pid 42");
  });
});

describe("backgroundCopy — unavailable", () => {
  const reasons: BackgroundUnavailableReason[] = [
    "not-macos", "dev-build", "unsigned", "not-in-applications", "helper-missing", "other-install", "helper-failed",
  ];
  const expected: Record<BackgroundUnavailableReason, string> = {
    "not-macos": "Only available on macOS",
    "dev-build": "Unavailable in development builds",
    unsigned: "Unavailable in unsigned builds",
    "not-in-applications": "Move Agetor to Applications first",
    "helper-missing": "This build has no login-item helper",
    "other-install": "Another Agetor install owns the background core",
    "helper-failed": "Couldn't read the login-item status",
  };

  test("every reason has its own label, a disabled off switch and no actions", () => {
    for (const reason of reasons) {
      expect(backgroundCopy(status("unavailable", { unavailableReason: reason }))).toEqual({
        label: expected[reason],
        detail: null,
        toggleEnabled: false,
        toggleChecked: false,
        actions: [],
      });
    }
    // The table covers exactly the reasons the type declares.
    expect(Object.keys(UNAVAILABLE_REASON_TEXT).sort()).toEqual([...reasons].sort());
  });

  test("the helper's own error text is shown as the detail", () => {
    const c = backgroundCopy(status("unavailable", { unavailableReason: "helper-failed", detail: "spawn EACCES" }));
    expect(c.label).toBe("Couldn't read the login-item status");
    expect(c.detail).toBe("spawn EACCES");
  });

  test("a detail equal to the label is not repeated", () => {
    const c = backgroundCopy(status("unavailable", { unavailableReason: "not-macos", detail: "Only available on macOS" }));
    expect(c.detail).toBeNull();
  });

  test("no reason falls back to a generic label", () => {
    expect(backgroundCopy(status("unavailable")).label).toBe("Unavailable on this install");
  });
});

describe("background status store", () => {
  const unsubs: Array<() => void> = [];
  afterEach(() => {
    while (unsubs.length) unsubs.pop()!();
  });

  test("publish reaches every subscriber with the status", () => {
    const a: BackgroundStatus[] = [];
    const b: BackgroundStatus[] = [];
    unsubs.push(subscribeBackgroundStatus((s) => a.push(s)), subscribeBackgroundStatus((s) => b.push(s)));
    const s = status("running");
    publishBackgroundStatus(s);
    expect(a).toEqual([s]);
    expect(b).toEqual([s]);
  });

  test("unsubscribe stops delivery to that listener only", () => {
    const a: string[] = [];
    const b: string[] = [];
    const offA = subscribeBackgroundStatus((s) => a.push(s.state));
    unsubs.push(subscribeBackgroundStatus((s) => b.push(s.state)));
    publishBackgroundStatus(status("running"));
    offA();
    publishBackgroundStatus(status("off"));
    expect(a).toEqual(["running"]);
    expect(b).toEqual(["running", "off"]);
  });

  test("a throwing listener neither stops the others nor the publisher", () => {
    const seen: string[] = [];
    const warn = console.warn;
    console.warn = () => {};
    try {
      unsubs.push(subscribeBackgroundStatus(() => { throw new Error("boom"); }));
      unsubs.push(subscribeBackgroundStatus((s) => seen.push(s.state)));
      expect(() => publishBackgroundStatus(status("parked"))).not.toThrow();
    } finally {
      console.warn = warn;
    }
    expect(seen).toEqual(["parked"]);
  });

  test("a listener may unsubscribe itself while a publish is in flight", () => {
    const seen: string[] = [];
    const off = subscribeBackgroundStatus(() => off());
    unsubs.push(subscribeBackgroundStatus((s) => seen.push(s.state)));
    publishBackgroundStatus(status("stopped"));
    publishBackgroundStatus(status("off"));
    expect(seen).toEqual(["stopped", "off"]);
  });

  test("publishing with no subscribers is a no-op", () => {
    expect(() => publishBackgroundStatus(status("off"))).not.toThrow();
  });
});
