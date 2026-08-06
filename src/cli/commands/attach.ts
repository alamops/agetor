import { getClient, type Flags } from "../context.ts";
import { resolveTask } from "../resolve.ts";
import { c, out, isTTY } from "../output.ts";
import { usageError } from "../usage.ts";

/**
 * Mirrors `tmuxSocketName()`/`tmuxSocketArgs()` from `../../bun/tmux-resolution.ts`
 * (same precedence: `AGETOR_TMUX_SOCKET` env override, `"default"` forcing
 * tmux's own default socket, else `NODE_ENV === "test"` → `"agetor-test"`,
 * else `null`/production default) rather than importing that module. That
 * module pulls in `db.ts`, which opens (and migrates) the SQLite database as
 * a module-load side effect — exactly what `core-creds.ts` documents the CLI
 * must never do so it can talk to a running core without booting a second DB
 * handle on the same file. Keep this in sync with tmux-resolution.ts if its
 * precedence ever changes.
 */
function cliTmuxSocketArgs(): string[] {
  const override = process.env.AGETOR_TMUX_SOCKET;
  const name = override ? (override === "default" ? null : override)
    : process.env.NODE_ENV === "test" ? "agetor-test"
    : null;
  return name ? ["-L", name] : [];
}

/**
 * Attach the current terminal to a claude-code task's live tmux session — the
 * in-terminal equivalent of the app's "Open in tmux". Agetor creates sessions
 * on tmux's default socket (no -L/-S) in production, named `agetor-<id>`, so
 * a plain `tmux attach` finds them; under an active non-default socket (test
 * isolation) `cliTmuxSocketArgs()` threads the matching `-L <name>` through.
 * Detach with Ctrl-b d.
 */
export async function cmdAttach(args: string[], flags: Flags): Promise<void> {
  const ref = args[0];
  if (!ref) throw usageError("attach");
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
  const socketArgs = cliTmuxSocketArgs();
  const alive = Bun.spawnSync([tmuxBin, ...socketArgs, "has-session", "-t", session], {
    stdout: "ignore",
    stderr: "ignore",
  });
  if (alive.exitCode !== 0) {
    throw new Error(
      `tmux session '${session}' is unreachable via '${tmuxBin}' — if the app uses bundled ` +
        `tmux, set AGETOR_TMUX_BIN to match; otherwise respawn it with ` +
        `'agetor send ${task.id.slice(0, 8)} <message>'`,
    );
  }

  // Best-effort unpin of a stuck `window-size manual` pin before attaching —
  // this CLI surface can't import claude-tmux.ts's `healWindowSize` (see the
  // module comment above), so it duplicates the minimal fix inline. See
  // `healWindowSize` in ../../bun/claude-tmux.ts for the full rationale.
  Bun.spawnSync(
    [tmuxBin, ...socketArgs, "set-window-option", "-t", "=" + session, "window-size", "latest"],
    { stdout: "ignore", stderr: "ignore" },
  );

  out(c.dim(`attaching to ${session} — detach with Ctrl-b d`));
  const proc = Bun.spawn([tmuxBin, ...socketArgs, "attach", "-t", session], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exit(await proc.exited);
}
