// Pure text-cleaning for `MessageHistoryPicker` — extracted out of that
// component (rather than left module-private there) so it can be unit-tested
// without a DOM/React runtime; this repo has no jsdom/testing-library, and
// `MessageHistoryPicker.tsx` imports React + `lucide-react` + `@/lib/api` at
// module scope, none of which import cleanly for a plain `bun test` run.
import { isMachineEmittedMessage, normalizeDeliveredUserText, parseUserMessage, splitReferences } from "../../shared/user-message.ts";
import { canonicalizeAttachmentText } from "../../shared/attachments.ts";
import { stripAgentInstructionsPreamble } from "../../shared/agent-profile.ts";

/**
 * Reduce a raw sent-message payload to display text: normalize CR newlines,
 * canonicalize the image-attachment twin shapes (shared with `eventDedupKey`
 * in `lib/event-dedup.ts`), then undo agetor/claude-code-specific delivery
 * wrapping via `normalizeDeliveredUserText` (shared/user-message.ts) —
 * agetor's own typed lead-in line ahead of a bracketed-paste follow-up, and
 * claude CLI's `<pasted_content id="…">…</pasted_content id="…">` wrapper
 * around it (see docs/plans/pasted-content-tags.md D2) — BEFORE stripping a
 * launched-from-profile preamble: a first prompt over the argv budget is
 * itself delivered by paste (`claude-tmux.ts`'s deferred-paste path), so its
 * JSONL twin can be the lead-in + wrapper AROUND the whole
 * `<agent_instructions_defined_by_the_user>…</agent_instructions_defined_by_the_user>`
 * block, not just around the user's own prompt text —
 * `stripAgentInstructionsPreamble` only recognizes the preamble at the very
 * start of the string, so it has to see the unwrapped text to find it at all.
 * Once both are undone, the preamble is stripped (resending this message
 * must not re-inject it a second time — `startTask` adds its own fresh
 * copy), then unwrap a slash-command XML expansion back to its plain "/cmd
 * args" echo (same shape `parseUserMessage`/`canonicalizeUserText` use
 * elsewhere for the run stream, both from `src/shared/user-message.ts`),
 * then strip a trailing "Referenced files" block via the shared splitter so
 * its heading text never gets re-typed here. A `tagged` message whose
 * segments are ALL machine-emitted (a `<local-command-stdout>` +
 * `<forked-skill-launch>` pair after a background skill launch, a `!`
 * shell-escape's `<bash-*>` lines) is not user-authored either and is
 * dropped the same way; a message that mixes in (or is entirely)
 * user-authored prose or tags — e.g. `<context>…</context>` pasted ahead of
 * typed text — is kept VERBATIM, tags included, so re-inserting it from
 * history reproduces the original prompt byte-for-byte rather than losing
 * the tags the user relied on.
 *
 * Normalizing before parsing/stripping also means a pasted send's live echo
 * (never wrapped — the wrapper is a JSONL-transcription artifact) and its
 * JSONL twin (lead-in + wrapped, or lead-in only when claude's wrapping gate
 * is off) both reduce to the exact same string here, so the caller's
 * dedup-by-cleaned-text loop collapses them into one history entry instead
 * of two.
 */
export function cleanMessageText(raw: string): string {
  const withoutAttachmentDiffs = canonicalizeAttachmentText(raw.replace(/\r\n?/g, "\n"));
  const text = stripAgentInstructionsPreamble(normalizeDeliveredUserText(withoutAttachmentDiffs));
  const parsed = parseUserMessage(text);
  let display: string;
  if (parsed?.kind === "command") {
    display = parsed.command.args
      ? `${parsed.command.name} ${parsed.command.args}`
      : parsed.command.name;
    return display.trim();
  }
  if (parsed?.kind === "command-output") {
    // Local-command stdout is not a user-authored message — drop it (the
    // caller's `if (!text) continue` filter relies on the empty string).
    return "";
  }
  if (parsed?.kind === "tagged") {
    return isMachineEmittedMessage(parsed.segments) ? "" : parsed.text.trim();
  }
  const { args } = splitReferences(text);
  return args.trim();
}
