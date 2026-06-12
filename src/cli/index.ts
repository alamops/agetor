#!/usr/bin/env bun
import pkg from "../../package.json" with { type: "json" };
import { setPlain, c, out, errln, printJson, isTTY } from "./output.ts";
import { getClient, ensureOpts, type Flags } from "./context.ts";
import { ensureCore } from "./daemon/supervisor.ts";
import { AgetorClient } from "./api-client.ts";
import { cmdDaemon } from "./commands/daemon.ts";
import { cmdLs } from "./commands/ls.ts";
import { cmdShow } from "./commands/show.ts";
import { cmdStart, cmdSend, cmdCancel, cmdRm } from "./commands/lifecycle.ts";
import { cmdAdd } from "./commands/add.ts";
import { cmdAnswer } from "./commands/answer.ts";
import { cmdLogs } from "./commands/logs.ts";
import { cmdEdit, cmdMove, cmdArchive, cmdUnarchive } from "./commands/manage.ts";
import { cmdDiff } from "./commands/diff.ts";
import { cmdAttach } from "./commands/attach.ts";
import { cmdHarness } from "./commands/harness.ts";
import { cmdProjects } from "./commands/projects.ts";
import { cmdCommit } from "./commands/commit.ts";
import { cmdConfig } from "./commands/config.ts";
import { cmdShell } from "./commands/shell.ts";
import { helpFor } from "./usage.ts";

const HELP = `agetor — drive Agetor from the terminal

Usage: agetor [command] [options]

Commands:
  (no command)        open the live dashboard
  add                 create a task (guided wizard, or --title/--prompt)
  ls [filters]        list tasks (--column/--agent/--type/--repo/--search/--archived/--all)
  ps                  list running / blocked tasks
  show <id>           task details, runs, pending interactions
  edit <id> [flags]   change title/prompt/agent/workdir/model/mode/effort/type/column
  move <id> <column>  move a task between columns (mark done = move <id> done)
  start <id>          run a not-yet-run task
  send <id> <msg…>    message a running task (resumes a finished one)
  commit <id>         ask the agent to commit all changes & push the branch
  answer <id>         answer a task that needs input (interactive)
  logs <id>           stream a task's live conversation (--no-follow, --notify)
  diff <id>           show the task's git diff
  attach <id>         attach your terminal to the live tmux session (claude-code)
  shell <id>          open a shell in the task's worktree (--print for the path)
  cancel <id>         stop the active run
  archive <id>        archive a done task   (unarchive <id> to restore)
  rm <id> [--yes]     delete a task (worktree + branch)
  info                show the connected core's version
  daemon <sub>        start | stop | status of the background core
  harness <sub>       list | add | edit | enable | disable | rm | shell agent harnesses
  projects <sub>      list | add | rm | branches (project folders)
  config [k] [v]      view / set core preferences (defaultHarness, last model…)
  help                show this help

Global options:
  --json              machine-readable JSON output
  --plain             disable color / animation
  --no-daemon         fail instead of auto-starting a background core
  --data-dir <dir>    target a specific AGETOR_DATA_DIR
  --port <n>          port for a freshly-spawned daemon
  -h, --help          show help
  -V, --version       print version
`;

interface Parsed {
  flags: Flags;
  cmd?: string;
  args: string[];
  help: boolean;
  version: boolean;
}

function parseArgs(argv: string[]): Parsed {
  const flags: Flags = { json: false, plain: false, noDaemon: false };
  const positionals: string[] = [];
  let help = false;
  let version = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case "--json": flags.json = true; break;
      case "--plain": flags.plain = true; break;
      case "--no-daemon": flags.noDaemon = true; break;
      case "--data-dir": flags.dataDir = argv[++i]; break;
      case "--port": flags.port = Number(argv[++i]); break;
      case "-h": case "--help": help = true; break;
      case "-V": case "--version": version = true; break;
      default: positionals.push(a);
    }
  }
  return { flags, cmd: positionals[0], args: positionals.slice(1), help, version };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  // Hidden internal subcommand: boot the headless daemon in-process. Lazily
  // imported so every client command stays free of the server stack / sqlite.
  if (argv[0] === "__daemon") {
    const { runDaemon } = await import("../bun/headless.ts");
    await runDaemon();
    return;
  }

  const { flags, cmd, args, help, version } = parseArgs(argv);
  if (flags.plain || flags.json) setPlain(true);

  if (version) return out(pkg.version);
  // `agetor help [cmd [sub]]` and `agetor <cmd> [sub] --help` both resolve to a
  // command/subcommand block; bare `help`/`--help` falls back to the index.
  if (cmd === "help") return out(helpFor(args[0], args[1]) ?? HELP);
  if (help) return out(helpFor(cmd, args[0]) ?? HELP);

  switch (cmd) {
    case undefined: {
      if (!isTTY || flags.json) {
        out(c.dim("the dashboard needs an interactive terminal — try `agetor ls` or `agetor --help`"));
        return;
      }
      const core = await ensureCore(ensureOpts(flags));
      const client = new AgetorClient(core);
      // Lazy import so Ink only loads for the dashboard, never for one-shot cmds.
      const { runDashboard } = await import("./tui/render.tsx");
      await runDashboard(client, core, flags.dataDir);
      return;
    }
    case "ls":
      return cmdLs(args, flags);
    case "ps":
      return cmdLs(args, flags, { onlyRunning: true });
    case "daemon":
      return cmdDaemon(args, flags);
    case "add":
      return cmdAdd(args, flags);
    case "show":
    case "inspect":
      return cmdShow(args, flags);
    case "start":
      return cmdStart(args, flags);
    case "send":
    case "msg":
      return cmdSend(args, flags);
    case "commit":
      return cmdCommit(args, flags);
    case "answer":
      return cmdAnswer(args, flags);
    case "logs":
    case "tail":
      return cmdLogs(args, flags);
    case "cancel":
      return cmdCancel(args, flags);
    case "rm":
    case "delete":
      return cmdRm(args, flags);
    case "edit":
      return cmdEdit(args, flags);
    case "move":
    case "mv":
      return cmdMove(args, flags);
    case "archive":
      return cmdArchive(args, flags);
    case "unarchive":
      return cmdUnarchive(args, flags);
    case "diff":
      return cmdDiff(args, flags);
    case "attach":
      return cmdAttach(args, flags);
    case "shell":
      return cmdShell(args, flags);
    case "harness":
    case "harnesses":
      return cmdHarness(args, flags);
    case "projects":
    case "project":
      return cmdProjects(args, flags);
    case "config":
      return cmdConfig(args, flags);
    case "info": {
      const client = await getClient(flags);
      const meta = await client.info();
      return flags.json ? printJson(meta) : out(`agetor core v${meta.version}`);
    }
    default:
      errln(c.red(`unknown command: ${cmd}`));
      errln("run `agetor --help` for usage");
      process.exitCode = 1;
  }
}

main().catch((e) => {
  errln(c.red(`error: ${e?.message ?? String(e)}`));
  process.exit(1);
});
