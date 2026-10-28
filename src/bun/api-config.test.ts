import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import path from "node:path";
import {
  API_TOKEN,
  CLI_TOKEN,
  DEFAULT_API_HOST,
  formatHostForUrl,
  getApiPort,
  nonLoopbackBindWarning,
  resolveApiHost,
} from "./api-config.ts";

let savedHost: string | undefined;
let savedPort: string | undefined;

beforeEach(() => {
  savedHost = process.env.AGETOR_API_HOST;
  savedPort = process.env.AGETOR_API_PORT;
});
afterEach(() => {
  if (savedHost === undefined) delete process.env.AGETOR_API_HOST;
  else process.env.AGETOR_API_HOST = savedHost;
  if (savedPort === undefined) delete process.env.AGETOR_API_PORT;
  else process.env.AGETOR_API_PORT = savedPort;
});

describe("getApiPort", () => {
  it("defaults to 4317", () => {
    delete process.env.AGETOR_API_PORT;
    expect(getApiPort()).toBe(4317);
  });

  it("reads AGETOR_API_PORT fresh on each call", () => {
    process.env.AGETOR_API_PORT = "5001";
    expect(getApiPort()).toBe(5001);
    process.env.AGETOR_API_PORT = "5002";
    expect(getApiPort()).toBe(5002);
  });
});

describe("resolveApiHost", () => {
  it("defaults to 127.0.0.1 when AGETOR_API_HOST is unset", () => {
    delete process.env.AGETOR_API_HOST;
    expect(DEFAULT_API_HOST).toBe("127.0.0.1");
    expect(resolveApiHost()).toEqual({ ok: true, host: "127.0.0.1" });
  });

  it("reads AGETOR_API_HOST fresh on each call", () => {
    process.env.AGETOR_API_HOST = "0.0.0.0";
    expect(resolveApiHost()).toEqual({ ok: true, host: "0.0.0.0" });
    process.env.AGETOR_API_HOST = "::";
    expect(resolveApiHost()).toEqual({ ok: true, host: "::" });
  });

  it("falls back to the default on an empty or whitespace-only value", () => {
    expect(resolveApiHost("")).toEqual({ ok: true, host: "127.0.0.1" });
    expect(resolveApiHost("   \t\n")).toEqual({ ok: true, host: "127.0.0.1" });
  });

  it("maps localhost to IPv4 loopback — Bun binds `localhost` as ::1 only on macOS", () => {
    expect(resolveApiHost("localhost")).toEqual({ ok: true, host: "127.0.0.1" });
    expect(resolveApiHost("LOCALHOST")).toEqual({ ok: true, host: "127.0.0.1" });
    expect(resolveApiHost("127.0.0.1")).toEqual({ ok: true, host: "127.0.0.1" });
  });

  it("accepts the wildcards, trimmed, with `[::]` unbracketed", () => {
    expect(resolveApiHost("  0.0.0.0 \n")).toEqual({ ok: true, host: "0.0.0.0" });
    expect(resolveApiHost("::")).toEqual({ ok: true, host: "::" });
    expect(resolveApiHost("[::]")).toEqual({ ok: true, host: "::" });
  });

  it("refuses any address 127.0.0.1 clients can't reach, naming the variable and the supported values", () => {
    for (const h of [
      "::1",
      "[::1]",
      "127.0.0.2",
      "192.168.1.10",
      "172.17.0.2",
      "::ffff:127.0.0.1",
      "fe80::1",
      "example.com",
      "0.0.0.O",
      "not a host!",
    ]) {
      const r = resolveApiHost(h);
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.error).toContain(`AGETOR_API_HOST=${JSON.stringify(h)}`);
      expect(r.error).toContain("127.0.0.1");
      expect(r.error).toContain("0.0.0.0");
      expect(r.error).toContain("::");
      expect(r.error).not.toContain("\n");
    }
  });
});

describe("formatHostForUrl", () => {
  it("brackets bare IPv6 literals only", () => {
    expect(formatHostForUrl("127.0.0.1")).toBe("127.0.0.1");
    expect(formatHostForUrl("0.0.0.0")).toBe("0.0.0.0");
    expect(formatHostForUrl("::")).toBe("[::]");
    expect(formatHostForUrl("[::]")).toBe("[::]");
  });
});

describe("nonLoopbackBindWarning", () => {
  it("is null for the loopback bind", () => {
    expect(nonLoopbackBindWarning("127.0.0.1", 4317)).toBeNull();
  });

  it("is a single line naming the bind, plain HTTP and the cleartext token otherwise", () => {
    const w = nonLoopbackBindWarning("0.0.0.0", 4317);
    expect(w).not.toBeNull();
    expect(w!).not.toContain("\n");
    expect(w!).toContain("0.0.0.0:4317");
    expect(w!).toContain("beyond loopback");
    expect(w!).toContain("plain HTTP");
    expect(w!).toContain("cleartext");
    expect(w!).toContain("-p 127.0.0.1:4317:4317");
    expect(nonLoopbackBindWarning("::", 4317)!).toContain("[::]:4317");
  });
});

// The tokens are read once, when the module is first evaluated, so the
// env-handling cases run in a fresh `bun` child per scenario.
function probeTokens(env: Record<string, string | undefined>): {
  api: string;
  cli: string;
  envAfter: string | null;
} {
  const base: Record<string, string | undefined> = { ...process.env };
  delete base.AGETOR_API_TOKEN;
  const mod = path.join(import.meta.dir, "api-config.ts");
  const code =
    `const m = await import(${JSON.stringify(mod)});` +
    `console.log(JSON.stringify({ api: m.API_TOKEN, cli: m.CLI_TOKEN, envAfter: process.env.AGETOR_API_TOKEN ?? null }));`;
  const r = Bun.spawnSync([process.execPath, "-e", code], { env: { ...base, ...env }, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`probe failed: ${r.stderr.toString()}`);
  return JSON.parse(r.stdout.toString());
}

describe("API_TOKEN / CLI_TOKEN", () => {
  it("are 32-byte hex strings that differ", () => {
    expect(CLI_TOKEN).toMatch(/^[0-9a-f]{64}$/);
    expect(API_TOKEN.length).toBeGreaterThan(0);
    expect(CLI_TOKEN).not.toBe(API_TOKEN);
  });

  it("AGETOR_API_TOKEN is deleted from process.env once read", () => {
    expect(process.env.AGETOR_API_TOKEN).toBeUndefined();
  });

  it("the env override sets the master only, and is removed from the environment", () => {
    const r = probeTokens({ AGETOR_API_TOKEN: "e2e-master-token" });
    expect(r.api).toBe("e2e-master-token");
    expect(r.envAfter).toBeNull();
    expect(r.cli).toMatch(/^[0-9a-f]{64}$/);
    expect(r.cli).not.toBe("e2e-master-token");
  });

  it("without an override both are random per launch (and a blank override counts as unset)", () => {
    const a = probeTokens({});
    const b = probeTokens({ AGETOR_API_TOKEN: "   " });
    expect(a.api).toMatch(/^[0-9a-f]{64}$/);
    expect(b.api).toMatch(/^[0-9a-f]{64}$/);
    expect(a.api).not.toBe(b.api);
    expect(a.cli).not.toBe(b.cli);
    expect(a.cli).not.toBe(a.api);
    expect(b.envAfter).toBeNull();
  });

  it("the CLI token has no env override", () => {
    const r = probeTokens({ AGETOR_CLI_TOKEN: "pinned", AGETOR_API_TOKEN: "m" });
    expect(r.cli).not.toBe("pinned");
  });
});
