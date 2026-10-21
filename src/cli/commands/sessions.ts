import { confirm as clackConfirm, isCancel } from "@clack/prompts";
import { getClient, type Flags } from "../context.ts";
import { c, isTTY, out, printJson } from "../output.ts";
import { usageError } from "../usage.ts";
import { LONG_PATH_IMPORT_ERROR, MISSING_FOLDER_IMPORT_ERROR } from "../../shared/claude-session-meta.ts";
import { CLAUDE_SESSIONS_LIVENESS_STALE_MS } from "../../shared/types.ts";
import type { AgetorClient, ClaudeSessionSummary } from "../api-client.ts";

function reasonFor(session: ClaudeSessionSummary): string | null {
  if (session.importable) return null;
  if (session.blockedReason === "long-path") return LONG_PATH_IMPORT_ERROR;
  if (session.blockedReason === "missing-folder") return MISSING_FOLDER_IMPORT_ERROR;
  if (session.blockedReason === "live") return session.liveHint ?? "Close it in your terminal first";
  if (session.blockedReason === "no-harness") return "Account isn't set up in Agetor — Add it to import";
  return "Couldn't tell if this session is still open";
}

/** The cached list, re-checked when its liveness is missing or stale — the
 *  same rule the app's import dialog uses. An older core sends no
 *  `livenessCheckedAt`; its list is used as-is. */
async function listSessions(client: AgetorClient): Promise<ClaudeSessionSummary[]> {
  const listed = await client.listClaudeSessions();
  if (listed.livenessCheckedAt === undefined) return listed.sessions;
  const checkedAt = listed.livenessCheckedAt;
  if (checkedAt !== null && Date.now() - checkedAt <= CLAUDE_SESSIONS_LIVENESS_STALE_MS) return listed.sessions;
  return (await client.recheckClaudeSessions()).sessions;
}

function parseFlags(args: string[]): { dryRun: boolean; yes: boolean; rest: string[] } {
  let dryRun = false;
  let yes = false;
  const rest: string[] = [];
  for (const arg of args) {
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--yes" || arg === "-y") yes = true;
    else rest.push(arg);
  }
  return { dryRun, yes, rest };
}

export async function cmdSessions(args: string[], flags: Flags): Promise<void> {
  const { dryRun, yes, rest } = parseFlags(args);
  const sub = rest[0] ?? "ls";
  if (sub === "--help" || sub === "-h") throw usageError("sessions");
  const client = await getClient(flags);
  if (sub === "ls") {
    const sessions = await listSessions(client);
    if (flags.json) return printJson({ sessions });
    if (sessions.length === 0) {
      out("No Claude Code sessions to import.");
      return;
    }
    for (const session of sessions) printSession(session);
    return;
  }
  if (sub !== "import") throw usageError("sessions");
  const ids = rest.slice(1);
  const { sessions } = await client.recheckClaudeSessions();
  const chosen = ids.length === 0 ? sessions.filter((s) => s.importable) : sessions.filter((s) => ids.includes(s.sessionId));
  const missing = ids.filter((id) => !sessions.some((s) => s.sessionId === id));
  if (flags.json && dryRun) return printJson({ sessions: chosen, missing, dryRun: true });
  if (!flags.json) {
    for (const session of chosen) printSession(session);
    for (const id of missing) out(c.yellow(`${id}: session not found`));
  }
  if (dryRun) return;
  const blocked = chosen.filter((s) => !s.importable);
  // Requested ids that won't be imported, reported beside the import results.
  const skipped = [
    ...blocked.map((s) => ({ id: s.sessionId, error: reasonFor(s) ?? "session not importable" })),
    ...missing.map((id) => ({ id, error: "session not found" })),
  ];
  if (!flags.json && ids.length === 1 && blocked.length === 1 && reasonFor(blocked[0]!) === LONG_PATH_IMPORT_ERROR) {
    throw new Error(LONG_PATH_IMPORT_ERROR);
  }
  const importable = chosen.filter((s) => s.importable);
  if (importable.length === 0) {
    if (flags.json) return printJson({ results: skipped });
    if (ids.length === 1 && (blocked[0] || missing.length)) {
      const blockedSession = blocked[0];
      throw new Error(blockedSession ? (reasonFor(blockedSession) ?? "session not found") : "session not found");
    }
    return;
  }
  if (!yes && !dryRun) {
    if (!isTTY) throw new Error("refusing to import without --yes");
    const answer = await clackConfirm({ message: `Import ${importable.length} Claude Code session(s)?`, initialValue: false });
    if (isCancel(answer) || answer !== true) return;
  }
  const imported = await client.importClaudeSessions(importable.map((s) => s.sessionId));
  if (flags.json) return printJson({ results: [...imported.results, ...skipped] });
  for (const result of imported.results) {
    if (result.error) out(c.yellow(`${result.id}: ${result.error}`));
    else out(`imported ${result.id} → ${result.taskId}`);
  }
  if (imported.results.some((r) => r.error)) {
    throw new Error("one or more sessions were not imported");
  }
}

function printSession(session: ClaudeSessionSummary): void {
  const reason = reasonFor(session);
  const branch = session.gitBranch ? ` · ${session.gitBranch}` : "";
  out(`${session.sessionId}  ${session.title || "Untitled"}${branch}`);
  out(c.dim(`  ${session.cwd}`));
  if (reason) out(c.yellow(`  ${reason}`));
}
