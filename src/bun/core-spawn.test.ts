import { test, expect, afterEach, describe } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { SCRUBBED_ENV_KEYS, childEnv, coreSpawn, coreSpawnSync } from "./core-spawn.ts";
import { getDisclaimSwitch, setDisclaimSwitch } from "./disclaim.ts";

// Every env var and the in-memory switch this file touches is restored after
// each case — bun runs all test files in one process.
const ORIGINAL = {
  AGETOR_DISCLAIM_BIN: process.env.AGETOR_DISCLAIM_BIN,
  AGETOR_API_TOKEN: process.env.AGETOR_API_TOKEN,
};
const ORIGINAL_SWITCH = getDisclaimSwitch();

afterEach(() => {
  for (const [k, v] of Object.entries(ORIGINAL)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  setDisclaimSwitch(ORIGINAL_SWITCH);
});

const scratch = mkdtempSync(path.join(tmpdir(), "agetor-core-spawn-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));

/** A stand-in for the real helper: records its argv (one arg per line) to
 *  `log`, then exec-replaces with the command, exactly like disclaim does. */
function recordingHelper(name: string): { bin: string; log: string } {
  const bin = path.join(scratch, name);
  const log = path.join(scratch, `${name}.log`);
  writeFileSync(
    bin,
    `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> "${log}"; done\nprintf -- '--\\n' >> "${log}"\nexec "$@"\n`,
  );
  chmodSync(bin, 0o755);
  return { bin, log };
}

function recorded(log: string): string[][] {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .split("--\n")
    .filter(Boolean)
    .map((chunk) => chunk.split("\n").filter((l, i, arr) => !(i === arr.length - 1 && l === "")));
}

const darwin = process.platform === "darwin";

/** The error `fn` throws, as a comparable shape. */
function errorShape(fn: () => unknown) {
  try {
    fn();
  } catch (e: any) {
    return {
      message: e.message,
      code: e.code,
      errno: e.errno,
      syscall: e.syscall,
      path: e.path,
      ctor: e.constructor.name,
    };
  }
  throw new Error("expected a throw");
}

describe("childEnv", () => {
  test("SCRUBBED_ENV_KEYS names the master token", () => {
    expect(SCRUBBED_ENV_KEYS).toContain("AGETOR_API_TOKEN");
  });

  test("returns a new object, never mutating base", () => {
    const base = { A: "1", AGETOR_API_TOKEN: "secret" };
    const env = childEnv({ B: "2" }, base);
    expect(env).not.toBe(base);
    expect(env).toEqual({ A: "1", B: "2" });
    expect(base).toEqual({ A: "1", AGETOR_API_TOKEN: "secret" });
  });

  test("an undefined extra value deletes the key", () => {
    expect(childEnv({ A: undefined, C: "3" }, { A: "1", B: "2" })).toEqual({ B: "2", C: "3" });
  });

  test("an extra value cannot re-introduce a scrubbed key", () => {
    expect(childEnv({ AGETOR_API_TOKEN: "x" }, {})).toEqual({});
  });

  test("defaults to the LIVE process.env, not a snapshot", () => {
    process.env.CORE_SPAWN_LIVE_PROBE = "yes";
    try {
      expect(childEnv().CORE_SPAWN_LIVE_PROBE).toBe("yes");
    } finally {
      delete process.env.CORE_SPAWN_LIVE_PROBE;
    }
  });
});

describe("coreSpawn env", () => {
  test("child never sees AGETOR_API_TOKEN from the parent (disclaim off)", async () => {
    setDisclaimSwitch(false);
    process.env.AGETOR_API_TOKEN = "parent-secret";
    const proc = coreSpawn(["/bin/sh", "-c", 'printf "%s" "${AGETOR_API_TOKEN-unset}"'], {
      stdout: "pipe",
    });
    expect(await new Response(proc.stdout as ReadableStream).text()).toBe("unset");
    await proc.exited;
  });

  test("an explicit opts.env is the base and is scrubbed too", async () => {
    setDisclaimSwitch(false);
    const proc = coreSpawn(["/bin/sh", "-c", 'printf "%s|%s" "${FOO-unset}" "${AGETOR_API_TOKEN-unset}"'], {
      env: { PATH: "/usr/bin:/bin", FOO: "bar", AGETOR_API_TOKEN: "leak" },
      stdout: "pipe",
    });
    expect(await new Response(proc.stdout as ReadableStream).text()).toBe("bar|unset");
    await proc.exited;
  });

  test("the live env (not the startup snapshot) reaches the child", async () => {
    setDisclaimSwitch(false);
    process.env.CORE_SPAWN_LIVE_PROBE = "added-after-start";
    try {
      const proc = coreSpawn(["/bin/sh", "-c", 'printf "%s" "$CORE_SPAWN_LIVE_PROBE"'], { stdout: "pipe" });
      expect(await new Response(proc.stdout as ReadableStream).text()).toBe("added-after-start");
      await proc.exited;
    } finally {
      delete process.env.CORE_SPAWN_LIVE_PROBE;
    }
  });

  test.skipIf(!darwin)("scrubbed through the disclaim helper as well", async () => {
    const { bin } = recordingHelper("env-helper");
    process.env.AGETOR_DISCLAIM_BIN = bin;
    setDisclaimSwitch(true);
    process.env.AGETOR_API_TOKEN = "parent-secret";
    const proc = coreSpawn(["/bin/sh", "-c", 'printf "%s" "${AGETOR_API_TOKEN-unset}"'], { stdout: "pipe" });
    expect(await new Response(proc.stdout as ReadableStream).text()).toBe("unset");
    await proc.exited;
  });
});

describe.skipIf(!darwin)("coreSpawn disclaim wrapping", () => {
  test("helper sees [resolvedAbs, ...rest] for an absolute path", async () => {
    const { bin, log } = recordingHelper("abs-helper");
    process.env.AGETOR_DISCLAIM_BIN = bin;
    setDisclaimSwitch(true);
    const proc = coreSpawn(["/bin/echo", "hello", "world"], { stdout: "pipe" });
    expect(await new Response(proc.stdout as ReadableStream).text()).toBe("hello world\n");
    await proc.exited;
    expect(recorded(log)).toEqual([["/bin/echo", "hello", "world"]]);
  });

  test("a bare name is resolved on the CHILD env's PATH", async () => {
    const { bin, log } = recordingHelper("bare-helper");
    process.env.AGETOR_DISCLAIM_BIN = bin;
    setDisclaimSwitch(true);
    const dir = mkdtempSync(path.join(scratch, "pathdir-"));
    const tool = path.join(dir, "core-spawn-tool");
    writeFileSync(tool, "#!/bin/sh\necho tool-ran\n");
    chmodSync(tool, 0o755);
    // The core's own PATH has no such tool; only the child env's PATH does.
    const proc = coreSpawn(["core-spawn-tool"], {
      env: { PATH: `${dir}:/usr/bin:/bin` },
      stdout: "pipe",
    });
    expect(await new Response(proc.stdout as ReadableStream).text()).toBe("tool-ran\n");
    await proc.exited;
    expect(recorded(log)).toEqual([[tool]]);
  });

  test("a relative path with a slash resolves against opts.cwd", async () => {
    const { bin, log } = recordingHelper("rel-helper");
    process.env.AGETOR_DISCLAIM_BIN = bin;
    setDisclaimSwitch(true);
    const dir = mkdtempSync(path.join(scratch, "reldir-"));
    const tool = path.join(dir, "rel-tool");
    writeFileSync(tool, "#!/bin/sh\necho rel-ran\n");
    chmodSync(tool, 0o755);
    const proc = coreSpawn(["./rel-tool"], { cwd: dir, stdout: "pipe" });
    expect(await new Response(proc.stdout as ReadableStream).text()).toBe("rel-ran\n");
    await proc.exited;
    expect(recorded(log)).toEqual([[realpathish(tool)]]);
  });

  test("a missing absolute binary throws the same shape as Bun.spawn", () => {
    const { bin } = recordingHelper("miss-abs-helper");
    process.env.AGETOR_DISCLAIM_BIN = bin;
    const missing = "/nonexistent/core-spawn-bin";
    setDisclaimSwitch(false);
    const plain = errorShape(() => Bun.spawn([missing, "a"]));
    setDisclaimSwitch(true);
    expect(errorShape(() => coreSpawn([missing, "a"]))).toEqual(plain);
    expect(plain.code).toBe("ENOENT");
  });

  test("a PATH miss throws the same shape as Bun.spawn", () => {
    const { bin, log } = recordingHelper("miss-path-helper");
    process.env.AGETOR_DISCLAIM_BIN = bin;
    const env = { PATH: "/nonexistent-dir" };
    setDisclaimSwitch(false);
    const plain = errorShape(() => Bun.spawn(["core-spawn-nope", "a"], { env }));
    setDisclaimSwitch(true);
    expect(errorShape(() => coreSpawn(["core-spawn-nope", "a"], { env }))).toEqual(plain);
    expect(plain).toMatchObject({ code: "ENOENT", errno: -2 });
    // The helper must never have been started for an unresolvable binary.
    expect(recorded(log)).toEqual([]);
  });

  test("a missing relative binary and a missing cwd also match Bun.spawn", () => {
    const { bin } = recordingHelper("miss-rel-helper");
    process.env.AGETOR_DISCLAIM_BIN = bin;
    const cases: [string[], { cwd: string }][] = [
      [["./core-spawn-rel-nope"], { cwd: scratch }],
      [["/bin/echo", "a"], { cwd: "/nonexistent-cwd-core-spawn" }],
    ];
    for (const [argv, opts] of cases) {
      setDisclaimSwitch(false);
      const plain = errorShape(() => Bun.spawn(argv, opts));
      setDisclaimSwitch(true);
      expect(errorShape(() => coreSpawn(argv, opts))).toEqual(plain);
    }
  });

  test("a cwd the core can't stat (EACCES, as under a TCC-protected folder) still goes through the helper and fails like Bun.spawn", () => {
    if (process.getuid?.() === 0) return;
    const { bin } = recordingHelper("eacces-cwd-helper");
    process.env.AGETOR_DISCLAIM_BIN = bin;
    const parent = path.join(scratch, "eacces-parent");
    mkdirSync(path.join(parent, "child"), { recursive: true });
    chmodSync(parent, 0o000);
    try {
      const opts = { cwd: path.join(parent, "child") };
      setDisclaimSwitch(false);
      const plain = errorShape(() => Bun.spawn(["/bin/echo", "a"], opts));
      setDisclaimSwitch(true);
      const wrapped = errorShape(() => coreSpawn(["/bin/echo", "a"], opts));
      expect(plain.code).toBe("EACCES");
      expect(wrapped.code).toBe("EACCES");
      expect(wrapped.errno).toBe(plain.errno);
    } finally {
      chmodSync(parent, 0o700);
    }
  });

  test("a non-executable file is not handed to the helper", () => {
    const { bin, log } = recordingHelper("noexec-helper");
    process.env.AGETOR_DISCLAIM_BIN = bin;
    const file = path.join(scratch, "not-executable");
    writeFileSync(file, "#!/bin/sh\necho no\n");
    chmodSync(file, 0o644);
    setDisclaimSwitch(false);
    const plain = errorShape(() => Bun.spawn([file]));
    setDisclaimSwitch(true);
    expect(errorShape(() => coreSpawn([file]))).toEqual(plain);
    expect(recorded(log)).toEqual([]);
  });
});

describe("coreSpawn passthrough", () => {
  test.skipIf(!darwin)("switch off: helper is not used", async () => {
    const { bin, log } = recordingHelper("off-helper");
    process.env.AGETOR_DISCLAIM_BIN = bin;
    setDisclaimSwitch(false);
    const proc = coreSpawn(["/bin/echo", "plain"], { stdout: "pipe" });
    expect(await new Response(proc.stdout as ReadableStream).text()).toBe("plain\n");
    await proc.exited;
    expect(recorded(log)).toEqual([]);
  });

  test.skipIf(!darwin)("helper unavailable (AGETOR_DISCLAIM_BIN missing): plain spawn", async () => {
    process.env.AGETOR_DISCLAIM_BIN = path.join(scratch, "no-such-helper");
    setDisclaimSwitch(true);
    const proc = coreSpawn(["/bin/echo", "plain"], { stdout: "pipe" });
    expect(await new Response(proc.stdout as ReadableStream).text()).toBe("plain\n");
    await proc.exited;
  });

  test("works with no override under NODE_ENV=test (helper is not auto-discovered)", async () => {
    delete process.env.AGETOR_DISCLAIM_BIN;
    setDisclaimSwitch(true);
    const proc = coreSpawn(["/bin/echo", "plain"], { stdout: "pipe" });
    expect(await new Response(proc.stdout as ReadableStream).text()).toBe("plain\n");
    await proc.exited;
  });
});

describe("coreSpawnSync", () => {
  test("child never sees AGETOR_API_TOKEN", () => {
    setDisclaimSwitch(false);
    process.env.AGETOR_API_TOKEN = "parent-secret";
    const r = coreSpawnSync("/bin/sh", ["-c", 'printf "%s" "${AGETOR_API_TOKEN-unset}"'], {
      encoding: "utf8",
    });
    expect(r.stdout).toBe("unset");
    expect(r.status).toBe(0);
  });

  test("an explicit opts.env is scrubbed", () => {
    setDisclaimSwitch(false);
    const r = coreSpawnSync("/bin/sh", ["-c", 'printf "%s|%s" "${FOO-unset}" "${AGETOR_API_TOKEN-unset}"'], {
      env: { PATH: "/usr/bin:/bin", FOO: "bar", AGETOR_API_TOKEN: "leak" },
      encoding: "utf8",
    });
    expect(r.stdout).toBe("bar|unset");
  });

  test.skipIf(!darwin)("helper sees [resolvedAbs, ...rest]; output parity with plain spawnSync", () => {
    const { bin, log } = recordingHelper("sync-helper");
    process.env.AGETOR_DISCLAIM_BIN = bin;
    setDisclaimSwitch(true);
    const wrapped = coreSpawnSync("echo", ["a", "b"], { encoding: "utf8" });
    const plain = spawnSync("echo", ["a", "b"], { encoding: "utf8" });
    expect(wrapped.stdout).toBe(plain.stdout);
    expect(wrapped.status).toBe(plain.status);
    expect(recorded(log)).toEqual([[Bun.which("echo")!, "a", "b"]]);
  });

  test.skipIf(!darwin)("an unresolvable binary returns spawnSync's ENOENT result, helper unused", () => {
    const { bin, log } = recordingHelper("sync-miss-helper");
    process.env.AGETOR_DISCLAIM_BIN = bin;
    setDisclaimSwitch(true);
    for (const file of ["core-spawn-nope", "/nonexistent/core-spawn-bin"]) {
      const wrapped = coreSpawnSync(file, ["a"], { encoding: "utf8" });
      const plain = spawnSync(file, ["a"], { encoding: "utf8" });
      expect((wrapped.error as NodeJS.ErrnoException).code).toBe("ENOENT");
      expect({
        status: wrapped.status ?? null,
        signal: wrapped.signal,
        stdout: wrapped.stdout ?? null,
        message: wrapped.error!.message,
        syscall: (wrapped.error as NodeJS.ErrnoException).syscall,
        path: (wrapped.error as NodeJS.ErrnoException).path,
      }).toEqual({
        status: plain.status ?? null,
        signal: plain.signal,
        stdout: plain.stdout ?? null,
        message: plain.error!.message,
        syscall: (plain.error as NodeJS.ErrnoException).syscall,
        path: (plain.error as NodeJS.ErrnoException).path,
      });
    }
    expect(recorded(log)).toEqual([]);
  });

  test.skipIf(!darwin)("switch off: helper is not used", () => {
    const { bin, log } = recordingHelper("sync-off-helper");
    process.env.AGETOR_DISCLAIM_BIN = bin;
    setDisclaimSwitch(false);
    const r = coreSpawnSync("/bin/echo", ["plain"], { encoding: "utf8" });
    expect(r.stdout).toBe("plain\n");
    expect(recorded(log)).toEqual([]);
  });
});

/** `path.resolve` result for a file we created under a possibly-symlinked tmp
 *  dir: the wrapper resolves with path.resolve (no realpath), so the expected
 *  value is the same string. Kept as a named helper so the intent is explicit. */
function realpathish(p: string): string {
  return path.resolve(p);
}
