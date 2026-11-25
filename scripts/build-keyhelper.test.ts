import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fillEntitlements, parseTeamId, teamIdFromIdentity } from "./build-keyhelper.ts";

const REPO = path.resolve(import.meta.dir, "..");
const hasSwiftc = process.platform === "darwin" && Bun.which("xcrun") !== null;

describe("build-keyhelper helpers", () => {
  test("parseTeamId reads the first TeamIdentifier", () => {
    const plist = "<dict><key>TeamIdentifier</key>\n<array>\n<string>ABCDE12345</string>\n</array></dict>";
    expect(parseTeamId(plist)).toBe("ABCDE12345");
    expect(parseTeamId("<dict></dict>")).toBeNull();
    expect(parseTeamId("<key>TeamIdentifier</key><array><string>short</string></array>")).toBeNull();
  });
  test("teamIdFromIdentity reads the trailing team id", () => {
    expect(teamIdFromIdentity("Developer ID Application: Example Co (ABCDE12345)")).toBe("ABCDE12345");
    expect(teamIdFromIdentity("0123456789ABCDEF0123456789ABCDEF01234567")).toBeNull();
  });
  test("fillEntitlements fills every placeholder and refuses a bad team id", () => {
    const filled = fillEntitlements(
      "<string>__TEAM_ID__.sh.alamops.agetor.keyhelper</string><string>__TEAM_ID__</string>",
      "ABCDE12345",
    );
    expect(filled).toBe("<string>ABCDE12345.sh.alamops.agetor.keyhelper</string><string>ABCDE12345</string>");
    expect(() => fillEntitlements("__TEAM_ID__", "x")).toThrow();
    expect(() => fillEntitlements("__TEAM_ID__", "ABCDE1234</string>")).toThrow();
  });
});

describe("build-keyhelper --adhoc", () => {
  const body = async () => {
    const out = mkdtempSync(path.join(tmpdir(), "agt-keyhelper-"));
    try {
      const build = Bun.spawn(["bun", path.join(REPO, "scripts/build-keyhelper.ts"), "--adhoc", "--out", out], {
        cwd: REPO,
        stdout: "pipe",
        stderr: "pipe",
      }); // spawn-exempt(test): runs a repo build script
      expect(await build.exited).toBe(0);
      const exe = path.join(out, "AgetorKeyHelper.app", "Contents", "MacOS", "keyhelper");
      const run = Bun.spawn([exe, "selftest-vectors", path.join(REPO, "packages/remote-protocol/vectors")], { stdout: "pipe", stderr: "pipe" }); // spawn-exempt(test): runs the built helper
      const stdout = await new Response(run.stdout).text();
      expect(await run.exited).toBe(0);
      // CI2 asserts these two always run; the QR vectors arrive with P4 and are skipped while absent.
      expect(stdout).toContain("checked agetor-derive.json");
      expect(stdout).toContain("checked agetor-canonical-json.json");
      expect(stdout).toContain("vectors ok");

      // A tampered vector makes the helper exit non-zero.
      const bad = mkdtempSync(path.join(tmpdir(), "agt-keyhelper-vec-"));
      try {
        await Bun.write(path.join(bad, "agetor-derive.json"), JSON.stringify({ handshakeHash: "00".repeat(32), sas: "000000", sasCases: [], pairingSecret: "00".repeat(32), pairingMailbox: { key: "", id: "" } }));
        const tampered = Bun.spawn([exe, "selftest-vectors", bad], { stdout: "pipe", stderr: "pipe" }); // spawn-exempt(test): runs the built helper
        expect(await tampered.exited).not.toBe(0);
      } finally {
        rmSync(bad, { recursive: true, force: true });
      }

      // The stdio protocol: unknown commands, bad args and malformed JSON get error lines, never a crash.
      const proc = Bun.spawn([exe], { stdin: "pipe", stdout: "pipe", stderr: "pipe" }); // spawn-exempt(test): runs the built helper
      proc.stdin.write('{"id":1,"cmd":"bogus"}\nnot json\n{"id":2,"cmd":"dh","args":{"peerPub":"zz"}}\n');
      proc.stdin.end();
      const lines = (await new Response(proc.stdout).text()).trim().split("\n").map((l) => JSON.parse(l));
      expect(await proc.exited).toBe(0);
      expect(lines.length).toBe(3);
      expect(lines.every((l) => l.ok === false)).toBe(true);
      expect(lines.map((l) => l.error.code).sort()).toEqual(["bad-args", "bad-json", "unknown-command"]);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  };
  if (hasSwiftc) test("builds, passes the shared vectors, fails a tampered one and answers the protocol", body, 180_000);
  else if (process.env.CI === "true") test("swiftc is required under CI", () => { throw new Error("swiftc/xcrun not found but CI=true"); });
  else test.skip("SKIPPED LOUDLY: no swiftc on this machine, so the key helper was not built or checked", () => {});
});
