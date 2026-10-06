import { AGENT_PROFILE_LIMITS } from "./agent-profile.ts";

function endsInHighSurrogate(s: string): boolean {
  if (s.length === 0) return false;
  const c = s.charCodeAt(s.length - 1);
  return c >= 0xd800 && c <= 0xdbff;
}

/** A free name for a duplicate of `base`: `base (copy)`, then `(copy 2)` …
 *  `(copy 999)`. Uniqueness uses the server's `name_key` (`trim().toLowerCase()`).
 *  The base is shortened (never the suffix) so the result fits `maxLen`; if
 *  every candidate collides the 999th is returned anyway. */
export function duplicateAgentName(
  base: string,
  existingNames: readonly string[],
  maxLen: number = AGENT_PROFILE_LIMITS.name,
): string {
  const taken = new Set(existingNames.map((n) => n.trim().toLowerCase()));
  let candidate = "";
  for (let n = 1; n <= 999; n++) {
    const suffix = n === 1 ? " (copy)" : ` (copy ${n})`;
    if (suffix.length > maxLen) {
      let cut = suffix.slice(0, Math.max(0, maxLen));
      if (endsInHighSurrogate(cut)) cut = cut.slice(0, -1);
      return cut;
    }
    let head = base;
    const room = maxLen - suffix.length;
    if (head.length > room) {
      head = head.slice(0, room);
      if (endsInHighSurrogate(head)) head = head.slice(0, -1);
    }
    candidate = head + suffix;
    if (!taken.has(candidate.trim().toLowerCase())) return candidate;
  }
  return candidate;
}
