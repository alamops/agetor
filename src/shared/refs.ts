// Shared by both processes — must stay free of runtime imports from either
// side. The orchestrator inlines refs into the launch prompt; the run panel
// inlines them into per-message follow-ups. Both go through these helpers so
// the heading + bullet shape can never drift between create-time and
// per-message paths.
import type { TaskReference } from "./types.ts";

/** Heading used for both task-create and per-message references blocks. */
export const REFS_HEADING = "Referenced files/folders:";

/** Render references as a markdown-ish bullet list. Empty input → empty
 *  string so callers can concatenate unconditionally. Folders carry a
 *  trailing slash so the agent (and a human reading the transcript) can
 *  tell them apart at a glance. */
export function formatReferences(refs: TaskReference[]): string {
  if (!refs.length) return "";
  const lines = refs.map((r) => `- ${r.path}${r.isDirectory ? "/" : ""}`);
  return `${REFS_HEADING}\n${lines.join("\n")}`;
}

/** Build the outgoing prompt/message body. When the user supplied no text
 *  (refs-only send), we drop the leading blank lines so the body starts
 *  with the heading rather than with two stray newlines. */
export function appendReferences(text: string, refs: TaskReference[]): string {
  const block = formatReferences(refs);
  if (!block) return text;
  if (!text) return block;
  return `${text}\n\n${block}`;
}
