/**
 * Boot-time scan for Claude Code sessions started outside Agetor.
 * Scheduled from `index.ts` once the API has bound, after
 * `reconcileOrphans`. A pref of "0" skips the scan and its toast.
 * Incomplete imports still resume — a crashed backfill must not stay
 * stuck in `importing`, where Send is refused. Failures are logged
 * and never fatal.
 *
 * The scan usually finishes before the webview has connected to
 * `/app/events`, which replays nothing. A notice with no listener is held
 * here and sent to the next client that connects
 * (`flushPendingClaudeSessionsNotice`). Ids are recorded as seen only once
 * the notice was sent, so a lost toast is offered again next launch.
 *
 * OpenCode sessions started outside Agetor ride the same scan
 * (`docs/plans/add-opencode-harness.md` D-13): after Claude's, under the same
 * preference, with the same hold-until-a-client-connects rule, as an
 * `opencode_sessions_found` notice. Seen ids share `claude_session_seen` —
 * OpenCode's `ses_…` ids can't collide with Claude's uuids. Resume of an
 * OpenCode import left `importing` is scheduled by the entry points
 * themselves (`resumeIncompleteOpencodeImports`), headless included.
 */
import { homedir } from "node:os";
import { CLAUDE_SESSIONS_LAUNCH_SCAN_PREF, type AppEvent } from "../shared/types.ts";
import { claudeSessionSeen, harnesses, hiddenClaudeSessionIds, hiddenOpencodeSessionIds, preferences } from "./db.ts";
import {
  claudeConfigDirsToScan,
  discoverAgetorWorktreeRoots,
  refreshClaudeSessionLiveness,
  scanClaudeSessions,
  type ScanClaudeSessionsOptions,
} from "./claude-session-scan.ts";
import { resumeIncompleteImports } from "./claude-session-import.ts";
import { scanOpencodeSessions } from "./opencode-session-scan.ts";
import { broadcastAppEvent, hasAppEventListeners } from "./quit-guard.ts";

const SEEN_CAP = 2000;

/** Ids found by the launch scan that no client has been told about yet. */
let pendingNotice: string[] | null = null;
/** The OpenCode counterpart of {@link pendingNotice}. */
let pendingOpencodeNotice: string[] | null = null;

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
      .map((h) => ({ id: h.id, kind: h.kind, home: h.home, bin: h.bin })),
    worktreeRoots: discoverAgetorWorktreeRoots(homeDir),
    ownedSessionIds: hiddenClaudeSessionIds(),
  };
}

function noticeFor(ids: readonly string[]): AppEvent {
  return { type: "claude_sessions_found", count: ids.length, ts: Date.now() };
}

function opencodeNoticeFor(ids: readonly string[]): AppEvent {
  return { type: "opencode_sessions_found", count: ids.length, sessionIds: [...ids], ts: Date.now() };
}

/** Send held launch-scan notices (Claude's, then OpenCode's) to a client
 *  that just connected, then record their ids as seen. Ids imported since
 *  the scan are dropped first. Called by the `/app/events` route right after
 *  it subscribes. */
export function flushPendingClaudeSessionsNotice(send: (e: AppEvent) => void): void {
  const held = pendingNotice;
  pendingNotice = null;
  if (held) {
    const hidden = hiddenClaudeSessionIds();
    const ids = held.filter((id) => !hidden.has(id));
    if (ids.length > 0) {
      send(noticeFor(ids));
      claudeSessionSeen.add(ids, SEEN_CAP);
    }
  }
  const heldOpencode = pendingOpencodeNotice;
  pendingOpencodeNotice = null;
  if (heldOpencode) {
    const hidden = hiddenOpencodeSessionIds();
    const ids = heldOpencode.filter((id) => !hidden.has(id));
    if (ids.length > 0) {
      send(opencodeNoticeFor(ids));
      claudeSessionSeen.add(ids, SEEN_CAP);
    }
  }
}

/** Test seam: drop held notices (both kinds). */
export function clearPendingClaudeSessionsNotice(): void {
  pendingNotice = null;
  pendingOpencodeNotice = null;
}

export async function startClaudeSessionLaunchScan(deps?: {
  scan?: typeof scanClaudeSessions;
  scanOpencode?: typeof scanOpencodeSessions;
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
    await refreshClaudeSessionLiveness(claudeConfigDirsToScan(opts), process.env, opts.harnesses, opts.homeDir);
    const scan = deps?.scan ?? scanClaudeSessions;
    const sessions = await scan(opts);
    const known = claudeSessionSeen.ids();
    const fresh = sessions.filter((s) => s.importable && !known.has(s.sessionId)).map((s) => s.sessionId);
    if (fresh.length > 0) {
      if (!hasAppEventListeners()) {
        pendingNotice = fresh;
      } else {
        broadcastAppEvent(noticeFor(fresh));
        claudeSessionSeen.add(fresh, SEEN_CAP);
      }
    }
  } catch (err) {
    console.error("[agetor] claude session launch scan failed:", err);
  }
  try {
    const scan = deps?.scanOpencode ?? scanOpencodeSessions;
    const sessions = await scan();
    const known = claudeSessionSeen.ids();
    const fresh = sessions.filter((s) => s.importable && !known.has(s.sessionId)).map((s) => s.sessionId);
    // A session listed under two harnesses is one id in the notice.
    const unique = [...new Set(fresh)];
    if (unique.length === 0) return;
    if (!hasAppEventListeners()) {
      pendingOpencodeNotice = unique;
      return;
    }
    broadcastAppEvent(opencodeNoticeFor(unique));
    claudeSessionSeen.add(unique, SEEN_CAP);
  } catch (err) {
    console.error("[agetor] opencode session launch scan failed:", err);
  }
}
