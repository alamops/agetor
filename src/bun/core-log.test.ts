/**
 * Unit tests for the persistent core log (docs/plans/non-blocking-core.md, T1).
 * Every test uses its own mkdtemp data dir (never the real ~/.agetor) and
 * restores the console and env it touched.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  flushCoreLog,
  installCoreLog,
  redactLogText,
  registerLogSecret,
  uninstallCoreLog,
} from "./core-log.ts";

let dir: string;
let priorEnv: string | undefined;
let realConsole: Record<string, unknown>;
let seen: string[];

const LEVELS = ["log", "info", "warn", "error", "debug"] as const;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "core-log-test-"));
  priorEnv = process.env.AGETOR_CORE_LOG;
  process.env.AGETOR_CORE_LOG = "1";
  realConsole = {};
  seen = [];
  for (const l of LEVELS) {
    realConsole[l] = console[l];
    // The "original" console the tee must still call.
    console[l] = ((...a: unknown[]) => {
      seen.push(`${l}:${a.map(String).join(" ")}`);
    }) as never;
  }
});

afterEach(async () => {
  await uninstallCoreLog();
  for (const l of LEVELS) console[l] = realConsole[l] as never;
  if (priorEnv === undefined) delete process.env.AGETOR_CORE_LOG;
  else process.env.AGETOR_CORE_LOG = priorEnv;
  rmSync(dir, { recursive: true, force: true });
});

const logFile = () => path.join(dir, "logs", "core.log");
const mode = (p: string) => statSync(p).mode & 0o777;

describe("core log", () => {
  test("writes land in <dataDir>/logs/core.log with 0600/0700 and the original console still runs", async () => {
    installCoreLog({ dataDir: dir });
    console.log("hello", { a: 1 });
    console.warn("careful");
    console.error(new Error("boom"));
    await flushCoreLog();
    const text = readFileSync(logFile(), "utf8");
    expect(text).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z LOG hello \{ a: 1 \}$/m);
    expect(text).toMatch(/ WARN careful$/m);
    expect(text).toMatch(/ ERROR Error: boom\n\s+at /);
    expect(mode(logFile())).toBe(0o600);
    expect(mode(path.join(dir, "logs"))).toBe(0o700);
    expect(seen).toContain("log:hello [object Object]");
    expect(seen).toContain("warn:careful");
  });

  test("install is idempotent: a second call does not double-wrap or double-log", async () => {
    installCoreLog({ dataDir: dir });
    installCoreLog({ dataDir: dir });
    console.log("once");
    await flushCoreLog();
    expect(readFileSync(logFile(), "utf8").match(/ LOG once/g)).toHaveLength(1);
    expect(seen.filter((s) => s === "log:once")).toHaveLength(1);
  });

  test("rotation keeps core.log, .1 and .2 and never more", async () => {
    installCoreLog({ dataDir: dir, maxBytes: 2000, files: 3 });
    for (let round = 0; round < 8; round++) {
      for (let i = 0; i < 20; i++) console.log(`round ${round} line ${i} ${"x".repeat(40)}`);
      await flushCoreLog();
    }
    const names = readdirSync(path.join(dir, "logs")).sort();
    expect(names).toEqual(["core.log", "core.log.1", "core.log.2"]);
    // The newest data is in the live file; the older generations hold older rounds.
    expect(readFileSync(logFile(), "utf8")).toContain("round 7");
    expect(readFileSync(`${logFile()}.2`, "utf8")).not.toContain("round 7");
    expect(mode(`${logFile()}.1`)).toBe(0o600);
  });

  test("registered secrets, Bearer headers and token= values are redacted in the file", async () => {
    installCoreLog({ dataDir: dir });
    registerLogSecret("s3cr3t-master-value");
    console.log("leak s3cr3t-master-value in text");
    console.log("Authorization: Bearer xyz");
    console.log("GET /tasks/1/events?token=abc123def&x=1");
    console.log(JSON.stringify({ token: "jsonsecret" }));
    console.log("opencode password=hunter2");
    await flushCoreLog();
    const text = readFileSync(logFile(), "utf8");
    for (const bad of ["s3cr3t-master-value", "xyz", "abc123def", "jsonsecret", "hunter2"]) {
      expect(text).not.toContain(bad);
    }
    expect(text).toContain("[redacted]");
    expect(text).toContain("x=1"); // only the value is cut, not the rest of the line
  });

  test("redactLogText: a short registered secret is ignored, a long one is replaced inside a string", () => {
    registerLogSecret("ab");
    registerLogSecret("longsecretvalue");
    expect(redactLogText("ab cd")).toBe("ab cd");
    expect(redactLogText("prefixlongsecretvalue!")).toBe("prefix[redacted]!");
    expect(redactLogText("Bearer xyz")).toBe("Bearer [redacted]");
  });

  test("a 10,000-call burst returns without any synchronous file write", async () => {
    installCoreLog({ dataDir: dir });
    const t0 = performance.now();
    for (let i = 0; i < 10_000; i++) console.log(`burst line ${i} payload`);
    const loopMs = performance.now() - t0;
    // No yield has happened yet. A per-line appendFileSync would already have
    // put every line on disk (or at least created the file) by now.
    const onDisk = existsSync(logFile()) ? statSync(logFile()).size : 0;
    expect(onDisk).toBe(0);
    // Generous bound for a loaded box; the point is milliseconds, not the
    // seconds a per-line write would cost.
    expect(loopMs).toBeLessThan(1500);
    await flushCoreLog();
    expect(readFileSync(logFile(), "utf8").match(/burst line/g)).toHaveLength(10_000);
  });

  test("a storm past the queue ceiling drops the oldest lines and says so", async () => {
    installCoreLog({ dataDir: dir });
    const big = "lorem ipsum ".repeat(300); // 3.6 kB, under the per-line cut
    for (let i = 0; i < 1000; i++) console.log(`storm ${i} ${big}`); // ~3.6 MB queued, no yield
    await flushCoreLog();
    const text = readFileSync(logFile(), "utf8");
    expect(text).toMatch(/core log: \d+ lines dropped/);
    expect(text).toContain("storm 999 "); // newest survives
    expect(text).not.toContain("storm 0 "); // oldest dropped
  });

  test("a write failure never throws into callers and is reported once", async () => {
    // Make the logs dir impossible to create: a file sits where it should be.
    await Bun.write(path.join(dir, "logs"), "not a dir");
    installCoreLog({ dataDir: dir });
    expect(() => console.log("still fine")).not.toThrow();
    await flushCoreLog();
    console.log("second");
    await flushCoreLog();
    const reports = seen.filter((s) => s.startsWith("error:[agetor] core log write failed:"));
    expect(reports).toHaveLength(1);
    expect(seen).toContain("log:still fine");
  });

  test("is off under NODE_ENV=test unless AGETOR_CORE_LOG=1, and off with =0", async () => {
    expect(process.env.NODE_ENV).toBe("test");
    delete process.env.AGETOR_CORE_LOG;
    installCoreLog({ dataDir: dir });
    console.log("nope");
    await flushCoreLog();
    expect(existsSync(path.join(dir, "logs"))).toBe(false);
    process.env.AGETOR_CORE_LOG = "0";
    installCoreLog({ dataDir: dir });
    console.log("nope");
    await flushCoreLog();
    expect(existsSync(path.join(dir, "logs"))).toBe(false);
  });

  test("the exit flush writes what is still queued (child process)", async () => {
    const script = path.join(dir, "child.ts");
    await Bun.write(
      script,
      `import { installCoreLog } from ${JSON.stringify(path.resolve(import.meta.dir, "core-log.ts"))};
       installCoreLog({ dataDir: ${JSON.stringify(dir)} });
       console.log("queued at exit");
       process.exit(0);`,
    );
    const proc = Bun.spawn([process.execPath, script], {
      env: { ...process.env, AGETOR_CORE_LOG: "1" },
      stdout: "ignore",
      stderr: "ignore",
    });
    await proc.exited;
    expect(readFileSync(logFile(), "utf8")).toContain("queued at exit");
    expect(mode(logFile())).toBe(0o600);
  });
});
