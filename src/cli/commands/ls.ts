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

interface LsFilters {
  columns: string[];
  agent?: string;
  type?: string;
  repo?: string;
  search?: string;
  archived: boolean;
  all: boolean;
}

function parseLsFilters(args: string[]): LsFilters {
  const f: LsFilters = { columns: [], archived: false, all: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = () => args[++i];
    switch (a) {
      case "--column": case "-c": { const v = next(); if (v) f.columns.push(...v.split(",")); break; }
      case "--agent": f.agent = next(); break;
      case "--type": f.type = next(); break;
      case "--repo": case "--workdir": f.repo = next(); break;
      case "--search": case "-q": f.search = next(); break;
      case "--archived": f.archived = true; break;
      case "--all": f.all = true; break;
      default: break;
    }
  }
  return f;
}

export async function cmdLs(
  args: string[],
  flags: Flags,
  opts: { onlyRunning?: boolean } = {},
): Promise<void> {
  const f = parseLsFilters(args);
  const client = await getClient(flags);
  let tasks = await client.listTasks();
  // Archive view: active-only by default (matches the app); --archived shows
  // only archived, --all shows both.
  if (f.archived) tasks = tasks.filter((t) => t.archivedAt != null);
  else if (!f.all) tasks = tasks.filter((t) => t.archivedAt == null);
  if (opts.onlyRunning) {
    tasks = tasks.filter((t) => t.column === "running" || t.column === "blocked");
  }
  if (f.columns.length) tasks = tasks.filter((t) => f.columns.includes(t.column));
  if (f.agent) tasks = tasks.filter((t) => t.agent === f.agent);
  if (f.type) tasks = tasks.filter((t) => t.taskType === f.type);
  if (f.repo) {
    const r = f.repo.toLowerCase();
    tasks = tasks.filter((t) => t.workdir.toLowerCase().includes(r));
  }
  if (f.search) {
    const q = f.search.toLowerCase();
    tasks = tasks.filter((t) =>
      `${t.title} ${t.prompt} ${t.workdir} ${t.branch ?? ""}`.toLowerCase().includes(q),
    );
  }
  if (flags.json) return printJson(tasks);
  if (tasks.length === 0) {
    out(c.dim("no matching tasks"));
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
