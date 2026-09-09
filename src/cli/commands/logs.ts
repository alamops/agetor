import { getClient, type Flags } from "../context.ts";
import { resolveTask } from "../resolve.ts";
import { streamSse, type SseHandle } from "../sse.ts";
import { c, out, errln } from "../output.ts";
import { usageError } from "../usage.ts";
import { notifyFor, osNotify } from "../notify.ts";
import type { RunEvent, GlobalEvent } from "../../shared/types.ts";
import { FX_RECOVERY_STATUS_PREFIX, isInternalStatusSentinel } from "../../shared/types.ts";
import { fxRecoveryNoticeText, parseFxRecoveryPayload } from "../../shared/fx-recovery.ts";
import { userMessageLines, type PlainLine } from "../../shared/user-message.ts";
import {
  parseSentFilesToolUse,
  parseSentFilesToolResult,
  sanitizeToolResultAttachments,
  sentFilesSummaryLine,
  type SentFilesRequest,
} from "../../shared/sent-files.ts";

export async function cmdLogs(args: string[], flags: Flags): Promise<void> {
  const ref = args.find((a) => !a.startsWith("-"));
  const noFollow = args.includes("--no-follow");
  const notify = args.includes("--notify");
  const rebuild = args.includes("--rebuild");
  if (!ref) throw usageError("logs");
  const client = await getClient(flags);
  const task = await resolveTask(client, ref);
  const formatEvent = createEventFormatter();
  const renderLine = createLineRenderer(formatEvent, flags.json);

  // --rebuild: reconstruct the latest run's events from the on-disk claude
  // JSONL (recovery when the live stream truncated) — a one-shot snapshot.
  if (rebuild) {
    const run = (await client.getRuns(task.id))[0];
    if (!run) {
      out(c.dim("no runs to rebuild"));
      return;
    }
    const { events, reason } = await client.rebuildEvents(run.id);
    if (reason) errln(c.dim(reason));
    for (const e of events) {
      const line = renderLine(e);
      if (line !== null) out(line);
    }
    return;
  }

  await new Promise<void>((resolve) => {
    let handle: SseHandle | undefined;
    let notifyHandle: SseHandle | undefined;
    let quiet: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      handle?.close();
      notifyHandle?.close();
      if (quiet) clearTimeout(quiet);
      resolve();
    };
    const onEvent = (e: RunEvent) => {
      const line = renderLine(e);
      if (line !== null) out(line);
      if (noFollow) {
        // Close once the replay burst goes quiet for a beat.
        if (quiet) clearTimeout(quiet);
        quiet = setTimeout(finish, 700);
      }
    };
    handle = streamSse<RunEvent>(`/tasks/${task.id}/events`, onEvent, {
      dataDir: flags.dataDir,
      onReconnect: () => {
        if (!flags.json && !noFollow) errln(c.dim("…reconnecting"));
      },
    });
    // --notify (only while following): a desktop notification + bell when this
    // task changes to a terminal status or starts waiting on you.
    if (notify && !noFollow) {
      notifyHandle = streamSse<GlobalEvent>(
        "/events",
        (e) => {
          const n = notifyFor(e, task.id);
          if (n) osNotify(n.title, n.body);
        },
        { dataDir: flags.dataDir },
      );
    }
    process.on("SIGINT", () => {
      finish();
      process.exit(0);
    });
    // Safety: with --no-follow and zero events, don't hang forever.
    if (noFollow) quiet = setTimeout(finish, 2500);
  });
}

// Internal-only sentinel status chunks (permission-mode chip, fx usage chip,
// …) are UI-plumbing, not transcript content — see `isInternalStatusSentinel`
// in shared/types.ts, the one predicate every raw-status renderer must
// consult so a new sentinel can't leak verbatim into one surface while
// another suppresses it. `--json` still emits the raw event for programmatic
// consumers; only the human-readable render skips it.
function shouldSkipEvent(e: RunEvent): boolean {
  return e.stream === "status" && isInternalStatusSentinel(e.data);
}

/**
 * Builds the per-event `RunEvent → string | null` renderer both the
 * `--rebuild` loop and the streaming path share — `null` means "print
 * nothing for this event". `--json` always wins (the raw event, unskipped,
 * exactly as before this task's change) and short-circuits everything else.
 *
 * For the human-readable path, an `fx-recovery:` status sentinel is handled
 * BEFORE the generic `shouldSkipEvent`/`isInternalStatusSentinel` check that
 * would otherwise hide it unconditionally like every other internal fx
 * sentinel (usage/provider/title): a `state === "active"` payload is fx's
 * own live retry-progress line (e.g. "⚠ Rate limited · HTTP 429 · … ·
 * retrying request in 8s · attempt 5/10") — the whole point of surfacing
 * the Gateway rate-limit storm in `agetor logs` as it happens — so it
 * prints in yellow via `fxRecoveryNoticeText`. Every other state
 * (`paused`/`recovered`/`cleared`) — or a body that fails to parse — prints
 * NOTHING here: the driver already emits a separate, persisted PLAIN status
 * line at those terminal transitions (`fxRecoverySummaryLine`, see
 * fx-acp.ts), and rendering this sentinel too would double it. Any other
 * event falls through to the pre-existing `shouldSkipEvent` skip +
 * `formatEvent` render, unchanged.
 */
function createLineRenderer(
  formatEvent: (e: RunEvent) => string,
  json: boolean,
): (e: RunEvent) => string | null {
  return (e: RunEvent): string | null => {
    if (json) return JSON.stringify(e);
    if (e.stream === "status" && e.data.startsWith(FX_RECOVERY_STATUS_PREFIX)) {
      const payload = parseFxRecoveryPayload(e.data.slice(FX_RECOVERY_STATUS_PREFIX.length));
      return payload?.state === "active" ? c.yellow(fxRecoveryNoticeText(payload)) : null;
    }
    if (shouldSkipEvent(e)) return null;
    return formatEvent(e);
  };
}

/**
 * Builds a `formatEvent` renderer with its own private `toolUseId → request`
 * map for pairing a `SendUserFile` tool_use with its later tool_result — see
 * the `tool_use`/`tool_result` cases below. One instance per `cmdLogs`
 * invocation (never a module-level singleton): `--rebuild` and the
 * streaming/`--follow` path are mutually exclusive within a single call, so
 * one map safely covers whichever branch runs, and a fresh map per call
 * means no state leaks between unrelated invocations (or test cases).
 */
function createEventFormatter(): (e: RunEvent) => string {
  const pendingSentFiles = new Map<string, SentFilesRequest>();

  return function formatEvent(e: RunEvent): string {
    switch (e.stream) {
      // `userMessageLines` (src/shared/user-message.ts) is the single source
      // of truth for rendering a raw user-turn string across all three
      // surfaces — the webview's transcript bubble, this CLI render, and the
      // TUI dashboard — so a tagged message (slash-command XML,
      // local-command output, a forked-skill launch, a shell escape, …)
      // prints labeled lines here instead of raw `<tag>` text. `--json`
      // output is unaffected: it emits the raw event, never routing through
      // this formatter.
      case "user":
        return userMessageLines(e.data).map((line) => `${colorLabel(line)} ${line.text}`).join("\n");
      case "assistant":
        return e.data;
      case "thinking":
        return c.dim(e.data);
      case "status":
        return c.dim(`• ${e.data}`);
      case "stderr":
        return c.red(e.data);
      case "stdout":
        return e.data;
      case "tool_use": {
        const t = tryJson(e.data) as { id?: string; name?: string; input?: unknown } | null;
        if (t?.id && t.name) {
          const req = parseSentFilesToolUse(t.name, t.input);
          if (req) {
            pendingSentFiles.set(t.id, req);
            return c.magenta(`📎 ${sentFilesSummaryLine(req, null)}`);
          }
        }
        return c.magenta(`▸ ${t?.name ?? "tool"}`);
      }
      case "tool_result": {
        const t = tryJson(e.data) as
          | { toolUseId?: string; content?: unknown; isError?: boolean; attachments?: unknown }
          | null;
        const req = t?.toolUseId ? pendingSentFiles.get(t.toolUseId) : undefined;
        if (req && t) {
          pendingSentFiles.delete(t.toolUseId!);
          const result = parseSentFilesToolResult(
            t.content,
            t.isError,
            sanitizeToolResultAttachments(t.attachments),
          );
          return c.magenta(`📎 ${sentFilesSummaryLine(req, result)}`);
        }
        return c.dim(`  ↳ ${t?.isError ? "error" : "result"}`);
      }
      case "interaction": {
        const r = tryJson(e.data) as { kind?: string } | null;
        if (r?.kind === "fx_permission") {
          return c.yellow(`! fx is requesting permission — agetor answer ${e.taskId.slice(0, 8)}`);
        }
        return c.yellow(
          `! needs answer (${r?.kind ?? "?"}) — agetor answer ${e.taskId.slice(0, 8)}`,
        );
      }
      case "interaction_resolved":
        return c.dim("✓ interaction answered");
      default:
        return e.data;
    }
  };
}

/** Color a `PlainLine`'s label by its tone — `user` cyan (matches today's
 *  "you›"), `machine`/`tag` dim, `error` red. */
function colorLabel(line: PlainLine): string {
  switch (line.tone) {
    case "user":
      return c.cyan(line.label);
    case "error":
      return c.red(line.label);
    case "machine":
    case "tag":
      return c.dim(line.label);
  }
}

function tryJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
