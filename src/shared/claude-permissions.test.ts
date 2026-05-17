import { test, expect } from "bun:test";
import {
  derivePermissionEntry,
  matchesPermissionEntry,
  parsePermissionEntry,
  proposeAllowRules,
} from "./claude-permissions.ts";

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
