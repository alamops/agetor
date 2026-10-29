import type {
  BackgroundStatus,
  BackgroundUnavailableReason,
  RemoteAccessStatus,
} from "../shared/types.ts";

/**
 * The native "Remote Access…" box (docs/plans/always-on-host.md §3.6, grill
 * D9/C5). Remote access is a preview and the ONLY way to turn it on: no HTTP
 * route, CLI command or preference write may do it, because an agent can reach
 * all of those. A native message box can't be answered by a program that lacks
 * the Accessibility permission, which every disclaimed agent does.
 *
 * It takes `showMessageBox` and `background` as dependencies so the branch table
 * runs under fakes. The caller (index.ts) wraps `showMessageBox` with the
 * event-loop lag label, because the call is a synchronous FFI call that blocks
 * the Bun thread until the user answers. Changes reach the webview through
 * background.ts's change subscription (server.ts broadcasts `background_changed`),
 * so nothing here broadcasts.
 */

export interface MessageBoxOptions {
  type?: "info" | "warning" | "error" | "question";
  title?: string;
  message?: string;
  detail?: string;
  buttons?: string[];
  defaultId?: number;
  cancelId?: number;
}

export type ShowMessageBox = (opts: MessageBoxOptions) => Promise<{ response: number }>;

export interface RemoteAccessBackground {
  getBackgroundStatus(opts?: { fresh?: boolean }): Promise<BackgroundStatus>;
  turnOnBackground(): Promise<BackgroundStatus>;
  getRemoteAccess(): RemoteAccessStatus;
  setRemoteAccessOff(): void;
  setRemoteAccessOnFromNativeBox(): void;
  /**
   * Boots the supervisor of an enabled-but-`stopped` item (background.ts's
   * `startBackgroundNow`). Optional: when the caller doesn't inject one, the
   * real controller is loaded on demand.
   */
  startBackgroundNow?(): Promise<BackgroundStatus>;
}

export interface RemoteAccessBoxDeps {
  showMessageBox: ShowMessageBox;
  background: RemoteAccessBackground;
  openLoginItems: () => Promise<void>;
  log?: (msg: string) => void;
  /** How long to wait for the supervisor after turning the host on (default 6 s). */
  hostWaitMs?: number;
  /** Poll interval of that wait (default 400 ms). */
  hostPollMs?: number;
  /** Test seam for the poll sleep. */
  sleep?: (ms: number) => Promise<void>;
}

const HOST_WAIT_MS = 6_000;
const HOST_POLL_MS = 400;

/** The host is up or coming up: the C3 reconcile (background.ts) keeps remote access on for these. */
function hostIsUp(s: BackgroundStatus): boolean {
  return s.state === "running" || s.state === "parked" || s.state === "starting";
}

const TITLE_OFF = "Remote access (preview)";
const TITLE_ON = "Remote access is on (preview)";

/** Plain wording for why the switch is unavailable; mirrors the Settings copy. */
const UNAVAILABLE_TEXT: Record<BackgroundUnavailableReason, string> = {
  "not-macos": "Only available on macOS.",
  "dev-build": "Unavailable in development builds.",
  unsigned: "Unavailable in unsigned builds.",
  "not-in-applications": "Move Agetor to Applications first.",
  "helper-missing": "This build has no login-item helper.",
  "other-install": "Another Agetor install owns the background core.",
  "helper-failed": "Couldn't read the login-item status.",
};

function unavailableText(status: BackgroundStatus): string {
  const reason = status.unavailableReason
    ? UNAVAILABLE_TEXT[status.unavailableReason]
    : "Background running isn't available on this install.";
  // helper-failed carries the helper's own error, which is the useful part.
  return status.detail && status.detail !== reason ? `${reason} ${status.detail}` : reason;
}

export async function runRemoteAccessBox(deps: RemoteAccessBoxDeps): Promise<void> {
  const { showMessageBox, background } = deps;
  try {
    const remote = background.getRemoteAccess();
    if (remote.enabled) {
      const { response } = await showMessageBox({
        type: "question",
        title: TITLE_ON,
        message: "This Mac is set up to stay reachable for the Agetor Companion app.",
        detail:
          "This is a preview: pairing arrives in a later version, so no device can connect yet. Turning it off leaves Keep Agetor running in the background as it is.",
        buttons: ["Turn Off", "Keep On"],
        defaultId: 1,
        cancelId: 1,
      });
      if (response === 0) background.setRemoteAccessOff();
      return;
    }

    const status = await background.getBackgroundStatus({ fresh: true });
    if (status.state === "unavailable") {
      await showMessageBox({
        type: "info",
        title: TITLE_OFF,
        message: "Remote access isn't available on this install.",
        detail: `It needs Keep Agetor running in the background, which can't be turned on here. ${unavailableText(status)}`,
        buttons: ["OK"],
        defaultId: 0,
        cancelId: 0,
      });
      return;
    }

    const { response } = await showMessageBox({
      type: "question",
      title: TITLE_OFF,
      message: "Keep this Mac reachable for the Agetor Companion app.",
      detail:
        "This is a preview: pairing arrives in a later version, so no device can connect yet. Turning it on also turns on Keep Agetor running in the background.",
      buttons: ["Turn On", "Cancel"],
      defaultId: 1,
      cancelId: 1,
    });
    if (response !== 0) return;

    // Remote access needs the background host, so it comes on first. Only a
    // registration macOS reports as enabled AND a host that is running, parked
    // or starting turns remote on (C5): any failure leaves remote access off.
    // The host check matters because background.ts's C3 reconcile turns remote
    // access straight back off whenever the host is `stopped`, which is what a
    // just-registered item reads like until its supervisor writes its first
    // state file (background.ts bridges that with a short `starting` grace),
    // and what an enabled item with no supervisor reads like for good.
    let result = status;
    if (status.registration !== "enabled") {
      result = await background.turnOnBackground();
    } else if (status.state === "stopped") {
      result = await startStoppedHost(deps, status);
    }
    if (result.registration === "enabled" && result.state === "stopped") {
      result = await waitForHost(deps, result);
    }
    if (result.registration === "enabled" && hostIsUp(result)) {
      background.setRemoteAccessOnFromNativeBox();
      return;
    }

    if (result.registration === "requiresApproval" || result.state === "needs-approval") {
      const second = await showMessageBox({
        type: "warning",
        title: TITLE_OFF,
        message: "Remote access stays off: macOS needs your approval first.",
        detail:
          "Allow Agetor in System Settings › General › Login Items, then turn remote access on again.",
        buttons: ["Open Login Items", "OK"],
        defaultId: 0,
        cancelId: 1,
      });
      if (second.response === 0) await deps.openLoginItems();
      return;
    }

    const enabledButNotRunning = result.registration === "enabled";
    const reason =
      result.state === "unavailable"
        ? unavailableText(result)
        : enabledButNotRunning
          ? (result.detail && result.detail !== "Stopped until the next login."
              ? result.detail
              : "The login item is on, but the background host did not start. Try again in a moment.")
          : (result.detail ?? "macOS did not enable the login item.");
    await showMessageBox({
      type: "error",
      title: TITLE_OFF,
      message: enabledButNotRunning
        ? "Remote access stays off: the background host didn't start."
        : "Remote access stays off: Keep Agetor running in the background couldn't be turned on.",
      detail: reason,
      buttons: ["OK"],
      defaultId: 0,
      cancelId: 0,
    });
  } catch (err) {
    deps.log?.(`[agetor] remote access box failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** An enabled item with no live supervisor: boot one rather than fail. */
async function startStoppedHost(deps: RemoteAccessBoxDeps, current: BackgroundStatus): Promise<BackgroundStatus> {
  try {
    const start =
      deps.background.startBackgroundNow ?? (await import("./background.ts")).startBackgroundNow;
    return await start();
  } catch (err) {
    deps.log?.(`[agetor] remote access: starting the background host failed: ${err instanceof Error ? err.message : String(err)}`);
    // Whatever it was (already running, raced), the fresh status below decides.
    return deps.background.getBackgroundStatus({ fresh: true }).catch(() => current);
  }
}

/** Bounded wait for a registered item's supervisor to come up; returns the last status seen. */
async function waitForHost(deps: RemoteAccessBoxDeps, first: BackgroundStatus): Promise<BackgroundStatus> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = deps.hostPollMs ?? HOST_POLL_MS;
  const deadline = (deps.hostWaitMs ?? HOST_WAIT_MS) / Math.max(1, pollMs);
  let last = first;
  for (let i = 0; i < deadline; i++) {
    await sleep(pollMs);
    last = await deps.background.getBackgroundStatus({ fresh: true });
    if (last.registration !== "enabled" || last.state !== "stopped") break;
  }
  return last;
}
