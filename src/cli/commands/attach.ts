import { getClient, type Flags } from "../context.ts";
import { resolveTask } from "../resolve.ts";
import { c, out, isTTY } from "../output.ts";
import { usageError } from "../usage.ts";
import type { AgetorClient } from "../api-client.ts";

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

/** The harness's kind, from the harness list (a custom account's id differs from its kind), else the id itself (every built-in is seeded under its kind); null when neither resolves. */
async function harnessKindOf(client: AgetorClient, harnessId: string): Promise<string | null> {
  try {
    const { harnesses } = await client.listHarnesses();
    const row = harnesses.find((h) => h.id === harnessId);
    if (row) return row.kind;
  } catch { /* the id fallback below */ }
  return harnessId;
}

/**
 * The text of the error `agetor attach` gives when an OpenCode 2.x turn has
 * no tmux session because it runs on the agetor-managed OpenCode server (a
 * child of the core, hosted for the whole app, not one session per turn), or
 * null when `latest` (the task's newest run) is not such a turn. A server turn
 * is stamped with no tmux session; an OpenCode 1.x (or `opencode run`) turn
 * always has one. Only the follow commands that exist are named: `agetor logs`
 * streams the run's events and `agetor show` prints its state.
 */
export function opencodeServerTurnAttachError(
  taskId: string,
  harnessKind: string | null,
  latest: { tmuxSession: string | null } | undefined,
): string | null {
  if (harnessKind !== "opencode" || !latest || latest.tmuxSession) return null;
  const id = taskId.slice(0, 8);
  return (
    "no tmux session — this OpenCode turn runs on the agetor-managed OpenCode server, which has no " +
    "terminal to attach to. Follow it in the app, with 'agetor logs " + id + "' " +
    "(add --no-follow for a snapshot) or 'agetor show " + id + "'"
  );
}

/**
 * Attach the current terminal to a task's live tmux session — the
 * in-terminal equivalent of the app's "Open in tmux". Every tmux-hosted
 * agent kind runs in a per-task tmux session (fx alone is a plain child
 * process with none): claude-code's lives for the whole task, while for the
 * turn-only kinds — codex, cursor, gemini and antigravity — it exists only
 * while a turn is in flight (each turn is a fresh one-shot session). The
 * kinds without one: fx and cursor (child processes speaking ACP), and an
 * OpenCode 2.x turn, which runs on the agetor-managed OpenCode server
 * ({@link opencodeServerTurnAttachError}); an OpenCode 1.x (`opencode run`)
 * turn is tmux-hosted like codex. Agetor creates sessions on tmux's default
 * socket (no -L/-S) in production, named `agetor-<id>`, so a plain `tmux
 * attach` finds them; under an active non-default socket (test isolation)
 * `cliTmuxSocketArgs()` threads the matching `-L <name>` through. Detach
 * with Ctrl-b d.
 */
export async function cmdAttach(args: string[], flags: Flags): Promise<void> {
  const ref = args[0];
  if (!ref) throw usageError("attach");
  if (!isTTY) throw new Error("agetor attach needs an interactive terminal (TTY)");

  const client = await getClient(flags);
  const task = await resolveTask(client, ref);
  const runs = await client.getRuns(task.id);
  const serverTurn = opencodeServerTurnAttachError(task.id, await harnessKindOf(client, task.agent), runs[0]);
  if (serverTurn) throw new Error(serverTurn);
  const session = runs.find((r) => r.tmuxSession)?.tmuxSession ?? null;
  if (!session) {
    throw new Error(
      "no tmux session — attach needs a task that has run (try 'agetor start' first); " +
        "for codex, gemini, antigravity and an OpenCode 1.x turn it only exists while a turn is in flight",
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
