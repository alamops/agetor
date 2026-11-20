/**
 * Test support: a scripted `tmux` stand-in that behaves like claude 2.1.326's
 * startup dialogs closely enough to drive `spawnClaudeViaTmux`'s boot poller
 * and the card drive end to end (`AGETOR_TMUX_BIN` points at it).
 *
 * It models the guard facts the fix depends on (decoded from the binary and
 * proved live, docs/plans/claude-enter-to-confirm-prompts-investigation.md §2
 * and the 2026-11-17 held-state spike): an add-dir select ignores any key inside
 * 500 ms of mounting (and of the last refusal) and flips its footer to the
 * "held" text, a refusal puts the cursor back on "No, exit", and Enter on "Yes"
 * is accepted only if the input event right before it was a counted Down. It is
 * NOT claude: just the part of its behaviour the driver has to survive.
 *
 * Not a test file (no `.test.` in the name), so `bun test` does not run it.
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

export type ScriptedDialog =
  | { kind: "add-dir"; repo: string; path: string }
  | { kind: "chrome" }
  | { kind: "theme" }
  | { kind: "enter-only" }
  | { kind: "paste-code" }
  /** A fixed pane that never changes and is not a dialog the driver cards. */
  | { kind: "raw"; text: string };

export interface ScriptedConfig {
  /** Dialogs shown in order; claude proceeds once every one is accepted. */
  dialogs: ScriptedDialog[];
  /** Session file written when the last dialog is accepted (and/or at once). */
  jsonlPath?: string;
  /** Write `jsonlPath` as soon as the session starts (a `--resume` of an existing session). */
  jsonlAtStart?: boolean;
  /** Refuse this many otherwise-valid confirm Enters (a swallowed Enter). */
  refuseEnters?: number;
  /** The pane drawn after the last dialog. */
  composer?: string;
  /** Typed text echoed after `send-keys -l` into the paste-code line. */
  echoTyped?: boolean;
}

interface StubState {
  cfg: ScriptedConfig;
  i: number;
  cursor: number;
  held: boolean;
  mountedAt: number;
  refusedAt: number;
  lastKey: string | null;
  refuse: number;
  typed: string;
  done: boolean;
  started: boolean;
  killed?: boolean;
  /** Set when an accepted Enter landed on "No, exit" (claude would have exited). */
  exited?: boolean;
  /** The text typed into the OAuth prompt when it was submitted. */
  submitted?: string;
}

export interface ScriptedSession {
  /** Every tmux invocation for this session, oldest first (`-L <socket>` stripped). */
  calls(): Array<{ argv: string[]; t: number }>;
  /** This session's `send-keys` calls. */
  keys(): Array<{ k: string; t: number; literal: boolean }>;
  state(): StubState;
  /** Mutate the session's state (e.g. advance past a dialog "answered in the terminal"). */
  patch(p: Partial<StubState>): void;
}

export interface ScriptedTmux {
  /** The binary to point `AGETOR_TMUX_BIN` at. ONE per test file: every
   *  session is keyed by its tmux name, so a boot poller still running from an
   *  earlier test can only ever talk to its own session. */
  bin: string;
  dir: string;
  /** Script the session `sessionName` (`agetor-<taskId>`); returns its handle. */
  add(sessionName: string, cfg: ScriptedConfig): ScriptedSession;
  cleanup(): void;
}

const ADD_DIR_BODY = (p: string, repo: string): string => `────────────────────────────────────────────────────────────────────────────────
 Adding a new directory:
 ${p}
 This directory is part of the repository at
 /Users/me/Projects/acme/${repo}. Trusting it trusts
 that whole repository, including its other worktrees and subdirectories.
 This session hasn't worked here before. Is this a directory you created or one
 you trust?
 Claude Code'll be able to read, edit, and execute files here. Its skills,
 commands, and agents load and can run commands, and so can the git settings of
 its repository. Your answer holds for this session.
 Security guide
`;

const STUB = String.raw`
const fs = require("node:fs");
const dir = process.env.SCRIPTED_TMUX_DIR;
const logPath = dir + "/log.jsonl";
let argv = process.argv.slice(2);
if (argv[0] === "-L") argv = argv.slice(2);
const now = Date.now();
const cmd = argv[0];
const flag = (f) => { const i = argv.indexOf(f); return i >= 0 ? String(argv[i + 1] ?? "") : ""; };
const session = (flag("-t") || flag("-s")).replace(/^=/, "").replace(/:.*$/, "");
fs.appendFileSync(logPath, JSON.stringify({ argv, t: now, session }) + "\n");
const statePath = dir + "/state-" + session.replace(/[^A-Za-z0-9_.-]/g, "_") + ".json";
if (!session || !fs.existsSync(statePath)) {
  // A session this stub was never told about: the real tmux says "can't find session".
  if (cmd === "has-session" || cmd === "capture-pane" || cmd === "send-keys") process.exit(cmd === "capture-pane" ? 0 : 1);
  process.exit(0);
}
const st = JSON.parse(fs.readFileSync(statePath, "utf8"));
const save = () => fs.writeFileSync(statePath, JSON.stringify(st));
const cur = () => st.cfg.dialogs[st.i];
const armed = () => now - Math.max(st.mountedAt, st.refusedAt) >= 500;
const writeJsonl = () => { if (st.cfg.jsonlPath) { fs.mkdirSync(require("node:path").dirname(st.cfg.jsonlPath), { recursive: true }); fs.writeFileSync(st.cfg.jsonlPath, ""); } };
const advance = () => {
  st.i += 1; st.cursor = 0; st.held = false; st.mountedAt = now; st.refusedAt = 0; st.lastKey = null; st.typed = "";
  if (st.i >= st.cfg.dialogs.length) { st.done = true; writeJsonl(); }
};
const render = () => {
  const d = cur();
  if (!d) return st.cfg.composer || "────────────────────────────────────────────────────────────────────────────────\n❯ \n────────────────────────────────────────────────────────────────────────────────\n  ? for shortcuts\n";
  const row = (i, label) => (st.cursor === i ? " ❯ " : "   ") + label + "\n";
  if (d.kind === "add-dir") {
    const body = ${JSON.stringify(ADD_DIR_BODY("@@PATH@@", "@@REPO@@"))}.replace("@@PATH@@", d.path).replace("@@REPO@@", d.repo);
    return body + row(0, "No, exit") + row(1, "Yes, add it") + (st.held ? " Esc to exit · To add it, press ↓ to Yes, then Enter\n" : " Enter to confirm · Esc to cancel\n");
  }
  if (d.kind === "chrome") {
    return "Claude in Chrome extension detected\n\nClaude will use your Chrome browser by default — navigating sites, filling\nforms, and capturing screenshots in your existing session.\n\n" + row(0, "No, keep browser tools off") + row(1, "Yes, use my browser") + "\n Enter to confirm · Esc to keep browser tools off\n";
  }
  if (d.kind === "theme") {
    return "Welcome to Claude Code v2.1.326\n\n Let's get started.\n\n Choose the text style that looks best with your terminal\n To change this later, run /theme\n\n" + (st.cursor === 0 ? " ❯ ✔ " : "   ✔ ") + "Auto (match terminal)\n" + (st.cursor === 1 ? " ❯   " : "     ") + "Dark mode\n" + (st.cursor === 2 ? " ❯   " : "     ") + "Light mode\n     …\n  Syntax theme: Monokai Extended (ctrl+t to disable)\n";
  }
  if (d.kind === "raw") return d.text;
  if (d.kind === "enter-only") return "\n Login successful. Press Enter to continue…\n";
  if (d.kind === "paste-code") return "\n Browser didn't open? Use the url below to sign in\n\n https://claude.ai/oauth/authorize?code=true&client_id=00000000-0000-0000-0000-000000000000\n\n Paste code here if prompted > " + (st.cfg.echoTyped ? st.typed : "") + "\n";
  return "";
};
if (cmd === "new-session") {
  st.mountedAt = now; st.started = true; st.killed = false;
  if (st.cfg.jsonlAtStart || st.cfg.dialogs.length === 0) { if (st.cfg.dialogs.length === 0) st.done = true; writeJsonl(); }
  save();
} else if (cmd === "has-session") {
  save(); process.exit(st.killed ? 1 : 0);
} else if (cmd === "kill-session") {
  st.killed = true; save();
} else if (cmd === "capture-pane") {
  process.stdout.write(render());
} else if (cmd === "send-keys") {
  const literal = argv.includes("-l");
  const key = argv[argv.length - 1];
  fs.appendFileSync(logPath, JSON.stringify({ key, literal, t: now, session }) + "\n");
  const d = cur();
  if (d && literal) {
    st.typed += key;
  } else if (d && (key === "Down" || key === "Up")) {
    const rows = d.kind === "theme" ? 3 : 2;
    if (d.kind === "add-dir") {
      if (armed()) { st.cursor = (st.cursor + (key === "Down" ? 1 : rows - 1)) % rows; st.lastKey = key === "Down" ? "down-counted" : "up"; }
      else { st.held = true; st.refusedAt = now; st.cursor = 0; st.lastKey = "arrow-refused"; }
    } else { st.cursor = (st.cursor + (key === "Down" ? 1 : rows - 1)) % rows; st.lastKey = key; }
  } else if (d && key === "Enter") {
    if (d.kind === "add-dir") {
      if (st.cursor === 1 && st.lastKey === "down-counted" && armed() && st.refuse <= 0) { advance(); }
      else if (st.cursor === 1 && st.refuse > 0 && st.lastKey === "down-counted") { st.refuse -= 1; st.held = true; st.refusedAt = now; st.cursor = 0; st.lastKey = "enter-refused"; }
      else if (st.cursor === 0 && armed() && st.lastKey === "down-counted") { st.exited = true; st.killed = true; }
      else { st.held = true; st.refusedAt = now; st.cursor = 0; st.lastKey = "enter-refused"; }
    } else if (d.kind === "paste-code") {
      st.submitted = st.typed; advance();
    } else { advance(); }
  } else if (!d) { /* keys at the composer: ignored */ }
  save();
} else {
  save();
}
process.exit(0);
`;

export function makeScriptedClaudeTmux(): ScriptedTmux {
  const dir = mkdtempSync(path.join("/tmp", "agetor-scripted-tmux-"));
  mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, "tmux");
  const logPath = path.join(dir, "log.jsonl");
  writeFileSync(logPath, "");
  // A bun script: the shebang must run with the same runtime as the tests.
  writeFileSync(
    bin,
    `#!${process.execPath}\nprocess.env.SCRIPTED_TMUX_DIR = ${JSON.stringify(dir)};\n${STUB}`,
  );
  chmodSync(bin, 0o755);
  const readLog = (): Array<Record<string, unknown>> =>
    existsSync(logPath)
      ? readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
      : [];
  return {
    bin,
    dir,
    add(sessionName, cfg) {
      const statePath = path.join(dir, `state-${sessionName.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
      const initial: StubState = {
        cfg, i: 0, cursor: 0, held: false, mountedAt: 0, refusedAt: 0, lastKey: null,
        refuse: cfg.refuseEnters ?? 0, typed: "", done: false, started: false,
      };
      writeFileSync(statePath, JSON.stringify(initial));
      return {
        calls: () =>
          readLog()
            .filter((e) => Array.isArray(e.argv) && e.session === sessionName)
            .map((e) => ({ argv: e.argv as string[], t: e.t as number })),
        keys: () =>
          readLog()
            .filter((e) => typeof e.key === "string" && e.session === sessionName)
            .map((e) => ({ k: e.key as string, t: e.t as number, literal: e.literal === true })),
        state: () => JSON.parse(readFileSync(statePath, "utf8")) as StubState,
        patch: (p) => writeFileSync(statePath, JSON.stringify({ ...JSON.parse(readFileSync(statePath, "utf8")), ...p })),
      };
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

