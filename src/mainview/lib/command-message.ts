// Parsing for slash-command user messages in the task-details stream.
//
// Background: when a task/follow-up is sent as a recognized slash command
// (e.g. "/implement do the thing"), claude CLI's JSONL transcribes the send
// as an XML expansion — `<command-message>…</command-message>
// <command-name>/implement</command-name> <command-args>do the
// thing</command-args>` — rather than the plain text the user actually typed.
// Rendered verbatim that's raw-tag noise in the "you" bubble. This module
// turns that shape (and the two other raw-tag shapes claude emits for local
// commands) into structured data the UI can render as a badge + markdown body
// + reference chips, instead of literal `<command-*>` text.
//
// Kept free of React imports so it's plain, unit-testable logic — same
// convention as `prompt-noise.ts` / `diff-selection.ts`.
import { REFS_HEADING } from "../../shared/refs.ts";

export interface CommandInvocation {
  /** Command name including the leading slash, e.g. "/implement". */
  name: string;
  /** Argument text (may be ""), with any trailing references block removed. */
  args: string;
  /** Paths parsed from a trailing "Referenced files/folders:" block ("" if
   *  none — i.e. an empty array). Folders keep their trailing slash. */
  references: string[];
}

export type ParsedUserMessage =
  | { kind: "command"; command: CommandInvocation }
  | { kind: "command-output"; output: string };

/** Result of locating the three recognized XML tags, before the
 *  references-block split is applied to the args content. Kept separate from
 *  `CommandInvocation` because `canonicalizeUserText` needs the *unsplit*
 *  args (references block still inline) to reproduce the original send. */
interface RawCommandXml {
  name: string;
  argsRaw: string;
}

/**
 * Locate `<command-message>` (optional), `<command-name>` (required),
 * `<command-args>` (optional) anywhere in `text`, in any order, tolerating
 * `\r`/`\r\n` newlines (plain `\s` already matches those). Strict on purpose:
 * a duplicate of any tag, or any non-whitespace content left over once all
 * recognized tags are stripped, means this isn't really the expansion shape
 * and we bail to `null` rather than risk mis-rendering an ordinary message
 * that merely contains a `<command-name>`-shaped substring.
 */
function matchCommandXml(text: string): RawCommandXml | null {
  const messageMatches = [...text.matchAll(/<command-message>[\s\S]*?<\/command-message>/g)];
  const nameMatches = [...text.matchAll(/<command-name>([\s\S]*?)<\/command-name>/g)];
  const argsMatches = [...text.matchAll(/<command-args>([\s\S]*?)<\/command-args>/g)];

  if (nameMatches.length !== 1) return null; // required, exactly once
  if (messageMatches.length > 1) return null;
  if (argsMatches.length > 1) return null;

  const nameMatch = nameMatches[0];
  if (!nameMatch) return null; // unreachable given the length check above; narrows for TS

  let remainder = text;
  for (const m of messageMatches) remainder = remainder.replace(m[0], "");
  remainder = remainder.replace(nameMatch[0], "");
  for (const m of argsMatches) remainder = remainder.replace(m[0], "");
  if (remainder.trim() !== "") return null;

  const rawName = (nameMatch[1] ?? "").trim();
  if (!rawName) return null;
  const name = `/${rawName.replace(/^\/+/, "")}`; // normalize to exactly one leading slash
  const argsMatch = argsMatches[0];
  const argsRaw = argsMatch ? (argsMatch[1] ?? "").trim() : "";
  return { name, argsRaw };
}

/**
 * Split a trailing "Referenced files/folders:" block off the end of a
 * command's argument text. The block is the LAST blank-line-separated
 * paragraph, its first line must be the exact `REFS_HEADING`, and every
 * following line in that paragraph must be a `- <path>` bullet — this is
 * exactly the shape `formatReferences` (src/shared/refs.ts) produces via
 * `appendReferences`'s `"${text}\n\n${block}"` join. Any deviation (heading
 * not alone on its line, a non-bullet line mixed in, no heading at all) means
 * don't split: return `text` unchanged with no references, rather than
 * guess.
 */
export function splitReferences(text: string): { args: string; references: string[] } {
  const paragraphs = text.split(/\n\s*\n/);
  const last = paragraphs[paragraphs.length - 1];
  if (last === undefined) return { args: text, references: [] }; // unreachable — split() always yields >= 1 element

  const lines = last.split(/\r\n|\r|\n/);

  if (lines[0]?.trim() !== REFS_HEADING) {
    return { args: text, references: [] };
  }
  const bulletLines = lines.slice(1);
  if (bulletLines.length === 0) {
    return { args: text, references: [] };
  }

  const references: string[] = [];
  for (const line of bulletLines) {
    const m = /^- (.+)$/.exec(line);
    if (!m) return { args: text, references: [] };
    references.push(m[1] ?? "");
  }

  const args = paragraphs.slice(0, -1).join("\n\n").trimEnd();
  return { args, references };
}

/** (a) claude CLI's JSONL expansion of a recognized slash command. */
function tryParseCommandXml(text: string): CommandInvocation | null {
  const raw = matchCommandXml(text);
  if (!raw) return null;
  const { args, references } = splitReferences(raw.argsRaw);
  return { name: raw.name, args, references };
}

// Lowercase-only command name so an absolute path ("/Users/...") can never
// match (uppercase first segment fails the char class), and the lookahead
// boundary means "/tmp/foo" fails too (next char after "tmp" is "/", neither
// whitespace nor end of string). Colons are allowed for plugin/skill names
// like "vercel:deploy".
const PLAIN_ECHO_NAME_RE = /^\/[a-z0-9][a-z0-9_:-]*(?=\s|$)/;

/** (b) the raw text the user typed, echoed live by the orchestrator before
 *  claude ever transcribes it — no XML wrapping at all. */
function tryParsePlainEcho(text: string): CommandInvocation | null {
  const m = PLAIN_ECHO_NAME_RE.exec(text);
  if (!m) return null;
  const name = m[0];
  const argsRaw = text.slice(name.length).trim();
  const { args, references } = splitReferences(argsRaw);
  return { name, args, references };
}

const LOCAL_STDOUT_SELF_CLOSING_RE = /^\s*<local-command-stdout\s*\/>\s*$/;
const LOCAL_STDOUT_RE = /^\s*<local-command-stdout>([\s\S]*?)<\/local-command-stdout>\s*$/;

/** (c) output of a local (non-slash) command, wrapped by claude CLI in
 *  `<local-command-stdout>`. Returns `null` (not `""`) when the shape doesn't
 *  match at all, so callers can distinguish "no match" from "matched, empty
 *  output". */
function tryParseLocalCommandStdout(text: string): string | null {
  if (LOCAL_STDOUT_SELF_CLOSING_RE.test(text)) return "";
  const m = LOCAL_STDOUT_RE.exec(text);
  return m ? (m[1] ?? "").trim() : null;
}

/**
 * Recognize a user message as a slash-command invocation or local-command
 * output, trying each shape in turn. Returns `null` for an ordinary message,
 * which callers must render completely unchanged from today's behavior.
 */
export function parseUserMessage(text: string): ParsedUserMessage | null {
  const xml = tryParseCommandXml(text);
  if (xml) return { kind: "command", command: xml };

  const echo = tryParsePlainEcho(text);
  if (echo) return { kind: "command", command: echo };

  const stdout = tryParseLocalCommandStdout(text);
  if (stdout !== null) return { kind: "command-output", output: stdout };

  return null;
}

/**
 * Reduce a user message to the text form that would appear as the LIVE echo
 * of the same send. A slash-command send produces a live echo
 * ("/implement args…") the instant it's submitted, and later a JSONL twin —
 * claude CLI's `<command-name>`/`<command-args>` XML expansion of that same
 * send — whose text differs byte-for-byte from the echo. Canonicalizing the
 * XML shape back to the echo shape here lets `eventDedupKey`'s existing
 * echo-vs-twin key collapse the two into one bubble. For every other input
 * (including messages that merely resemble the XML shape but fail the strict
 * parse) this is the identity function — no trimming, no normalization — so
 * it must not shift the dedup key of ordinary messages.
 */
export function canonicalizeUserText(text: string): string {
  const raw = matchCommandXml(text);
  if (!raw) return text;
  return raw.argsRaw ? `${raw.name} ${raw.argsRaw}` : raw.name;
}
