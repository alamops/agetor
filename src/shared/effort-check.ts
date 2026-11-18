/**
 * The single gate every harness spawn path asks before an effort id reaches
 * argv or an environment variable (claude `CLAUDE_CODE_EFFORT_LEVEL`, codex
 * `-c model_reasoning_effort=`, copilot `--reasoning-effort`, a cursor
 * variant id). A CLI can now report an effort agetor has never heard of
 * (dynamic-model-catalog #12, #15); it is allowed through only when the CLI
 * itself listed it for the model and it is a plain token.
 */

import { EFFORT_ID_RE, EFFORT_OPTIONS, MODEL_DEFAULT_EFFORT_KINDS, type AgentKind } from "./types.ts";

export { EFFORT_ID_RE };

/** The levels claude's `CLAUDE_CODE_EFFORT_LEVEL` has always accepted. */
const CLAUDE_EFFORT_IDS: ReadonlySet<string> = new Set(["low", "medium", "high", "xhigh", "max"]);

const KNOWN_EFFORT_IDS: ReadonlySet<string> = new Set(EFFORT_OPTIONS.map((o) => o.id));

/**
 * True when `effort` may be passed to `kind`'s CLI. Known ids pass (claude:
 * only `low…max`; `auto` only on the kinds that offer it), an unknown id
 * passes only when it is in the model's `discovered` effort set and matches
 * {@link EFFORT_ID_RE}. `discovered` is the CLI-reported set for the model
 * being spawned, or null when discovery has nothing for it.
 */
export function effortPassesSpawnCheck(
  kind: AgentKind,
  effort: string,
  discovered: readonly string[] | null,
): boolean {
  if (!EFFORT_ID_RE.test(effort)) return false;
  if (effort === "auto") return MODEL_DEFAULT_EFFORT_KINDS.has(kind);
  const known = kind === "claude-code" ? CLAUDE_EFFORT_IDS.has(effort) : KNOWN_EFFORT_IDS.has(effort);
  if (known) return true;
  return discovered?.includes(effort) === true;
}
