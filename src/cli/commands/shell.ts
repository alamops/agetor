import { existsSync } from "node:fs";
import { getClient, type Flags } from "../context.ts";
import { resolveTask } from "../resolve.ts";
import { c, out, isTTY } from "../output.ts";
import { usageError } from "../usage.ts";

/**
 * Open a shell in the task's worktree (or its workdir when isolation is off) —
 * the terminal equivalent of the app's worktree terminal tab. `--print` / `-p`
 * just echoes the directory so you can `cd "$(agetor shell -p <id>)"`.
 */
export async function cmdShell(args: string[], flags: Flags): Promise<void> {
  const ref = args.find((a) => !a.startsWith("-"));
  if (!ref) throw usageError("shell");
  const printOnly = args.includes("--print") || args.includes("-p");

  const client = await getClient(flags);
  const task = await resolveTask(client, ref);
  const dir = task.worktreePath ?? task.workdir;

  if (printOnly) {
    out(dir);
    return;
  }
  if (!existsSync(dir)) {
    throw new Error(`directory no longer exists: ${dir}`);
  }
  if (!isTTY) {
    throw new Error(
      "agetor shell needs an interactive terminal (TTY) — use --print to just print the path",
    );
  }

  const shell = process.env.SHELL || "/bin/zsh";
  const where = task.branch ? `${c.dim(dir)} ${c.dim(`(${task.branch})`)}` : c.dim(dir);
  out(`${c.green("●")} ${c.bold(task.title)} — ${where} · Ctrl-D to exit`);
  const proc = Bun.spawn([shell], {
    cwd: dir,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exitCode = (await proc.exited) ?? 0;
}
