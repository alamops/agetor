import { getClient, type Flags } from "../context.ts";
import { c, out, printJson, table } from "../output.ts";
import type { Task } from "../../shared/types.ts";

const COLUMN_GLYPH: Record<string, string> = {
  backlog: "·",
  ready: "○",
  running: "▸",
  blocked: "!",
  review: "✓",
  done: "✓",
};

export async function cmdLs(
  _args: string[],
  flags: Flags,
  opts: { onlyRunning?: boolean } = {},
): Promise<void> {
  const client = await getClient(flags);
  let tasks = await client.listTasks();
  if (opts.onlyRunning) {
    tasks = tasks.filter((t) => t.column === "running" || t.column === "blocked");
  }
  if (flags.json) return printJson(tasks);
  if (tasks.length === 0) {
    out(c.dim(opts.onlyRunning ? "no running tasks" : "no tasks"));
    return;
  }
  const rows = tasks.map((t) => [
    glyph(t),
    c.dim(t.id.slice(0, 8)),
    truncate(t.title, 44),
    c.gray(t.agent ?? ""),
    colorColumn(t.column),
    t.pendingInteractionCount > 0 ? c.yellow(`! ${t.pendingInteractionCount}`) : "",
  ]);
  out(table(["", "id", "title", "agent", "column", "needs"], rows));
}

function glyph(t: Task): string {
  const g = COLUMN_GLYPH[t.column] ?? "·";
  if (t.column === "running") return c.cyan(g);
  if (t.column === "blocked") return c.yellow(g);
  if (t.column === "review" || t.column === "done") return c.green(g);
  return c.gray(g);
}

function colorColumn(col: string): string {
  if (col === "running") return c.cyan(col);
  if (col === "blocked") return c.yellow(col);
  if (col === "review") return c.green(col);
  return col;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
