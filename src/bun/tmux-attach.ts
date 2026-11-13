// The shell command Agetor hands to Terminal.app when the user clicks
// "Open in Terminal" / "Open tmux" for a task (POST /tasks/:id/open-tmux).
//
// Pure string construction — no spawning, no environment reads — so the exact
// command is unit-testable without a live Terminal window. `server.ts` wraps
// the result in `toTerminalAppleScript` (agents.ts) and runs osascript.
//
// Why this is a separate module (issue #298): the old route hand-rolled the
// command inline with double-quote escaping for AppleScript, which made the
// two failure modes from the report invisible to tests:
//
//   1. The bundled tmux links a vendored libncursesw whose compiled-in
//      terminfo directory is the build machine's Homebrew Cellar path. A tty
//      client then died with `can't find terminfo database` before the shell
//      started. `terminfoDirs` carries the real search path
//      (`<bundle>/bin/terminfo:/usr/share/terminfo`) so the terminal session
//      can resolve a TERM — only ever set for the bundled binary.
//   2. The old command used `exec`, so the shell was replaced by tmux and a
//      failure closed the window instantly (`[Process completed]`) with no
//      way to read the error. This command deliberately does NOT use `exec`:
//      it appends a fallback that prints the failure and waits for Enter, so
//      the window stays open and the user can read what happened.

/** Inputs for {@link buildTmuxAttachCommand}. */
export interface TmuxAttachCommandInput {
  /** Absolute path to the resolved tmux binary. */
  tmuxPath: string;
  /** Socket selector args (`tmuxSocketArgs()` — `["-L", "agetor"]`, or `[]`
   *  for tmux's default socket). */
  socketArgs: string[];
  /** The session to attach to (`agetor-<taskId-prefix>`). */
  sessionName: string;
  /** `terminfoDirsFor()`'s value for a BUNDLED binary; `null`/`undefined` for
   *  system tmux, which keeps its own lookup. */
  terminfoDirs?: string | null;
}

/** POSIX single-quote: safe for spaces, `$`, backticks, `;`, globs — and a
 *  literal `'` is expressed as the standard `'\''` sequence. */
function sq(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * The one-line shell command for the attach. Shape:
 *
 *   /bin/sh -c '[TERMINFO_DIRS=… ]<tmux> <-L socket> attach -t <session> || { … }'
 *
 * The outer `/bin/sh -c` is load-bearing: Terminal.app's `do script` runs the
 * command through the user's LOGIN shell, which may be fish or nushell — those
 * do not parse a POSIX `VAR=val cmd` prefix, the `{ …; }` group, or `read -r`.
 * Naming /bin/sh explicitly makes the command interpreter-independent (and
 * `/bin/sh` ships with every macOS).
 *
 * The trailing fallback prints a readable error and waits for Enter instead of
 * letting Terminal close on failure. It is intentionally part of the command
 * (pinned by a unit test) because the route cannot observe a failure that
 * happens *inside* the terminal's shell — osascript returns 0 as soon as
 * Terminal accepts the command, so only the shell can report this one.
 */
export function buildTmuxAttachCommand(input: TmuxAttachCommandInput): string {
  const parts: string[] = [];
  if (input.terminfoDirs) parts.push(`TERMINFO_DIRS=${sq(input.terminfoDirs)}`);
  parts.push(sq(input.tmuxPath));
  for (const arg of input.socketArgs) parts.push(sq(arg));
  parts.push("attach", "-t", sq(input.sessionName));
  const script =
    parts.join(" ") +
    " || { echo; echo 'Agetor could not attach to the tmux session.'; echo 'Press Enter to close this window.'; read -r _; }";
  // `sq` also neutralizes the script's own single quotes for the login shell;
  // inside /bin/sh they come back as the quoting the inner command expects.
  return `/bin/sh -c ${sq(script)}`;
}
