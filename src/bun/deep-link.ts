/**
 * Pure helpers for agetor's custom URL scheme (`agetor://`), used to deep
 * link from outside the app (e.g. a terminal-notifier click) back into a
 * specific task. The only verb today is opening a task:
 *
 *   agetor://task/<taskId>
 *
 * Kept dependency-free and side-effect-free at import time so it's trivially
 * unit-testable and safe to import from both the main process and tests.
 */

/** The app's custom URL scheme, without the trailing colon. */
export const APP_URL_SCHEME = "agetor";

/**
 * The app's macOS bundle identifier — kept here (alongside the URL scheme) as
 * a single source of truth so it can't drift across call sites. Mirrors
 * `identifier` in electrobun.config.ts (which keeps its own hand-synced copy,
 * since a build-config file shouldn't import app source). Used as
 * terminal-notifier's `-sender` so a deep-link notification posts under
 * agetor's own icon/identity.
 */
export const APP_BUNDLE_ID = "sh.alamops.agetor";

/**
 * Builds a deep link that opens a given task, e.g.
 *   buildTaskDeepLink("abc123") -> "agetor://task/abc123"
 * The taskId is percent-encoded so ids containing "/", "?", "#", etc. still
 * round-trip through parseTaskDeepLink.
 */
export function buildTaskDeepLink(taskId: string): string {
  return `${APP_URL_SCHEME}://task/${encodeURIComponent(taskId)}`;
}

/**
 * Parses a `agetor://task/<taskId>` deep link and returns the decoded
 * taskId, or `null` if the URL is malformed in any way. Never throws.
 *
 * Strictness rules (deliberately the stricter reading where the spec allows
 * a choice):
 *   - scheme must be exactly "agetor:" (case-insensitive, per the URL spec —
 *     WHATWG URL parsing already lowercases the scheme for us).
 *   - host/authority must be exactly "task".
 *   - the path must be exactly one non-empty segment: "/<id>". Anything else
 *     (missing id, empty id, an extra "/segment", a doubled "//") is
 *     rejected outright rather than best-effort-normalized.
 *   - a query string or fragment is treated as identity-changing junk and
 *     rejected — a deep link either has one canonical form or is invalid,
 *     so callers never have to reason about how "?x=1" or "#y" should be
 *     ignored.
 */
export function parseTaskDeepLink(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (parsed.protocol.toLowerCase() !== `${APP_URL_SCHEME}:`) return null;
  if (parsed.host.toLowerCase() !== "task") return null;
  if (parsed.search !== "" || parsed.hash !== "") return null;

  // Exactly "/<one-non-empty-segment>" — no extra slashes, no empty segments.
  const match = /^\/([^/]+)$/.exec(parsed.pathname);
  if (!match) return null;

  const rawId = match[1];
  if (!rawId) return null;

  try {
    const taskId = decodeURIComponent(rawId);
    return taskId.length > 0 ? taskId : null;
  } catch {
    return null;
  }
}
