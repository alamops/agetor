// Core-side controller for "Run Agetor in the background" and the remote-access
// preview switch (docs/plans/always-on-host.md §3.3-§3.5; grill C3-C5, C9-C11,
// C17).
//
// macOS is the source of truth for whether the login item is registered:
// nothing about the registration is cached in SQLite. Every status is derived
// from the bundled Swift helper (`login-item-helper.ts`) plus the supervisor's
// own state file (`login-daemon.json`), through the pure `deriveBackgroundStatus`
// in `background-derive.ts`. The only thing stored in the database is the
// remote-access preference (`REMOTE_ACCESS_PREF_KEY`).
//
// Remote access can only be turned ON from the native Remote Access… box in the
// desktop app (`setRemoteAccessOnFromNativeBox`). Every HTTP surface — the
// webview, the CLI, and any agent that can read a token — can only turn it off.
// A switch an agent could flip would let it open the machine to the network;
// the native box needs a human click that an agent without Accessibility
// permission cannot make (plan D10/D11, grill C6).

import { homedir } from "node:os";
import {
  REMOTE_ACCESS_PREF_KEY,
  type BackgroundStatus,
  type RemoteAccessStatus,
} from "../shared/types.ts";
import { dataDir, preferences } from "./db.ts";
import { launchedBy } from "./daemon-mode.ts";
import { liveSupervisor } from "./login-daemon-state.ts";
import { loginItemHelper, type HelperInfo, type LoginItemHelper } from "./login-item-helper.ts";
import { deriveBackgroundStatus, expectedDataDirForChannel } from "./background-derive.ts";
import type { BackgroundRegistration } from "../shared/types.ts";

const STATUS_CACHE_MS = 2000;

/**
 * After a successful register / reregister, launchd needs a moment to start the
 * supervisor and the supervisor to write `login-daemon.json`. For this long an
 * enabled item with no live supervisor reads `starting` rather than `stopped`,
 * so the remote-access reconcile (C3) doesn't undo "Turn On" in the window
 * before the first state file lands. If no supervisor shows up in time it
 * reads `stopped` again (and remote access is turned off, as before).
 */
const DEFAULT_START_GRACE_MS = 15_000;
let startGraceUntil = 0;

function startGraceMs(): number {
  const raw = Number(process.env.AGETOR_BACKGROUND_START_GRACE_MS);
  return Number.isFinite(raw) && raw >= 0 && process.env.AGETOR_BACKGROUND_START_GRACE_MS ? raw : DEFAULT_START_GRACE_MS;
}

function armStartGrace(): void {
  startGraceUntil = Date.now() + startGraceMs();
}

/** Thrown by `startBackgroundNow` when its precondition fails; the route maps
 *  it to 409 `{ error, code }`. */
export class BackgroundStartError extends Error {
  readonly code: "not-enabled" | "already-running" | "unavailable";
  constructor(code: "not-enabled" | "already-running" | "unavailable", message: string) {
    super(message);
    this.name = "BackgroundStartError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Remote access preference

/** AGETOR_FAKE_REMOTE_ACCESS=on (honored only together with
 *  AGETOR_FAKE_LOGIN_ITEM=1) seeds the preference "on" at the first read in
 *  the process, so an e2e can start with remote access already enabled
 *  without driving the native box. */
let fakeRemoteSeeded = false;

function remoteIsOn(): boolean {
  if (
    !fakeRemoteSeeded &&
    process.env.AGETOR_FAKE_LOGIN_ITEM === "1" &&
    process.env.AGETOR_FAKE_REMOTE_ACCESS === "on"
  ) {
    fakeRemoteSeeded = true;
    preferences.set(REMOTE_ACCESS_PREF_KEY, "on");
  }
  return preferences.get(REMOTE_ACCESS_PREF_KEY) === "on";
}

export function getRemoteAccess(): RemoteAccessStatus {
  return { enabled: remoteIsOn(), preview: true };
}

/** Writes "off" when the switch is currently on. Returns whether it changed. */
function writeRemoteOff(): boolean {
  if (!remoteIsOn()) return false;
  preferences.set(REMOTE_ACCESS_PREF_KEY, "off");
  return true;
}

/** Turn remote access off (no-op when it already is) and tell listeners. */
export function setRemoteAccessOff(): void {
  if (writeRemoteOff()) void notifyChanged();
}

/**
 * Turn remote access ON. ONLY `remote-access-box.ts` (the native message box)
 * may call this, and only after the background host is `enabled` (C5). No
 * route may ever reach it — see the module comment.
 */
export function setRemoteAccessOnFromNativeBox(): void {
  remoteIsOn(); // let the one-time fake seed run before this explicit write
  preferences.set(REMOTE_ACCESS_PREF_KEY, "on");
  void notifyChanged();
}

// ---------------------------------------------------------------------------
// Change notification

const listeners = new Set<(s: BackgroundStatus) => void>();

/** Listeners get a fresh status after every state change (including remote
 *  access on/off). Returns an unsubscribe function. */
export function subscribeBackgroundChanges(fn: (s: BackgroundStatus) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function emit(status: BackgroundStatus): void {
  for (const fn of [...listeners]) {
    try {
      fn(status);
    } catch (e) {
      console.warn("[agetor] background change listener threw:", e);
    }
  }
}

async function notifyChanged(): Promise<void> {
  invalidate();
  if (listeners.size === 0) return;
  emit(await getBackgroundStatus({ fresh: true }));
}

// ---------------------------------------------------------------------------
// Status

let cache: { at: number; status: BackgroundStatus } | null = null;
let inflight: Promise<BackgroundStatus> | null = null;
/** The last failure from a user-triggered helper action (register/unregister/
 *  reregister), shown as the `detail` of an `off` / `needs-approval` state until
 *  the next successful action. In memory only. */
let lastActionDetail: string | null = null;

function invalidate(): void {
  cache = null;
  inflight = null;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function probe(): Promise<BackgroundStatus> {
  const fake = process.env.AGETOR_FAKE_LOGIN_ITEM === "1";
  const home = homedir();
  const helper = loginItemHelper(dataDir);

  let info: HelperInfo | null = null;
  let registration: BackgroundRegistration | null = null;
  let helperError: string | undefined;
  if (helper) {
    try {
      info = await helper.info();
      registration = await helper.status();
    } catch (e) {
      helperError = errorText(e);
      registration = null;
    }
  }

  const isLoginItemCore = launchedBy() === "login-item";
  const remoteAccess = remoteIsOn();
  const supervisor = liveSupervisor(dataDir);
  // A supervisor that has reported ends the grace; one that never does lets it lapse.
  if (supervisor) startGraceUntil = 0;
  let status = deriveBackgroundStatus({
    // The fake seam stands in for the macOS helper, so it also stands in for
    // the platform; and it can't know the real data dir of a stable install
    // (tests use a temp dir), so it sidesteps the other-install comparison.
    platform: fake ? "darwin" : process.platform,
    info,
    helperError,
    registration,
    supervisor,
    expectSupervisor: Date.now() < startGraceUntil,
    isLoginItemCore,
    selfPid: isLoginItemCore ? process.pid : null,
    dataDir: fake && info ? expectedDataDirForChannel(info.channel, home) : dataDir,
    home,
    remoteAccess,
  });

  if (
    lastActionDetail &&
    !status.detail &&
    (status.state === "off" || status.state === "needs-approval")
  ) {
    status = { ...status, detail: lastActionDetail };
  }

  // C3: remote access can't stay on while the host isn't running, parked or
  // starting (e.g. the user removed the login item in System Settings).
  if (
    status.remoteAccess &&
    status.state !== "running" &&
    status.state !== "parked" &&
    status.state !== "starting"
  ) {
    writeRemoteOff();
    console.warn(
      `[agetor] remote access turned off: background host is ${status.state}`,
    );
    status = { ...status, remoteAccess: false };
    // The change reaches listeners from the next tick (not from inside this
    // probe, which they may be awaiting).
    setTimeout(() => {
      void notifyChanged();
    }, 0);
  }
  return status;
}

export function getBackgroundStatus(opts: { fresh?: boolean } = {}): Promise<BackgroundStatus> {
  if (!opts.fresh && cache && Date.now() - cache.at < STATUS_CACHE_MS) {
    return Promise.resolve(cache.status);
  }
  if (inflight) return inflight; // concurrent callers share one helper probe
  const p: Promise<BackgroundStatus> = probe()
    .then((status) => {
      if (inflight === p) {
        cache = { at: Date.now(), status };
        inflight = null;
      }
      return status;
    })
    .catch((e) => {
      if (inflight === p) inflight = null;
      throw e;
    });
  inflight = p;
  return p;
}

// ---------------------------------------------------------------------------
// Actions

/** Turn the login item on. Callers (the route) enforce app-only. When the
 *  switch is unavailable, or macOS leaves the item unregistered / needing
 *  approval, the returned status says so (state + `detail`). */
export async function turnOnBackground(): Promise<BackgroundStatus> {
  const before = await getBackgroundStatus({ fresh: true });
  if (before.state === "unavailable") return before;
  const helper = loginItemHelper(dataDir);
  if (!helper) return before;
  let registeredNow = false;
  if (before.registration !== "enabled") {
    lastActionDetail = null;
    registeredNow = true;
    try {
      const res = await helper.register();
      if (!res.ok || res.registration !== "enabled") {
        lastActionDetail =
          res.error?.message ??
          (res.registration === "requiresApproval"
            ? null
            : "macOS did not enable the login item.");
      }
    } catch (e) {
      lastActionDetail = errorText(e);
    }
  }
  invalidate();
  let status = await getBackgroundStatus({ fresh: true });
  if (registeredNow && status.registration === "enabled") {
    // The supervisor hasn't had time to write its state file: don't read that
    // as "stopped" (see DEFAULT_START_GRACE_MS).
    armStartGrace();
    invalidate();
    status = await getBackgroundStatus({ fresh: true });
  }
  emit(status);
  return status;
}

/**
 * Turn the login item off. Remote access goes off FIRST (C3), so it is never
 * left on over a host that is about to disappear. When this process IS the
 * background core, unregistering makes launchd kill it, so the answer is the
 * predicted `off` status and the (setsid'd) helper unregister runs on the next
 * tick, after the caller has its reply.
 */
export async function turnOffBackground(): Promise<BackgroundStatus> {
  writeRemoteOff();
  startGraceUntil = 0;
  const before = await getBackgroundStatus({ fresh: true });
  if (before.state === "unavailable") {
    emit(before);
    return before;
  }
  const helper = loginItemHelper(dataDir);
  if (!helper) return before;
  lastActionDetail = null;

  if (launchedBy() === "login-item") {
    const predicted: BackgroundStatus = {
      ...before,
      state: "off",
      registration: "notRegistered",
      detail: undefined,
      supervisorPid: null,
      corePid: null,
      remoteAccess: false,
    };
    invalidate();
    cache = { at: Date.now(), status: predicted };
    emit(predicted);
    setTimeout(() => {
      void unregisterQuietly(helper);
    }, 0);
    return predicted;
  }

  await unregisterQuietly(helper);
  invalidate();
  const status = await getBackgroundStatus({ fresh: true });
  emit(status);
  return status;
}

async function unregisterQuietly(helper: LoginItemHelper): Promise<void> {
  try {
    const res = await helper.unregister();
    if (!res.ok) lastActionDetail = res.error?.message ?? "macOS did not remove the login item.";
  } catch (e) {
    lastActionDetail = errorText(e);
  }
  if (lastActionDetail) {
    console.warn(`[agetor] background unregister: ${lastActionDetail}`);
    // The predicted `off` was wrong; tell listeners the truth.
    void notifyChanged();
  }
}

/** Boot a supervisor now when the item is enabled but nothing is running (C17):
 *  `reregister` (the helper waits out the 500 ms launchd needs). */
export async function startBackgroundNow(): Promise<BackgroundStatus> {
  const before = await getBackgroundStatus({ fresh: true });
  if (before.state === "unavailable") {
    throw new BackgroundStartError(
      "unavailable",
      before.detail ?? "Running in the background isn't available on this install.",
    );
  }
  if (before.registration !== "enabled") {
    throw new BackgroundStartError(
      "not-enabled",
      "Turn on Run Agetor in the background first.",
    );
  }
  if (before.state !== "stopped") {
    throw new BackgroundStartError("already-running", "The background host is already running.");
  }
  const helper = loginItemHelper(dataDir);
  if (!helper) {
    throw new BackgroundStartError("unavailable", "This install has no login-item helper.");
  }
  lastActionDetail = null;
  let failure: string | null = null;
  try {
    const res = await helper.reregister();
    if (!res.ok) failure = res.error?.message ?? "macOS did not restart the login item.";
  } catch (e) {
    failure = errorText(e);
  }
  if (!failure) armStartGrace(); // launchd is starting the supervisor (DEFAULT_START_GRACE_MS)
  invalidate();
  let status = await getBackgroundStatus({ fresh: true });
  if (failure) status = { ...status, detail: failure };
  emit(status);
  return status;
}

/** Open System Settings › Login Items. */
export async function openLoginItems(): Promise<void> {
  const helper = loginItemHelper(dataDir);
  if (!helper) throw new Error("The login-item helper isn't available on this install.");
  await helper.openSettings();
}

/** Test hooks; not for production callers. */
export const __testing = {
  /** Forget the post-register grace window (and any cached status). */
  resetStartGrace(): void {
    startGraceUntil = 0;
    invalidate();
  },
};
