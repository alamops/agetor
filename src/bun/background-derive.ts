// Pure derivation of the "Run Agetor in the background" state
// (docs/plans/always-on-host.md §3.4, steps 1-3).
//
// LEAF MODULE: imports shared types and the *types* of the helper client and
// the supervisor state file only — never `db.ts` — so the `agetor` CLI can
// derive the same status offline (no core running) from the installed app's
// helper plus `login-daemon.json`. The C3 reconcile (remote access can't stay
// on while the background host isn't running) is NOT here: it needs the
// preference store and lives in `background.ts`.
//
// macOS is the source of truth for registration. Nothing here (or anywhere in
// the background controller) caches `registration` in SQLite; it is read from
// the helper on every probe.

import path from "node:path";
import type {
  BackgroundRegistration,
  BackgroundStatus,
  BackgroundUnavailableReason,
} from "../shared/types.ts";
import type { HelperInfo } from "./login-item-helper.ts";
import type { LoginDaemonState } from "./login-daemon-state.ts";

export interface BackgroundDeriveInput {
  platform: NodeJS.Platform;
  /** null = no helper resolved */
  info: HelperInfo | null;
  /** set when info()/status() threw (→ unavailable "helper-failed") */
  helperError?: string;
  registration: BackgroundRegistration | null;
  /** `liveSupervisor()` result */
  supervisor: LoginDaemonState | null;
  /** this process is the login-item core */
  isLoginItemCore: boolean;
  /** this process's pid when `isLoginItemCore` */
  selfPid: number | null;
  /** this core's (or the CLI's) data dir */
  dataDir: string;
  home: string;
  remoteAccess: boolean;
}

/** The data dir the installed app of a channel uses: stable builds keep
 *  `~/.agetor`; canary and dev channels use `~/.agetor-dev` (channel-defaults). */
export function expectedDataDirForChannel(channel: string, home: string): string {
  return path.join(home, channel === "stable" ? ".agetor" : ".agetor-dev");
}

const HELPER_ERROR_DETAIL_CAP = 300;

const UNAVAILABLE_DETAIL: Record<Exclude<BackgroundUnavailableReason, "helper-failed">, string> = {
  "not-macos": "Running in the background is only available on macOS.",
  "helper-missing": "This install has no login-item helper.",
  "dev-build": "Development builds can't register a login item.",
  unsigned: "This build isn't signed with a developer certificate, so macOS won't allow a login item.",
  "not-in-applications": "Move Agetor to the Applications folder first.",
  "other-install": "This data folder belongs to a different Agetor install.",
};

function unavailable(
  reason: BackgroundUnavailableReason,
  detail: string,
  remoteAccess: boolean,
): BackgroundStatus {
  return {
    state: "unavailable",
    registration: null,
    unavailableReason: reason,
    detail,
    label: null,
    supervisorPid: null,
    corePid: null,
    remoteAccess,
  };
}

function capText(text: string): string {
  const t = text.trim();
  return t.length > HELPER_ERROR_DETAIL_CAP ? `${t.slice(0, HELPER_ERROR_DETAIL_CAP)}…` : t;
}

export function deriveBackgroundStatus(i: BackgroundDeriveInput): BackgroundStatus {
  const remote = i.remoteAccess;

  // Step 1 — can the switch be used on this install at all? Order matters: the
  // first failing check names the reason.
  if (i.platform !== "darwin") {
    return unavailable("not-macos", UNAVAILABLE_DETAIL["not-macos"], remote);
  }
  if (!i.info && !i.helperError) {
    return unavailable("helper-missing", UNAVAILABLE_DETAIL["helper-missing"], remote);
  }
  if (i.helperError) {
    return unavailable("helper-failed", `The login-item helper failed: ${capText(i.helperError)}`, remote);
  }
  const info = i.info as HelperInfo;
  if (info.channel !== "stable" && info.channel !== "canary") {
    return unavailable("dev-build", UNAVAILABLE_DETAIL["dev-build"], remote);
  }
  if (!info.signed) {
    return unavailable("unsigned", UNAVAILABLE_DETAIL.unsigned, remote);
  }
  if (info.location !== "applications" && info.location !== "user-applications") {
    return unavailable(
      "not-in-applications",
      info.location === "translocated"
        ? "Move Agetor to the Applications folder and reopen it."
        : UNAVAILABLE_DETAIL["not-in-applications"],
      remote,
    );
  }
  if (
    path.resolve(expectedDataDirForChannel(info.channel, i.home)) !== path.resolve(i.dataDir)
  ) {
    return unavailable("other-install", UNAVAILABLE_DETAIL["other-install"], remote);
  }
  if (i.registration === null) {
    // The helper answered `info` but no registration: treat it as broken
    // rather than guessing a state.
    return unavailable("helper-failed", "The login-item helper reported no registration status.", remote);
  }

  const label = info.label || i.supervisor?.label || null;
  const base = { registration: i.registration, label, remoteAccess: remote };

  // Step 2 — registration.
  if (i.registration === "notRegistered" || i.registration === "notFound") {
    return { ...base, state: "off", supervisorPid: null, corePid: null };
  }
  if (i.registration === "requiresApproval") {
    return {
      ...base,
      state: "needs-approval",
      detail: "Waiting for approval in System Settings › Login Items.",
      supervisorPid: null,
      corePid: null,
    };
  }

  // Step 3 — registration is enabled: what is the supervisor doing?
  const sup = i.supervisor;
  if (i.isLoginItemCore) {
    return {
      ...base,
      state: "running",
      supervisorPid: sup?.pid ?? null,
      corePid: i.selfPid ?? sup?.corePid ?? null,
    };
  }
  if (!sup || sup.state === "stopped") {
    return {
      ...base,
      state: "stopped",
      detail: "Stopped until the next login.",
      supervisorPid: null,
      corePid: null,
    };
  }
  switch (sup.state) {
    case "running":
      // A running supervisor with no core pid hasn't finished booting one.
      return sup.corePid
        ? { ...base, state: "running", supervisorPid: sup.pid, corePid: sup.corePid }
        : { ...base, state: "starting", supervisorPid: sup.pid, corePid: null };
    case "parked":
      return { ...base, state: "parked", supervisorPid: sup.pid, corePid: null };
    default: // "waiting"
      return { ...base, state: "starting", supervisorPid: sup.pid, corePid: null };
  }
}
