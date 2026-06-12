import { COLUMNS } from "../shared/types.ts";

const COLUMN_IDS = COLUMNS.map((col) => col.id).join(", ");

/**
 * Per-command help blocks. `agetor <cmd> --help` prints the whole block;
 * `usageError(cmd)` throws just the first (`usage:`) line so a bad-argument
 * error stays concise. One source, so help and the error never drift.
 *
 * Each entry's FIRST line is a complete, standalone `usage:` line.
 */
export const USAGE: Record<string, string> = {
  add: `usage: agetor add [flags]   (no flags → guided wizard)

  Create a task.
    --title <s>        task title          --prompt <s> | --prompt-file <p>
    --agent <id>       harness id          --workdir <path>   git repo to run in
    --isolation <m>    worktree | none     --base-ref <ref>   branch base (default HEAD)
    --model <id>   --mode <id>   --effort <id>
    --type <t>         task | subtask | epic | feature | bug | spike
    --ref <path>       attach a file/folder reference (repeatable)
    --start            run immediately (creates in 'ready', not 'backlog')`,

  ls: `usage: agetor ls [filters]

  List tasks. Filters combine (substring match for --repo/--search):
    --column <c>   --agent <id>   --type <t>   --repo <s>   --search <s>
    --archived     archived only        --all   include archived`,

  ps: `usage: agetor ps

  List running / blocked tasks only — the active subset of 'ls'.`,

  show: `usage: agetor show <task-id>

  Task details, run history (newest first), and any pending interactions.`,

  start: `usage: agetor start <task-id>

  Run a not-yet-run task. A finished task continues via 'send'; a running one
  stops via 'cancel'.`,

  send: `usage: agetor send <task-id> <message…>

  Message a task. Resumes a finished task's session, or folds into the live turn
  if one is running. Blocked while the task is waiting on an answer.`,

  commit: `usage: agetor commit <task-id>

  Ask the agent to commit all changes and push the branch. Resumes the session
  like 'send'; refused while the task is still running.`,

  answer: `usage: agetor answer <task-id>

  Answer a task that needs input — an interactive picker for AskUserQuestion
  options or a tmux prompt.`,

  commands: `usage: agetor commands <task-id>

  List the slash commands (/…) and MCP/skill extensions (@…) available to the
  task's agent in its workdir — the CLI view of the app composer's autocomplete.`,

  logs: `usage: agetor logs <task-id> [--no-follow] [--notify] [--rebuild]

  Stream the task's live conversation. --no-follow prints the current scrollback
  and exits. --notify (while following) rings a desktop notification + bell when
  the task succeeds / fails / starts waiting on you (macOS). --rebuild prints the
  latest run reconstructed from the on-disk claude JSONL (recovery).`,

  cancel: `usage: agetor cancel <task-id>

  Stop the active run. The session stays alive for follow-ups (claude-code).`,

  attach: `usage: agetor attach <task-id>

  Attach your terminal to the task's live tmux session (claude-code only).
  Detach with Ctrl-b d.`,

  shell: `usage: agetor shell <task-id> [--print]

  Open a shell in the task's worktree (or its workdir when isolation is off) —
  the terminal version of the app's worktree terminal. --print / -p just echoes
  the directory, e.g. cd "$(agetor shell -p <id>)".`,

  edit: `usage: agetor edit <task-id> [flags]   (at least one flag)

  Patch a task. Changing model / mode / effort applies to a live session mid-run.
    --title <s>   --prompt <s> | --prompt-file <p>   --agent <id>   --workdir <p>
    --model <id>   --mode <id>   --effort <id>   --type <t>   --column <c>`,

  move: `usage: agetor move <task-id> <column>   (columns: ${COLUMN_IDS})

  Move a task between columns (mark done = move <id> done).`,

  archive: `usage: agetor archive <task-id>

  Archive a done task (unarchive <id> to restore).`,

  unarchive: `usage: agetor unarchive <task-id>

  Restore an archived task.`,

  diff: `usage: agetor diff <task-id>

  Show the task's git diff (worktree vs its pinned base ref).`,

  rm: `usage: agetor rm <task-id> [--yes]

  Delete a task, its worktree, and its branch. --yes skips the confirmation.`,

  projects: `usage: agetor projects <ls | add <path> [--name <n>] | rm <path> | branches <path>>

  Manage the registered project folders shown in the new-task picker.`,

  harness: `usage: agetor harness <ls | add <id> … | edit <id> … | enable <id> | disable <id> | rm <id> | shell <id>>

  Manage agent harnesses (aliases / parallel accounts).
  Run 'agetor harness add --help' / 'edit --help' for their flags;
  'agetor harness shell <id>' opens a shell with the harness env for login.`,

  // Subcommand-keyed blocks ("<cmd> <sub>") back both `agetor <cmd> <sub> --help`
  // and that subcommand's bad-argument error. Trivial subcommands (harness
  // enable/disable/rm, projects rm/branches) fall back to the command block.
  "projects add": `usage: agetor projects add <path> [--name <name>]

  Register a project folder (shown in the new-task workdir picker).`,

  "harness add": `usage: agetor harness add <id> --label <label> [--kind claude-code] [--home <abs>] [--bin <abs>] [--env KEY=VAL …]

  Create an agent harness — an alias, or a parallel account via a per-harness $HOME.`,

  "harness edit": `usage: agetor harness edit <id> [--label …] [--home <abs>|none] [--bin <abs>|none] [--env KEY=VAL …]

  Update a harness; pass 'none' to clear --home / --bin.`,

  "harness shell": `usage: agetor harness shell <id>

  Open your shell with the harness's env applied (CLAUDE_CONFIG_DIR / HOME, custom
  env, bin on PATH). Run 'claude /login' (or 'codex login') here to authenticate a
  parallel account against its own config. Ctrl-D to exit.`,

  daemon: `usage: agetor daemon <status | start | stop>

  Control the background headless core (used when the desktop app isn't open).`,

  info: `usage: agetor info

  Print the connected core's version.`,

  config: `usage: agetor config [<key> [value…]]

  View or set cross-session preferences stored in the core (the same store the
  app's settings use). No args lists all; one arg gets; key + value sets.
  Common keys: defaultHarness, lastModel:<kind>, lastMode:<kind>, lastEffort:<kind>.`,
};

const ALIASES: Record<string, string> = {
  mv: "move",
  msg: "send",
  inspect: "show",
  tail: "logs",
  delete: "rm",
  harnesses: "harness",
  project: "projects",
};

/** Resolve a command alias to its canonical name (for USAGE lookup). */
export function canonical(cmd: string): string {
  return ALIASES[cmd] ?? cmd;
}

/** The Error to throw when a command is misused — the centralized `usage:`
 *  line, so the error and `--help` share one source. */
export function usageError(cmd: string): Error {
  const block = USAGE[canonical(cmd)];
  return new Error(block ? block.split("\n", 1)[0]! : `unknown command: ${cmd}`);
}

/** Resolve the help block for `agetor <cmd> [sub] --help` / `agetor help <cmd>
 *  [sub]`: a subcommand block when one exists, else the command block, else
 *  undefined (the caller falls back to the global index). */
export function helpFor(cmd: string | undefined, sub: string | undefined): string | undefined {
  if (!cmd) return undefined;
  const name = canonical(cmd);
  return (sub ? USAGE[`${name} ${sub}`] : undefined) ?? USAGE[name];
}
