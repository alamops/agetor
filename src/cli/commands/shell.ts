import { existsSync } from "node:fs";
import { getClient, type Flags } from "../context.ts";
import { resolveTask } from "../resolve.ts";
import { c, out, isTTY } from "../output.ts";
import { usageError } from "../usage.ts";
import { flagValue } from "../args.ts";
import { escapeFreeText } from "../../shared/terminal-text.ts";

/**
 * Open a shell in the task's worktree (or its workdir when isolation is off) —
 * the terminal equivalent of the app's worktree terminal tab. `--print` / `-p`
 * just echoes the directory so you can `cd "$(agetor shell -p <id>)"`.
 */
export async function cmdShell(args: string[], flags: Flags): Promise<void> {
  const repoIdx = args.indexOf("--repo");
  const repoFlag = repoIdx >= 0 ? flagValue(args, repoIdx + 1, "--repo") : null;
  // Skip the `--repo` value only when the flag is actually present: with no
  // `--repo`, `repoIdx` is -1 and the old `i !== repoIdx + 1` test skipped
  // index 0 — i.e. the task id in the documented `agetor shell <task-id>` form.
  const ref = args.find((a, i) => !a.startsWith("-") && (repoIdx < 0 || i !== repoIdx + 1));
  if (!ref) throw usageError("shell");
  const printOnly = args.includes("--print") || args.includes("-p");

  const client = await getClient(flags);
  const task = await resolveTask(client, ref);
  let dir = task.worktreePath ?? task.workdir;
  if (repoFlag) {
    const entry = (task.repositories ?? []).find((r) => r.name === repoFlag);
    if (!entry) throw new Error(`no repository "${repoFlag}" on this task (have: ${(task.repositories ?? []).map((r) => r.name).join(", ") || "none"})`);
    dir = entry.worktreePath ?? entry.path;
  }

  if (printOnly) {
    out(dir);
    return;
  }
  if (!existsSync(dir)) {
    // A multi-repository task's `workdir` is its workspace root, which agetor
    // creates when the task first starts. Before that (or if every repository
    // worktree was torn down) the root is simply absent — reporting "directory
    // no longer exists" implied it had been deleted. Name the real state and
    // the way to get a usable shell today.
    const repos = task.repositories ?? [];
    if (!repoFlag && repos.length > 1 && !repos.some((r) => r.worktreePath)) {
      throw new Error(
        "this multi-repository task has no worktrees yet — start the task first, "
          + "or use --repo <name> to open one repository's source checkout",
      );
    }
    throw new Error(`directory no longer exists: ${dir}`);
  }
  if (!isTTY) {
    throw new Error(
      "agetor shell needs an interactive terminal (TTY) — use --print to just print the path",
    );
  }

  const shell = process.env.SHELL || "/bin/zsh";
  const where = task.branch ? `${c.dim(dir)} ${c.dim(`(${task.branch})`)}` : c.dim(dir);
  out(`${c.green("●")} ${c.bold(escapeFreeText(task.title))} — ${where} · Ctrl-D to exit`);
  const proc = Bun.spawn([shell], {
    cwd: dir,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exitCode = (await proc.exited) ?? 0;
}
