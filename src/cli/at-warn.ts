import { existsSync } from "node:fs";
import path from "node:path";
import { c, errln } from "./output.ts";
import { findAtTokens } from "../shared/at-refs.ts";
import type { AgetorClient } from "./api-client.ts";
import type { Task } from "../shared/types.ts";

// Advisory, non-blocking copy for `@`-tokens that won't resolve to a real
// project file — the CLI-side twin of the webview's highlight/expansion
// split (CLAUDE.md §12). The server (or, for the CLI's own pre-send check,
// a local listing) tells us *which* raw tokens didn't resolve; this module
// decides which of those are worth telling a human about and how to phrase
// it. Pure filtering/copy helpers plus a thin stderr wrapper — mirrors
// `refs.ts`'s split of pure helpers (`resolveRefs`/`missingRefs`) from its
// warn wrapper (`warnMissingRefs`).

/** Cap on how many unresolved tokens get named in the warning line before
 *  falling back to "and N more". */
const MAX_LISTED = 3;

/**
 * Narrow a list of RAW unresolved `@`-tokens (as reported verbatim, `@`
 * included) down to the ones actually worth warning about:
 *
 *  - a token whose path names a known extension (the ExtensionPicker's own
 *    `@name` mention syntax — e.g. `@github`, `@some-mcp-server`) is never a
 *    file reference and is dropped unconditionally, regardless of
 *    `restrictTo`.
 *  - when `restrictTo` is a string, a token survives only if its RAW form
 *    also appears among `findAtTokens(restrictTo)` — used by `agetor add
 *    --issue`, whose composed prompt quotes issue text full of
 *    `@octocat`-style mentions that must not trigger warnings: only tokens
 *    the user themselves typed (into `--prompt`, `--prompt-file`, or the
 *    wizard's interactive prompt — never `--title`, which never holds prompt
 *    text) count.
 *    `restrictTo` of `null`/omitted applies no such filter.
 *
 * A raw token `findAtTokens` itself can't parse back into a token (e.g. a
 * bare `"@"` with nothing after it) is skipped rather than crashing — every
 * caller sources these from either the server's own tokenizer or a fresh
 * scan of the prompt, so this is a defensive no-op in practice, not a real
 * path.
 */
export function filterUnresolvedRefs(
  rawTokens: string[],
  opts: { extensionNames?: ReadonlySet<string>; restrictTo?: string | null } = {},
): string[] {
  const { extensionNames, restrictTo } = opts;
  const restrictRaws = restrictTo != null ? new Set(findAtTokens(restrictTo).map((t) => t.raw)) : null;

  const kept: string[] = [];
  for (const raw of rawTokens) {
    const token = findAtTokens(raw)[0];
    if (!token) continue;
    if (extensionNames?.has(token.path)) continue;
    if (restrictRaws && !restrictRaws.has(token.raw)) continue;
    kept.push(raw);
  }
  return kept;
}

/**
 * Human copy for a non-empty set of unresolved tokens (already filtered via
 * {@link filterUnresolvedRefs}); `null` when there's nothing to say. Singular
 * phrasing for exactly one token; plural otherwise, naming up to
 * {@link MAX_LISTED} of them and folding the rest into "and N more".
 */
export function unresolvedWarningLine(tokens: string[]): string | null {
  if (tokens.length === 0) return null;
  if (tokens.length === 1) {
    return `${tokens[0]} won't resolve to a project file — sent as plain text`;
  }
  const shown = tokens.slice(0, MAX_LISTED);
  const rest = tokens.length - shown.length;
  const list = shown.join(", ") + (rest > 0 ? `, and ${rest} more` : "");
  return `${tokens.length} @ references won't resolve to project files — sent as plain text: ${list}`;
}

/** Print the warning (yellow, stderr); no-op when `tokens` is empty. Same
 *  shape as `warnMissingRefs` in `refs.ts`. */
export function warnUnresolvedRefs(tokens: string[]): void {
  const line = unresolvedWarningLine(tokens);
  if (line) errln(c.yellow("! " + line));
}

/** CLI-side mirror of the webview's `isSafeClientRelPath`
 *  (`src/mainview/lib/at-highlight.ts`): a repo-relative path safe to
 *  `path.resolve` onto a trusted directory — non-empty, not itself absolute,
 *  NUL-free, and never escapes upward via a `..` segment. Used only to guard
 *  {@link existsInLiveScope}'s on-disk stat, so a path the server-side
 *  `resolveAtPath` would reject outright never gets "rescued" by finding
 *  something outside the project at that relative path. */
export function isSafeClientRelPath(relPath: string): boolean {
  if (!relPath || relPath.startsWith("/") || relPath.includes("\0")) return false;
  return !relPath.split("/").some((seg) => seg === "..");
}

/**
 * For a LIVE (non-pinned-ref) scope — `--isolation none`, i.e. `scope.ref ==
 * null` — whether `tokenPath` actually exists on disk under `dir`. The CLI
 * runs on the same machine the task's cwd lives on, so this mirrors the
 * server's real send-time oracle (`resolveAtPath` in `project-files.ts`)
 * directly rather than trusting the tracked/untracked-not-ignored listing
 * alone: a gitignored-but-present path (e.g. `@.env`) exists on disk even
 * though `listProjectFiles` never lists it, and send-time expansion WILL
 * resolve it — so it must not warn here either. Never throws; an unsafe or
 * missing path reads as "doesn't exist" (still warned about).
 */
export function existsInLiveScope(dir: string, tokenPath: string): boolean {
  let rel = tokenPath;
  while (rel.endsWith("/")) rel = rel.slice(0, -1);
  if (!rel || !isSafeClientRelPath(rel)) return false;
  try {
    return existsSync(path.resolve(dir, rel));
  } catch {
    return false;
  }
}

/** `agentDiscovery`'s extension names, as the set `filterUnresolvedRefs`
 *  exempts from the "won't resolve" warning (the ExtensionPicker's own
 *  `@name` mention syntax — e.g. `@github` — is never a file reference).
 *  Shared by `add.ts` (`cmdAdd`'s pre-check and `--start`) and
 *  `lifecycle.ts` (`cmdSend`, `cmdStart`) so there's one copy of this
 *  fail-open lookup rather than one per caller. A discovery failure must not
 *  block or fail the caller's own operation: falls back to an empty set
 *  (over-warn rather than crash) — the network call itself is the only
 *  non-injectable part, reached through the passed-in `client` so a test can
 *  swap in a fake `agentDiscovery` that throws or returns a controlled list
 *  without a real server. */
export async function discoveredExtensionNames(
  client: AgetorClient,
  task: Pick<Task, "agent" | "workdir" | "branch">,
): Promise<Set<string>> {
  try {
    const { extensions } = await client.agentDiscovery(task.agent, task.workdir, task.branch ?? null);
    return new Set(extensions.map((e) => (e.insert.startsWith("@") ? e.insert.slice(1) : e.name)));
  } catch {
    return new Set();
  }
}
