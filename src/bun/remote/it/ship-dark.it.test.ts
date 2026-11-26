// TS1: a build made with the release define ships the Companion dark (docs/architecture/remote-gateway.md "Ship dark"): the bundle holds no test
// seam and no Companion marker, and a core that runs it never starts the gateway and ignores the seams even when their env vars are set.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildFlagDefines } from "../../../shared/build-flags.ts";
import { COMPANION_MARKER, RELEASE_FORBIDDEN_STRINGS } from "../../../../scripts/verify-release.ts";
import { REPO_ROOT } from "./harness.ts";

const dir = mkdtempSync(path.join(tmpdir(), "agt-ship-dark-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Bundle with the `bun build` CLI in a child process (the in-process bundler is flaky inside `bun test`), with the build's own define flags. */
async function bundle(entry: string, env: Record<string, string>, out: string): Promise<string> {
  const file = path.join(dir, out);
  const defines = Object.entries(buildFlagDefines(env)).flatMap(([k, v]) => ["--define", `${k}=${v}`]);
  const p = Bun.spawnSync(["bun", "build", path.join(REPO_ROOT, entry), "--target", "bun", "--outfile", file, ...defines, "--external", "electrobun", "--external", "electrobun/bun", "--external", "three"], { cwd: REPO_ROOT });
  if (p.exitCode !== 0) throw new Error(`bun build failed: ${p.stderr.toString()}`);
  return file;
}

function run(script: string, env: Record<string, string>): { code: number; out: string } {
  const f = path.join(dir, `run-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(f, script);
  const p = Bun.spawnSync(["bun", f], { env: { ...process.env, NODE_ENV: "test", AGETOR_DATA_DIR: dir, ...env }, cwd: dir });
  return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
}

const SEAMS = { AGETOR_FAKE_KEY_HELPER: "1", AGETOR_FAKE_KEY_HELPER_DIR: dir, AGETOR_REMOTE_RELAY_URL: "ws://127.0.0.1:9", AGETOR_REMOTE_PUSH_URL: "http://127.0.0.1:9", AGETOR_E2E_HARNESS_SEAMS: "1" };

describe("a release build ships the Companion dark", () => {
  test("the gateway bundle holds no seam name and no Companion marker; a development bundle holds both kinds", async () => {
    const dark = await bundle("src/bun/remote/gateway.ts", { AGETOR_RELEASE_BUILD: "1" }, "gateway-dark.js");
    const darkText = await Bun.file(dark).text();
    for (const s of RELEASE_FORBIDDEN_STRINGS) expect(darkText.includes(s), s).toBe(false);
    expect(darkText.includes(COMPANION_MARKER)).toBe(false);
    const dev = await bundle("src/bun/remote/gateway.ts", {}, "gateway-dev.js");
    const devText = await Bun.file(dev).text();
    expect(devText.includes(COMPANION_MARKER)).toBe(true);
    expect(RELEASE_FORBIDDEN_STRINGS.every((s) => devText.includes(s))).toBe(true); // proves the check can fail
  }, 120_000);

  test("running the dark bundle with every seam env var set: the gateway never starts, no relay, no fake helper", async () => {
    const dark = await bundle("src/bun/remote/gateway.ts", { AGETOR_RELEASE_BUILD: "1" }, "gateway-dark2.js");
    const r = run(
      `const { startRemoteGateway } = await import(${JSON.stringify(dark)});
       const g = await startRemoteGateway({ mode: "app", deps: { log: () => {} } });
       console.log("RESULT " + JSON.stringify({ enabled: g.enabled, pairing: typeof g.startPairing, status: g.status() }));
       process.exit(0);`,
      SEAMS,
    );
    expect(r.out).toContain("RESULT ");
    const j = JSON.parse(r.out.split("RESULT ")[1]!.split("\n")[0]!) as { enabled: boolean; pairing: string; status: { companion: boolean; relay: { url: string | null; state: string } } };
    expect(j).toMatchObject({ enabled: false, pairing: "undefined", status: { companion: false, relay: { url: null, state: "off" } } });
  }, 120_000);

  test("the seams are refused in a release bundle of their own modules: relayUrl() is null and the key helper is the real client", async () => {
    const relayCfg = await bundle("src/bun/remote/relay-config.ts", { AGETOR_RELEASE_BUILD: "1" }, "relay-config-dark.js");
    const keyApi = await bundle("src/bun/remote/key-helper-api.ts", { AGETOR_RELEASE_BUILD: "1" }, "key-api-dark.js");
    const r = run(
      `const rc = await import(${JSON.stringify(relayCfg)});
       const ka = await import(${JSON.stringify(keyApi)});
       const h = ka.getKeyHelper();
       console.log("RESULT " + JSON.stringify({ relay: rc.relayUrl(), push: rc.pushUrl(), helper: h.constructor.name }));
       process.exit(0);`,
      SEAMS,
    );
    const j = JSON.parse(r.out.split("RESULT ")[1]!.split("\n")[0]!) as { relay: string | null; push: string | null; helper: string };
    expect(j.relay).toBeNull();
    expect(j.push).toBeNull();
    expect(j.helper).not.toMatch(/Fake/);
  }, 120_000);

  test("the same modules in a DEVELOPMENT bundle do honour the seams (the guard is the only thing in the way)", async () => {
    const relayCfg = await bundle("src/bun/remote/relay-config.ts", {}, "relay-config-dev.js");
    const r = run(`const rc = await import(${JSON.stringify(relayCfg)}); console.log("RESULT " + JSON.stringify({ relay: rc.relayUrl() })); process.exit(0);`, SEAMS);
    expect((JSON.parse(r.out.split("RESULT ")[1]!.split("\n")[0]!) as { relay: string | null }).relay).toBe("ws://127.0.0.1:9");
  }, 120_000);
});
