import os from "node:os";
import path from "node:path";

/**
 * Where GitHub Copilot CLI keeps its state (`config.json`, `session-state/`,
 * `skills/`, `mcp-config.json`, `agents/`) for one harness. Shared by
 * `buildCommand` (which pins the result as `COPILOT_HOME` on every spawn),
 * the tmux driver (plan-file reader), capability discovery and the
 * orchestrator's "does this session still exist under this account" check, so
 * they can never disagree about the directory.
 *
 * Precedence, first non-blank wins:
 *   1. the harness `env` map's own `COPILOT_HOME` (an explicit user override)
 *   2. `harness.home` (what the "Additional GitHub Copilot" template sets)
 *   3. the agetor process's `COPILOT_HOME`
 *   4. `<HOME>/.copilot` (Copilot's own default), where `<HOME>` is the
 *      harness `env` map's `HOME` when it sets one (the spawned process sees
 *      that HOME, so its `~` is there) and the process home otherwise
 *
 * Copilot has no XDG lookup for this directory — its docs name `~/.copilot`
 * as the default and `COPILOT_HOME` as the only override, and older XDG
 * locations are migrated into `~/.copilot` — so `XDG_CONFIG_HOME` is
 * deliberately ignored.
 */
export interface CopilotHomeInput {
  /** `harness.home` (null/undefined/blank when the harness has none). */
  harnessHome?: string | null;
  /** The harness `env` map (NOT the merged spawn env). */
  harnessEnv?: Record<string, string | undefined> | null;
  /** Injected for tests; defaults to `process.env`. */
  processEnv?: Record<string, string | undefined>;
}

function nonBlank(v: string | null | undefined): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

function expandHome(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return path.join(home, p.slice(2));
  return p;
}

export function copilotHome(input: CopilotHomeInput = {}): string {
  const processEnv = input.processEnv ?? process.env;
  const home = nonBlank(input.harnessEnv?.HOME) ?? os.homedir();
  const chosen =
    nonBlank(input.harnessEnv?.COPILOT_HOME) ??
    nonBlank(input.harnessHome) ??
    nonBlank(processEnv.COPILOT_HOME) ??
    path.join(home, ".copilot");
  return expandHome(chosen, home);
}
