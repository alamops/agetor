// Pure helpers for a task's pull-request records (`TaskPr`). Shared by the Bun
// core (`db.ts`), the webview, the CLI and the TUI, so it must stay free of
// runtime imports from either process. Contract: docs/architecture/multi-repo-tasks.md.
import type { TaskPr } from "./types.ts";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function nonEmptyString(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

function finiteNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Parse a stored `prs` value (an array, or its JSON text) into valid records.
 * Entries without a string `url` are dropped; a bad `number`, `head` or `base`
 * becomes null and a bad `createdAt` becomes 0. Malformed JSON gives `[]`.
 */
export function parseTaskPrs(raw: unknown): TaskPr[] {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  const out: TaskPr[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const url = nonEmptyString(entry.url);
    if (!url) continue;
    out.push({
      url,
      head: nonEmptyString(entry.head),
      base: nonEmptyString(entry.base),
      number: finiteNumber(entry.number),
      createdAt: finiteNumber(entry.createdAt) ?? 0,
    });
  }
  return out;
}

/**
 * Convert a legacy single `prUrl` into a record list. The head is whatever the
 * caller knows (the checkout or task branch), the base and number are unknown.
 */
export function legacyTaskPrs(
  prUrl: string | null | undefined,
  head: string | null,
  createdAt = 0,
): TaskPr[] {
  const url = nonEmptyString(prUrl);
  return url ? [{ url, head, base: null, number: null, createdAt }] : [];
}

/**
 * The PR records of a task or repository entry. Falls back to a legacy `prUrl`
 * only when `prs` is absent, which is JSON from an older core (a newer CLI or
 * webview talking to an older running app). A same-version core always sends `prs`.
 */
export function taskPrsOf(x: { prs?: TaskPr[] | null; prUrl?: string | null }): TaskPr[] {
  if (Array.isArray(x.prs)) return x.prs;
  return legacyTaskPrs(x.prUrl, null);
}

/** The PR opened from `head`, if any. */
export function prForHead(prs: readonly TaskPr[], head: string | null | undefined): TaskPr | null {
  if (!head) return null;
  return prs.find((p) => p.head === head) ?? null;
}

/**
 * The PR for the live checkout: a record whose head is one of `heads`, else a
 * converted legacy record (`head: null`), which predates head tracking and so
 * belongs to the only branch the task had.
 */
export function livePr(
  prs: readonly TaskPr[],
  heads: readonly (string | null | undefined)[],
): TaskPr | null {
  for (const h of heads) {
    const hit = prForHead(prs, h);
    if (hit) return hit;
  }
  return prs.find((p) => p.head === null) ?? null;
}

/** The PR the header's "View PR", mergeability and conflict flows act on. */
export function headerPr(
  prs: readonly TaskPr[],
  heads: readonly (string | null | undefined)[],
): TaskPr | null {
  return livePr(prs, heads) ?? prs[0] ?? null;
}

/** The deprecated derived `prUrl`: the first record's URL. */
export function firstPrUrl(prs: readonly TaskPr[]): string | null {
  return prs[0]?.url ?? null;
}

/** Append a record, deduping by URL (returns the input when it's a duplicate). */
export function appendTaskPr(prs: readonly TaskPr[], entry: TaskPr): TaskPr[] {
  if (prs.some((p) => p.url === entry.url)) return prs as TaskPr[];
  return [...prs, entry];
}
