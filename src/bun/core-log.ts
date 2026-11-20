import path from "node:path";
import { format } from "node:util";
import { resolveDataDir } from "./core-creds.ts";
import { createDaemonLogger, type DaemonLogger } from "./daemon-log.ts";

/**
 * The desktop app's core log: `$AGETOR_DATA_DIR/core.log`.
 *
 * The packaged app's launcher points the core's stdout and stderr at
 * /dev/null, so everything the core printed (the event-loop-lag monitor's
 * "core was unresponsive for N s during …" lines among them) was lost. This
 * copies every console line into the log as well, keeping the original
 * console output for `bun run dev`. Same rotation as `daemon.log`
 * (`daemon-log.ts`: 5 MB, two older generations); created owner-only.
 *
 * Imports only leaves (`core-creds`, `daemon-log`), never `db.ts`, so
 * `core-log-boot.ts` can install it before anything else in `index.ts` runs.
 * The headless core already writes to `daemon.log` by descriptor.
 */
export const coreLogPath = path.join(resolveDataDir(), "core.log");

const METHODS = ["log", "info", "warn", "error", "debug"] as const;
type Method = (typeof METHODS)[number];

/** Copy every `console.<method>` line into `logger`, prefixed with the level.
 *  Returns a function that puts the original methods back. */
export function installCoreLog(
  opts: { logger?: DaemonLogger | ((line: string) => void); target?: Pick<Console, Method> } = {},
): () => void {
  const logger = opts.logger ?? createDaemonLogger({ path: coreLogPath, mode: 0o600 });
  const target = opts.target ?? console;
  const originals = new Map<Method, (...args: unknown[]) => void>();
  for (const m of METHODS) {
    const original = target[m] as (...args: unknown[]) => void;
    originals.set(m, original);
    target[m] = (...args: unknown[]) => {
      original.apply(target, args);
      try {
        logger(`${m.toUpperCase()} ${format(...args)}`);
      } catch {
        /* logging must never throw into the caller */
      }
    };
  }
  return () => {
    for (const [m, original] of originals) target[m] = original;
  };
}
