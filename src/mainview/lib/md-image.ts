// Pure classifier + `urlTransform` for markdown `![alt](src)` image
// references found in agent transcripts (cursor/claude/codex/gemini/fx all
// emit plain markdown — see docs/plans/markdown-image-rendering.md §2).
// Rendering (the `MdImage` React component) lives in
// `../components/kanban/MdImage.tsx`; this module stays free of React/DOM/
// `node:` imports so it bundles cleanly into the webview, same discipline as
// `shorten-task-paths.ts`.
//
// Three input shapes agents actually produce, all covered by
// `classifyMdImageSrc`:
//   - cursor's ground truth: an absolute POSIX path (`/tmp/x.png`).
//   - claude-code's ground truth: a path relative to the task's cwd
//     (`docs/shot.png`), resolved against the task's own roots.
//   - a `file://` URL, which react-markdown's default `urlTransform` blanks
//     before any `components.img` override ever sees it (see `mdUrlTransform`
//     below) — so it must be unwrapped in the transform, not here.
import type { UrlTransform } from "react-markdown";
import { defaultUrlTransform } from "react-markdown";
import { isImagePath } from "../../shared/attachments.ts";

/** Classification of a markdown image `src`, after resolving it against a
 *  task's known roots (worktree/workdir). `remote` passes through untouched;
 *  `local`/`file` differ only by extension (`isImagePath`) — both carry
 *  `candidates`, absolute paths to try in order via `/files/preview` /
 *  `openPath`; `empty` covers a missing/blank src or anything
 *  react-markdown's default transform already blanked (`data:`, `C:\…`). */
export type MdImageSource =
  | { kind: "remote"; url: string }
  | { kind: "local"; path: string; candidates: string[] }
  | { kind: "file"; path: string; candidates: string[] }
  | { kind: "empty" };

/** POSIX-normalize `input`: split on `/`, drop empty and `.` segments, pop
 *  one segment on `..` (never climbing above a leading `/` — an absolute
 *  path can't go negative, so a `..` at the root is simply dropped), and
 *  collapse repeated slashes. A trailing `/` on the input is preserved on
 *  the output (directory refs must round-trip: `@src/bun` stays a directory
 *  mention as `src/bun/`, matching the `@`-expansion convention documented
 *  in CLAUDE.md's "@ file references" section). */
function normalizePosixPath(input: string): string {
  const isAbsolute = input.startsWith("/");
  const hadTrailingSlash = input.endsWith("/");
  const segments = input.split("/");
  const out: string[] = [];
  for (const seg of segments) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") {
        out.pop();
      } else if (!isAbsolute) {
        out.push("..");
      }
      // Absolute + empty `out`: climbing above `/` is a no-op, drop it.
      continue;
    }
    out.push(seg);
  }
  const body = out.join("/");
  const prefix = isAbsolute ? "/" : "";
  const suffix = hadTrailingSlash && body !== "" ? "/" : "";
  return `${prefix}${body}${suffix}`;
}

/**
 * Unwrap a `file://` URL to a POSIX path, or `null` if it isn't one agetor
 * can resolve. Accepts `file:///abs/path` and `file://localhost/abs/path`
 * (an empty or `localhost` host); any other host is foreign (a real remote
 * file server) and is rejected. `?query`/`#hash` are stripped before percent-
 * decoding (`decodeURIComponent`, `null` on a malformed escape) — unlike a
 * bare absolute/relative path (see `classifyMdImageSrc`), where `?`/`#` are
 * kept verbatim since a POSIX filename may legally contain either character.
 * The regex's capture group always starts with a literal, unencoded `/`, so
 * the decoded result is guaranteed to start with `/` too — this function can
 * never fabricate a relative path out of a `file:` URL.
 */
export function fileUrlToPath(value: string): string | null {
  const match = /^file:\/\/([^/]*)(\/.*)?$/i.exec(value.trim());
  if (!match) return null;
  const host = match[1] ?? "";
  if (host !== "" && host.toLowerCase() !== "localhost") return null;
  let rawPath = match[2] ?? "";
  if (rawPath === "") return null;
  const hashIdx = rawPath.indexOf("#");
  if (hashIdx !== -1) rawPath = rawPath.slice(0, hashIdx);
  const queryIdx = rawPath.indexOf("?");
  if (queryIdx !== -1) rawPath = rawPath.slice(0, queryIdx);
  try {
    return decodeURIComponent(rawPath);
  } catch {
    return null;
  }
}

/** Matches a URL scheme prefix (RFC 3986 `scheme:`), used to blank any
 *  scheme this classifier doesn't explicitly understand — `data:`,
 *  `javascript:`, `blob:`, a bare `C:\…`, etc. — mirroring
 *  `defaultUrlTransform`'s own blanking of unsafe schemes (see the module
 *  doc comment) so the classifier doesn't depend on an upstream caller
 *  having already applied it. The character class deliberately excludes
 *  `/`, so a colon that follows a path separator (`docs/a:b.png`) can never
 *  match — that's a relative path, not a scheme. */
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Classify a markdown image `src` against a task's known roots
 * (`[worktreePath, workdir]`, in that order — a torn-down worktree still
 * falls back to the source workdir, D5 in the plan). Falsy/blank roots are
 * skipped, not treated as `""`.
 *
 * Resolution order:
 *   1. blank/missing → `empty`.
 *   2. `^https?:` → `remote` (passthrough, untouched).
 *   3. `^file:` → unwrap via `fileUrlToPath` (which strips `?query`/`#hash`
 *      before percent-decoding); `null` → `empty`; otherwise the unwrapped
 *      path is treated as absolute (step 6).
 *   4. `^//` (protocol-relative — no scheme, e.g. `//img.shields.io/b.svg`,
 *      as GitHub issue/PR bodies and badge services commonly emit) →
 *      `remote`, prefixed `https:`. This has no colon, so it survives
 *      react-markdown's default `urlTransform` untouched and would
 *      otherwise fall into the absolute-path branch below and misclassify
 *      as a local file (`/img.shields.io/b.svg` → 404 → a misleading
 *      "not found" chip).
 *   5. any other URL-scheme prefix (`URL_SCHEME_RE`, e.g. `data:`,
 *      `javascript:`, `blob:`, a bare `C:\…`) → `empty`, mirroring
 *      `defaultUrlTransform`'s own blanking of unsafe schemes — a relative
 *      path like `foo:bar.png` is therefore also `empty` here (consistent
 *      with react-markdown blanking that same string upstream), while a
 *      colon appearing after the first `/` (`docs/a:b.png`) does not match
 *      and still resolves as relative (step 7).
 *   6. a leading `/` → absolute: one candidate, the normalized value
 *      itself. Unlike a `file:` URL, `?`/`#` are kept verbatim here (and in
 *      the relative branch below) rather than stripped — a POSIX filename
 *      may legally contain either character, so `/tmp/a.png?v=1` resolves
 *      as the literal (non-image) path `/tmp/a.png?v=1`, not `/tmp/a.png`.
 *   7. otherwise relative: strip one leading `@` (the `@rel` mention form
 *      `shortenTaskPaths` produces for a path the user typed under a task
 *      root — see `shorten-task-paths.ts`), then a leading `./`; join
 *      against each non-empty-string root in order, normalize, and dedupe
 *      while keeping order. Zero usable roots yields `candidates: []` and a
 *      display `path` of the stripped-but-unresolved relative text.
 *
 * `local` vs `file` is decided by `isImagePath` on the display path (a
 * `.pdf`, or a path ending `/`, is `file`; a canonical image extension is
 * `local`) — same rule either way since the extension survives root-joining
 * unchanged.
 */
export function classifyMdImageSrc(
  src: string | null | undefined,
  roots: readonly (string | null | undefined)[],
): MdImageSource {
  const trimmed = (src ?? "").trim();
  if (trimmed === "") return { kind: "empty" };
  if (/^https?:/i.test(trimmed)) return { kind: "remote", url: trimmed };

  let displayPath: string;
  let candidates: string[];

  if (/^file:/i.test(trimmed)) {
    const unwrapped = fileUrlToPath(trimmed);
    if (unwrapped === null) return { kind: "empty" };
    displayPath = normalizePosixPath(unwrapped);
    candidates = [displayPath];
  } else if (trimmed.startsWith("//")) {
    return { kind: "remote", url: `https:${trimmed}` };
  } else if (URL_SCHEME_RE.test(trimmed)) {
    return { kind: "empty" };
  } else if (trimmed.startsWith("/")) {
    displayPath = normalizePosixPath(trimmed);
    candidates = [displayPath];
  } else {
    let rel = trimmed;
    if (rel.startsWith("@")) rel = rel.slice(1);
    if (rel.startsWith("./")) rel = rel.slice(2);

    const seen = new Set<string>();
    candidates = [];
    for (const root of roots) {
      if (typeof root !== "string" || root.trim() === "") continue;
      const joined = normalizePosixPath(`${root}/${rel}`);
      if (seen.has(joined)) continue;
      seen.add(joined);
      candidates.push(joined);
    }
    displayPath = candidates[0] ?? rel;
  }

  return isImagePath(displayPath)
    ? { kind: "local", path: displayPath, candidates }
    : { kind: "file", path: displayPath, candidates };
}

/**
 * Custom `urlTransform` for every `ReactMarkdown` call site that can render
 * an agent-authored image (D3 in the plan). react-markdown applies
 * `urlTransform` to the hast tree BEFORE `components.img` ever runs
 * (`node_modules/react-markdown/lib/index.js:346-385, 421-444`), and its
 * default transform blanks any scheme outside `https?|ircs?|mailto|xmpp` —
 * so a `file://` src arrives at `MdImage` as `src=""` unless it's unwrapped
 * here first; nothing inside the component can recover the original value.
 * Scoped to `img`/`src` only (A1 in the plan: a `file://` *link* — `a`/
 * `href` — keeps today's blanked behavior); everything else defers to
 * `defaultUrlTransform` unchanged (`https:` passthrough, `data:`/`C:\…`
 * still blanked).
 */
export const mdUrlTransform: UrlTransform = (value, key, node) => {
  if (key === "src" && node.tagName === "img" && /^file:/i.test(value)) {
    return fileUrlToPath(value) ?? "";
  }
  return defaultUrlTransform(value);
};
