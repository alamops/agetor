import { getClient, type Flags } from "../context.ts";
import { resolveTask } from "../resolve.ts";
import { c, out, isTTY } from "../output.ts";

/**
 * Attach the current terminal to a claude-code task's live tmux session — the
 * in-terminal equivalent of the app's "Open in tmux". Agetor creates sessions
 * on tmux's default socket (no -L/-S), named `agetor-<id>`, so a plain
 * `tmux attach` finds them. Detach with Ctrl-b d.
 */
export async function cmdAttach(args: string[], flags: Flags): Promise<void> {
  const ref = args[0];
  if (!ref) throw new Error("usage: agetor attach <task-id>");
  if (!isTTY) throw new Error("agetor attach needs an interactive terminal (TTY)");

  const client = await getClient(flags);
  const task = await resolveTask(client, ref);
  const runs = await client.getRuns(task.id);
  const session = runs.find((r) => r.tmuxSession)?.tmuxSession ?? null;
  if (!session) {
    throw new Error(
      "no tmux session — attach is for claude-code tasks that have run (try 'agetor start' first)",
    );
  }

  const tmuxBin = process.env.AGETOR_TMUX_BIN ?? "tmux";
  const alive = Bun.spawnSync([tmuxBin, "has-session", "-t", session], {
    stdout: "ignore",
    stderr: "ignore",
  });
  if (alive.exitCode !== 0) {
    throw new Error(
      `tmux session '${session}' is gone — respawn it with ` +
        `'agetor send ${task.id.slice(0, 8)} <message>'`,
    );
  }

  out(c.dim(`attaching to ${session} — detach with Ctrl-b d`));
  const proc = Bun.spawn([tmuxBin, "attach", "-t", session], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exit(await proc.exited);
}
