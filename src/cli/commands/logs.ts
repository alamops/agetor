import { getClient, type Flags } from "../context.ts";
import { resolveTask } from "../resolve.ts";
import { streamSse, type SseHandle } from "../sse.ts";
import { c, out, errln } from "../output.ts";
import { usageError } from "../usage.ts";
import type { RunEvent } from "../../shared/types.ts";

export async function cmdLogs(args: string[], flags: Flags): Promise<void> {
  const ref = args.find((a) => !a.startsWith("-"));
  const noFollow = args.includes("--no-follow");
  if (!ref) throw usageError("logs");
  const client = await getClient(flags);
  const task = await resolveTask(client, ref);

  await new Promise<void>((resolve) => {
    let handle: SseHandle | undefined;
    let quiet: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      handle?.close();
      if (quiet) clearTimeout(quiet);
      resolve();
    };
    const onEvent = (e: RunEvent) => {
      out(flags.json ? JSON.stringify(e) : formatEvent(e));
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
    process.on("SIGINT", () => {
      finish();
      process.exit(0);
    });
    // Safety: with --no-follow and zero events, don't hang forever.
    if (noFollow) quiet = setTimeout(finish, 2500);
  });
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
