import { AGENT_PROFILE_LIMITS } from "./agent-profile.ts";

function endsInHighSurrogate(s: string): boolean {
  if (s.length === 0) return false;
  const c = s.charCodeAt(s.length - 1);
  return c >= 0xd800 && c <= 0xdbff;
}

/** A free name for a duplicate of `base`: `base (copy)`, then `(copy 2)`, …
 *  Uniqueness uses the server's `name_key` (`trim().toLowerCase()`).
 *  The base is shortened (never the suffix) so the result fits `maxLen`.
 *  Numbering continues while the suffix itself still fits. A taken name is
 *  never returned. When even ` (copy)` is longer than `maxLen`, a cut of that
 *  suffix is returned only if it is free. */
export function duplicateAgentName(
  base: string,
  existingNames: readonly string[],
  maxLen: number = AGENT_PROFILE_LIMITS.name,
): string {
  const taken = new Set(existingNames.map((n) => n.trim().toLowerCase()));
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? " (copy)" : ` (copy ${n})`;
    if (suffix.length > maxLen) {
      let cut = suffix.slice(0, Math.max(0, maxLen));
      if (endsInHighSurrogate(cut)) cut = cut.slice(0, -1);
      if (cut && !taken.has(cut.trim().toLowerCase())) return cut;
      throw new Error("no free duplicate name fits the length cap");
    }
    let head = base;
    const room = maxLen - suffix.length;
    if (head.length > room) {
      head = head.slice(0, room);
      if (endsInHighSurrogate(head)) head = head.slice(0, -1);
    }
    const candidate = head + suffix;
    if (!taken.has(candidate.trim().toLowerCase())) return candidate;
  }
}
