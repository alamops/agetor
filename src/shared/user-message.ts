// Parsing for user-turn text emitted into the task-details stream — slash
// commands, local-command output, and (below) arbitrary machine-emitted or
// prompt-authored tags.
//
// Background: when a task/follow-up is sent as a recognized slash command
// (e.g. "/implement do the thing"), claude CLI's JSONL transcribes the send
// as an XML expansion — `<command-message>…</command-message>
// <command-name>/implement</command-name> <command-args>do the
// thing</command-args>` — rather than the plain text the user actually typed.
// Rendered verbatim that's raw-tag noise in the "you" bubble. Separately,
// claude wraps local (non-slash) command output in `<local-command-stdout>`,
// and the orchestrator/CLI weave other machine-emitted markers inline with a
// user's own text (a background skill launch, a shell escape's input/stdout/
// stderr). This module turns all of those raw-tag shapes into structured
// data the UI and CLI/TUI can render as badges, labeled blocks, and plain
// lines, instead of literal `<*>` text.
//
// Lives in src/shared/ — the only directory the bun main process, the
// webview, and the CLI/TUI all import from — so it is kept free of React,
// DOM, and any runtime import from src/bun/, src/mainview/, or src/cli/.
// Regex-based, small pure functions, same convention as `prompt-noise.ts` /
// `diff-selection.ts`.
import { REFS_HEADING } from "./refs.ts";

export interface CommandInvocation {
  /** Command name including the leading slash, e.g. "/implement". */
  name: string;
  /** Argument text (may be ""), with any trailing references block removed. */
  args: string;
  /** Paths parsed from a trailing "Referenced files/folders:" block ("" if
   *  none — i.e. an empty array). Folders keep their trailing slash. */
  references: string[];
}

// ---------------------------------------------------------------------------
// General tag-segment model (used by the "tagged" ParsedUserMessage kind
// below, and by parseMessageSegments' consumers such as userMessageLines).

export interface TextSegment {
  kind: "text";
  /** Plain prose between (or around) tags. Verbatim — never trimmed. */
  text: string;
}

export interface TagSegment {
  kind: "tag";
  /** Lowercase tag name, e.g. "bash-input". */
  name: string;
  /** Raw attribute text, trimmed; "" when the tag has none. */
  attrs: string;
  /** Verbatim inner text between the open and close tags; "" for a
   *  self-closing tag. Never trimmed — callers trim per their own display
   *  rules (see `userMessageLines` below). */
  body: string;
  /** The full matched substring, open tag through close tag inclusive. */
  raw: string;
}

export type MessageSegment = TextSegment | TagSegment;

export type ParsedUserMessage =
  | { kind: "command"; command: CommandInvocation }
  | { kind: "command-output"; output: string }
  | { kind: "tagged"; text: string; segments: MessageSegment[]; references: string[] };

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
 * following line in that paragraph must be either a `- <path>` bullet or a
 * bare `-` (optionally followed by trailing whitespace) — this is exactly
 * the shape `formatReferences` (src/shared/refs.ts) produces via
 * `appendReferences`'s `"${text}\n\n${block}"` join, PLUS claude's own
 * rewrite of an image bullet's path (see `attachments.ts`'s header comment),
 * which blanks the path and leaves a bare `-` behind. A bare bullet is
 * accepted and dropped — it contributes no reference, since its path was
 * stripped by claude before we ever saw it — while a `- <path>` bullet keeps
 * its current behavior. Any other non-bullet line still bails the whole
 * split: don't split, return `text` unchanged with no references, rather
 * than guess.
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
    if (/^-\s*$/.test(line)) continue; // bare bullet (claude's rewrite) — dropped, no reference
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

/** ANSI SGR ("Select Graphic Rendition") escape sequences — e.g. claude's
 *  `\x1b[1m`/`\x1b[22m` bold toggle around the model name in `/model`'s
 *  stdout ("Set model to \x1b[1mOpus 5 (1M context)\x1b[22m for this session
 *  only"). tmux's pane capture forwards these raw; rendered verbatim they'd
 *  show as literal escape-code noise in the command-output bubble. */
const ANSI_SGR_RE = /\x1b\[[0-9;]*m/g;

/** Strip ANSI SGR escape codes from `s`. Exported so `userMessageLines`
 *  (below) can clean a `local-command-stdout` tag body the same way this
 *  module already cleans the lone-tag `command-output` shape. */
export function stripAnsiSgr(s: string): string {
  return s.replace(ANSI_SGR_RE, "");
}

/** (c) output of a local (non-slash) command, wrapped by claude CLI in
 *  `<local-command-stdout>`. Returns `null` (not `""`) when the shape doesn't
 *  match at all, so callers can distinguish "no match" from "matched, empty
 *  output". ANSI SGR codes are stripped before trimming — rendering-only,
 *  same as the trim itself; `canonicalizeUserText` (which feeds dedup keys)
 *  never routes through here and is unaffected. */
function tryParseLocalCommandStdout(text: string): string | null {
  if (LOCAL_STDOUT_SELF_CLOSING_RE.test(text)) return "";
  const m = LOCAL_STDOUT_RE.exec(text);
  return m ? stripAnsiSgr(m[1] ?? "").trim() : null;
}

// ---------------------------------------------------------------------------
// General tag-segment parsing
//
// Background: beyond the three fixed shapes above, some user turns carry
// OTHER machine-emitted markers inline with a user's own text — e.g.
// `<bash-input>ls -la</bash-input>` (a shell escape) or
// `<forked-skill-launch>{"skillName":"code-review",...}</forked-skill-launch>`
// (a background subagent kickoff) — and a prompt author's own text can
// legitimately contain XML-ish tags too (`<context>…</context>`). Rendered as
// raw text these are noise or, worse, ambiguous with prose. This parser
// recognizes ANY top-level `<name>…</name>` (or self-closing `<name/>`) run
// as a distinct segment so callers can render known names specially (see
// `MACHINE_TAGS` below) and fall back to a generic "labeled block" rendering
// for everything else. This is a general mechanism, not an allow-list.

/**
 * HTML element names excluded from tag-segment recognition so ordinary
 * HTML-ish prose (`<b>bold</b>`, a stray `<div>`) keeps rendering as literal
 * text, exactly as it does today (an unrecognized raw HTML node already
 * renders as text under markdown's default, non-`skipHtml` handling — see
 * plan §2). This is NOT a generic HTML denylist and NOT exhaustive of HTML5:
 * words that read as *prompt* tags — `summary`, `section`, `article`,
 * `header`, `footer`, `nav`, `main`, `aside`, `output`, `title`, `time`,
 * `data`, `menu`, `dialog`, `details`, `label`, `context`, `task`,
 * `example`, … — are deliberately NOT excluded here: a labeled block is the
 * intended rendering for those, even though several also happen to be valid
 * HTML element names.
 */
export const HTML_ELEMENT_NAMES: ReadonlySet<string> = new Set([
  "a", "abbr", "b", "bdi", "bdo", "big", "blockquote", "body", "br", "button",
  "canvas", "caption", "center", "cite", "code", "del", "dfn", "div", "em",
  "font", "form", "h1", "h2", "h3", "h4", "h5", "h6", "head", "hr", "html",
  "i", "iframe", "img", "input", "ins", "kbd", "li", "mark", "ol", "option",
  "p", "path", "picture", "pre", "q", "s", "samp", "script", "select",
  "small", "source", "span", "strike", "strong", "style", "sub", "sup", "svg",
  "table", "tbody", "td", "textarea", "tfoot", "th", "thead", "tr", "tt", "u",
  "ul", "var", "video", "audio", "wbr", "g",
]);

/**
 * Control-tag names already owned by `matchCommandXml` / the strict
 * command-XML parse above. Excluded from generic tag-segment recognition
 * (same mechanism as `HTML_ELEMENT_NAMES`) so a message that FAILS that
 * strict parse — a duplicate tag, leftover non-whitespace text, a missing
 * required tag, one of these substrings appearing mid-sentence — falls all
 * the way through `parseUserMessage` to `null` (an ordinary message that
 * merely contains one of these substrings), rather than being silently
 * reinterpreted as a generic tagged message one layer down. Without this
 * exclusion the two parses fight over the same three tag names and several
 * of `matchCommandXml`'s own strict-parse guard tests regress. Not needed
 * for `local-command-stdout`: a message consisting of ONLY that tag is
 * already fully handled by `tryParseLocalCommandStdout` before this code
 * ever runs, and a message combining it with other tags (e.g. the
 * forked-skill-launch fixture below) is exactly the new case this general
 * parser exists to handle.
 */
const RESERVED_COMMAND_XML_TAG_NAMES: ReadonlySet<string> = new Set([
  "command-message",
  "command-name",
  "command-args",
]);

// Matches one tag OPEN at the sticky cursor: `<name>`, `<name attrs>`,
// `<name/>`, or `<name attrs/>`. `name` must start lowercase. The char right
// after `name` is effectively constrained to whitespace, `/`, or `>`: for
// anything else (`:` in `<https://x>`, `@` in `<foo@bar.com>`) every
// backtracked length of the name group fails to reach a `>`, so the whole
// match fails and it's never treated as a tag. The non-greedy attrs group is
// what lets a trailing `/` right before `>` register as self-closing instead
// of being swallowed into attrs (it only extends past "attrs" once the
// shorter match fails to reach `/>` or `>`).
const TAG_OPEN_RE = /<([a-z][a-z0-9_-]*)(?:\s+([^<>]*?))?\s*(\/)?>/y;

interface TagOpenMatch {
  name: string;
  attrs: string;
  selfClosing: boolean;
  /** Index just past the matched `>`. */
  end: number;
}

function matchTagOpen(text: string, at: number): TagOpenMatch | null {
  TAG_OPEN_RE.lastIndex = at;
  const m = TAG_OPEN_RE.exec(text);
  if (!m) return null;
  const name = m[1];
  if (!name) return null; // unreachable — required by the regex
  return { name, attrs: (m[2] ?? "").trim(), selfClosing: m[3] === "/", end: at + m[0].length };
}

type ProtectedRange = readonly [start: number, end: number];

function inProtectedRange(ranges: readonly ProtectedRange[], idx: number): boolean {
  return ranges.some(([start, end]) => idx >= start && idx < end);
}

const FENCE_LINE_RE = /^ {0,3}(`{3,}|~{3,})/;

/** Backtick runs on one line that pair up by exact length, e.g. a single
 *  backtick span or a longer run used to escape an inner backtick. A run
 *  with no same-length partner later on the line is left unprotected (it
 *  wasn't really an inline code span). */
function inlineCodeRanges(line: string, lineStart: number): ProtectedRange[] {
  const runs: Array<{ start: number; end: number; len: number }> = [];
  const runRe = /`+/g;
  let m: RegExpExecArray | null;
  while ((m = runRe.exec(line))) {
    runs.push({ start: m.index, end: m.index + m[0].length, len: m[0].length });
  }

  const ranges: ProtectedRange[] = [];
  let i = 0;
  while (i < runs.length) {
    const open = runs[i];
    if (!open) break;
    const closeIdx = runs.findIndex((r, j) => j > i && r.len === open.len);
    if (closeIdx === -1) {
      i++;
      continue;
    }
    const close = runs[closeIdx];
    if (!close) break;
    ranges.push([lineStart + open.start, lineStart + close.end]);
    i = closeIdx + 1;
  }
  return ranges;
}

/**
 * Ranges of `text` where a `<` must never be read as a tag boundary and a
 * would-be closing tag must never be treated as a real close: fenced code
 * blocks (``` or ~~~, ≤3-space indent, closed by a same-or-longer matching
 * fence — an unterminated fence protects to the end of the text) and inline
 * code spans (a backtick run paired with a same-length run later on the same
 * line). These are the only two "this isn't really markup" carve-outs —
 * everything else on the top-level scan is fair game.
 */
function computeProtectedRanges(text: string): ProtectedRange[] {
  const ranges: ProtectedRange[] = [];
  const lines = text.split("\n");
  const lineStarts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }

  let fenceOpen = false;
  let fenceChar = "";
  let fenceLen = 0;
  let fenceStart = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const start = lineStarts[i] ?? 0;
    const m = FENCE_LINE_RE.exec(line);
    if (!fenceOpen) {
      if (m?.[1]) {
        fenceOpen = true;
        fenceChar = m[1][0] ?? "";
        fenceLen = m[1].length;
        fenceStart = start;
      } else {
        ranges.push(...inlineCodeRanges(line, start));
      }
    } else if (m?.[1] && m[1][0] === fenceChar && m[1].length >= fenceLen) {
      ranges.push([fenceStart, start + line.length]);
      fenceOpen = false;
      fenceChar = "";
    }
  }
  if (fenceOpen) ranges.push([fenceStart, text.length]);
  return ranges;
}

/**
 * Scan forward from `start` (just past the open tag's `>`) for the balancing
 * `</name>` (optionally `</name  >`), counting nested same-name opens
 * (`<name` followed by whitespace, `/`, or `>`) so a tag containing a nested
 * tag of the same name closes at the outer close, not the inner one. `<` and
 * would-be closes inside a protected range are skipped entirely. Returns
 * `null` (unbalanced) when no close is found before the end of `text`.
 */
function findBalancedClose(
  text: string,
  start: number,
  name: string,
  protectedRanges: readonly ProtectedRange[],
): { bodyEnd: number; end: number } | null {
  const openPrefix = `<${name}`;
  const closePrefix = `</${name}`;
  let depth = 0;
  let j = start;
  while (j < text.length) {
    if (text[j] !== "<" || inProtectedRange(protectedRanges, j)) {
      j++;
      continue;
    }
    if (text.startsWith(closePrefix, j)) {
      let k = j + closePrefix.length;
      while (/\s/.test(text[k] ?? "")) k++;
      if (text[k] === ">") {
        const end = k + 1;
        if (depth === 0) return { bodyEnd: j, end };
        depth--;
        j = end;
        continue;
      }
      j++;
      continue;
    }
    if (text.startsWith(openPrefix, j)) {
      const nextCh = text[j + openPrefix.length];
      if (nextCh !== undefined && /[\s>/]/.test(nextCh)) {
        depth++;
        j += openPrefix.length;
        continue;
      }
    }
    j++;
  }
  return null;
}

/**
 * Segment `text` into alternating prose and top-level tags. Newlines are
 * normalized to `\n` first (same reason as `parseUserMessage`). With no
 * recognized tags at all, returns exactly one text segment covering the
 * (CR-normalized) input — never an empty array — so callers can always
 * assume `segments.length >= 1`. Whitespace-only text between/around tags is
 * dropped once at least one tag is found (so the newline or space separating
 * two adjacent tags produces no segment); non-whitespace text is kept
 * verbatim, untrimmed.
 */
export function parseMessageSegments(text: string): MessageSegment[] {
  const normalized = text.replace(/\r\n?/g, "\n");
  const protectedRanges = computeProtectedRanges(normalized);

  type Part = { type: "text"; text: string } | { type: "tag"; seg: TagSegment };
  const parts: Part[] = [];
  let hasTag = false;
  let textStart = 0;
  let i = 0;

  const flush = (end: number) => {
    parts.push({ type: "text", text: normalized.slice(textStart, end) });
  };

  while (i < normalized.length) {
    if (normalized[i] !== "<" || inProtectedRange(protectedRanges, i)) {
      i++;
      continue;
    }
    const open = matchTagOpen(normalized, i);
    if (!open || HTML_ELEMENT_NAMES.has(open.name) || RESERVED_COMMAND_XML_TAG_NAMES.has(open.name)) {
      i++;
      continue;
    }
    if (open.selfClosing) {
      flush(i);
      parts.push({
        type: "tag",
        seg: { kind: "tag", name: open.name, attrs: open.attrs, body: "", raw: normalized.slice(i, open.end) },
      });
      hasTag = true;
      i = open.end;
      textStart = i;
      continue;
    }
    const close = findBalancedClose(normalized, open.end, open.name, protectedRanges);
    if (!close) {
      i++;
      continue;
    }
    flush(i);
    parts.push({
      type: "tag",
      seg: {
        kind: "tag",
        name: open.name,
        attrs: open.attrs,
        body: normalized.slice(open.end, close.bodyEnd),
        raw: normalized.slice(i, close.end),
      },
    });
    hasTag = true;
    i = close.end;
    textStart = i;
  }
  flush(normalized.length);

  if (!hasTag) return [{ kind: "text", text: normalized }];

  const segments: MessageSegment[] = [];
  for (const part of parts) {
    if (part.type === "tag") {
      segments.push(part.seg);
    } else if (part.text.trim() !== "") {
      segments.push({ kind: "text", text: part.text });
    }
  }
  return segments;
}

/** True when `segments` contains at least one recognized tag, as opposed to
 *  being ordinary prose that merely segmented into a single text run. */
export function hasTagSegments(segments: readonly MessageSegment[]): boolean {
  return segments.some((seg) => seg.kind === "tag");
}

// ---------------------------------------------------------------------------
// Known-tag helpers

/** Tag names emitted by agetor/claude machinery rather than authored by the
 *  user. Drives history-picker dropping, the "you" header label (shown only
 *  when authored content exists), and plain-text tone selection below. */
export const MACHINE_TAGS: ReadonlySet<string> = new Set([
  "local-command-stdout",
  "forked-skill-launch",
  "bash-input",
  "bash-stdout",
  "bash-stderr",
]);

/** True iff `segments` is non-empty and every segment is a tag whose name is
 *  in `MACHINE_TAGS` — i.e. the message carries no user-authored text at all. */
export function isMachineEmittedMessage(segments: readonly MessageSegment[]): boolean {
  return segments.length > 0 && segments.every((seg) => seg.kind === "tag" && MACHINE_TAGS.has(seg.name));
}

export interface ForkedSkillLaunch {
  agentId: string;
  skillName: string;
  description: string;
}

/** Parse a `<forked-skill-launch>` tag body (JSON: `{agentId, skillName,
 *  description}`). Requires an object with a string `skillName`; `agentId`
 *  and `description` default to `""` when missing or non-string. `null` on
 *  any failure (not JSON, not an object, missing/non-string `skillName`). */
export function parseForkedSkillLaunch(body: string): ForkedSkillLaunch | null {
  const trimmed = body.trim();
  if (!trimmed) return null;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.skillName !== "string") return null;
  const agentId = typeof obj.agentId === "string" ? obj.agentId : "";
  const description = typeof obj.description === "string" ? obj.description : "";
  return { agentId, skillName: obj.skillName, description };
}

/** Preferred display label for a forked-skill launch: the description when
 *  it already looks like a slash invocation ("/code-review …"), else a bare
 *  "/<skillName>". */
export function forkedSkillLabel(launch: ForkedSkillLaunch): string {
  return launch.description.startsWith("/") ? launch.description : `/${launch.skillName}`;
}

/** "forked-skill-launch" → "forked skill launch" — hyphens/underscores to
 *  spaces, for a generic tag's display label. */
export function humanizeTagName(name: string): string {
  return name.replace(/[-_]+/g, " ");
}

/** Parse `body` as JSON only when it's a plain object or array — the shapes
 *  worth pretty-printing in a generic tag block. Returns `undefined` (not
 *  `null`) for anything else (not JSON, or JSON that's a string/number/
 *  boolean/null), so callers can `?? fallback` without a null check. */
export function tryParseJsonBody(body: string): unknown {
  const trimmed = body.trim();
  if (!trimmed) return undefined;
  try {
    const value: unknown = JSON.parse(trimmed);
    if (value !== null && typeof value === "object") return value;
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Recognize a user message as a slash-command invocation, local-command
 * output, or a tagged message carrying other recognized/generic tags, trying
 * each shape in turn. Returns `null` for ordinary prose, which callers must
 * render completely unchanged from today's behavior.
 *
 * Newlines are normalized to `\n` up front: the JSONL twin of a send can carry
 * bare `\r` newlines (tmux's paste-buffer artifact — see event-dedup.ts), and
 * `splitReferences`' blank-line paragraph split needs real `\n`s to find a
 * trailing refs block. Rendering-only — `canonicalizeUserText` stays a strict
 * byte identity on non-command input and must not normalize.
 */
export function parseUserMessage(text: string): ParsedUserMessage | null {
  text = text.replace(/\r\n?/g, "\n");
  const xml = tryParseCommandXml(text);
  if (xml) return { kind: "command", command: xml };

  const echo = tryParsePlainEcho(text);
  if (echo) return { kind: "command", command: echo };

  const stdout = tryParseLocalCommandStdout(text);
  if (stdout !== null) return { kind: "command-output", output: stdout };

  const { args, references } = splitReferences(text);
  const segments = parseMessageSegments(args);
  if (hasTagSegments(segments)) return { kind: "tagged", text: args, segments, references };

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

// ---------------------------------------------------------------------------
// Plain-text rendering (CLI / TUI)
//
// The webview renders `ParsedUserMessage` as markdown/JSX (a later task);
// the CLI and TUI have no such renderer and just print labeled lines. This
// is that shared plain-text form, so both surfaces stay in sync with the
// parser above instead of hand-rolling their own tag handling.

export interface PlainLine {
  /** Short prefix like "you›" / "cmd›" / "skill›", printed before `text`. */
  label: string;
  text: string;
  tone: "user" | "machine" | "error" | "tag";
}

/**
 * Render a raw user-turn string as one or more labeled plain-text lines.
 * Ordinary prose (parseUserMessage → null) yields exactly one `you›` line
 * with `text` untouched — byte-identical to today's CLI/TUI output. A
 * `tagged` message yields one line per segment (text runs become `you›`
 * lines; known machine tags get a dedicated label; any other tag gets a
 * generic `<name>›` label with its body, nested tags left raw); a non-empty
 * `references` list appends a trailing `refs›` line. If every segment
 * produces no visible line (e.g. a message that's only an empty
 * `<bash-stdout>`), falls back to a single `cmd› —` line so callers never
 * have to handle an empty result.
 */
export function userMessageLines(text: string): PlainLine[] {
  const parsed = parseUserMessage(text);
  if (parsed === null) return [{ label: "you›", text, tone: "user" }];
  if (parsed.kind === "command") {
    return [{ label: "you›", text: canonicalizeUserText(text), tone: "user" }];
  }
  if (parsed.kind === "command-output") {
    return [{ label: "cmd›", text: parsed.output || "—", tone: "machine" }];
  }

  const lines: PlainLine[] = [];
  for (const seg of parsed.segments) {
    if (seg.kind === "text") {
      lines.push({ label: "you›", text: seg.text.trim(), tone: "user" });
      continue;
    }
    if (seg.name === "local-command-stdout") {
      const cleaned = stripAnsiSgr(seg.body).trim();
      lines.push({ label: "cmd›", text: cleaned || "—", tone: "machine" });
      continue;
    }
    if (seg.name === "forked-skill-launch") {
      const launch = parseForkedSkillLaunch(seg.body);
      if (launch) {
        const agentSuffix = launch.agentId ? ` (agent ${launch.agentId.slice(0, 8)})` : "";
        lines.push({
          label: "skill›",
          text: `${forkedSkillLabel(launch)} launched in background${agentSuffix}`,
          tone: "machine",
        });
        continue;
      }
      // Failed to parse the launch JSON — fall through to the generic tag
      // rendering below rather than a bespoke error line.
    }
    if (seg.name === "bash-input") {
      lines.push({ label: "sh›", text: `$ ${seg.body.trim()}`, tone: "machine" });
      continue;
    }
    if (seg.name === "bash-stdout") {
      const t = seg.body.trim();
      if (t) lines.push({ label: "out›", text: t, tone: "machine" });
      continue;
    }
    if (seg.name === "bash-stderr") {
      const t = seg.body.trim();
      if (t) lines.push({ label: "err›", text: t, tone: "error" });
      continue;
    }
    lines.push({ label: `${seg.name}›`, text: seg.body.trim(), tone: "tag" });
  }
  if (parsed.references.length > 0) {
    lines.push({ label: "refs›", text: parsed.references.join(", "), tone: "user" });
  }
  if (lines.length === 0) return [{ label: "cmd›", text: "—", tone: "machine" }];
  return lines;
}
