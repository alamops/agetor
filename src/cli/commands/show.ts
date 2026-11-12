import { getClient, type Flags } from "../context.ts";
import { resolveTask } from "../resolve.ts";
import { c, out, printJson } from "../output.ts";
import { usageError } from "../usage.ts";
import { ApiError, type AgetorClient } from "../api-client.ts";
import { DEFAULT_MODEL, defaultModeFor, type Run, type Task } from "../../shared/types.ts";
import { pipelineStepProgress, stepNameById } from "../../shared/pipeline.ts";
import { harnessMoveNote, harnessStackBannerMode, memberReasonText, memberStateText, stackPositionText } from "../../shared/harness-stack.ts";
import { coolingText, limitRowsForModel } from "../stack-display.ts";
import { escapeControlChars, escapeFreeText, truncateText } from "../../shared/terminal-text.ts";
import { colorRunStatus } from "./pipeline.ts";
import { profileHarnessContext, type ProfileHarnessContext } from "./agent-profile.ts";

/**
 * The `failover` line for a task with a recorded all-exhausted state.
 *
 * While the retry successor is alive (`inFlight` stays true for its whole life)
 * or the task is running, the retry is not "retrying…" any more: it is a real
 * run on the destination account (review S20). `attempts` is only incremented
 * when that run itself returns to exhausted, so the live attempt is
 * `attempts + 1`. `accountLabel` is the member's label (the caller resolves it
 * from the stack); the task's raw harness id stands in when it can't.
 */
export function failoverText(
  task: Pick<Task, "agent" | "column" | "harnessState">,
  accountLabel: string | null,
): string {
  const ex = task.harnessState!.allExhausted!;
  const attempt = `attempt ${Math.min(ex.attempts + 1, ex.max)}/${ex.max}`;
  if (ex.inFlight === true || task.column === "running") {
    return `running on ${accountLabel ?? task.agent} after a quota reset (${attempt})`;
  }
  if (ex.reason === "no-usable-member") {
    if (ex.attempts >= ex.max) return "blocked: no usable account — fix one under Settings → Harnesses (or agetor harness …)";
    if (ex.nextAttemptAt > 0) {
      return `blocked: no usable account — retrying at ${new Date(ex.nextAttemptAt).toLocaleString()} (${attempt})`;
    }
    return "blocked: no usable account — fix one under Settings → Harnesses (or agetor harness …)";
  }
  if (ex.attempts >= ex.max) return "out of quota — run the task manually after a reset";
  if (ex.nextAttemptAt > 0) return `out of quota — waiting until ${new Date(ex.nextAttemptAt).toLocaleString()} (${attempt})`;
  return `out of quota — retrying on the next available account (${attempt})`;
}

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

  // The harness lookup only resolves the default mode text; a failed lookup
  // falls back to the built-in-id heuristic. It is skipped when a stored mode
  // needs no default on a built-in harness (a built-in harness's id is its
  // kind).
  const builtinCtx = profileHarnessContext(task.agent, null);
  const needsLookup = task.mode == null || builtinCtx.kind == null;
  const harnessCtx = needsLookup
    ? profileHarnessContext(task.agent, await client.listHarnesses().catch(() => null))
    : builtinCtx;
  const stacksPayload = typeof client.listHarnessStacks === "function"
    ? await client.listHarnessStacks().catch(() => null)
    : null;
  const modeText = resolveModeText(harnessCtx, task.mode);

  // A step task's title is `<pipeline> · <step>`, both locally written names.
  out(`${c.bold(escapeFreeText(task.title))}  ${c.dim(task.id)}`);
  // A pipeline (parent) task's own agent/model/mode are cosmetic — copied
  // from the start step's profile at create time; the parent never spawns
  // an agent, each step launches on its own frozen profile (L-CLI4).
  const agentNote = task.pipelineId ? c.dim(" (start step's harness — steps own the launch)") : "";
  out(
    `  ${label("column")} ${colorColumn(task.column)}   ${label("agent")} ${escapeControlChars(task.agent)}${agentNote}` +
      `   ${label("model")} ${escapeControlChars(task.model ?? "-")}   ${label("mode")} ${escapeControlChars(modeText)}`,
  );
  const stack = (stacksPayload?.stacks ?? []).find((st) => st.members.some((m) => m.harnessId === task.agent));
  if (stack) {
    // A stack with fewer than two members has no backups: no `(n/m)`.
    const pos = stackPositionText(stack, task.agent);
    const position = pos === null ? "" : ` (${pos})`;
    out(`  ${label("stack")} ${escapeFreeText(stack.label)}${position}`);
    // Only rows that apply to this task's model: the account-wide row and the
    // row for its resolved model, never another model's.
    const taskModel = task.model ?? DEFAULT_MODEL[stack.kind];
    for (const s of limitRowsForModel(stacksPayload?.limitStates ?? [], task.agent, taskModel)) {
      out(`  ${label("cooling")} ${c.yellow(coolingText(s))}`);
      const msg = memberStateText(s).message;
      if (msg) out(`    ${c.dim(escapeFreeText(msg))}`);
    }
  }
  const hs = task.harnessState;
  if (hs?.allExhausted) {
    const text = failoverText(task, stack?.members.find((m) => m.harnessId === task.agent)?.label ?? null);
    out(`  ${label("failover")} ${c.yellow(escapeFreeText(text))}`);
    const resetAt = hs.allExhausted.earliestResetAtMs;
    if (resetAt != null) out(`    earliest reset: ${new Date(resetAt).toLocaleString()}`);
    for (const r of hs.allExhausted.memberReasons ?? []) {
      out(`    - ${escapeFreeText(memberReasonText(r))}`);
    }
  }
  if (hs?.scheduledSwitch) {
    out(`  ${label("switch")} ${c.cyan("switch to the next account scheduled for the end of this turn")} ${c.dim(`(agetor switch-account ${task.id.slice(0, 8)} --cancel to undo)`)}`);
  }
  // Same TTL and precedence as the webview banner.
  if (hs?.lastMove?.reason === "switch-now" && harnessStackBannerMode(hs) === "moved") {
    out(`  ${label("switch")} ${escapeFreeText(harnessMoveNote(hs.lastMove, task.agent))} ${c.dim(`(${new Date(hs.lastMove.at).toLocaleString()})`)}`);
  }
  out(`  ${label("workdir")} ${c.dim(task.workdir)}`);
  if (task.branch) out(`  ${label("branch")} ${escapeControlChars(task.branch)}`);
  // Last-seen worktree checkout (recorded at run start/settle, terminal open,
  // archive). Drift off the task branch is tolerated, so say where it is.
  if (task.checkoutBranch) {
    const drifted = task.branch != null && task.checkoutBranch !== task.branch;
    out(
      `  ${label("checkout")} ${escapeControlChars(task.checkoutBranch)}` +
        (drifted ? c.yellow(" (drifted from task branch)") : ""),
    );
  }
  if (task.issueUrl) out(`  ${label("issue")} ${task.issueUrl}`);
  if (task.agentProfile) {
    const deletedSuffix = await agentProfileDeletedSuffix(client, task);
    out(`  ${label("profile")} ${escapeControlChars(task.agentProfile.name)} (${task.agentProfile.id})${deletedSuffix}`);
  }
  if (task.importedClaude) {
    const branch = task.importedClaude.gitBranch ?? "no branch";
    out(
      `  ${label("imported")} ${escapeControlChars(task.importedClaude.sessionId)} ` +
        `(on ${escapeControlChars(branch)}, ${task.importedClaude.status})`,
    );
  } else if (task.importedOpencode) {
    const imported = task.importedOpencode;
    out(
      `  ${label("imported")} ${escapeControlChars(imported.sessionId)} ` +
        `(OpenCode via ${escapeControlChars(imported.harnessId)}, ${imported.status})`,
    );
    if (imported.status === "failed" && imported.error) out(c.yellow(`    ⚠ ${escapeFreeText(imported.error)}`));
  }
  if (task.pipelineId && task.pipelineRun) {
    const progress = pipelineStepProgress(task.pipelineRun);
    out(
      `  ${label("pipeline")} ${escapeControlChars(task.pipelineRun.pipelineName)} (${task.pipelineId})` +
        `   ${label("status")} ${colorRunStatus(task.pipelineRun.status)}   ${label("steps")} ${escapeControlChars(progress.label)}`,
    );
    // A block message can quote an agent's own handoff text verbatim.
    for (const b of task.pipelineRun.blocked) {
      out(c.yellow(`    ⚠ ${escapeFreeText(b.message)}`));
    }
    // Pending human gates (same shape `pipeline status` prints) — the run is
    // parked in Review until one is decided.
    const gates = task.pipelineRun.humanSteps ?? [];
    if (gates.length > 0) {
      const graph = task.pipelineRun.snapshot?.graph ?? null;
      const nameOf = (id: string) => escapeControlChars(graph ? stepNameById(graph, id) : id);
      out(c.cyan(`    ◆ ${gates.length} pending human review${gates.length === 1 ? "" : "s"}:`));
      for (const g of gates) {
        const from = g.arrivals.map((a) => nameOf(a.fromStepId)).join(", ") || "(manual)";
        out(`      ${nameOf(g.stepId)}  ${c.dim(`seq ${g.seq}`)}  ${c.dim(`from ${from}`)}`);
      }
      out(c.dim(`      decide with: agetor pipeline review ${task.id.slice(0, 8)}`));
    }
  }
  if (task.pipelineParentId) {
    const stepOf = await pipelineStepOfText(client, task);
    if (stepOf) out(`  ${label("step of")} ${stepOf}`);
  }
  // The prompt can be third-party text (`agetor add --issue` quotes an issue
  // body): line breaks fold to spaces for this one-line summary, and control
  // and invisible characters are escaped so none reaches the terminal.
  out(`  ${label("prompt")} ${c.dim(promptSummary(task.prompt))}`);
  if (pending.length > 0) {
    out(
      c.yellow(
        `  ! ${pending.length} pending interaction(s) — answer: agetor answer ${task.id.slice(0, 8)}`,
      ),
    );
    // `/tasks/:id/interactions/pending` aggregates a pipeline parent's step
    // interactions — say which step task each card actually belongs to when
    // it isn't the task the user asked about.
    for (const req of pending) {
      if (req.taskId !== task.id) {
        out(c.yellow(`    ↳ ${req.kind} on step task ${req.taskId.slice(0, 8)}`));
      }
    }
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
 * `auto`. The harness kind comes from `profileHarnessContext` (the
 * `listHarnesses()` row first — covers a custom-account harness whose id
 * differs from its `AgentKind` — falling back to treating `agent` itself as a
 * built-in kind id, which is how every built-in harness is seeded, mirroring
 * `defaultNonInteractiveMode` in `add.ts`) and the text is
 * `defaultModeFor(kind) + " (default)"`; when the kind can't be resolved at
 * all (harness deleted, listHarnesses failed) it is `"-"` rather than a guess.
 */
function resolveModeText(harness: ProfileHarnessContext, mode: string | null): string {
  if (mode) return mode;
  return harness.kind ? `${defaultModeFor(harness.kind)} (default)` : "-";
}

/** ` (deleted)` when the task's bound profile no longer exists — checked
 *  only when `agentProfileId` is set (a task can carry an `agentProfile`
 *  snapshot with a null id after `DELETE /tasks/:id/agent-profile`, though
 *  that route clears the snapshot too; this guard is defensive either way).
 *  Any error other than a clean 404 is swallowed — a flaky lookup must not
 *  make a live profile look deleted. */
async function agentProfileDeletedSuffix(client: AgetorClient, task: Task): Promise<string> {
  if (!task.agentProfileId) return "";
  try {
    await client.getAgentProfile(task.agentProfileId);
    return "";
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return c.dim(" (deleted)");
    return "";
  }
}

/**
 * `"<parent title> (<parent id>) · step <step name>"` for a hidden pipeline
 * step task (`task.pipelineParentId` set) — resolved via `GET /tasks/:id/
 * pipeline` (`getPipelineRun`) on the parent id, which both confirms the
 * parent is actually a pipeline task and returns its `pipelineRun.snapshot`
 * graph (frozen at first Run) to resolve the step's display name from
 * `task.pipelineStepId`. Falls back to the step task's own title when the
 * snapshot or step id isn't available (e.g. an old run predating the
 * snapshot). Never fails the whole `show` on a lookup error (L-CLI3): a
 * clean 404 means the parent row is gone — an ORPHANED step, which the
 * server lets you delete/archive directly (`isOrphanedPipelineStep`) — so
 * say so instead of swallowing it; any other error still prints the bare
 * parent id, so the relationship is never silently dropped.
 */
async function pipelineStepOfText(client: AgetorClient, task: Task): Promise<string | null> {
  if (!task.pipelineParentId) return null;
  const parentId = task.pipelineParentId;
  try {
    const { task: parent } = await client.getPipelineRun(parentId);
    const graph = parent.pipelineRun?.snapshot?.graph;
    const stepName = graph && task.pipelineStepId ? stepNameById(graph, task.pipelineStepId) : task.title;
    return `${escapeFreeText(parent.title)} (${parent.id}) · step ${escapeControlChars(stepName)}`;
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      return `${parentId} ${c.yellow("(pipeline task no longer exists — this step can be deleted/archived directly)")}`;
    }
    return parentId;
  }
}

function label(s: string): string {
  return c.dim(s + ":");
}
/** The `prompt:` line of `agetor show`: one line, at most 240 characters
 *  of the prompt, escaped for the terminal. */
export function promptSummary(prompt: string): string {
  return escapeFreeText(truncateText(prompt.replace(/[\r\n]+/g, " "), 240));
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
