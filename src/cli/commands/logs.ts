import { getClient, type Flags } from "../context.ts";
import { resolveTask } from "../resolve.ts";
import { streamSse, type SseHandle } from "../sse.ts";
import { c, out, errln } from "../output.ts";
import { usageError } from "../usage.ts";
import { notifyFor, osNotify } from "../notify.ts";
import type { RunEvent, GlobalEvent } from "../../shared/types.ts";
import { isInternalStatusSentinel } from "../../shared/types.ts";

export async function cmdLogs(args: string[], flags: Flags): Promise<void> {
  const ref = args.find((a) => !a.startsWith("-"));
  const noFollow = args.includes("--no-follow");
  const notify = args.includes("--notify");
  const rebuild = args.includes("--rebuild");
  if (!ref) throw usageError("logs");
  const client = await getClient(flags);
  const task = await resolveTask(client, ref);

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
      if (!flags.json && shouldSkipEvent(e)) continue;
      out(flags.json ? JSON.stringify(e) : formatEvent(e));
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
      if (flags.json || !shouldSkipEvent(e)) {
        out(flags.json ? JSON.stringify(e) : formatEvent(e));
      }
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

function formatEvent(e: RunEvent): string {
  switch (e.stream) {
    case "user":
      return `${c.cyan("you›")} ${e.data}`;
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
      const t = tryJson(e.data) as { name?: string } | null;
      return c.magenta(`▸ ${t?.name ?? "tool"}`);
    }
    case "tool_result": {
      const t = tryJson(e.data) as { isError?: boolean } | null;
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
}

function tryJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
