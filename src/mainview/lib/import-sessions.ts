/**
 * Pure helpers behind the Import sessions dialog and the session/harness
 * toasts in App.tsx (docs/plans/add-opencode-harness.md D-13, D-14). No
 * React, no DOM, so `bun test` covers them directly.
 */
import { MISSING_FOLDER_IMPORT_ERROR } from "../../shared/claude-session-meta.ts";
import type { OpencodeSessionListItem } from "../../shared/types.ts";

export const OPENCODE_BUSY_COPY = "OpenCode is still working on this session";
export const OPENCODE_BUSY_UNKNOWN_COPY = "Couldn't check whether OpenCode is still working on this session";

/** Why an OpenCode row can't be imported, or `null` when it can. */
export function opencodeBlockedCopy(session: OpencodeSessionListItem): string | null {
  if (session.importable) return null;
  if (session.blockedReason === "missing-folder") return MISSING_FOLDER_IMPORT_ERROR;
  if (session.blockedReason === "busy") return OPENCODE_BUSY_COPY;
  return "This session can't be imported";
}

/** A warning for an importable row whose busy check couldn't run. It does
 *  not block Import (the backend imports it, then reports an unfinished
 *  session with a status line). */
export function opencodeWarningCopy(session: OpencodeSessionListItem): string | null {
  return session.importable && session.busyUnknown ? OPENCODE_BUSY_UNKNOWN_COPY : null;
}

/** Selection key for an OpenCode row. The same session id can be listed by
 *  two OpenCode harnesses (two accounts sharing a project), so the harness
 *  is part of the key. */
export function opencodeRowKey(session: Pick<OpencodeSessionListItem, "harnessId" | "sessionId">): string {
  return `opencode:${session.harnessId}:${session.sessionId}`;
}

/** Selection key for a Claude row. */
export function claudeRowKey(sessionId: string): string {
  return `claude-code:${sessionId}`;
}

/** Key recording that a session id was imported, whichever harness's row
 *  it was imported from: one session becomes one task, so every row listing
 *  it (another account sharing the project) is gone once it is imported. */
export function opencodeSessionKey(sessionId: string): string {
  return `opencode-session:${sessionId}`;
}

/**
 * Group OpenCode rows by the harness that listed them, for one
 * `importOpencodeSessions(ids, harnessId)` call per harness. A session id is
 * imported once: when two harnesses' rows of the same session are both
 * picked, the first row's harness takes it (the other would only fail as
 * "already imported"). Insertion order is kept.
 */
export function groupOpencodeImports(
  rows: readonly Pick<OpencodeSessionListItem, "harnessId" | "sessionId">[],
): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  const taken = new Set<string>();
  for (const row of rows) {
    if (taken.has(row.sessionId)) continue;
    taken.add(row.sessionId);
    const ids = groups.get(row.harnessId) ?? [];
    ids.push(row.sessionId);
    groups.set(row.harnessId, ids);
  }
  return groups;
}

/**
 * Merge two lists that are each already in the server's order (newest
 * first) into one, newest first. Each list keeps its own relative order;
 * on a tie the first list's row comes first.
 */
export function mergeByActivity<A, B>(
  a: readonly A[],
  activityA: (row: A) => number,
  b: readonly B[],
  activityB: (row: B) => number,
): (A | B)[] {
  const out: (A | B)[] = [];
  let i = 0;
  let j = 0;
  const at = (n: number) => (Number.isFinite(n) ? n : -Infinity);
  while (i < a.length && j < b.length) {
    if (at(activityA(a[i]!)) >= at(activityB(b[j]!))) out.push(a[i++]!);
    else out.push(b[j++]!);
  }
  while (i < a.length) out.push(a[i++]!);
  while (j < b.length) out.push(b[j++]!);
  return out;
}

/** "Codex", "Codex and Cursor", "Codex, Cursor and OpenCode". */
export function joinLabels(labels: readonly string[]): string {
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

/** Toast copy for `harnesses_auto_enabled`, or `null` when nothing was
 *  turned on. Falls back to the harness id for a missing label. */
export function autoEnabledToastText(harnessIds: readonly string[], labels: readonly string[]): string | null {
  const names = harnessIds.map((id, i) => labels[i]?.trim() || id).filter((name) => name.length > 0);
  if (names.length === 0) return null;
  const one = names.length === 1;
  return `Turned on ${joinLabels(names)} because ${one ? "it's" : "they're"} installed — turn ${one ? "it" : "them"} off in Settings`;
}

/** Toast copy for `opencode_sessions_found`, mirroring the Claude one. */
export function opencodeSessionsFoundText(count: number): string {
  return `${count} OpenCode session${count === 1 ? "" : "s"} found outside Agetor — Review`;
}
