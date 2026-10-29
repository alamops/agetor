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
}

export interface RemoteAccessBoxDeps {
  showMessageBox: ShowMessageBox;
  background: RemoteAccessBackground;
  openLoginItems: () => Promise<void>;
  log?: (msg: string) => void;
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
    // registration macOS reports as enabled turns remote on (C5): any failure
    // leaves remote access off.
    let result = status;
    if (status.registration !== "enabled") {
      result = await background.turnOnBackground();
    }
    if (result.registration === "enabled") {
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

    const reason =
      result.state === "unavailable"
        ? unavailableText(result)
        : (result.detail ?? "macOS did not enable the login item.");
    await showMessageBox({
      type: "error",
      title: TITLE_OFF,
      message: "Remote access stays off: Keep Agetor running in the background couldn't be turned on.",
      detail: reason,
      buttons: ["OK"],
      defaultId: 0,
      cancelId: 0,
    });
  } catch (err) {
    deps.log?.(`[agetor] remote access box failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
