// Shared by both processes — must stay free of runtime imports from either
// side (see refs.ts's header for the same rule). `src/bun/agents.ts` is the
// spawn-time enforcer (it throws above this budget when building the gemini
// launch argv); this module is what lets the webview/CLI pre-check the same
// budget before ever calling createTask/startTask, so an over-cap prompt can
// be caught with a clear message instead of surfacing as a failed run.
import type { AgentKind } from "./types.ts";

/**
 * Same tmux-imsg-cap constraint documented in `src/bun/agents.ts` next to the
 * (re-exported) constant of the same name: gemini's one-shot tmux launch has
 * no deferred-paste fallback for an oversized prompt, so anything above this
 * budget must be caught before spawn rather than mis-delivered.
 */
export const GEMINI_PROMPT_ARGV_MAX_BYTES = 4096;

/** Per-kind prompt-argv byte budgets. A kind absent from this map is
 *  uncapped (claude has a deferred-paste fallback; codex/cursor/fx deliver
 *  the prompt off argv entirely). */
export const PROMPT_ARGV_MAX_BYTES: Partial<Record<AgentKind, number>> = {
  gemini: GEMINI_PROMPT_ARGV_MAX_BYTES,
};

/**
 * Whether `prompt` exceeds `kind`'s prompt-argv budget, and by how much.
 * Returns null when the kind is uncapped or the prompt fits — the common
 * case, so callers can do `const overage = promptByteOverage(kind, prompt);
 * if (overage) { ... }` without an extra boolean. Byte length is measured
 * with `TextEncoder`, matching `Buffer.byteLength(prompt, "utf8")` on the
 * spawn side.
 */
export function promptByteOverage(kind: AgentKind, prompt: string): { limit: number; bytes: number } | null {
  const limit = PROMPT_ARGV_MAX_BYTES[kind];
  if (limit == null) return null;
  const bytes = new TextEncoder().encode(prompt).length;
  return bytes > limit ? { limit, bytes } : null;
}
