import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { getClient, type Flags } from "../context.ts";
import { resolveTask } from "../resolve.ts";
import { c, errln, out, printJson } from "../output.ts";
import { ApiError, type PatchTaskInput } from "../api-client.ts";
import { COLUMNS, describeArchiveUncommittedChanges, isArchiveUncommittedChanges } from "../../shared/types.ts";
import { flagValue } from "../args.ts";
import { parseOpencodeServerFlag, parseSpeedFlag, usageError, warnOpencodeServerFlagIgnored } from "../usage.ts";
import { escapeControlChars, escapeFreeText } from "../../shared/terminal-text.ts";
import { isMultiRepoTask } from "../../shared/multi-repo.ts";
import type { Task, WorktreeTeardownResult } from "../../shared/types.ts";

const COLUMN_IDS = COLUMNS.map((col) => col.id);

export async function cmdEdit(args: string[], flags: Flags): Promise<void> {
  const ref = args[0];
  if (!ref) throw usageError("edit");
  const patch: PatchTaskInput = {};
  let detachProfile = false;
  let opencodeServerIgnored = false;
  const removeRepos: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const a = args[i]!;
    const val = (allowDash = false) => flagValue(args, ++i, a, allowDash);
    switch (a) {
      case "--title": patch.title = val(); break;
      case "--prompt": patch.prompt = val(); break;
      case "--prompt-file": {
        const f = val(true);
        patch.prompt = f === "-" ? (await Bun.stdin.text()).trim() : readFileSync(f, "utf8");
        break;
      }
      case "--agent": patch.agent = val(); break;
      // Resolve relative to the CLI's cwd, matching `add`/`projects add` —
      // the daemon that ultimately runs git ops may have a different cwd.
      case "--workdir": patch.workdir = path.resolve(val()); break;
      case "--model": patch.model = val(); break;
      case "--mode": patch.mode = val(); break;
      case "--effort": patch.effort = val(); break;
      // --fast / --no-fast are aliases of --speed fast / off; the later of
      // several speed flags wins. Only `speed` goes on the wire.
      case "--speed": patch.speed = parseSpeedFlag(val()); break;
      case "--fast": patch.speed = "fast"; break;
      case "--no-fast": patch.speed = "off"; break;
      case "--max-mode": patch.maxMode = true; break;
      case "--no-max-mode": patch.maxMode = false; break;
      // Retired: validated so an old script's typo still fails, then dropped
      // (never sent) with one stderr notice.
      case "--opencode-server": opencodeServerIgnored = parseOpencodeServerFlag(val()); break;
      case "--type": patch.taskType = val(); break;
      case "--column": patch.column = val(); break;
      case "--detach-profile": detachProfile = true; break;
      case "--remove-repo": removeRepos.push(val()); break;
      default: break;
    }
  }
  const nothingToPatch = Object.keys(patch).length === 0 && !detachProfile && removeRepos.length === 0;
  if (nothingToPatch && !opencodeServerIgnored) {
    throw new Error(
      "nothing to edit — pass at least one of --title/--prompt/--agent/--workdir/--model/--mode/--effort/--speed/--fast/--no-fast/--max-mode/--no-max-mode/--type/--column/--detach-profile/--remove-repo",
    );
  }
  if (patch.column && !COLUMN_IDS.includes(patch.column as (typeof COLUMN_IDS)[number])) {
    throw new Error(`unknown column "${patch.column}" — one of: ${COLUMN_IDS.join(", ")}`);
  }
  const client = await getClient(flags);
  const task = await resolveTask(client, ref);
  // The retired flag's notice comes after the ref resolved, so a typo'd ref
  // is still an error. An old script whose only flag was the retired one
  // then succeeds: there is nothing to change, and the notice says why.
  if (opencodeServerIgnored) warnOpencodeServerFlagIgnored();
  if (nothingToPatch) return;
  // Detach first so a combined `--detach-profile --model …` unlocks the
  // bound fields before the patch that wants to change them — the server
  // 409s a PATCH that touches agent/mode/model/effort/speed/maxMode while
  // still bound. That 409's message says "agent" (the server's own
  // vocabulary — "agent" = harness there), which would read as nonsense at
  // the CLI boundary where "agent" = harness and "profile" = agent profile
  // (docs/plans/task-details-agent-row.md D4); rewrite it in place rather
  // than change the server string, which the webview also reads verbatim.
  // Every other error this command can raise still propagates unmodified.
  let updated = detachProfile ? await client.detachTaskAgentProfile(task.id) : task;
  // Repository removals (issue #291), in the order given, before any patch;
  // the first refusal stops the command with the core's message (`running`,
  // `dirty`, `last-repository`, `not-multi`, `pipeline-step`). Each success
  // prints the escaped status line unless `--json`.
  for (const name of removeRepos) {
    const before = (updated.repositories ?? []).find((r) => r.name === name) ?? null;
    updated = await client.removeTaskRepository(updated.id, name);
    if (!flags.json) out(removedRepositoryLine(updated, name, before?.branch ?? null));
  }
  if (Object.keys(patch).length > 0) {
    try {
      updated = await client.patchTask(updated.id, patch);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.message.startsWith("task is bound to agent")) {
        const rewritten = err.message.replace(/^task is bound to agent/, "task is bound to profile");
        throw new Error(`${rewritten} (agetor edit ${task.id.slice(0, 8)} --detach-profile)`);
      }
      // A live run blocks an account switch. The core suggests nothing, so
      // point at the command that waits for the end of the turn. Any other
      // message (including the "may have gone through" transport wording)
      // propagates unchanged.
      if (patch.agent !== undefined && err instanceof ApiError && err.status === 409 && err.message.includes("stop the run before switching accounts")) {
        throw new Error(`${err.message} — or run 'agetor switch-account ${task.id.slice(0, 8)}' to schedule the switch for the end of the turn`);
      }
      throw err;
    }
  }
  if (flags.json) return printJson(updated);
  // model/mode/effort changes are forwarded to a live claude session by the
  // server (reconcileTaskSession sends /model, /effort, cycles mode).
  const changed = [...(detachProfile ? ["detach-profile"] : []), ...Object.keys(patch)];
  if (changed.length === 0) return; // only removals, each already reported
  out(`${c.green("✓")} updated ${c.dim(updated.id.slice(0, 8))} — ${changed.join(", ")}`);
}

/** The success line for one `--remove-repo`. Repository and branch names are
 *  agent/user-controlled text, so both go through the identifier escaper. */
export function removedRepositoryLine(task: Pick<Task, "id">, name: string, branch: string | null): string {
  const kept = branch ? ` (branch ${escapeControlChars(branch)} kept)` : "";
  return `${c.green("✓")} removed repository ${escapeControlChars(name)} from ${c.dim(task.id.slice(0, 8))}${kept}`;
}

export async function cmdMove(args: string[], flags: Flags): Promise<void> {
  const ref = args[0];
  const column = args[1];
  if (!ref || !column) {
    throw usageError("move");
  }
  if (!COLUMN_IDS.includes(column as (typeof COLUMN_IDS)[number])) {
    throw new Error(`unknown column "${column}" — one of: ${COLUMN_IDS.join(", ")}`);
  }
  const client = await getClient(flags);
  const task = await resolveTask(client, ref);
  const updated = await client.patchTask(task.id, { column });
  if (flags.json) return printJson(updated);
  out(`${c.cyan("→")} moved ${c.dim(updated.id.slice(0, 8))} → ${column}`);
}

export async function cmdArchive(args: string[], flags: Flags): Promise<void> {
  let ref: string | undefined;
  let discardChanges = false;
  for (const a of args) {
    if (a === "--discard-changes") discardChanges = true;
    else if (a.startsWith("-")) throw usageError("archive");
    else if (ref === undefined) ref = a;
    else throw usageError("archive");
  }
  if (!ref) throw usageError("archive");
  const client = await getClient(flags);
  const task = await resolveTask(client, ref);
  let updated: Task & { teardown?: WorktreeTeardownResult };
  try {
    // Wait for the worktree removal so the command reports what happened to
    // the checkout, not what was queued (issue #315).
    updated = await client.archiveTask(task.id, { forceWorktree: discardChanges, awaitTeardown: true });
  } catch (e) {
    // Archive removes the worktree; the core refuses when that would discard
    // uncommitted work, and nothing changed. Say why and how to go ahead.
    if (e instanceof ApiError && e.status === 409 && isArchiveUncommittedChanges(e.body)) {
      const names = e.body.repositories.map((n) => escapeControlChars(n));
      throw new Error(`${describeArchiveUncommittedChanges(names)} Re-run with --discard-changes to archive anyway.`);
    }
    throw e;
  }
  if (flags.json) return printJson(updated);
  out(`${c.green("✓")} archived ${taskLabel(updated)}`);
  for (const line of archiveReport(task, updated.teardown)) out(line);
}

/** `<id8>  <title>`, the head of the archive and unarchive reports. */
function taskLabel(task: Task): string {
  return `${c.dim(task.id.slice(0, 8))}  ${escapeFreeText(task.title)}`;
}

/** `path` with the home directory shortened to `~`, escaped for the terminal. */
export function tildePath(p: string, home: string = homedir()): string {
  const short = home && (p === home || p.startsWith(home + path.sep)) ? `~${p.slice(home.length)}` : p;
  return escapeControlChars(short);
}

/** Why a checkout is still on disk, from its teardown `reason`. */
function keptReason(reason: WorktreeTeardownResult["reason"]): string {
  switch (reason) {
    case "dirty": return "it has uncommitted changes";
    case "workspace-not-empty": return "it holds files outside its repositories";
    case "source-missing": return "its source repository no longer exists";
    default: return "the removal failed";
  }
}

const REMOVE_HINT = "Remove it from the Worktrees page, or by hand.";

/**
 * The lines under `✓ archived <id>` (issue #315): what the archive did to the
 * task's checkouts, from the teardown outcome the core reports
 * (`awaitTeardown`) and the row as it was before the archive. A removed
 * worktree says its branch was kept (unarchive re-creates the worktree from
 * it); a checkout still on disk is a `!` line with the reason and what to do;
 * the archive succeeded either way. Nothing to remove (`isolation: "none"`,
 * never started, a pipeline step, already gone), or a core too old to report
 * the outcome, adds no lines.
 */
export function archiveReport(
  task: Task,
  teardown: WorktreeTeardownResult | undefined,
  home: string = homedir(),
): string[] {
  if (!teardown) return [];
  const gone = (r: WorktreeTeardownResult) => r.reason === "no-worktree" || r.reason === "already-absent";
  const id8 = task.id.slice(0, 8);
  const hint = c.dim(`(agetor unarchive ${id8} restores it)`);

  if (!teardown.repositories) {
    if (!teardown.removed) {
      if (gone(teardown)) return [];
      const where = task.worktreePath ? ` ${tildePath(task.worktreePath, home)}` : "";
      return [
        `  ${c.yellow("!")} worktree still on disk:${where} ${c.dim(`(${keptReason(teardown.reason)})`)}`,
        `    ${REMOVE_HINT}`,
      ];
    }
    const rows: [string, string][] = [];
    if (task.worktreePath) rows.push(["worktree removed", tildePath(task.worktreePath, home)]);
    else rows.push(["worktree removed", ""]);
    if (task.branch) rows.push(["branch kept", escapeControlChars(task.branch)]);
    const width = Math.max(...rows.map(([label]) => label.length));
    return rows.map(([label, value], i) => {
      const line = `  ${c.gray(label.padEnd(width))}  ${value}`.trimEnd();
      return i === rows.length - 1 ? `${line}  ${hint}` : line;
    });
  }

  // A multi-repository task: one row per repository that had a checkout. A
  // problem row carries its `!` in the indent, so the names stay aligned.
  const branchOf = (name: string) => task.repositories?.find((r) => r.name === name)?.branch ?? null;
  const pathOf = (name: string) => task.repositories?.find((r) => r.name === name)?.worktreePath ?? null;
  const shown = teardown.repositories.filter((r) => !gone(r.result) || r.result.removed);
  const width = Math.max(0, ...shown.map((r) => escapeControlChars(r.name).length));
  const lines: string[] = [];
  let stuck = false;
  for (const { name, result } of shown) {
    const label = escapeControlChars(name).padEnd(width);
    if (result.removed) {
      const branch = branchOf(name);
      lines.push(`  ${c.bold(label)}  worktree removed${branch ? ` · branch ${escapeControlChars(branch)} kept` : ""}`);
    } else {
      stuck = true;
      const p = pathOf(name);
      lines.push(
        `${c.yellow("!")} ${c.bold(label)}  worktree still on disk:${p ? ` ${tildePath(p, home)}` : ""} ${c.dim(`(${keptReason(result.reason)})`)}`,
      );
    }
  }
  // Every checkout went, but the task workspace survives on other files.
  if (!teardown.removed && !stuck && !gone(teardown)) {
    stuck = true;
    const root = task.worktreePath ?? task.workdir;
    lines.push(`  ${c.yellow("!")} task workspace still on disk: ${tildePath(root, home)} ${c.dim(`(${keptReason(teardown.reason)})`)}`);
  }
  if (stuck) lines.push(`    ${REMOVE_HINT}`);
  else if (lines.length > 0) lines.push(`  ${hint}`);
  return lines;
}

export async function cmdUnarchive(args: string[], flags: Flags): Promise<void> {
  const ref = args[0];
  if (!ref) throw usageError("unarchive");
  const client = await getClient(flags);
  const task = await resolveTask(client, ref);
  const updated = await client.unarchiveTask(task.id);
  if (flags.json) return printJson(updated);
  out(`${c.green("✓")} unarchived ${taskLabel(updated)}`);
  for (const line of unarchiveReport(updated, existsSync)) out(line);
}

/**
 * The lines under `✓ unarchived <id>`: whether each worktree is back on disk.
 * The core re-creates them before it answers, so the CLI (always on the same
 * machine as the core) checks the paths. A checkout that isn't back is
 * re-created on the task's next start. A task with no worktree of its own
 * (`isolation: "none"`, a pipeline step) adds no lines.
 */
export function unarchiveReport(
  task: Task,
  exists: (p: string) => boolean,
  home: string = homedir(),
): string[] {
  if (task.isolation !== "worktree" || task.pipelineParentId) return [];
  const id8 = task.id.slice(0, 8);
  const missingHint = `    ${c.dim(`agetor start ${id8} re-creates it.`)}`;
  if (!isMultiRepoTask(task)) {
    if (!task.worktreePath) return [];
    const p = tildePath(task.worktreePath, home);
    if (!exists(task.worktreePath)) return [`  ${c.yellow("!")} worktree not re-created: ${p}`, missingHint];
    const branch = task.branch ? `  ${c.dim(`(branch ${escapeControlChars(task.branch)})`)}` : "";
    return [`  ${c.gray("worktree re-created")}  ${p}${branch}`];
  }
  const repos = (task.repositories ?? []).filter((r) => r.worktreePath);
  const width = Math.max(0, ...repos.map((r) => escapeControlChars(r.name).length));
  const lines: string[] = [];
  let missing = false;
  for (const r of repos) {
    const label = c.bold(escapeControlChars(r.name).padEnd(width));
    if (exists(r.worktreePath!)) {
      lines.push(`  ${label}  worktree re-created${r.branch ? ` · branch ${escapeControlChars(r.branch)}` : ""}`);
    } else {
      missing = true;
      lines.push(`${c.yellow("!")} ${label}  worktree not re-created: ${tildePath(r.worktreePath!, home)}`);
    }
  }
  if (missing) lines.push(missingHint);
  return lines;
}
