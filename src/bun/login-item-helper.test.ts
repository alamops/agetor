import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  HelperError,
  __testing,
  loginItemHelper,
  resolveLoginItemHelperPath,
} from "./login-item-helper.ts";

// Client for the Swift login-item helper (docs/plans/always-on-host.md §3.3):
// path precedence, the real-binary protocol (driven by `#!/bin/sh` stubs) and
// the file-backed fake seam (AGETOR_FAKE_LOGIN_ITEM=1) that e2e specs rely on.
//
// No db.ts here, so there is no data-dir singleton to protect. coreSpawn runs
// the stubs undisclaimed: under `bun test` NODE_ENV is "test", which makes
// disclaimAvailable() false unless AGETOR_DISCLAIM_BIN is set.

const ENV_KEYS = [
  "AGETOR_LOGIN_ITEM_HELPER",
  "AGETOR_FAKE_LOGIN_ITEM",
  "AGETOR_DATA_DIR",
  "AGETOR_DISCLAIM_BIN",
] as const;
const savedEnv: Record<string, string | undefined> = {};
const realExecPath = process.execPath;

let root: string;

beforeAll(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  root = mkdtempSync(path.join(tmpdir(), "login-item-helper-"));
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  process.execPath = realExecPath;
  __testing.setTimeoutMs();
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  delete process.env.AGETOR_LOGIN_ITEM_HELPER;
  delete process.env.AGETOR_FAKE_LOGIN_ITEM;
  // Never let the repo's own env route spawns through the disclaim helper.
  delete process.env.AGETOR_DISCLAIM_BIN;
});

afterEach(() => {
  process.execPath = realExecPath;
  __testing.setTimeoutMs();
});

/** Write an executable `#!/bin/sh` stub and return its path. */
let stubSeq = 0;
function stub(body: string): string {
  const file = path.join(root, `stub-${++stubSeq}`);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

/** A stub that prints `json` for every command (and records its argv). */
function echoStub(json: string): string {
  return stub(`printf '%s\\n' '${json}'`);
}

const INFO_JSON = {
  bundlePath: "/Applications/Agetor.app",
  bundleId: "sh.example.agetor",
  channel: "stable",
  label: "sh.example.agetor.daemon",
  plist: "sh.example.agetor.daemon.plist",
  signed: true,
  teamId: "TEAMID0000",
  location: "applications",
};

describe("resolveLoginItemHelperPath", () => {
  test("AGETOR_LOGIN_ITEM_HELPER wins when the file exists", () => {
    const bin = echoStub("{}");
    process.env.AGETOR_LOGIN_ITEM_HELPER = bin;
    expect(resolveLoginItemHelperPath()).toBe(bin);
    expect(resolveLoginItemHelperPath({ forCli: true })).toBe(bin);
  });

  test("a set-but-missing override is null, never a fall-through to another binary", () => {
    // Plant a perfectly good execPath sibling: the override must still win by
    // returning null, so a typo never quietly runs a different helper.
    const dir = path.join(root, "bundle-missing-override");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "agetor-login-item"), "#!/bin/sh\n");
    process.execPath = path.join(dir, "bun");
    process.env.AGETOR_LOGIN_ITEM_HELPER = path.join(root, "does-not-exist");
    expect(resolveLoginItemHelperPath()).toBeNull();
    expect(resolveLoginItemHelperPath({ forCli: true })).toBeNull();
  });

  test("the sibling of the running executable is used when there is no override", () => {
    const dir = path.join(root, "bundle-sibling");
    mkdirSync(dir, { recursive: true });
    const sibling = path.join(dir, "agetor-login-item");
    writeFileSync(sibling, "#!/bin/sh\n");
    process.execPath = path.join(dir, "bun");
    expect(resolveLoginItemHelperPath()).toBe(sibling);
    expect(resolveLoginItemHelperPath({ forCli: true })).toBe(sibling);
  });

  test("no override and no sibling: null without forCli (even if an app is installed)", () => {
    const empty = path.join(root, "bundle-empty");
    mkdirSync(empty, { recursive: true });
    process.execPath = path.join(empty, "bun");
    expect(resolveLoginItemHelperPath()).toBeNull();
    expect(resolveLoginItemHelperPath({})).toBeNull();
  });

  test("forCli also looks in /Applications, then ~/Applications", async () => {
    // os.homedir() is resolved by the runtime at startup and ignores later
    // changes to process.env.HOME, so the ~/Applications case runs in a child
    // process that starts with a temp HOME.
    const home = path.join(root, "home-cli");
    const rel = path.join("Applications", "Agetor.app", "Contents", "MacOS", "agetor-login-item");
    const systemWide = path.join("/", rel);
    const userLevel = path.join(home, rel);
    mkdirSync(home, { recursive: true });

    const resolveInChild = async (forCli: boolean): Promise<string | null> => {
      const env: Record<string, string> = { ...(process.env as Record<string, string>), HOME: home };
      delete env.AGETOR_LOGIN_ITEM_HELPER;
      delete env.AGETOR_FAKE_LOGIN_ITEM;
      const proc = Bun.spawn(
        [
          realExecPath,
          "-e",
          `import { resolveLoginItemHelperPath } from ${JSON.stringify(path.resolve(import.meta.dir, "login-item-helper.ts"))};
           console.log(JSON.stringify(resolveLoginItemHelperPath({ forCli: ${forCli} })));`,
        ],
        { env, stdout: "pipe", stderr: "pipe" },
      );
      try {
        const out = await new Response(proc.stdout as ReadableStream).text();
        await proc.exited;
        return JSON.parse(out.trim()) as string | null;
      } finally {
        proc.kill();
      }
    };

    // Nothing in the temp HOME yet: the answer is the machine's own
    // /Applications install if there is one, else null.
    expect(await resolveInChild(true)).toBe(existsSync(systemWide) ? systemWide : null);

    mkdirSync(path.dirname(userLevel), { recursive: true });
    writeFileSync(userLevel, "#!/bin/sh\n");
    // /Applications comes first when it exists; otherwise the user copy.
    expect(await resolveInChild(true)).toBe(existsSync(systemWide) ? systemWide : userLevel);
    // Still invisible to a non-CLI caller.
    expect(await resolveInChild(false)).toBeNull();
  });

  test("loginItemHelper returns null when nothing resolves", () => {
    const empty = path.join(root, "bundle-empty-null");
    mkdirSync(empty, { recursive: true });
    process.execPath = path.join(empty, "bun");
    expect(loginItemHelper()).toBeNull();
  });
});

describe("real helper (stub scripts)", () => {
  function helperFor(bin: string) {
    process.env.AGETOR_LOGIN_ITEM_HELPER = bin;
    const h = loginItemHelper();
    expect(h).not.toBeNull();
    return h!;
  }

  test("info parses the pinned shape", async () => {
    const h = helperFor(echoStub(JSON.stringify(INFO_JSON)));
    expect(await h.info()).toEqual(INFO_JSON as never);
  });

  test("info normalizes a dev build's null label/plist to empty strings and keeps a null teamId", async () => {
    const h = helperFor(
      echoStub(JSON.stringify({ ...INFO_JSON, channel: "dev", label: null, plist: null, teamId: null, signed: false })),
    );
    const info = await h.info();
    expect(info.label).toBe("");
    expect(info.plist).toBe("");
    expect(info.teamId).toBeNull();
    expect(info.channel).toBe("dev");
  });

  test("the command name reaches the helper as argv[1]", async () => {
    // One stub, branching on its first argument, proves each method sends the
    // right subcommand.
    const bin = stub(`
case "$1" in
  info) printf '%s\\n' '${JSON.stringify(INFO_JSON)}' ;;
  status) printf '%s\\n' '{"registration":"requiresApproval"}' ;;
  register) printf '%s\\n' '{"ok":true,"registration":"enabled"}' ;;
  unregister) printf '%s\\n' '{"ok":true,"registration":"notRegistered"}' ;;
  reregister) printf '%s\\n' '{"ok":true,"registration":"enabled"}' ;;
  open-settings) printf '%s\\n' '{"ok":true}' ;;
  *) echo "unexpected $1" >&2; exit 9 ;;
esac`);
    const h = helperFor(bin);
    expect((await h.info()).bundleId).toBe("sh.example.agetor");
    expect(await h.status()).toBe("requiresApproval");
    expect(await h.register()).toEqual({ ok: true, registration: "enabled" });
    expect(await h.unregister()).toEqual({ ok: true, registration: "notRegistered" });
    expect(await h.reregister()).toEqual({ ok: true, registration: "enabled" });
    await h.openSettings();
  });

  test("a handled failure is exit 0 with ok:false and an error, returned (not thrown)", async () => {
    const h = helperFor(
      echoStub(
        JSON.stringify({
          ok: false,
          registration: "requiresApproval",
          error: { domain: "SMAppServiceErrorDomain", code: 1, message: "Operation not permitted" },
        }),
      ),
    );
    expect(await h.register()).toEqual({
      ok: false,
      registration: "requiresApproval",
      error: { domain: "SMAppServiceErrorDomain", code: 1, message: "Operation not permitted" },
    });
  });

  test("garbage output is a HelperError", async () => {
    const h = helperFor(stub(`echo "not json at all"`));
    const err = await h.info().catch((e) => e);
    expect(err).toBeInstanceOf(HelperError);
    expect((err as HelperError).command).toBe("info");
    expect((err as HelperError).exitCode).toBe(0);
    expect((err as HelperError).message).toContain("non-JSON");
  });

  test("a non-zero exit is a HelperError carrying exit code and stderr", async () => {
    const h = helperFor(stub(`echo "bundle exploded" >&2; exit 3`));
    const err = await h.status().catch((e) => e);
    expect(err).toBeInstanceOf(HelperError);
    expect((err as HelperError).exitCode).toBe(3);
    expect((err as HelperError).stderr).toBe("bundle exploded");
    expect((err as HelperError).message).toContain("exited 3");
    expect((err as HelperError).message).toContain("bundle exploded");
  });

  test("stderr is capped at 2000 characters", async () => {
    const h = helperFor(stub(`head -c 5000 /dev/zero | tr '\\0' 'e' >&2; exit 2`));
    const err = (await h.info().catch((e) => e)) as HelperError;
    expect(err).toBeInstanceOf(HelperError);
    expect(err.stderr.length).toBeLessThanOrEqual(2001);
    expect(err.stderr.endsWith("…")).toBe(true);
  });

  test("a wrong-shaped answer is a HelperError for every method", async () => {
    // Valid JSON, wrong shape.
    const wrong = helperFor(echoStub(JSON.stringify({ unexpected: true })));
    for (const call of [
      () => wrong.info(),
      () => wrong.status(),
      () => wrong.register(),
      () => wrong.unregister(),
      () => wrong.reregister(),
      () => wrong.openSettings(),
    ]) {
      const err = await call().catch((e) => e);
      expect(err).toBeInstanceOf(HelperError);
      expect((err as HelperError).message).toContain("unexpected JSON shape");
    }
  });

  test("an unknown registration value, a bad location and a malformed error object are rejected", async () => {
    let h = helperFor(echoStub(JSON.stringify({ ok: true, registration: "weird" })));
    expect(await h.register().catch((e) => e)).toBeInstanceOf(HelperError);
    expect(await helperFor(echoStub(JSON.stringify({ registration: "weird" }))).status().catch((e) => e)).toBeInstanceOf(
      HelperError,
    );
    h = helperFor(echoStub(JSON.stringify({ ...INFO_JSON, location: "the-moon" })));
    expect(await h.info().catch((e) => e)).toBeInstanceOf(HelperError);
    h = helperFor(
      echoStub(JSON.stringify({ ok: false, registration: "notRegistered", error: { domain: "d", code: "1", message: "m" } })),
    );
    expect(await h.register().catch((e) => e)).toBeInstanceOf(HelperError);
  });

  test("open-settings must answer ok:true", async () => {
    const h = helperFor(echoStub(JSON.stringify({ ok: false })));
    expect(await h.openSettings().catch((e) => e)).toBeInstanceOf(HelperError);
  });

  test("a helper that overruns the timeout is killed and surfaces a HelperError", async () => {
    __testing.setTimeoutMs(150);
    const h = helperFor(stub(`exec sleep 30`));
    const started = Date.now();
    const err = (await h.info().catch((e) => e)) as HelperError;
    expect(err).toBeInstanceOf(HelperError);
    expect(err.exitCode).toBeNull();
    expect(err.message).toContain("timed out");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test("the timeout restores to the default", () => {
    __testing.setTimeoutMs(5);
    __testing.setTimeoutMs();
    expect(__testing.DEFAULT_TIMEOUT_MS).toBe(15_000);
  });

  test("unregister and reregister time out strictly after the Swift helper's worst case; quick commands keep 15 s", () => {
    const swiftUnregister = __testing.SWIFT_UNREGISTER_WAIT_MS;
    expect(__testing.commandTimeoutMs("unregister")).toBeGreaterThan(swiftUnregister);
    expect(__testing.commandTimeoutMs("reregister")).toBeGreaterThan(
      swiftUnregister + __testing.SWIFT_REREGISTER_PAUSE_MS,
    );
    for (const quick of ["info", "status", "register", "open-settings"]) {
      expect(__testing.commandTimeoutMs(quick)).toBe(__testing.DEFAULT_TIMEOUT_MS);
    }
  });

  test("the test override applies to every command, then restores the per-command defaults", () => {
    __testing.setTimeoutMs(42);
    expect(__testing.commandTimeoutMs("reregister")).toBe(42);
    expect(__testing.commandTimeoutMs("info")).toBe(42);
    __testing.setTimeoutMs();
    expect(__testing.commandTimeoutMs("reregister")).toBeGreaterThan(__testing.DEFAULT_TIMEOUT_MS);
  });

  test("a slow reregister under the default timeout is not killed", async () => {
    __testing.setTimeoutMs(); // defaults: reregister gets > 20 s, far above this stub's delay
    const h = helperFor(
      stub(`sleep 0.4\necho '${JSON.stringify({ ok: true, registration: "enabled" })}'`),
    );
    expect(await h.reregister()).toEqual({ ok: true, registration: "enabled" });
  });

  test("a binary that cannot be executed is a HelperError, not a raw spawn error", async () => {
    // Exists (so it resolves) but isn't executable.
    const file = path.join(root, "not-executable");
    writeFileSync(file, "#!/bin/sh\necho {}\n");
    chmodSync(file, 0o644);
    const h = helperFor(file);
    const err = await h.info().catch((e) => e);
    expect(err).toBeInstanceOf(HelperError);
    expect((err as HelperError).exitCode).toBeNull();
  });
});

describe("file-backed fake (AGETOR_FAKE_LOGIN_ITEM=1)", () => {
  let dir: string;
  const fakeFile = () => path.join(dir, __testing.FAKE_FILENAME);
  const readFake = () => JSON.parse(readFileSync(fakeFile(), "utf8"));
  const seed = (state: Record<string, unknown>) => writeFileSync(fakeFile(), JSON.stringify(state));

  beforeEach(() => {
    dir = mkdtempSync(path.join(root, "fake-"));
    process.env.AGETOR_FAKE_LOGIN_ITEM = "1";
  });

  test("the fake wins over a configured real binary and needs no helper on disk", () => {
    process.env.AGETOR_LOGIN_ITEM_HELPER = path.join(root, "does-not-exist");
    expect(loginItemHelper(dir)).not.toBeNull();
  });

  test("a missing file reads as notRegistered with default info", async () => {
    const h = loginItemHelper(dir)!;
    expect(await h.status()).toBe("notRegistered");
    const info = await h.info();
    expect(info.channel).toBe("stable");
    expect(info.signed).toBe(true);
    expect(info.location).toBe("applications");
  });

  test("calls are logged in order and persisted", async () => {
    const h = loginItemHelper(dir)!;
    await h.info();
    await h.status();
    await h.register();
    await h.openSettings();
    await h.reregister();
    await h.unregister();
    expect(readFake().calls).toEqual(["info", "status", "register", "openSettings", "reregister", "unregister"]);
  });

  test("register / reregister / unregister transition the registration", async () => {
    const h = loginItemHelper(dir)!;
    expect(await h.register()).toEqual({ ok: true, registration: "enabled" });
    expect(await h.status()).toBe("enabled");
    expect(await h.reregister()).toEqual({ ok: true, registration: "enabled" });
    expect(await h.unregister()).toEqual({ ok: true, registration: "notRegistered" });
    expect(await h.status()).toBe("notRegistered");
    expect(readFake().registration).toBe("notRegistered");
  });

  test("a seeded registration and info override are honored (and merged over the defaults)", async () => {
    seed({ registration: "requiresApproval", info: { channel: "dev", signed: false }, calls: [] });
    const h = loginItemHelper(dir)!;
    expect(await h.status()).toBe("requiresApproval");
    const info = await h.info();
    expect(info.channel).toBe("dev");
    expect(info.signed).toBe(false);
    expect(info.bundleId).toBe("sh.alamops.agetor"); // untouched default
  });

  test("a separate client instance (another process, in effect) sees the same state", async () => {
    await loginItemHelper(dir)!.register();
    expect(await loginItemHelper(dir)!.status()).toBe("enabled");
  });

  test("a corrupt file degrades to a clean slate instead of throwing", async () => {
    writeFileSync(fakeFile(), "{not json");
    const h = loginItemHelper(dir)!;
    expect(await h.status()).toBe("notRegistered");
  });

  test("an unknown seeded registration falls back to notRegistered", async () => {
    seed({ registration: "bogus", calls: [] });
    expect(await loginItemHelper(dir)!.status()).toBe("notRegistered");
  });

  test("failNext on a transition becomes a one-shot ok:false result and keeps the registration", async () => {
    seed({
      registration: "notRegistered",
      calls: [],
      failNext: {
        command: "register",
        error: { domain: "SMAppServiceErrorDomain", code: 7, message: "denied" },
        registration: "requiresApproval",
      },
    });
    const h = loginItemHelper(dir)!;
    const first = await h.register();
    expect(first).toEqual({
      ok: false,
      registration: "requiresApproval",
      error: { domain: "SMAppServiceErrorDomain", code: 7, message: "denied" },
    });
    expect(readFake().registration).toBe("requiresApproval");
    expect(readFake().failNext).toBeUndefined();
    // One-shot: the next register succeeds.
    expect(await h.register()).toEqual({ ok: true, registration: "enabled" });
  });

  test("failNext only fires for its own command", async () => {
    seed({
      registration: "enabled",
      calls: [],
      failNext: { command: "unregister", error: { domain: "d", code: 1, message: "nope" } },
    });
    const h = loginItemHelper(dir)!;
    expect(await h.status()).toBe("enabled"); // not consumed by status
    expect(readFake().failNext).toBeDefined();
    const res = await h.unregister();
    expect(res.ok).toBe(false);
    expect(res.registration).toBe("enabled"); // failed unregister leaves it registered
  });

  test("failNext on info / status / openSettings throws a HelperError with the message", async () => {
    for (const [command, call] of [
      ["info", (h: NonNullable<ReturnType<typeof loginItemHelper>>) => h.info()],
      ["status", (h: NonNullable<ReturnType<typeof loginItemHelper>>) => h.status()],
      ["openSettings", (h: NonNullable<ReturnType<typeof loginItemHelper>>) => h.openSettings()],
    ] as const) {
      seed({ registration: "enabled", calls: [], failNext: { command, error: { domain: "d", code: 1, message: `${command} broke` } } });
      const err = await call(loginItemHelper(dir)!).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HelperError);
      expect((err as HelperError).message).toBe(`${command} broke`);
      // The failing call is still logged.
      expect(readFake().calls).toContain(command);
    }
  });

  test("the data dir is resolved per call: AGETOR_DATA_DIR is honored when none is passed", async () => {
    process.env.AGETOR_DATA_DIR = dir;
    await loginItemHelper()!.register();
    expect(readFake().registration).toBe("enabled");
    const other = mkdtempSync(path.join(root, "fake-other-"));
    process.env.AGETOR_DATA_DIR = other;
    expect(await loginItemHelper()!.status()).toBe("notRegistered");
  });
});
