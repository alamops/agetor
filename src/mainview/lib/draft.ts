import type { TaskDraft, TaskReference } from "../../shared/types.ts";

/**
 * Normalize composer state (text + attached references) into a `TaskDraft`,
 * or `null` when there's nothing worth persisting — empty text (after
 * trimming, for the emptiness check only) and no references. When non-null,
 * `text` is preserved VERBATIM (not trimmed) so leading/trailing whitespace
 * the user typed survives a round trip through the server.
 */
export function normalizeDraft(text: string, references: TaskReference[]): TaskDraft | null {
  if (text.trim() === "" && references.length === 0) return null;
  return { text, references };
}

/**
 * Order-sensitive structural equality for two drafts (or nulls). Two
 * references match when both `path` and `isDirectory` are equal; the
 * reference arrays must be the same length and in the same order.
 */
export function draftsEqual(a: TaskDraft | null, b: TaskDraft | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.text !== b.text) return false;
  if (a.references.length !== b.references.length) return false;
  return a.references.every((ref, i) => {
    const other = b.references[i];
    return other !== undefined && ref.path === other.path && ref.isDirectory === other.isDirectory;
  });
}
