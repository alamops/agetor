import { test, expect } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Pre-set AGETOR_DATA_DIR before claude-tmux.ts's transitive db.ts import.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-pane-pid-"));
const { panePidFor } = await import("./claude-tmux.ts");

/** Fake `tmux` whose `list-panes` prints `stdout` and exits `code`; every
 *  other subcommand succeeds silently. Socket args (`-L …`) may precede the
 *  subcommand, hence the arg scan. */
function fakeTmux(stdout: string, code = 0) {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-fake-tmux-"));
  const bin = path.join(dir, "tmux");
  writeFileSync(
    bin,
    "#!/bin/sh\n"
    + "for a in \"$@\"; do\n"
    + "  if [ \"$a\" = \"list-panes\" ]; then\n"
    + `    printf ${JSON.stringify(stdout)}\n`
    + `    exit ${code}\n`
    + "  fi\n"
    + "done\n"
    + "exit 0\n",
  );
  chmodSync(bin, 0o755);
  const prev = process.env.AGETOR_TMUX_BIN;
  process.env.AGETOR_TMUX_BIN = bin;
  return () => {
    if (prev === undefined) delete process.env.AGETOR_TMUX_BIN;
    else process.env.AGETOR_TMUX_BIN = prev;
  };
}

test("panePidFor: exact session-name match on the list-panes listing", () => {
  const restore = fakeTmux("agetor-other\t111\nagetor-x\t4242\nagetor-x2\t9\n");
  try {
    expect(panePidFor("agetor-x")).toBe(4242);
    expect(panePidFor("agetor-x2")).toBe(9);
    expect(panePidFor("agetor-other")).toBe(111);
  } finally { restore(); }
});

test("panePidFor: a name prefix never matches (agetor-x must not read agetor-x2's pid)", () => {
  const restore = fakeTmux("agetor-x2\t9\n");
  try { expect(panePidFor("agetor-x")).toBeNull(); } finally { restore(); }
});

test("panePidFor: the first listed pane wins when the user split the window", () => {
  const restore = fakeTmux("agetor-x\t4242\nagetor-x\t5151\n");
  try { expect(panePidFor("agetor-x")).toBe(4242); } finally { restore(); }
});

test("panePidFor: an empty/unparseable pid field is null, never 0 (tmux 3.6a empty-format trap)", () => {
  for (const out of ["agetor-x\t\n", "agetor-x\tabc\n", "agetor-x\t0\n", "agetor-x\n", ""]) {
    const restore = fakeTmux(out);
    try { expect(panePidFor("agetor-x")).toBeNull(); } finally { restore(); }
  }
});

test("panePidFor: a failing tmux is null", () => {
  const restore = fakeTmux("agetor-x\t4242\n", 1);
  try { expect(panePidFor("agetor-x")).toBeNull(); } finally { restore(); }
});
