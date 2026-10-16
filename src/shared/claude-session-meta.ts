/**
 * Pure helpers for importing Claude Code sessions started outside Agetor.
 * No runtime imports from either process — the scanner and the commit path
 * both call these so the permission-mode map and the long-path predicate
 * cannot drift. See docs/plans/import-claude-code-sessions.md §3.
 */

/** Copy shown when a cwd's encoded project directory cannot be reproduced. */
export const LONG_PATH_IMPORT_ERROR = "Folder path is too long to import yet";

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
  /** Last assistant `message.model`, raw. Null when absent. */
  model: string | null;
  /** Last `permissionMode` string. Null when the transcript has none. */
  permissionMode: string | null;
  /** Count of `type:"user"` plus `type:"assistant"` lines. */
  messageCount: number;
  /** True when at least one `type:"user"` line exists. */
  hasUser: boolean;
  /** Timestamp of the last non-empty line, ms epoch. Null when that line
   *  has no parseable timestamp (the caller falls back to file mtime). */
  lastTimestamp: number | null;
  /** Successor session id when a continuation key is present. */
  continuedIn: string | null;
  /** Last non-empty `cwd` on the transcript. */
  cwd: string | null;
}

const TITLE_MAX = 200;
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

function capTitle(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= TITLE_MAX ? trimmed : trimmed.slice(0, TITLE_MAX);
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
  if (cwd) acc.cwd = cwd;

  for (const key of ["continuedIn", "continued-in", "continuedSessionId"] as const) {
    const next = nonEmptyString(line[key]);
    if (next) acc.continuedIn = next;
  }

  const type = typeof line.type === "string" ? line.type : "";
  if (type === "user" || type === "assistant") acc.messageCount += 1;
  if (type === "user") acc.hasUser = true;

  if (type === "assistant") {
    const message = asRecord(line.message);
    const model = nonEmptyString(message?.model);
    if (model) acc.model = model;
  }

  if (type === "user" && line.isMeta !== true && acc.firstHumanPrompt === null) {
    const message = asRecord(line.message);
    const text = humanText(message?.content ?? line.content);
    if (text) acc.firstHumanPrompt = text;
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

/** Parse a transcript. Missing fields are null. Never throws. */
export function readClaudeSessionMeta(jsonlText: string): ClaudeSessionMeta {
  const acc = emptyAcc();
  for (const line of jsonlText.split("\n")) noteLine(acc, line);
  return finish(acc);
}

/** Streaming twin of {@link readClaudeSessionMeta}. One instance per file. */
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
