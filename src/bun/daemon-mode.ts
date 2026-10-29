/**
 * How the headless core was launched, when it should shut itself down for lack
 * of clients, and the exit codes / launchd labels the login-item supervisor and
 * its core child agree on.
 *
 * LEAF MODULE: imports nothing (no `node:*`, no repo module), so it can never reach `db.ts`, or
 * anything that reaches it. The login-item supervisor (docs/plans/always-on-host.md
 * §3) runs with no database open — it must be able to import this file, decide
 * its idle rule and pick its launchd label without ever creating or touching
 * `agetor.sqlite`. A test (U1) scans the import graph to keep it that way.
 */

/** Who started this process: the launchd login item (always-on host) or the
 *  user/CLI (`agetor daemon start`, the app's own spawn). */
export type LaunchedBy = "login-item" | "cli";

/** The login-item supervisor sets `AGETOR_LAUNCHED_BY=login-item` on the core
 *  child it spawns; anything else (unset, unknown value) is the CLI path. */
export function launchedBy(env: NodeJS.ProcessEnv = process.env): LaunchedBy {
  return env.AGETOR_LAUNCHED_BY === "login-item" ? "login-item" : "cli";
}

/** The CLI-launched daemon's historical idle shutdown: 5 minutes with no
 *  client. */
const DEFAULT_CLI_IDLE_MS = 5 * 60 * 1000;

/**
 * Idle-shutdown timeout for the headless core, in ms; `0` means "never".
 *
 * Precedence: an explicit `AGETOR_DAEMON_IDLE_MS` always wins (so a tester can
 * force a short idle under the login item, or `0` for a CLI daemon that must
 * not exit); otherwise a login-item core never idles out (the whole point of
 * an always-on host), and a CLI-launched one keeps the 5-minute default.
 * A value that doesn't parse to a finite, non-negative number reads as `0`
 * (disabled) rather than falling back to a default the user clearly meant to
 * override.
 */
export function resolveIdleTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.AGETOR_DAEMON_IDLE_MS;
  if (raw !== undefined) {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }
  return launchedBy(env) === "login-item" ? 0 : DEFAULT_CLI_IDLE_MS;
}

/** Core exit code meaning "I'm done, but don't restart me — park": the
 *  supervisor stays alive without a core child until a client or the app asks
 *  for one (the app handed the port over, or the user stopped the host). */
export const CORE_EXIT_PARK = 76;

/** Supervisor exit code for "the app bundle I was launched from changed
 *  (update / move)": non-zero so launchd's KeepAlive relaunches it from the
 *  new bundle. */
export const SUPERVISOR_EXIT_BUNDLE_CHANGED = 75;

/** launchd labels of the per-channel login item. Canary and dev-channel
 *  builds use their own label so signed-build QA never collides with the
 *  user's real stable job. */
export const LOGIN_ITEM_LABELS = {
  stable: "sh.alamops.agetor.daemon",
  canary: "sh.alamops.agetor.canary.daemon",
} as const;
