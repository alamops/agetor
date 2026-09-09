import { getClient, type Flags } from "../context.ts";
import { resolveTask } from "../resolve.ts";
import { c, out, printJson, table } from "../output.ts";
import { usageError } from "../usage.ts";
import { sentFileBasename, formatByteSize } from "../../shared/sent-files.ts";
import type { SentFileEntry } from "../../shared/types.ts";

/**
 * `agetor files <task-id> [--json]` — the CLI view of `task.sentFiles`
 * (files delivered to the user via a `SendUserFile` tool call; see
 * `src/shared/sent-files.ts`), mirroring `agetor show`'s resolve-then-render
 * shape. `sentFiles` is server-managed (not PATCHable) so there's nothing to
 * mutate here — this is a read-only view, same posture as `logs --rebuild`.
 */
export async function cmdFiles(args: string[], flags: Flags): Promise<void> {
  const ref = args.find((a) => !a.startsWith("-"));
  if (!ref) throw usageError("files");
  const client = await getClient(flags);
  const task = await resolveTask(client, ref);
  const files = task.sentFiles ?? [];

  if (flags.json) return printJson(files);

  if (files.length === 0) {
    out(c.dim("No files sent yet."));
    return;
  }

  // Newest first — matches `agetor show`'s "runs, newest first" convention.
  const sorted = [...files].sort((a, b) => b.sentAt - a.sentAt);
  const rows = sorted.map((f) => [
    sentFileBasename(f.path),
    f.size !== null ? formatByteSize(f.size) : "-",
    sentTimeLabel(f),
    c.dim(f.path),
  ]);
  out(table(["file", "size", "sent", "path"], rows));
}

function sentTimeLabel(f: SentFileEntry): string {
  return new Date(f.sentAt).toLocaleString();
}
