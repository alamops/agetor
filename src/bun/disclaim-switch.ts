// Launch-time decision for the disclaim switch (docs/plans/master-token-agent-read.md
// P4/P5, grill D4-D7). `disclaim.ts` holds the switch in memory (default ON, no
// db.ts import); this module is the only place that reads the stored preference
// and turns it into that in-memory value, so `core-spawn.ts` stays importable
// without opening the database.
//
// Why the stored value can't be trusted: the SQLite file is writable by any
// process running as the same user, an agent included. An agent that writes
// `disclaimSpawnedAgents = "false"` would otherwise make the next launch run
// every agent and every core spawn with Agetor's own macOS permissions (grill
// G3/G5). So the stored value is only ever a *request* to turn it off:
//   - app: the switch stays ON while the user is asked (native message box,
//     which an agent can't click without the Accessibility permission that
//     disclaimed agents don't inherit). Only an explicit "Keep it off" turns it
//     off; the default and cancel button turn it back on.
//   - headless: there's no dialog, so a stored "off" is ignored (D6).
//
// The confirm must resolve BEFORE any agent host starts (`ensureDisclaimedServer()`
// in index.ts, P5): the switch is ON the whole time, so a tmux server started
// during the wait would be disclaimed anyway, and the answer only affects spawns
// made after it. Nothing here restarts a live tmux server; turning the switch
// off affects future spawns only.

import {
  DISCLAIM_PREF_KEY,
  isDisclaimOffValue,
  setDisclaimSwitch,
} from "./disclaim.ts";

export interface DisclaimSwitchDeps {
  /** Raw stored `disclaimSpawnedAgents` value, or null when never set. */
  readPref(): string | null;
  writePref(v: string): void;
  /** App only: ask the user whether to keep isolation off. `true` = "Keep it
   *  off"; `false` = "Turn it back on" (also the default / cancel result). */
  confirmKeepOff?: () => boolean | Promise<boolean>;
  log(msg: string): void;
}

/**
 * Decide the switch at launch.
 *
 * Reading of the plan's "stored `"false"` → keep on, ask; keep off → off;
 * otherwise write `"true"`": the "otherwise" is the dialog's other answer, so
 * `"true"` is written only in the off → turn-it-back-on branch. A missing or
 * non-"false" stored value just leaves the switch on and is NOT rewritten
 * (nothing to repair, and a launch shouldn't write a preference needlessly).
 */
export async function initDisclaimSwitch(
  mode: "app" | "headless",
  deps: DisclaimSwitchDeps,
): Promise<void> {
  // Always start from ON: the in-memory default is already on, but a prior
  // call in the same process (tests, a re-init) may have left it off.
  setDisclaimSwitch(true);

  let stored: string | null;
  try {
    stored = deps.readPref();
  } catch (err) {
    // An unreadable preference can't request "off"; stay on.
    deps.log(
      `[agetor] couldn't read ${DISCLAIM_PREF_KEY} (${errMessage(err)}) — permission isolation stays on`,
    );
    return;
  }
  if (!isDisclaimOffValue(stored)) return;

  if (mode === "headless") {
    deps.log(
      `[agetor] ${DISCLAIM_PREF_KEY} is stored as "off"; ignored on headless — permission isolation stays on`,
    );
    return;
  }

  // App: the switch is ON until the user answers.
  let keepOff = false;
  if (!deps.confirmKeepOff) {
    deps.log(
      `[agetor] ${DISCLAIM_PREF_KEY} is stored as "off" but no confirmation is available — permission isolation stays on`,
    );
    return;
  }
  try {
    keepOff = (await deps.confirmKeepOff()) === true;
  } catch (err) {
    // Fail closed: a dialog that can't be shown or answered never turns
    // isolation off.
    deps.log(
      `[agetor] couldn't ask about turning permission isolation off (${errMessage(err)}) — it stays on`,
    );
    return;
  }

  if (keepOff) {
    setDisclaimSwitch(false);
    deps.log("[agetor] permission isolation kept off at the user's request");
    return;
  }
  // "Turn it back on": persist it so the next launch doesn't ask again.
  try {
    deps.writePref("true");
  } catch (err) {
    deps.log(
      `[agetor] couldn't store ${DISCLAIM_PREF_KEY}=true (${errMessage(err)}) — isolation is on for this launch`,
    );
  }
}

/**
 * Apply a `PUT /preferences/disclaimSpawnedAgents` after the route stored the
 * value. The route itself already refused a CLI-token caller asking for "off"
 * (D4), so a value reaching here came from the app (or is an "on" value).
 *   - app: applies immediately (D5) — affects future spawns only.
 *   - headless: stays on whatever was stored (D6); logs when the value is off.
 */
export function applyDisclaimPreferenceWrite(
  mode: "app" | "headless",
  value: string,
  log: (m: string) => void,
): void {
  const off = isDisclaimOffValue(value);
  if (mode === "headless") {
    setDisclaimSwitch(true);
    if (off) {
      log(
        `[agetor] ${DISCLAIM_PREF_KEY} stored as "off"; ignored on headless — permission isolation stays on`,
      );
    }
    return;
  }
  setDisclaimSwitch(!off);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
