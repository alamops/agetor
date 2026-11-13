import { test, expect, beforeAll, afterAll } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { rmTestDataDir } from "./test-data-dir.ts";

// Top-level: db.ts captures AGETOR_DATA_DIR at first import. This file pulls
// `toTerminalAppleScript` out of agents.ts (which reaches db.ts via the
// tmux drivers), so the env must be set before that module loads — same
// convention (and the same deferred dynamic import) as tmux-resolution.test.ts
// and agents.test.ts.
const testDataDir = mkdtempSync(path.join(tmpdir(), "agetor-tmux-attach-"));
process.env.AGETOR_DATA_DIR = testDataDir;

let buildTmuxAttachCommand: typeof import("./tmux-attach.ts").buildTmuxAttachCommand;
let toTerminalAppleScript: typeof import("./agents.ts").toTerminalAppleScript;

beforeAll(async () => {
  ({ buildTmuxAttachCommand } = await import("./tmux-attach.ts"));
  ({ toTerminalAppleScript } = await import("./agents.ts"));
});

afterAll(() => {
  rmTestDataDir(testDataDir);
});

/** The stay-open fallback every attach command must end with. Pinned as a
 *  literal: it is the difference between "the user can read the error" and
 *  Terminal showing `[Process completed]` and closing (issue #298). */
const STAY_OPEN_FALLBACK =
  " || { echo; echo 'Agetor could not attach to the tmux session.'; echo 'Press Enter to close this window.'; read -r _; }";

/** The wrapper {@link buildTmuxAttachCommand} must apply: the inner POSIX
 *  command is handed to `/bin/sh`, so Terminal's `do script` only has to ask
 *  the user's login shell (bash/zsh/fish/nushell) to run one plain program
 *  with a single-quoted argument. `VAR=val` prefixes and `{ …; }` groups are
 *  NOT portable across login shells; the /bin/sh hop is what makes them safe.
 *  The quote escaping is written out here rather than imported so a change to
 *  the production helper cannot silently change the security boundary. */
const shWrapped = (inner: string): string =>
  `/bin/sh -c '${inner.split("'").join("'\\''")}'`;

test("buildTmuxAttachCommand — system tmux: /bin/sh wrapper, no TERMINFO_DIRS, no exec, stay-open fallback", () => {
  const inner =
    "'/opt/homebrew/bin/tmux' '-L' 'agetor' attach -t 'agetor-1234abcd'" + STAY_OPEN_FALLBACK;
  const cmd = buildTmuxAttachCommand({
    tmuxPath: "/opt/homebrew/bin/tmux",
    socketArgs: ["-L", "agetor"],
    sessionName: "agetor-1234abcd",
  });
  expect(cmd).toBe(shWrapped(inner));
  // The wrapper is the portability fix: Terminal runs `do script` through the
  // login shell, which may be fish/nushell and reject `VAR=val`/`{ …; }`.
  expect(cmd.startsWith("/bin/sh -c '")).toBe(true);
  // Dropping `exec` is load-bearing: with it the shell is replaced by tmux and
  // a failure closes the window before the `||` branch can run.
  expect(cmd).not.toContain("exec ");
  expect(cmd).not.toContain("TERMINFO_DIRS");
});

test("buildTmuxAttachCommand — bundled tmux: TERMINFO_DIRS prefix first, then the same argv shape", () => {
  const inner =
    "TERMINFO_DIRS='/Applications/Agetor.app/Contents/Resources/app/bin/terminfo:/usr/share/terminfo'" +
    " '/Applications/Agetor.app/Contents/Resources/app/bin/tmux' '-L' 'agetor'" +
    " attach -t 'agetor-92876414-902'" +
    STAY_OPEN_FALLBACK;
  const cmd = buildTmuxAttachCommand({
    tmuxPath: "/Applications/Agetor.app/Contents/Resources/app/bin/tmux",
    socketArgs: ["-L", "agetor"],
    sessionName: "agetor-92876414-902",
    terminfoDirs: "/Applications/Agetor.app/Contents/Resources/app/bin/terminfo:/usr/share/terminfo",
  });
  expect(cmd).toBe(shWrapped(inner));
  // Order pinned: the env assignment must precede the command so the client
  // inherits it, and `attach -t <session>` must stay the trailing argv (the
  // exact string above is the authority; this keeps the intent readable).
  expect(cmd.indexOf("/app/bin/terminfo")).toBeLessThan(cmd.indexOf("/app/bin/tmux"));
  expect(cmd.indexOf("/app/bin/tmux")).toBeLessThan(cmd.indexOf("-L"));
  expect(cmd.indexOf("-L")).toBeLessThan(cmd.indexOf("attach -t"));
});

test("buildTmuxAttachCommand — no socket args (tmux's default socket) drops the -L pair cleanly", () => {
  const inner = "'/usr/bin/tmux' attach -t 'agetor-abc'" + STAY_OPEN_FALLBACK;
  expect(
    buildTmuxAttachCommand({ tmuxPath: "/usr/bin/tmux", socketArgs: [], sessionName: "agetor-abc" }),
  ).toBe(shWrapped(inner));
});

test("buildTmuxAttachCommand — every interpolated value is POSIX single-quoted (spaces, $, `;`, and a literal quote)", () => {
  const inner =
    "TERMINFO_DIRS='/opt/agetor test/My Apps/terminfo dir'" +
    " '/opt/agetor test/My Apps/tmux $bin'" +
    " '-L' 'socket; rm -rf /'" +
    " attach -t 'agetor-o'\\''brien'" +
    STAY_OPEN_FALLBACK;
  const cmd = buildTmuxAttachCommand({
    tmuxPath: "/opt/agetor test/My Apps/tmux $bin",
    socketArgs: ["-L", "socket; rm -rf /"],
    sessionName: "agetor-o'brien",
    terminfoDirs: "/opt/agetor test/My Apps/terminfo dir",
  });
  expect(cmd).toBe(shWrapped(inner));
  // A literal `'` inside a quoted value is the standard close-escape-reopen,
  // visible in the inner script before /bin/sh's wrapper escapes it again.
  expect(inner).toContain("'agetor-o'\\''brien'");
});

test("buildTmuxAttachCommand — the built command actually runs with those values under /bin/sh (env + argv survive quoting)", () => {
  // End-to-end shell check for the wrapper: a fake tmux prints TERMINFO_DIRS
  // and its argv, so a quoting regression (double evaluation, a lost `'`, a
  // `;` escaping into a second command) shows up as wrong output rather than
  // only as a changed string. This also proves the login-shell portability
  // fix: the parsed program is /bin/sh, not whatever shell runs the test.
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-attach-bin-"));
  const fake = path.join(dir, "tmux");
  writeFileSync(fake, '#!/bin/sh\nprintf "TI=<%s>\\n" "$TERMINFO_DIRS"\nprintf "ARG=<%s>\\n" "$@"\n');
  chmodSync(fake, 0o755);
  try {
    const cmd = buildTmuxAttachCommand({
      tmuxPath: fake,
      socketArgs: ["-L", "socket; rm -rf /"],
      sessionName: "agetor-o'brien",
      terminfoDirs: "/opt/agetor test/ti dir:/usr/share/terminfo",
    });
    const run = Bun.spawnSync(["/bin/sh", "-c", cmd], { env: { PATH: "/usr/bin:/bin" } });
    expect(run.exitCode).toBe(0);
    const out = run.stdout.toString().trim().split("\n");
    expect(out).toEqual([
      "TI=</opt/agetor test/ti dir:/usr/share/terminfo>",
      "ARG=<-L>",
      "ARG=<socket; rm -rf />",
      "ARG=<attach>",
      "ARG=<-t>",
      "ARG=<agetor-o'brien>",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildTmuxAttachCommand — toTerminalAppleScript wraps it in a do script + activate, escaping backslashes/quotes for the AppleScript literal", () => {
  const command = buildTmuxAttachCommand({
    tmuxPath: "/opt/agetor test/My Apps/tmux",
    socketArgs: ["-L", "agetor"],
    sessionName: "agetor-o'brien",
    terminfoDirs: "/opt/agetor test/ti",
  });
  const script = toTerminalAppleScript(command);
  const prefix = 'tell application "Terminal" to do script "';
  const suffix = '"\nactivate application "Terminal"';
  expect(script.startsWith(prefix)).toBe(true);
  expect(script.endsWith(suffix)).toBe(true);
  // Decode the AppleScript string literal the way AppleScript will: `\\` is a
  // literal backslash and `\"` a literal quote (JSON's rules coincide here for
  // every character this command can contain). Whatever survives must be
  // byte-identical to the command, so no interpolation can break out of the
  // literal.
  const literal = script.slice(prefix.length, script.length - suffix.length);
  expect(JSON.parse(`"${literal}"`)).toBe(command);
  expect(script).toContain("read -r _; }");
});
