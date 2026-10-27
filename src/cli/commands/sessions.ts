import { confirm as clackConfirm, isCancel } from "@clack/prompts";
import { getClient, type Flags } from "../context.ts";
import { c, isTTY, out, printJson } from "../output.ts";
import { flagValue } from "../args.ts";
import { usageError } from "../usage.ts";
import { LONG_PATH_IMPORT_ERROR, MISSING_FOLDER_IMPORT_ERROR } from "../../shared/claude-session-meta.ts";
import { OPENCODE_SESSION_ID_RE } from "../../shared/opencode.ts";
import { escapeControlChars, escapeFreeText } from "../../shared/terminal-text.ts";
import { CLAUDE_SESSIONS_LIVENESS_STALE_MS, type OpencodeSessionListItem } from "../../shared/types.ts";
import type { AgetorClient, ClaudeSessionSummary } from "../api-client.ts";

/** Which importable session kinds a command covers (`--kind`). */
export type SessionKind = "claude" | "opencode";
const SESSION_KINDS: readonly SessionKind[] = ["claude", "opencode"];

/** One listed row, tagged with its kind — what `sessions ls` prints and what
 *  `--json` carries (the Claude row shape is unchanged apart from `kind`). */
export type ListedSession =
  | (ClaudeSessionSummary & { kind: "claude" })
  | (OpencodeSessionListItem & { kind: "opencode" });

/** Same copy as the core's OpenCode busy refusal
 *  (`OPENCODE_BUSY_IMPORT_ERROR` in `src/bun/opencode-session-import.ts`),
 *  which the CLI can't import without pulling in the server stack. */
export const OPENCODE_BUSY_REASON =
  "OpenCode is still working on this session — wait for it to finish, then import";

/** The sentence a blocked row prints, or null for an importable one. */
export function reasonFor(session: ListedSession): string | null {
  if (session.importable) return null;
  if (session.blockedReason === "missing-folder") return MISSING_FOLDER_IMPORT_ERROR;
  if (session.kind === "opencode") {
    if (session.blockedReason === "busy") return OPENCODE_BUSY_REASON;
    return "session not importable";
  }
  if (session.blockedReason === "long-path") return LONG_PATH_IMPORT_ERROR;
  if (session.blockedReason === "live") return session.liveHint ?? "Close it in your terminal first";
  if (session.blockedReason === "no-harness") return "Account isn't set up in Agetor — Add it to import";
  return "Couldn't tell if this session is still open";
}

/** The cached list, re-checked when its liveness is missing or stale — the
 *  same rule the app's import dialog uses. An older core sends no
 *  `livenessCheckedAt`; its list is used as-is. */
async function listClaude(client: AgetorClient): Promise<ClaudeSessionSummary[]> {
  const listed = await client.listClaudeSessions();
  if (listed.livenessCheckedAt === undefined) return listed.sessions;
  const checkedAt = listed.livenessCheckedAt;
  if (checkedAt !== null && Date.now() - checkedAt <= CLAUDE_SESSIONS_LIVENESS_STALE_MS) return listed.sessions;
  return (await client.recheckClaudeSessions()).sessions;
}

const tagClaude = (sessions: ClaudeSessionSummary[]): ListedSession[] =>
  sessions.map((s) => ({ ...s, kind: "claude" as const }));
const tagOpencode = (sessions: OpencodeSessionListItem[]): ListedSession[] =>
  sessions.map((s) => ({ ...s, kind: "opencode" as const }));

/** The OpenCode half of a list with no `--kind`: a core older than the
 *  OpenCode routes answers 404, which reads as "no OpenCode sessions"
 *  rather than failing the Claude half. An explicit `--kind opencode`
 *  calls the route directly, so its error reaches the user. */
async function optionalOpencode(load: () => Promise<{ sessions: OpencodeSessionListItem[] }>): Promise<OpencodeSessionListItem[]> {
  try {
    return (await load()).sessions;
  } catch {
    return [];
  }
}

export interface SessionsFlags {
  dryRun: boolean;
  yes: boolean;
  /** `--kind claude|opencode`; `null` covers both. */
  kind: SessionKind | null;
  /** `--harness <id>` — the OpenCode harness to import under. */
  harness: string | null;
  rest: string[];
}

export function parseSessionsFlags(args: string[]): SessionsFlags {
  const f: SessionsFlags = { dryRun: false, yes: false, kind: null, harness: null, rest: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--dry-run") f.dryRun = true;
    else if (arg === "--yes" || arg === "-y") f.yes = true;
    else if (arg === "--kind") {
      const v = flagValue(args, ++i, arg);
      if (!SESSION_KINDS.includes(v as SessionKind)) {
        throw new Error(`'--kind' must be one of ${SESSION_KINDS.join(", ")} (got '${escapeControlChars(v)}')`);
      }
      f.kind = v as SessionKind;
    } else if (arg === "--harness") f.harness = flagValue(args, ++i, arg);
    else f.rest.push(arg);
  }
  return f;
}

/** An import id's kind by its shape: OpenCode's own `ses_…` ids go to the
 *  OpenCode import, everything else (Claude's uuids) to the Claude import. */
export function sessionIdKind(id: string): SessionKind {
  return OPENCODE_SESSION_ID_RE.test(id) ? "opencode" : "claude";
}

/** One row per OpenCode session id. A session can be listed by several
 *  harnesses; the `--harness` one wins, then an importable row, then the
 *  first. */
function dedupeOpencode(rows: OpencodeSessionListItem[], harness: string | null): OpencodeSessionListItem[] {
  const byId = new Map<string, OpencodeSessionListItem>();
  const rank = (r: OpencodeSessionListItem) => (harness && r.harnessId === harness ? 2 : r.importable ? 1 : 0);
  for (const row of rows) {
    const prev = byId.get(row.sessionId);
    if (!prev || rank(row) > rank(prev)) byId.set(row.sessionId, row);
  }
  return [...byId.values()];
}

const sessionIdOf = (s: ListedSession): string => s.sessionId;

export async function cmdSessions(args: string[], flags: Flags): Promise<void> {
  const { dryRun, yes, kind, harness, rest } = parseSessionsFlags(args);
  const sub = rest[0] ?? "ls";
  if (sub === "--help" || sub === "-h") throw usageError("sessions");
  if (sub !== "ls" && sub !== "import") throw usageError("sessions");
  const client = await getClient(flags);
  if (sub === "ls") {
    const sessions = [
      ...(kind !== "opencode" ? tagClaude(await listClaude(client)) : []),
      ...(kind === "opencode"
        ? tagOpencode((await client.listOpencodeSessions()).sessions)
        : kind === null
          ? tagOpencode(await optionalOpencode(() => client.listOpencodeSessions()))
          : []),
    ];
    if (flags.json) return printJson({ sessions });
    if (sessions.length === 0) {
      out(
        kind === "claude"
          ? "No Claude Code sessions to import."
          : kind === "opencode"
            ? "No OpenCode sessions to import."
            : "No Claude Code or OpenCode sessions to import.",
      );
      return;
    }
    for (const session of sessions) printSession(session);
    return;
  }

  const ids = rest.slice(1);
  const wantClaude = kind !== "opencode" && (ids.length === 0 || ids.some((id) => sessionIdKind(id) === "claude"));
  const wantOpencode = kind !== "claude" && (ids.length === 0 || ids.some((id) => sessionIdKind(id) === "opencode"));
  if (harness && ids.length > 0 && !ids.some((id) => sessionIdKind(id) === "opencode")) {
    throw new Error("--harness applies to OpenCode sessions (ses_… ids) only");
  }
  const claudeRows = wantClaude ? (await client.recheckClaudeSessions()).sessions : [];
  const opencodeRows = wantOpencode
    ? dedupeOpencode(
        ids.length === 0 && kind === null
          ? await optionalOpencode(() => client.recheckOpencodeSessions())
          : (await client.recheckOpencodeSessions()).sessions,
        harness,
      )
    : [];
  const sessions: ListedSession[] = [...tagClaude(claudeRows), ...tagOpencode(opencodeRows)];
  // An id is looked up only among rows of its own kind, so `--kind` can't
  // match an id to the other kind's list.
  const rowsFor = (id: string) => sessions.filter((s) => s.kind === sessionIdKind(id) && s.sessionId === id);
  const requested = kind === null ? ids : ids.filter((id) => sessionIdKind(id) === kind);
  const chosen = ids.length === 0 ? sessions.filter((s) => s.importable) : requested.flatMap(rowsFor);
  const missing = requested.filter((id) => rowsFor(id).length === 0);
  // An id of the other kind under `--kind` is reported, never silently dropped.
  const wrongKind = ids.filter((id) => !requested.includes(id));
  const wrongKindError = `not ${kind === "opencode" ? "an OpenCode" : "a Claude Code"} session id (--kind ${kind})`;
  if (flags.json && dryRun) return printJson({ sessions: chosen, missing, dryRun: true });
  if (!flags.json) {
    for (const session of chosen) printSession(session);
    for (const id of missing) out(c.yellow(`${escapeControlChars(id)}: session not found`));
    for (const id of wrongKind) out(c.yellow(`${escapeControlChars(id)}: ${wrongKindError}`));
  }
  if (dryRun) return;
  const blocked = chosen.filter((s) => !s.importable);
  // Requested ids that won't be imported, reported beside the import results.
  const skipped = [
    ...blocked.map((s) => ({ id: s.sessionId, error: reasonFor(s) ?? "session not importable" })),
    ...missing.map((id) => ({ id, error: "session not found" })),
    ...wrongKind.map((id) => ({ id, error: wrongKindError })),
  ];
  if (!flags.json && ids.length === 1 && blocked.length === 1 && reasonFor(blocked[0]!) === LONG_PATH_IMPORT_ERROR) {
    throw new Error(LONG_PATH_IMPORT_ERROR);
  }
  const importable = chosen.filter((s) => s.importable);
  if (importable.length === 0) {
    if (flags.json) return printJson({ results: skipped });
    if (ids.length === 1 && skipped.length > 0) throw new Error(skipped[0]!.error);
    return;
  }
  const claudeIds = importable.filter((s) => s.kind === "claude").map(sessionIdOf);
  const opencodeIds = importable.filter((s) => s.kind === "opencode").map(sessionIdOf);
  if (!yes && !dryRun) {
    if (!isTTY) throw new Error("refusing to import without --yes");
    const answer = await clackConfirm({ message: `Import ${importCountText(claudeIds.length, opencodeIds.length)}?`, initialValue: false });
    if (isCancel(answer) || answer !== true) return;
  }
  const results = [
    ...(claudeIds.length > 0 ? (await client.importClaudeSessions(claudeIds)).results : []),
    ...(opencodeIds.length > 0 ? (await client.importOpencodeSessions(opencodeIds, harness ?? undefined)).results : []),
  ];
  if (flags.json) return printJson({ results: [...results, ...skipped] });
  for (const result of results) {
    if (result.error) out(c.yellow(`${escapeControlChars(result.id)}: ${escapeFreeText(result.error)}`));
    else out(`imported ${escapeControlChars(result.id)} → ${result.taskId}`);
  }
  if (results.some((r) => r.error)) {
    throw new Error("one or more sessions were not imported");
  }
}

/** `"2 Claude Code session(s)"`, `"1 OpenCode session(s)"`, or both joined. */
export function importCountText(claude: number, opencode: number): string {
  const parts: string[] = [];
  if (claude > 0) parts.push(`${claude} Claude Code`);
  if (opencode > 0) parts.push(`${opencode} OpenCode`);
  return `${parts.join(" and ")} session(s)`;
}

/** The kind column: `claude`, or `opencode · <harness label>` (the harness
 *  whose `session list` reported it). */
export function sessionKindTag(session: ListedSession): string {
  if (session.kind === "claude") return "claude";
  return `opencode · ${escapeControlChars(session.harnessLabel || session.harnessId)}`;
}

function printSession(session: ListedSession): void {
  const reason = reasonFor(session);
  const kindTag = c.gray(`[${sessionKindTag(session)}]`);
  if (session.kind === "claude") {
    const branch = session.gitBranch ? ` · ${escapeControlChars(session.gitBranch)}` : "";
    out(`${session.sessionId}  ${escapeFreeText(session.title || "Untitled")}${branch}  ${kindTag}`);
    out(c.dim(`  ${escapeControlChars(session.cwd)}`));
  } else {
    out(`${session.sessionId}  ${escapeFreeText(session.title || "Untitled")}  ${kindTag}`);
    out(c.dim(`  ${escapeControlChars(session.directory)}`));
    if (session.importable && session.busyUnknown) {
      out(c.yellow("  Couldn't check whether OpenCode is still working on it"));
    }
  }
  if (reason) out(c.yellow(`  ${reason}`));
}
