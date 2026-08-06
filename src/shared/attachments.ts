// Grammar for the "image attachment" shapes claude-code's tmux TUI produces
// when a user sends a message with an image path in it. Shared by both
// processes — must stay free of runtime imports from either side.
//
// Background: agetor records the prompt it sent verbatim (the "live" copy).
// claude-code's TUI, on seeing an image path in a bracketed paste, replaces
// the path with a `[Image #N]` placeholder (N is a session-wide counter, not
// per-message) and writes its OWN rewritten copy of the same send to its
// JSONL transcript (the "twin"). Byte-exact captured example, same send:
//
//   Live copy (agetor):
//     [screenshot-2026-07-29_15-38-35-8e708eec.png] I got this
//
//     Referenced files/folders:
//     - /Users/alamosaravali/.agetor/screenshots/screenshot-2026-07-29_15-38-35-8e708eec.png
//
//   Claude JSONL twin:
//     [Image #1][screenshot-2026-07-29_15-38-35-8e708eec.png] I got this
//
//     Referenced files/folders:
//     -
//
// The placeholder can in principle land anywhere in the text (not just at
// the start), and the image ref's bullet has its path stripped, leaving a
// bare `-` (possibly `- ` with trailing space). Non-image reference bullets
// (directories, code files) are left alone by claude — only the image
// bullet's path is stripped. Claude also emits a separate synthetic
// (isMeta) entry for the attachment itself, shaped exactly like:
//
//   [Image: source: /Users/alamosaravali/.agetor/screenshots/screenshot-2026-07-29_15-38-35-8e708eec.png]
//
// `canonicalizeAttachmentText` reduces both the live copy and the JSONL twin
// of the same send to one identical string, so a dedup key computed from it
// collapses the two into a single event. Callers are expected to have
// already normalized `\r` / `\r\n` to `\n` (mirrors the CR-normalization
// contract `command-message.ts`'s `parseUserMessage` documents) — this
// module does no newline normalization of its own.
import { REFS_HEADING } from "./refs.ts";

/** Canonical image-file extensions, kept in sync with `IMAGE_PATH_RE` in
 *  `src/bun/claude-tmux.ts` and the `IMAGE` set in
 *  `src/mainview/lib/file-icons.tsx` — when adding an extension to either of
 *  those, add it here too. */
const IMAGE_EXTENSIONS = [
  "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif", "heic",
];
const IMAGE_EXT_RE = new RegExp(`\\.(?:${IMAGE_EXTENSIONS.join("|")})$`, "i");

function basename(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}

/** True iff `path`'s basename ends in a canonical image extension
 *  (case-insensitive). A path ending in `/` is a directory ref and is never
 *  an image, regardless of what precedes the trailing slash. */
export function isImagePath(path: string): boolean {
  if (path.endsWith("/")) return false;
  return IMAGE_EXT_RE.test(basename(path));
}

/** Matches claude's `[Image #<digits>]` placeholder token. `N` is a
 *  session-wide attachment counter, not a per-message index — don't attempt
 *  to correlate the number to anything positional. Module-private — callers
 *  outside this file go through `stripImagePlaceholders`; nobody else in the
 *  repo imports this regex directly (checked at review time). */
const IMAGE_PLACEHOLDER_RE = /\[Image #\d+\]/g;

/** Remove every `[Image #N]` placeholder token from `text`, wherever it
 *  appears. Pure token removal — no whitespace collapsing beyond deleting
 *  the token itself, so e.g. a placeholder glued directly to adjacent text
 *  (`[Image #1][screenshot.png]`) leaves the neighbor untouched. */
export function stripImagePlaceholders(text: string): string {
  return text.replace(IMAGE_PLACEHOLDER_RE, "");
}

const IMAGE_SOURCE_META_RE = /^\[Image: source: (.+)\]$/;

/** If `text`, trimmed, is exactly claude's synthetic image-source-meta
 *  shape (`[Image: source: <path>]`), return `<path>`; else `null`. This is
 *  a separate (isMeta) transcript entry claude injects alongside the
 *  rewritten user turn, not part of the user message text itself. */
export function imageSourceMetaPath(text: string): string | null {
  const m = IMAGE_SOURCE_META_RE.exec(text.trim());
  return m ? (m[1] ?? null) : null;
}

const IMAGE_SOURCE_META_BREADCRUMB_PREFIX = "[Image: source: ";

/** Lax variant of `imageSourceMetaPath`, for RENDER-TIME filtering of
 *  persisted status breadcrumbs only — the strict `imageSourceMetaPath`
 *  remains the emit-side check. The old bun-side status path truncated
 *  breadcrumbs to 137 chars + `…`, which can chop off the closing `]` for a
 *  long path; the strict regex then fails to recognize an otherwise-valid
 *  persisted row. True iff `text`, trimmed, starts with
 *  `[Image: source: ` followed by at least one non-whitespace character —
 *  the closing `]` is optional and a trailing `…` is tolerated either
 *  way. */
export function isImageSourceMetaBreadcrumb(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith(IMAGE_SOURCE_META_BREADCRUMB_PREFIX)) return false;
  return /\S/.test(trimmed.slice(IMAGE_SOURCE_META_BREADCRUMB_PREFIX.length));
}

type Bullet =
  | { kind: "bare" }
  | { kind: "path"; path: string }
  | { kind: "invalid" };

/** Classify one line of a references-block bullet list. Tolerates both the
 *  well-formed `- <path>` shape (`splitReferences`' own rule, in
 *  `src/mainview/lib/command-message.ts`) and claude's rewritten bare `-`
 *  (or `- ` with trailing whitespace) left behind once an image bullet's
 *  path has been stripped. Anything else is `invalid` — a signal to the
 *  caller that this isn't a references block after all. */
function classifyBullet(line: string): Bullet {
  if (/^-\s*$/.test(line)) return { kind: "bare" };
  const m = /^- (.+)$/.exec(line);
  if (m) return { kind: "path", path: m[1] ?? "" };
  return { kind: "invalid" };
}

/**
 * Reduce a user message to the canonical form shared by the live copy and
 * claude's JSONL twin of the same image-attached send, so a dedup key
 * computed from the result collapses the two into one. Two transforms,
 * applied in order:
 *
 *  1. Strip every `[Image #N]` placeholder, wherever it appears in `text`.
 *  2. If the (placeholder-stripped) text ends with a trailing references
 *     block — located by the same rule as `splitReferences`: split on
 *     blank-line paragraphs, the LAST paragraph's first line must be
 *     exactly `REFS_HEADING` (the heading/bullet lines of that last
 *     paragraph are split on `\r\n|\r|\n`, not just `\n`, so a stray `\r`
 *     can't silently break convergence) — NORMALIZE every bullet that is
 *     either bare (`-` with optional trailing whitespace, claude's rewrite
 *     of a stripped image path) or whose path is an image path
 *     (`isImagePath`) to exactly `-`. Bullets that are neither bare nor an
 *     image path are kept verbatim. The heading is ALWAYS kept, even when
 *     every bullet normalizes to `-` — this function must never collapse a
 *     references-only send to the empty string, which would otherwise
 *     dedup-collide two distinct refs-only sends in the same run under the
 *     shared `""` key regardless of how many references each carried.
 *
 * A malformed references block — a line that's neither a bare bullet nor a
 * `- <path>` bullet, or a last paragraph whose first line isn't exactly
 * `REFS_HEADING` — is not a references block at all: that part of the text
 * is left untouched (placeholder stripping still applies).
 *
 * Identity contract: if no placeholder was stripped AND no bullet needed
 * normalizing (every bullet was already exactly `-`, or already a
 * non-image `- <path>`), this returns `text` completely unchanged — never
 * rebuilt, no reformatting. This function feeds a dedup key for every user
 * message (not just image-attached ones), so any incidental normalization
 * here would shift the key of ordinary messages.
 */
export function canonicalizeAttachmentText(text: string): string {
  const stripped = stripImagePlaceholders(text);

  const paragraphs = stripped.split(/\n\s*\n/);
  const last = paragraphs[paragraphs.length - 1];
  if (last === undefined) return stripped; // unreachable — split() always yields >= 1 element

  const lines = last.split(/\r\n|\r|\n/);
  if (lines[0]?.trim() !== REFS_HEADING) return stripped;

  const bulletLines = lines.slice(1);
  if (bulletLines.length === 0) return stripped;

  const kept: string[] = [];
  let normalizedAny = false;
  for (const line of bulletLines) {
    const bullet = classifyBullet(line);
    if (bullet.kind === "invalid") return stripped; // malformed → not a refs block at all
    if (bullet.kind === "path" && !isImagePath(bullet.path)) {
      kept.push(line);
      continue;
    }
    // Bare bullet, or an image-path bullet: normalize to a bare "-".
    if (line !== "-") normalizedAny = true;
    kept.push("-");
  }

  if (stripped === text && !normalizedAny) return text;

  const rebuiltLast = [REFS_HEADING, ...kept].join("\n");
  return [...paragraphs.slice(0, -1), rebuiltLast].join("\n\n");
}
