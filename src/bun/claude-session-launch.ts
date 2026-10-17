/**
 * Boot-time scan for Claude Code sessions started outside Agetor.
 * Deferred from `index.ts` next to the idle-session reaper, after
 * `reconcileOrphans`. A pref of "0" skips the scan and its toast.
 * Incomplete imports still resume — a crashed backfill must not stay
 * stuck in `importing`, where Send is refused. Failures are logged
 * and never fatal.
 */
import { homedir } from "node:os";
import {
  CLAUDE_SESSIONS_LAUNCH_SCAN_PREF,
  CLAUDE_SESSIONS_SEEN_IDS_PREF,
} from "../shared/types.ts";
import { harnesses, hiddenClaudeSessionIds, preferences } from "./db.ts";
import {
  claudeConfigDirsToScan,
  discoverAgetorWorktreeRoots,
  refreshClaudeSessionLiveness,
  scanClaudeSessions,
  type ScanClaudeSessionsOptions,
} from "./claude-session-scan.ts";
import { resumeIncompleteImports } from "./claude-session-import.ts";
import { broadcastAppEvent } from "./quit-guard.ts";

const SEEN_CAP = 2000;

/** `os.homedir()` caches its first answer, so a test that points `HOME` at a
 *  scratch directory after process start would otherwise scan the real
 *  `~/.claude`. Read `HOME` on each call. */
function sessionHome(): string {
  return process.env.HOME || homedir();
}

export function claudeSessionScanOptions(): ScanClaudeSessionsOptions {
  const homeDir = sessionHome();
  return {
    homeDir,
    harnesses: harnesses.list()
      .filter((h) => h.kind === "claude-code")
      .map((h) => ({ id: h.id, kind: h.kind, home: h.home })),
    worktreeRoots: discoverAgetorWorktreeRoots(homeDir),
    ownedSessionIds: hiddenClaudeSessionIds(),
  };
}

function readSeenIds(): string[] {
  const raw = preferences.get(CLAUDE_SESSIONS_SEEN_IDS_PREF);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string");
  } catch {
    return [];
  }
}

export async function startClaudeSessionLaunchScan(deps?: {
  scan?: typeof scanClaudeSessions;
}): Promise<void> {
  const scanOff = preferences.get(CLAUDE_SESSIONS_LAUNCH_SCAN_PREF) === "0";
  try {
    // Resume inserts a missing seed run before it returns (that write sits
    // ahead of the transcript read). Ownership for the toast is read after
    // that insert. A snapshot taken before it misses the new run id.
    await resumeIncompleteImports(claudeSessionScanOptions());
  } catch (err) {
    console.error("[agetor] claude session import resume failed:", err);
  }
  if (scanOff) return;
  try {
    const opts = claudeSessionScanOptions();
    await refreshClaudeSessionLiveness(claudeConfigDirsToScan(opts), process.env);
    const scan = deps?.scan ?? scanClaudeSessions;
    const sessions = await scan(opts);
    const seen = readSeenIds();
    const known = new Set(seen);
    const fresh = sessions.filter((s) => s.importable && !known.has(s.sessionId));
    if (fresh.length > 0) {
      broadcastAppEvent({ type: "claude_sessions_found", count: fresh.length, ts: Date.now() });
    }
    if (fresh.length === 0) return;
    const next = [...seen, ...fresh.map((s) => s.sessionId)].slice(-SEEN_CAP);
    preferences.set(CLAUDE_SESSIONS_SEEN_IDS_PREF, JSON.stringify(next));
  } catch (err) {
    console.error("[agetor] claude session launch scan failed:", err);
  }
}
