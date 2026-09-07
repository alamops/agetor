// Pure view-model transforms for the "Files sent to you" card
// (`SentFilesCard.tsx`) — no React, no DOM. Turns a `SendUserFile` tool_use
// request plus its (possibly not-yet-arrived) tool_result and a batched
// `/refs/resolve` stat into the tile list + status line the card renders.
// Kept pure and unit-tested directly (there's no jsdom in this repo — the
// logic that matters lives here, the rendering is covered by Playwright),
// same split as `src/shared/todo-progress.ts`.
import { isImagePath } from "../../shared/attachments.ts";
import type { SentFilesRequest, SentFilesResult } from "../../shared/sent-files.ts";

/** One tile in the "Files sent to you" card's grid — one per (deduped) path
 *  in the request's `files` list, in the order the tool_use listed them. */
export interface SentFileTile {
  path: string;
  name: string;
  kind: "image" | "file" | "folder";
  /** `null` while existence is unknown: `stats` hasn't come back yet, or
   *  `path` isn't absolute so there's nothing the client can key a stat
   *  lookup on. `true`/`false` once `stats` has answered for this path. */
  exists: boolean | null;
  size: number | null;
  mediaType: string | null;
}

/** The `/refs/resolve` answer, keyed by exact path — a present entry means
 *  the path exists (missing paths are dropped server-side, never a `false`
 *  value). */
export type PathStats = ReadonlyMap<string, { isDirectory: boolean }>;

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/");
}

/** Last path segment, trailing slashes stripped first so a directory ref
 *  keeps its own name rather than an empty string. Local copy — deliberately
 *  not importing `sentFileBasename` from `src/shared/sent-files.ts`/
 *  `refBasename` from `file-icons.tsx` to keep this module's only import
 *  surface the two types it actually consumes. */
function basename(path: string): string {
  let p = path;
  while (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  const idx = p.lastIndexOf("/");
  return idx === -1 ? p : p.slice(idx + 1);
}

/**
 * Build the tile list for a `SendUserFile` request: one tile per entry in
 * `req.files`, in order, deduped by exact path (first occurrence wins,
 * matching how a repeated path would render as one message-level file
 * anyway).
 *
 * - `size` / `mediaType` come from `result.attachments`, matched by exact
 *   path; `null` when there's no result yet or no matching attachment.
 * - `kind` is `"folder"` when `stats` has this path and reports
 *   `isDirectory`; else `"image"` when the matching attachment says
 *   `isImage === true`, or its `mediaType` starts with `"image/"`, or the
 *   path itself looks like an image path ({@link isImagePath}); else
 *   `"file"`. A directory stat always wins over an image-shaped path/
 *   attachment (defensive — Claude currently rejects directories outright,
 *   but the fx dormant mapping and a future harness could send one).
 * - `exists` is `null` while `stats` is `null` (pending) or `path` isn't
 *   absolute (nothing to stat client-side); `true` when `stats` has the
 *   path; `false` otherwise.
 */
export function buildSentFileTiles(
  req: SentFilesRequest,
  result: SentFilesResult | null,
  stats: PathStats | null,
): SentFileTile[] {
  const attachmentByPath = new Map((result?.attachments ?? []).map((a) => [a.path, a] as const));

  const seen = new Set<string>();
  const tiles: SentFileTile[] = [];
  for (const path of req.files) {
    if (seen.has(path)) continue;
    seen.add(path);

    const attachment = attachmentByPath.get(path) ?? null;
    const size = attachment?.size ?? null;
    const mediaType = attachment?.mediaType ?? null;

    const stat = stats?.get(path) ?? null;
    let kind: SentFileTile["kind"];
    if (stat?.isDirectory) {
      kind = "folder";
    } else if (
      attachment?.isImage === true
      || (mediaType !== null && mediaType.startsWith("image/"))
      || isImagePath(path)
    ) {
      kind = "image";
    } else {
      kind = "file";
    }

    const exists = stats === null || !isAbsolutePath(path) ? null : stats.has(path);

    tiles.push({ path, name: basename(path), kind, exists, size, mediaType });
  }
  return tiles;
}

/** Status-row tone + copy for a `SendUserFile` card. */
export function sentFilesStatus(
  req: SentFilesRequest,
  result: SentFilesResult | null,
): { tone: "success" | "pending" | "error"; text: string } {
  const total = req.files.length;
  const noun = total === 1 ? "file" : "files";

  if (result === null) {
    return { tone: "pending", text: `Sending ${total} ${noun}…` };
  }
  if (result.error !== null) {
    return { tone: "error", text: result.error };
  }

  const count = result.deliveredCount ?? total;
  const deliveredNoun = count === 1 ? "file" : "files";
  return { tone: "success", text: `${count} ${deliveredNoun} delivered` };
}
