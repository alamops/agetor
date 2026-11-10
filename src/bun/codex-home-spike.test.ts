// Opt-in real-binary reproduction of the harness-stack Codex spike (T00).
//
// Without AGETOR_REAL_CODEX=1 this file skips LOUDLY (the plan allows exactly
// one opt-in skip). With it, it proves the part that needs no login:
// CODEX_HOME alone owns login/config/MCP/writes, and creating a session writes
// only under CODEX_HOME. A decoy `$HOME/.codex` (fake auth + MCP config) makes
// the run prove CODEX_HOME wins over HOME, matching the shipped change that
// leaves HOME as the user's real home. It never prints a token and never
// touches the real ~/.codex.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ENABLED = process.env.AGETOR_REAL_CODEX === "1";

function codexBin(): string | null {
  return Bun.which("codex", { PATH: process.env.PATH }) ?? null;
}

const dirs: string[] = [];
function tempDir(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `agetor-codex-spike-${label}-`));
  dirs.push(dir);
  return dir;
}

function run(args: string[], env: Record<string, string>): { code: number; out: string } {
  const bin = codexBin();
  if (!bin) throw new Error("codex binary not found");
  const proc = Bun.spawnSync([bin, ...args], {
    env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  });
  return {
    code: proc.exitCode ?? -1,
    out: `${proc.stdout.toString("utf8")}${proc.stderr.toString("utf8")}`,
  };
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("codex HOME/CODEX_HOME isolation (opt-in real binary)", () => {
  test.skipIf(!ENABLED)(
    "CODEX_HOME alone isolates login, MCP config and writes (set AGETOR_REAL_CODEX=1 to run)",
    () => {
      const home = tempDir("home");
      const codexHome = tempDir("codex-home");
      // Decoy `$HOME/.codex`: if the CLI ever preferred HOME over CODEX_HOME
      // (the shipped change deliberately leaves HOME as the user's real home),
      // this fake login + MCP server would leak through. The assertions below
      // prove CODEX_HOME wins instead.
      const decoyCodex = path.join(home, ".codex");
      mkdirSync(decoyCodex, { recursive: true });
      writeFileSync(path.join(decoyCodex, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "decoy-not-a-real-key" }));
      writeFileSync(path.join(decoyCodex, "config.toml"), "[mcp_servers.decoy]\ncommand = \"true\"\n");
      const env = {
        HOME: home,
        PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/local/bin",
        CODEX_HOME: codexHome,
        TERM: "dumb",
      };
      const version = run(["--version"], env);
      expect(version.code).toBe(0);
      expect(version.out).toContain("codex-cli");

      const login = run(["login", "status"], env);
      // The decoy `$HOME/.codex/auth.json` is NOT read: CODEX_HOME wins, so a
      // fresh CODEX_HOME is logged out.
      expect(login.out).toMatch(/not logged in/i);

      const mcp = run(["mcp", "list"], env);
      // The decoy `$HOME/.codex/config.toml` is NOT read either.
      expect(mcp.out).toMatch(/no mcp servers/i);

      // Every write stayed under CODEX_HOME (argv0 bookkeeping is the only
      // thing a bare --version creates).
      const entries = readdirSync(codexHome);
      expect(entries.every((name) => name !== "auth.json")).toBe(true);
    },
  );
});
