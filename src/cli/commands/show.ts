import { getClient, type Flags } from "../context.ts";
import { resolveTask } from "../resolve.ts";
import { c, out, printJson } from "../output.ts";
import type { Run } from "../../shared/types.ts";

export async function cmdShow(args: string[], flags: Flags): Promise<void> {
  const ref = args[0];
  if (!ref) throw new Error("usage: agetor show <task-id>");
  const client = await getClient(flags);
  const task = await resolveTask(client, ref);
  const [runs, pending] = await Promise.all([
    client.getRuns(task.id),
    client.pendingInteractions(task.id).catch(() => []),
  ]);

  if (flags.json) return printJson({ task, runs, pending });

  out(`${c.bold(task.title)}  ${c.dim(task.id)}`);
  out(
    `  ${label("column")} ${colorColumn(task.column)}   ${label("agent")} ${task.agent}` +
      `   ${label("model")} ${task.model ?? "-"}   ${label("mode")} ${task.mode ?? "auto"}`,
  );
  out(`  ${label("workdir")} ${c.dim(task.workdir)}`);
  if (task.branch) out(`  ${label("branch")} ${task.branch}`);
  out(`  ${label("prompt")} ${c.dim(truncate(task.prompt, 240))}`);
  if (pending.length > 0) {
    out(
      c.yellow(
        `  ! ${pending.length} pending interaction(s) — answer: agetor answer ${task.id.slice(0, 8)}`,
      ),
    );
  }
  if (runs.length > 0) {
    out(c.dim(`\n  runs (${runs.length}, newest first):`));
    for (const r of runs.slice(0, 6)) {
      out(`    ${runGlyph(r.status)} ${c.dim(r.id.slice(0, 8))}  ${r.status}  ${c.gray(r.agent)}`);
    }
  }
}

function label(s: string): string {
  return c.dim(s + ":");
}
function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
function colorColumn(col: string): string {
  if (col === "running") return c.cyan(col);
  if (col === "blocked") return c.yellow(col);
  if (col === "review") return c.green(col);
  return col;
}
function runGlyph(status: Run["status"]): string {
  switch (status) {
    case "running": return c.cyan("▸");
    case "succeeded": return c.green("✓");
    case "failed": return c.red("✗");
    case "cancelled": return c.yellow("■");
    default: return c.gray("·");
  }
}
