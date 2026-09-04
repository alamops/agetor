// `@` file-reference autocomplete for the TUI Dashboard's message composer —
// CLI parity for the webview's `@` feature (see CLAUDE.md §12 and
// `src/mainview/components/kanban/AtFileAutocomplete.tsx`). Pure and
// DOM-free by design (no ink here) so it's unit-testable without rendering
// anything; `Composer.tsx` is the only consumer of the two suggestion
// functions, `Dashboard.tsx` the only consumer of `fileScopeForTask`.
//
// The TUI composer is a single append-only line — there is no way to move
// the caret to the middle of the text — so unlike the webview's
// `findActiveAtQuery(text, caret)` (caret can be anywhere), every call here
// uses `caret = text.length`. That's what makes `acceptSuggestion` safe to
// take just `{ start }` rather than a full `{ start, end }` slice: `end` is
// always `text.length`, i.e. always the end of the string being replaced.

import type { FileEntry } from "../../shared/at-file-filter.ts";
import { descendInto, filterFileEntries } from "../../shared/at-file-filter.ts";
import { findActiveAtQuery, formatAtToken } from "../../shared/at-refs.ts";
import type { Task } from "../../shared/types.ts";

/** How many rows the composer's popover shows at once. */
const MAX_SUGGESTIONS = 5;

/**
 * The project scope (`GET /files/index` params) a task's `@` popover should
 * list/validate against — EXACTLY the table `RunPanel.tsx`'s `fileScope`
 * memo uses (see CLAUDE.md §12): the live worktree once it exists; before
 * the first run of an isolated task, the source repo at whatever ref
 * `prepareWorkdir` will actually check the worktree out on (`task.branch`
 * when pinned to a pre-existing branch, else the pinned `baseRef`); a plain
 * workdir otherwise.
 */
export function fileScopeForTask(
  task: Pick<Task, "workdir" | "worktreePath" | "isolation" | "baseRef" | "branchSource" | "branch">,
): { dir: string; ref?: string | null } {
  if (task.worktreePath) return { dir: task.worktreePath };
  if (task.isolation === "worktree") {
    return {
      dir: task.workdir,
      ref: task.branchSource === "existing" && task.branch ? task.branch : (task.baseRef ?? "HEAD"),
    };
  }
  return { dir: task.workdir };
}

/** The active `@`-query slice at the end of `text`, plus its top suggestion
 *  rows. `null` when there's no active query (no `@`, or the token already
 *  finished) — the composer renders nothing in that case. A non-null result
 *  can still carry an empty `entries` array (no match); the composer treats
 *  that the same as "closed". */
export function suggestAtEntries(
  entries: FileEntry[],
  text: string,
): { slice: { start: number; end: number; query: string }; entries: FileEntry[] } | null {
  const active = findActiveAtQuery(text, text.length);
  if (!active) return null;
  return {
    slice: { start: active.start, end: active.end, query: active.query },
    entries: filterFileEntries(entries, active.query, MAX_SUGGESTIONS),
  };
}

/**
 * Apply picking `entry` while the popover is open: replaces `text.slice(
 * slice.start)` — always the whole active query, since the caret is always
 * at the end of `text` in this composer — with the committed token.
 *
 * A file commits and closes: `formatAtToken(entry.path) + " "`, matching the
 * webview's Enter/click `commit`.
 *
 * A directory instead *descends* and keeps the query alive, mirroring the
 * webview's Tab-descend (`AtFileAutocomplete.tsx`'s `descend`): the rewritten
 * text is `"@" + descendInto(entry.path)` with NO closing quote and NO
 * trailing space, so a follow-up keystroke keeps narrowing into that
 * directory. When the descended path itself contains whitespace, the
 * opening token is quoted (`@"...`) instead — a bare `@`-slice can never
 * contain whitespace (`findActiveAtQuery`'s bare branch rejects it), so an
 * unquoted descend into a spaced directory would otherwise go dead mid-path.
 */
export function acceptSuggestion(
  text: string,
  slice: { start: number },
  entry: FileEntry,
): string {
  const before = text.slice(0, slice.start);
  if (!entry.isDirectory) {
    return before + formatAtToken(entry.path) + " ";
  }
  const descended = descendInto(entry.path);
  const token = /\s/.test(descended) ? `@"${descended}` : `@${descended}`;
  return before + token;
}
