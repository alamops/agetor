/**
 * Pure helpers for importing Claude Code sessions started outside Agetor.
 * No runtime imports from either process — the scanner and the commit path
 * both call these so the permission-mode map and the long-path predicate
 * cannot drift. See docs/plans/import-claude-code-sessions.md §3.
 */
import { isMachineEmittedMessage, normalizeDeliveredUserText, parseUserMessage } from "./user-message.ts";

/** Copy shown when a cwd's encoded project directory cannot be reproduced. */
export const LONG_PATH_IMPORT_ERROR = "Folder path is too long to import yet";

/** Copy shown when the session's folder is gone. An in-place task there
 *  would fail at `tmux new-session -c <cwd>` on the first message. */
export const MISSING_FOLDER_IMPORT_ERROR = "Session folder no longer exists";

/** Claude's own project-dir substitution: every non-alphanumeric becomes `-`. */
export function plainEncodedProjectPath(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * True when Claude would hash this cwd and `encode` does not reproduce the
 * directory that holds the JSONL. A cwd whose plain encoding is 200
 * characters or fewer is never unresolved, even if the directory name
 * disagrees.
 */
export function claudeProjectDirUnresolved(
  cwd: string,
  dirName: string,
  encode: (cwd: string) => string,
): boolean {
  if (plainEncodedProjectPath(cwd).length <= 200) return false;
  return encode(cwd) !== dirName;
}

/** Claude permission-mode string → Agetor mode. `default`, missing, and any
 *  unrecognized string are `ask` (G1). Never null. */
export function agetorModeForClaudePermission(
  mode: string | null,
): "auto" | "bypass" | "acceptEdits" | "plan" | "ask" {
  switch (mode) {
    case "auto": return "auto";
    case "bypassPermissions": return "bypass";
    case "acceptEdits": return "acceptEdits";
    case "plan": return "plan";
    default: return "ask";
  }
}

export interface ClaudeSessionMeta {
  /** Last `aiTitle`, else the first human prompt, trimmed and capped at 200
   *  characters. Null when neither is present. */
  title: string | null;
  firstHumanPrompt: string | null;
  gitBranch: string | null;
  /** Last assistant `message.model`, raw. Null when absent. Claude's
   *  `<synthetic>` placeholder (API errors, interrupts) is skipped. */
  model: string | null;
  /** Last `permissionMode` string. Null when the transcript has none. */
  permissionMode: string | null;
  /** Human prompts plus assistant lines that carry text. Tool results,
   *  meta lines, command output, and tool-only assistant lines are not
   *  messages. */
  messageCount: number;
  /** True when at least one `type:"user"` line exists. */
  hasUser: boolean;
  /** Timestamp of the last non-empty line, ms epoch. Null when that line
   *  has no parseable timestamp (the caller falls back to file mtime). */
  lastTimestamp: number | null;
  /** Successor session id when a continuation key is present. */
  continuedIn: string | null;
  /** First non-empty `cwd` — the directory the session launched in. A later
   *  directory change does not replace it. */
  cwd: string | null;
}

const TITLE_MAX = 200;
/** The scanner keeps every visible session's meta in memory. The import
 *  path caps the stored prompt at 100 KB of UTF-8 later, so 100 K
 *  characters never cuts what it keeps. */
const FIRST_PROMPT_MAX = 100 * 1024;
/** Claude Code's model id on lines it writes itself. Not a real model. */
const SYNTHETIC_MODEL = "<synthetic>";
const INTERRUPT_RE =
  /doesn't want to proceed with this tool use|Request interrupted by user|tool use was rejected/i;

interface MetaAcc {
  aiTitle: string | null;
  firstHumanPrompt: string | null;
  gitBranch: string | null;
  model: string | null;
  permissionMode: string | null;
  messageCount: number;
  hasUser: boolean;
  lastTimestamp: number | null;
  continuedIn: string | null;
  cwd: string | null;
}

function emptyAcc(): MetaAcc {
  return {
    aiTitle: null,
    firstHumanPrompt: null,
    gitBranch: null,
    model: null,
    permissionMode: null,
    messageCount: 0,
    hasUser: false,
    lastTimestamp: null,
    continuedIn: null,
    cwd: null,
  };
}

/** Cut to `max` UTF-16 units without leaving half a surrogate pair. */
function capChars(text: string, max: number): string {
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

function capTitle(text: string): string {
  const trimmed = text.trim();
  return capChars(trimmed, TITLE_MAX);
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

function nonEmptyString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

function parseTimestamp(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) {
    return v < 1e12 ? Math.round(v * 1000) : Math.round(v);
  }
  if (typeof v !== "string" || !v.trim()) return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : ms;
}

/** Text a person typed, as a prompt: a slash command reads `/name args`,
 *  command output and other machine-written tags are not prompts. */
function humanPrompt(content: unknown): string | null {
  const text = humanText(content);
  if (text === null) return null;
  const parsed = parseUserMessage(text);
  if (!parsed) {
    const plain = normalizeDeliveredUserText(text.replace(/\r\n?/g, "\n")).trim();
    return plain || null;
  }
  if (parsed.kind === "command") {
    return `${parsed.command.name} ${parsed.command.args}`.trim() || null;
  }
  if (parsed.kind === "command-output") return null;
  if (isMachineEmittedMessage(parsed.segments)) return null;
  return text;
}

function hasAssistantText(content: unknown): boolean {
  if (typeof content === "string") return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  return content.some((block) => {
    const rec = asRecord(block);
    return rec?.type === "text" && nonEmptyString(rec.text) !== null;
  });
}

function humanText(content: unknown): string | null {
  if (typeof content === "string") {
    const t = content.trim();
    if (!t || INTERRUPT_RE.test(t)) return null;
    return t;
  }
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    const rec = asRecord(block);
    if (!rec || rec.type !== "text") continue;
    const t = nonEmptyString(rec.text);
    if (t && !INTERRUPT_RE.test(t)) parts.push(t);
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

function noteLine(acc: MetaAcc, raw: string): void {
  const trimmed = raw.trim();
  if (!trimmed) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return;
  }
  const line = asRecord(parsed);
  if (!line) return;

  const aiTitle = nonEmptyString(line.aiTitle);
  if (aiTitle) acc.aiTitle = aiTitle;

  const permission = nonEmptyString(line.permissionMode);
  if (permission) acc.permissionMode = permission;

  if ("gitBranch" in line) {
    acc.gitBranch = nonEmptyString(line.gitBranch);
  }

  const cwd = nonEmptyString(line.cwd);
  if (cwd && acc.cwd === null) acc.cwd = cwd;

  for (const key of ["continuedIn", "continued-in", "continuedSessionId"] as const) {
    const next = nonEmptyString(line[key]);
    if (next) acc.continuedIn = next;
  }

  const type = typeof line.type === "string" ? line.type : "";
  if (type === "user") acc.hasUser = true;

  if (type === "assistant") {
    const message = asRecord(line.message);
    const model = nonEmptyString(message?.model);
    if (model && model !== SYNTHETIC_MODEL) acc.model = model;
    if (hasAssistantText(message?.content ?? line.content)) acc.messageCount += 1;
  }

  // Compaction summaries are Claude's own text on a `user` line.
  const machineUser = line.isMeta === true
    || line.isCompactSummary === true
    || line.isVisibleInTranscriptOnly === true;
  if (type === "user" && !machineUser) {
    const message = asRecord(line.message);
    const prompt = humanPrompt(message?.content ?? line.content);
    if (prompt) {
      acc.messageCount += 1;
      if (acc.firstHumanPrompt === null) acc.firstHumanPrompt = capChars(prompt, FIRST_PROMPT_MAX);
    }
  }

  const ts = parseTimestamp(line.timestamp);
  acc.lastTimestamp = ts;
}

function finish(acc: MetaAcc): ClaudeSessionMeta {
  const titleSource = acc.aiTitle ?? acc.firstHumanPrompt;
  return {
    title: titleSource ? capTitle(titleSource) : null,
    firstHumanPrompt: acc.firstHumanPrompt,
    gitBranch: acc.gitBranch,
    model: acc.model,
    permissionMode: acc.permissionMode,
    messageCount: acc.messageCount,
    hasUser: acc.hasUser,
    lastTimestamp: acc.lastTimestamp,
    continuedIn: acc.continuedIn,
    cwd: acc.cwd,
  };
}

/** Parse a transcript one line at a time. Missing fields are null. Never
 *  throws. One instance per file. */
export function createClaudeSessionMetaReader(): {
  push(line: string): void;
  finish(): ClaudeSessionMeta;
} {
  const acc = emptyAcc();
  return {
    push(line: string) {
      noteLine(acc, line);
    },
    finish() {
      return finish(acc);
    },
  };
}
