import { getClient, type Flags } from "../context.ts";
import { c, out, printJson, table } from "../output.ts";
import type { Task } from "../../shared/types.ts";
import { COLUMNS } from "../../shared/types.ts";
import { flagValue } from "../args.ts";
import { fxAutoResumeCountdownText, isTaskFxPaused } from "../../shared/fx-recovery.ts";
import { pipelineStepProgress } from "../../shared/pipeline.ts";

const COLUMN_IDS = COLUMNS.map((col) => col.id);

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
  steps: boolean;
}

function parseLsFilters(args: string[]): LsFilters {
  const f: LsFilters = { columns: [], archived: false, all: false, steps: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const val = () => flagValue(args, ++i, a);
    switch (a) {
      case "--column": case "-c": f.columns.push(...val().split(",")); break;
      case "--agent": f.agent = val(); break;
      case "--type": f.type = val(); break;
      case "--repo": case "--workdir": f.repo = val(); break;
      case "--search": case "-q": f.search = val(); break;
      case "--archived": f.archived = true; break;
      case "--all": f.all = true; break;
      case "--steps": f.steps = true; break;
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
  const badCols = f.columns.filter(
    (col) => !COLUMN_IDS.includes(col as (typeof COLUMN_IDS)[number]),
  );
  if (badCols.length) {
    throw new Error(
      `unknown column${badCols.length > 1 ? "s" : ""}: ${badCols.join(", ")} — one of: ${COLUMN_IDS.join(", ")}`,
    );
  }
  const client = await getClient(flags);
  let tasks = await client.listTasks();
  // `GET /tasks` also returns hidden pipeline step tasks (D11,
  // docs/plans/pipelines.md) — hidden from `ls` by default, same as the
  // board and the TUI, since they're an implementation detail of the
  // pipeline's parent task; --steps opts back in.
  if (!f.steps) tasks = tasks.filter((t) => t.pipelineParentId == null);
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
    titleCell(t),
    agentCell(t),
    profileCell(t),
    colorColumn(t.column),
    needsCell(t),
  ]);
  out(table(["", "id", "title", "agent", "profile", "column", "needs"], rows));
}

/** Title column: a hidden pipeline step task (only ever listed under
 *  `--steps`) is prefixed `↳ ` so it reads as belonging to the parent row
 *  above it, mirroring the TUI's expanded step rows (L-CLI11). */
function titleCell(t: Task): string {
  return t.pipelineParentId ? `↳ ${truncate(t.title, 42)}` : truncate(t.title, 44);
}

/** Agent column: the raw harness id — always, regardless of whether the task
 *  is bound to an agent profile. The `--agent` filter above matches on the
 *  same `t.agent` field this renders. */
function agentCell(t: Task): string {
  return c.gray(t.agent ?? "");
}

/** Profile column: the bound agent profile's name (from the task's own
 *  frozen snapshot — reads the same whether the profile is still live or has
 *  since been deleted), or `-` when the task isn't bound to one. */
function profileCell(t: Task): string {
  return t.agentProfile ? c.bold(t.agentProfile.name) : c.dim("-");
}

/** The "needs" column: pending-interaction count first (unchanged), then an
 *  fx-pause hint — `⏸ paused` (yellow) when the task is sitting on a
 *  resumable fx pause with no auto-resume timer scheduled, or
 *  `⏸ auto m:ss` (cyan) counting down to the next automatic resume
 *  (`docs/plans/fx-recovery-follow-ups.md` §2). Joined with a space when
 *  both apply.
 *
 *  Code-review check (the `⏸` double-width-glyph finding that required a
 *  `pauseW` fix in Dashboard.tsx's `TaskRow`): `table()` (`output.ts`) pads
 *  every column to `visibleLen` (a plain, non-wcwidth-aware `.length`), so
 *  it under-measures this glyph by one cell too — but unlike the TUI's
 *  fixed-width, `wrap="truncate"` row, `cmdLs`'s "needs" column is BOTH (a)
 *  the table's last column, whose padding `table()`'s `fmt()` immediately
 *  `.trimEnd()`s away, and (b) never consulted when budgeting the "title"
 *  column (`truncate(t.title, 44)` above is a fixed, needs-independent
 *  constant). So the same off-by-one has nothing to overflow into here — no
 *  column-width accounting change was needed; `ls.test.ts` pins this
 *  (alignment across rows holds, and a hint-bearing row's `⏸` is never cut
 *  short). */
function needsCell(t: Task): string {
  const parts: string[] = [];
  if (t.pendingInteractionCount > 0) parts.push(c.yellow(`! ${t.pendingInteractionCount}`));
  if (isTaskFxPaused(t)) {
    const autoResume = t.fxRecovery?.autoResume;
    parts.push(
      autoResume
        ? c.cyan(`⏸ auto ${fxAutoResumeCountdownText(autoResume.at, Date.now())}`)
        : c.yellow("⏸ paused"),
    );
  }
  // A pipeline (parent) task whose run is blocked — extend the same "needs
  // attention" cell rather than adding a column of its own, mirroring the
  // fx-pause hint above. `pipelineRun` is only ever set on a parent task.
  if (t.pipelineId && t.pipelineRun?.status === "blocked") {
    parts.push(c.yellow(`pipeline blocked · ${pipelineStepProgress(t.pipelineRun).label}`));
  }
  // A step task (listed only under `--steps`) names its parent here so the
  // row is actionable — `agetor pipeline status <parent>` / `agetor show`.
  if (t.pipelineParentId) parts.push(c.dim(`step of ${t.pipelineParentId.slice(0, 8)}`));
  return parts.join(" ");
}

function glyph(t: Task): string {
  // A pipeline (parent) row gets the TUI's `»` marker (`Dashboard.tsx`'s
  // `pipelineText`) instead of the column glyph, colored by column — the
  // column cell still names the column, so nothing is lost (L-CLI11).
  const g = t.pipelineId ? "»" : (COLUMN_GLYPH[t.column] ?? "·");
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
