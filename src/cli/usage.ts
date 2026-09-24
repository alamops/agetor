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
    --profile <id|name>  launch from a saved agent profile (agetor profile ls) —
                        cannot combine with --agent/--model/--mode/--effort/
                        --fast/--max-mode, the profile defines them
    --pipeline <id|name> launch a pipeline (agetor pipeline ls) instead of a
                        single agent — cannot combine with --profile or any
                        of --agent/--model/--mode/--effort/--fast/--max-mode
    --type <t>         task | subtask | epic | feature | bug | spike
    --ref <path>       attach a file/folder reference (repeatable)
    --issue <url>      seed title/prompt from a GitHub/GitLab issue + its thread
                        (needs --workdir or cwd inside the repo; --title/--prompt optional)
    --start            run immediately (creates in 'ready', not 'backlog')`,

  ls: `usage: agetor ls [filters]

  List tasks. Filters combine (substring match for --repo/--search):
    --column <c>   --agent <id>   --type <t>   --repo <s>   --search <s>
    --archived     archived only        --all   include archived
    --steps        also list hidden pipeline step tasks (hidden by default)`,

  ps: `usage: agetor ps

  List running / blocked tasks only — the active subset of 'ls'.`,

  show: `usage: agetor show <task-id>

  Task details, run history (newest first), and any pending interactions.`,

  start: `usage: agetor start <task-id>

  Run a not-yet-run task. A finished task continues via 'send'; a running one
  stops via 'cancel'.`,

  send: `usage: agetor send <task-id> <message…> [--ref <path> …]

  Message a task. Resumes a finished task's session, or folds into the live turn
  if one is running. Blocked while the task is waiting on an answer. --ref
  attaches a file/folder (repeatable, made absolute); image refs are attached to
  the turn. --ref with no message sends just the attachment(s).`,

  commit: `usage: agetor commit <task-id>

  Ask the agent to commit all changes and push the branch. Resumes the session
  like 'send'; refused while the task is still running.`,

  answer: `usage: agetor answer <task-id>

  Answer a task that needs input — an interactive picker for AskUserQuestion
  options or a tmux prompt.`,

  resume: `usage: agetor resume <task-id> [--cancel]

  Continue an fx response paused after repeated Vercel AI Gateway rate-limit
  (HTTP 429) retries. No new prompt is sent — fx resumes from its own
  checkpoint. Only an fx task whose latest run ended paused this way
  qualifies; sending a new message instead discards the paused response.
    --cancel   call off a pending automatic resume without resuming now —
               the task stays paused`,

  commands: `usage: agetor commands <task-id>

  List the slash commands (/…) and MCP/skill extensions (@…) available to the
  task's agent in its workdir — the CLI view of the app composer's autocomplete.`,

  logs: `usage: agetor logs <task-id> [--no-follow] [--notify] [--rebuild]

  Stream the task's live conversation. --no-follow prints the current scrollback
  and exits. --notify (while following) rings a desktop notification + bell when
  the task succeeds / fails / starts waiting on you (macOS). --rebuild prints the
  latest run reconstructed from the on-disk claude JSONL (recovery).`,

  files: `usage: agetor files <task-id> [--json]

  List files the agent has sent you (SendUserFile) — basename, size, sent time,
  and full path, newest first. --json prints the raw array (empty when none).`,

  cancel: `usage: agetor cancel <task-id>

  Stop the active run. The session stays alive for follow-ups (claude-code).
  On a pipeline task, stops every currently-active step execution instead.`,

  attach: `usage: agetor attach <task-id>

  Attach your terminal to the task's live tmux session (all agent kinds;
  for codex/gemini this only exists while a turn is in flight).
  Detach with Ctrl-b d.`,

  shell: `usage: agetor shell <task-id> [--print]

  Open a shell in the task's worktree (or its workdir when isolation is off) —
  the terminal version of the app's worktree terminal. --print / -p just echoes
  the directory, e.g. cd "$(agetor shell -p <id>)".`,

  edit: `usage: agetor edit <task-id> [flags]   (at least one flag)

  Patch a task. Changing model / mode / effort applies to a live session mid-run.
  A task bound to an agent profile refuses agent/mode/model/effort/fast/max-mode
  edits (409) — pass --detach-profile first (or alongside) to unlock them.
    --title <s>   --prompt <s> | --prompt-file <p>   --agent <id>   --workdir <p>
    --model <id>   --mode <id>   --effort <id>   --type <t>   --column <c>
    --detach-profile   unbind from the task's agent profile (keeps its values)`,

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

  clone: `usage: agetor clone <url> [--provider github|gitlab|bitbucket] [--dest <path>] [--no-eli5]

  Clone a repository and register it as a new project — the CLI view of the
  app's "Clone repository" dialog. <url> accepts https://…, git@host:owner/repo
  (or ssh://…) for GitHub, GitLab (including self-hosted), and Bitbucket
  Cloud, or bare 'owner/repo' shorthand (resolved against --provider, default
  github). A private https repo falls back to the token stored in Settings →
  Git host tokens when an anonymous clone is refused.
    --provider <p>   github | gitlab | bitbucket — only disambiguates
                      shorthand; a full URL's own detected provider wins
    --dest <path>     destination folder (default: ~/<repo-name>)
    --no-eli5         skip creating + starting the explainer task that
                       otherwise writes ELI5.md at the clone's root
  Ctrl+C cancels an in-flight clone (the partial checkout is removed).`,

  harness: `usage: agetor harness <ls | add <id> … | edit <id> … | enable <id> | disable <id> | rm <id> | shell <id>>

  Manage agent harnesses (aliases / parallel accounts).
  Run 'agetor harness add --help' / 'edit --help' for their flags;
  'agetor harness shell <id>' opens a shell with the harness env for login.`,

  profile: `usage: agetor profile <ls | show <ref> | add <name> … | edit <ref> … | rm <ref>>

  Manage agent profiles — a reusable harness + model + effort + mode +
  instructions + skills preset — pick one at launch with 'agetor add --profile'.
  <ref> is a profile id or its (unique, case-insensitive) name.
  Run 'agetor profile add --help' / 'edit --help' for their flags.`,

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

  "profile add": `usage: agetor profile add <name> --harness <id> --model <id> [--effort <id>] [--mode <id>] [--fast|--no-fast] [--max-mode|--no-max-mode] [--instructions <text> | --instructions-file <path|-> ] [--skill <name> …]

  Create a reusable agent profile. --harness and --model are required.
  --instructions-file - reads instructions from stdin. --skill is repeatable.`,

  "profile edit": `usage: agetor profile edit <ref> [--name <new>] [--harness <id>] [--model <id>] [--effort <id>] [--mode <id>] [--fast|--no-fast] [--max-mode|--no-max-mode] [--instructions <text> | --instructions-file <path|-> ] [--skill <name> …] [--clear-skills]   (at least one flag)

  Update a profile. --skill appends to the existing skill list unless
  --clear-skills is also given (then the list is replaced).`,

  pipeline: `usage: agetor pipeline <ls | show <ref> | rm <ref> | export <ref> [--out <file|->] [--force] | import <file|-> [--name <n>] | retry <task> [--from <task>] | advance <task> [--next <step>… | --finish] [--from <task>] | restart <task> | status <task>>

  Manage pipelines — named graphs of agent-profile-bound steps launched as
  one board task (built in the app's Pipelines editor; the CLI moves them
  around) — and control a pipeline TASK's run.
    ls / show / rm / export / import   take a pipeline <ref> (id, or its
                                        unique case-insensitive name)
    retry / advance / restart / status take a pipeline TASK <ref> (id or
                                        short-id prefix, like every other
                                        task-targeting command; a hidden
                                        step task's id is refused — target
                                        its pipeline task instead)
  Launch a pipeline with 'agetor add --pipeline <id|name>'.`,

  "pipeline export": `usage: agetor pipeline export <ref> [--out <file|->] [--force]

  Print (or write to --out; '-' is stdout) the pipeline as PipelineInput
  JSON (name/description/graph/maxSteps) — re-importable with 'pipeline
  import'. Refuses to overwrite an existing --out file unless --force.
  Each step also carries a 'profileName' hint (and 'subagents.profileNames')
  next to its agent-profile id so an import on another machine can remap
  the profile by name.`,

  "pipeline import": `usage: agetor pipeline import <file|-> [--name <name>]

  Create a pipeline from an exported JSON file ('-' reads stdin). --name
  overrides the file's own name. A step agent-profile id (or subagent
  profile id) that doesn't exist on this machine is remapped to the unique
  local profile named by the file's 'profileName' hint when there is one
  (printed), else warned about (--json: folded into 'warnings') — assign a
  profile in the editor before running such a pipeline.`,

  "pipeline retry": `usage: agetor pipeline retry <task-id> [--from <step-task-id-or-prefix>]

  Retry the pipeline run's currently blocked (or cancelled) step
  execution(s). 409 unless the run is actually blocked or cancelled. --from
  narrows the retry to one specific active execution (its step task's id or
  a unique prefix of it — 'agetor pipeline status' lists them); omitted,
  every eligible execution plus every pending run-level block is retried.`,

  "pipeline advance": `usage: agetor pipeline advance <task-id> [--next <step-name-or-id> …] [--finish] [--from <step-task-id>]

  Manually resolve what a pipeline run is currently waiting on. --next
  (repeatable) names the step(s) to run next — matched against the run's
  snapshot graph by step name, then step id, then an edge label (the same
  precedence a step's own handoff 'next' gets); --finish ends the run here
  with no next step. Exactly one of --next / --finish is required. --from targets a
  specific blocked/awaiting execution when more than one is in play (e.g. a
  fan-out); omitted, the sole such execution is used.`,

  "pipeline restart": `usage: agetor pipeline restart <task-id>

  Restart the pipeline run from its start step, discarding current progress.`,

  "pipeline status": `usage: agetor pipeline status <task-id>

  Print the pipeline task's run status, blocked entries, active step
  executions, and full step history.`,

  daemon: `usage: agetor daemon <status | start | stop>

  Control the background headless core (used when the desktop app isn't open).`,

  info: `usage: agetor info

  Print the connected core's version.`,

  config: `usage: agetor config [<key> [value…]]

  View or set cross-session preferences stored in the core (the same store the
  app's settings use). No args lists all; one arg gets; key + value sets.
  Common keys: defaultHarness, lastModel:<kind>, lastMode:<kind>, lastEffort:<kind>,
  fxAutoResume (on|off — default on), fxAutoResumeDelaySec (10..3600, default 120).`,
};

const ALIASES: Record<string, string> = {
  mv: "move",
  msg: "send",
  inspect: "show",
  tail: "logs",
  delete: "rm",
  harnesses: "harness",
  profiles: "profile",
  pipelines: "pipeline",
  project: "projects",
  sent: "files",
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
