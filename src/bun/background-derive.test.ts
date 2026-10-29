import { describe, expect, test } from "bun:test";
import {
  deriveBackgroundStatus,
  expectedDataDirForChannel,
  type BackgroundDeriveInput,
} from "./background-derive.ts";
import type { HelperInfo } from "./login-item-helper.ts";
import type { LoginDaemonState } from "./login-daemon-state.ts";

// The pure half of the "Run Agetor in the background" state machine
// (docs/plans/always-on-host.md §3.4 steps 1-3). The C3 reconcile lives in
// background.ts and is covered by background.test.ts.

const HOME = "/Users/tester";
const DATA_DIR = `${HOME}/.agetor`;

const INFO: HelperInfo = {
  bundlePath: "/Applications/Agetor.app",
  bundleId: "sh.example.agetor",
  channel: "stable",
  label: "sh.example.agetor.daemon",
  plist: "sh.example.agetor.daemon.plist",
  signed: true,
  teamId: "TEAMID0000",
  location: "applications",
};

function sup(over: Partial<LoginDaemonState> = {}): LoginDaemonState {
  return {
    pid: 4242,
    state: "running",
    corePid: 4343,
    bundlePath: "/Applications/Agetor.app",
    version: "1.0.0",
    label: "sh.example.agetor.daemon",
    startedAt: 1,
    updatedAt: 2,
    ...over,
  };
}

function input(over: Partial<BackgroundDeriveInput> = {}): BackgroundDeriveInput {
  return {
    platform: "darwin",
    info: INFO,
    registration: "enabled",
    supervisor: null,
    isLoginItemCore: false,
    selfPid: null,
    dataDir: DATA_DIR,
    home: HOME,
    remoteAccess: false,
    ...over,
  };
}

describe("expectedDataDirForChannel", () => {
  test("stable keeps ~/.agetor; canary and dev use ~/.agetor-dev", () => {
    expect(expectedDataDirForChannel("stable", HOME)).toBe(`${HOME}/.agetor`);
    expect(expectedDataDirForChannel("canary", HOME)).toBe(`${HOME}/.agetor-dev`);
    expect(expectedDataDirForChannel("dev", HOME)).toBe(`${HOME}/.agetor-dev`);
    expect(expectedDataDirForChannel("anything-else", HOME)).toBe(`${HOME}/.agetor-dev`);
  });
});

describe("deriveBackgroundStatus — unavailable reasons (step 1)", () => {
  const reason = (over: Partial<BackgroundDeriveInput>) => {
    const s = deriveBackgroundStatus(input(over));
    expect(s.state).toBe("unavailable");
    expect(s.registration).toBeNull();
    expect(s.label).toBeNull();
    expect(s.supervisorPid).toBeNull();
    expect(s.corePid).toBeNull();
    return s;
  };

  test("not-macos", () => {
    expect(reason({ platform: "linux" }).unavailableReason).toBe("not-macos");
    expect(reason({ platform: "win32" }).unavailableReason).toBe("not-macos");
  });

  test("helper-missing: no info and no error", () => {
    expect(reason({ info: null, registration: null }).unavailableReason).toBe("helper-missing");
  });

  test("helper-failed: error text is carried and capped", () => {
    const s = reason({ info: null, registration: null, helperError: "boom" });
    expect(s.unavailableReason).toBe("helper-failed");
    expect(s.detail).toContain("boom");
    const long = reason({ info: null, registration: null, helperError: "x".repeat(1000) });
    expect(long.detail!.length).toBeLessThan(400);
    expect(long.detail!.endsWith("…")).toBe(true);
  });

  test("helper-failed also wins when info arrived but status threw", () => {
    expect(reason({ registration: null, helperError: "status exploded" }).unavailableReason).toBe(
      "helper-failed",
    );
  });

  test("dev-build: any channel but stable/canary", () => {
    expect(reason({ info: { ...INFO, channel: "dev" } }).unavailableReason).toBe("dev-build");
    expect(reason({ info: { ...INFO, channel: "" } }).unavailableReason).toBe("dev-build");
  });

  test("unsigned", () => {
    expect(reason({ info: { ...INFO, signed: false } }).unavailableReason).toBe("unsigned");
  });

  test("not-in-applications: volume / other, and a translocated copy gets its own advice", () => {
    expect(reason({ info: { ...INFO, location: "volume" } }).unavailableReason).toBe(
      "not-in-applications",
    );
    expect(reason({ info: { ...INFO, location: "other" } }).unavailableReason).toBe(
      "not-in-applications",
    );
    const translocated = reason({ info: { ...INFO, location: "translocated" } });
    expect(translocated.unavailableReason).toBe("not-in-applications");
    expect(translocated.detail).toContain("reopen");
    // ~/Applications is a supported place.
    expect(
      deriveBackgroundStatus(input({ info: { ...INFO, location: "user-applications" } })).state,
    ).not.toBe("unavailable");
  });

  test("other-install: the data dir isn't this channel's", () => {
    expect(reason({ dataDir: "/somewhere/else" }).unavailableReason).toBe("other-install");
    // A canary app expects ~/.agetor-dev, so ~/.agetor is the wrong install.
    expect(
      reason({ info: { ...INFO, channel: "canary" }, dataDir: DATA_DIR }).unavailableReason,
    ).toBe("other-install");
    // ...and a stable app doesn't own ~/.agetor-dev.
    expect(reason({ dataDir: `${HOME}/.agetor-dev` }).unavailableReason).toBe("other-install");
  });

  test("other-install compares resolved paths: trailing slashes and dot segments are the same dir", () => {
    expect(deriveBackgroundStatus(input({ dataDir: `${DATA_DIR}/` })).state).toBe("stopped");
    expect(deriveBackgroundStatus(input({ dataDir: `${HOME}/./.agetor` })).state).toBe("stopped");
    expect(deriveBackgroundStatus(input({ home: `${HOME}/` })).state).toBe("stopped");
    expect(
      deriveBackgroundStatus(input({ info: { ...INFO, channel: "canary" }, dataDir: `${HOME}/.agetor-dev/` }))
        .state,
    ).toBe("stopped");
  });

  test("registration null with a healthy info is helper-failed, not a guessed state", () => {
    const s = reason({ registration: null });
    expect(s.unavailableReason).toBe("helper-failed");
    expect(s.detail).toContain("no registration");
  });

  test("the remote-access flag survives into unavailable statuses", () => {
    expect(reason({ platform: "linux", remoteAccess: true }).remoteAccess).toBe(true);
    expect(reason({ platform: "linux", remoteAccess: false }).remoteAccess).toBe(false);
  });

  test("precedence: the first failing check names the reason", () => {
    // Everything wrong at once → not-macos.
    const everything = input({
      platform: "linux",
      info: { ...INFO, channel: "dev", signed: false, location: "volume" },
      dataDir: "/x",
      registration: null,
    });
    expect(deriveBackgroundStatus(everything).unavailableReason).toBe("not-macos");
    // helperError beats helper-missing (info is null in both).
    expect(
      deriveBackgroundStatus(input({ info: null, registration: null, helperError: "e" }))
        .unavailableReason,
    ).toBe("helper-failed");
    // dev-build beats unsigned beats not-in-applications beats other-install.
    const chain = { ...INFO, channel: "dev", signed: false, location: "volume" as const };
    expect(deriveBackgroundStatus(input({ info: chain, dataDir: "/x" })).unavailableReason).toBe(
      "dev-build",
    );
    expect(
      deriveBackgroundStatus(input({ info: { ...chain, channel: "stable" }, dataDir: "/x" }))
        .unavailableReason,
    ).toBe("unsigned");
    expect(
      deriveBackgroundStatus(input({ info: { ...chain, signed: true }, dataDir: "/x" }))
        .unavailableReason,
    ).toBe("dev-build");
    expect(
      deriveBackgroundStatus(
        input({ info: { ...chain, channel: "stable", signed: true }, dataDir: "/x" }),
      ).unavailableReason,
    ).toBe("not-in-applications");
    expect(
      deriveBackgroundStatus(input({ dataDir: "/x", registration: null })).unavailableReason,
    ).toBe("other-install");
  });
});

describe("deriveBackgroundStatus — registration (step 2)", () => {
  test("notRegistered and notFound are off", () => {
    for (const registration of ["notRegistered", "notFound"] as const) {
      const s = deriveBackgroundStatus(input({ registration, supervisor: sup() }));
      expect(s.state).toBe("off");
      expect(s.registration).toBe(registration);
      // A leftover supervisor doesn't make a de-registered item look alive.
      expect(s.supervisorPid).toBeNull();
      expect(s.corePid).toBeNull();
      expect(s.unavailableReason).toBeUndefined();
    }
  });

  test("requiresApproval is needs-approval with a pointer to System Settings", () => {
    const s = deriveBackgroundStatus(input({ registration: "requiresApproval" }));
    expect(s.state).toBe("needs-approval");
    expect(s.registration).toBe("requiresApproval");
    expect(s.detail).toContain("Login Items");
    expect(s.supervisorPid).toBeNull();
  });

  test("label prefers the helper's, then the supervisor's, then null", () => {
    expect(deriveBackgroundStatus(input({ registration: "notRegistered" })).label).toBe(INFO.label);
    expect(
      deriveBackgroundStatus(
        input({ info: { ...INFO, label: "" }, supervisor: sup({ label: "from.supervisor" }) }),
      ).label,
    ).toBe("from.supervisor");
    expect(deriveBackgroundStatus(input({ info: { ...INFO, label: "" } })).label).toBeNull();
  });

  test("remoteAccess is passed through", () => {
    expect(deriveBackgroundStatus(input({ remoteAccess: true })).remoteAccess).toBe(true);
    expect(deriveBackgroundStatus(input({ remoteAccess: false })).remoteAccess).toBe(false);
  });
});

describe("deriveBackgroundStatus — enabled × supervisor (step 3)", () => {
  test("this process is the login-item core → running with its own pid", () => {
    const s = deriveBackgroundStatus(
      input({ isLoginItemCore: true, selfPid: 999, supervisor: sup({ pid: 11, corePid: 22 }) }),
    );
    expect(s).toMatchObject({ state: "running", supervisorPid: 11, corePid: 999 });
  });

  test("login-item core with no supervisor file still reads running", () => {
    const s = deriveBackgroundStatus(input({ isLoginItemCore: true, selfPid: 999 }));
    expect(s).toMatchObject({ state: "running", supervisorPid: null, corePid: 999 });
  });

  test("login-item core falls back to the supervisor's corePid without a selfPid", () => {
    const s = deriveBackgroundStatus(
      input({ isLoginItemCore: true, selfPid: null, supervisor: sup({ corePid: 22 }) }),
    );
    expect(s.corePid).toBe(22);
  });

  test("supervisor running with a corePid → running", () => {
    const s = deriveBackgroundStatus(input({ supervisor: sup({ pid: 11, corePid: 22 }) }));
    expect(s).toMatchObject({ state: "running", supervisorPid: 11, corePid: 22 });
  });

  test("supervisor running without a corePid → starting (it hasn't booted a core yet)", () => {
    const s = deriveBackgroundStatus(input({ supervisor: sup({ pid: 11, corePid: null }) }));
    expect(s).toMatchObject({ state: "starting", supervisorPid: 11, corePid: null });
  });

  test("supervisor parked → parked", () => {
    const s = deriveBackgroundStatus(
      input({ supervisor: sup({ pid: 11, state: "parked", corePid: null }) }),
    );
    expect(s).toMatchObject({ state: "parked", supervisorPid: 11, corePid: null });
  });

  test("supervisor waiting → starting", () => {
    const s = deriveBackgroundStatus(
      input({ supervisor: sup({ pid: 11, state: "waiting", corePid: null }) }),
    );
    expect(s).toMatchObject({ state: "starting", supervisorPid: 11, corePid: null });
  });

  test("no supervisor, or one that recorded a clean stop → stopped", () => {
    for (const supervisor of [null, sup({ state: "stopped", corePid: null })]) {
      const s = deriveBackgroundStatus(input({ supervisor }));
      expect(s).toMatchObject({ state: "stopped", supervisorPid: null, corePid: null });
      expect(s.detail).toContain("next login");
      expect(s.registration).toBe("enabled");
    }
  });
});
