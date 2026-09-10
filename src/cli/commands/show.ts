import { getClient, type Flags } from "../context.ts";
import { resolveTask } from "../resolve.ts";
import { c, out, printJson } from "../output.ts";
import { usageError } from "../usage.ts";
import type { AgetorClient } from "../api-client.ts";
import { AGENT_OPTIONS, defaultModeFor, type AgentKind, type Run } from "../../shared/types.ts";

export async function cmdShow(args: string[], flags: Flags): Promise<void> {
  const ref = args[0];
  if (!ref) throw usageError("show");
  const client = await getClient(flags);
  const task = await resolveTask(client, ref);
  const [runs, pending] = await Promise.all([
    client.getRuns(task.id),
    client.pendingInteractions(task.id).catch(() => []),
  ]);

  if (flags.json) return printJson({ task, runs, pending });

  const modeText = await resolveModeText(client, task.agent, task.mode);

  out(`${c.bold(task.title)}  ${c.dim(task.id)}`);
  out(
    `  ${label("column")} ${colorColumn(task.column)}   ${label("agent")} ${task.agent}` +
      `   ${label("model")} ${task.model ?? "-"}   ${label("mode")} ${modeText}`,
  );
  out(`  ${label("workdir")} ${c.dim(task.workdir)}`);
  if (task.branch) out(`  ${label("branch")} ${task.branch}`);
  if (task.issueUrl) out(`  ${label("issue")} ${task.issueUrl}`);
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

/**
 * `task.mode` display text (code-review fix, `docs/plans/fx-recovery-follow-ups.md`
 * §3.6/`defaultModeFor`): a stored `null` mode no longer prints the literal
 * string `"auto"` — for fx specifically that was a lie, since a null fx mode
 * actually spawns as `yolo` ("Full access") via `defaultModeFor`, not
 * `auto`. Resolves the task's harness kind (`client.listHarnesses()` first —
 * covers a custom-account harness whose id differs from its `AgentKind` —
 * falling back to treating `agent` itself as a built-in kind id, which is
 * how every built-in harness is seeded, mirroring `defaultNonInteractiveMode`
 * in `add.ts`) and prints `defaultModeFor(kind) + " (default)"`; when the
 * kind can't be resolved at all (harness deleted, listHarnesses failed)
 * prints `"-"` rather than guessing.
 */
async function resolveModeText(
  client: AgetorClient,
  agent: string,
  mode: string | null,
): Promise<string> {
  if (mode) return mode;
  const kind = await resolveAgentKind(client, agent);
  return kind ? `${defaultModeFor(kind)} (default)` : "-";
}

async function resolveAgentKind(client: AgetorClient, agentId: string): Promise<AgentKind | null> {
  try {
    const { harnesses } = await client.listHarnesses();
    const found = harnesses.find((h) => h.id === agentId);
    if (found) return found.kind;
  } catch {
    // listHarnesses failed — fall through to the built-in-id heuristic below
    // rather than failing the whole `show` command over a display nicety.
  }
  return agentId in AGENT_OPTIONS ? (agentId as AgentKind) : null;
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
