import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMPANION_MARKER, RELEASE_FORBIDDEN_STRINGS, profileTeamId, verifyKeyHelperLayout, verifyReleaseBundles } from "./verify-release.ts";
import { checkKeyHelperSigning, shouldSkipKeyHelper } from "./verify-vendor-signing.ts";

const TEAM = "ZQG3522LY7"; // the release team (verify-release.ts TEAM_ID)
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** A hand-assembled inner .app. */
function tree(opts: { helper?: "bin" | "macos" | "none"; profile?: boolean; main?: string | null; daemon?: Record<string, string>; cli?: string } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "agt-verify-release-"));
  roots.push(root);
  const app = join(root, "Agetor.app");
  const helperDir = opts.helper === "macos" ? join(app, "Contents/MacOS/AgetorKeyHelper.app") : join(app, "Contents/Resources/app/bin/AgetorKeyHelper.app");
  if (opts.helper !== "none") {
    mkdirSync(join(helperDir, "Contents"), { recursive: true });
    if (opts.profile !== false) writeFileSync(join(helperDir, "Contents/embedded.provisionprofile"), "profile");
  }
  mkdirSync(join(app, "Contents/Resources/app/bun"), { recursive: true });
  if (opts.main !== null) writeFileSync(join(app, "Contents/Resources/app/bun/index.js"), opts.main ?? "console.log('hi');");
  if (opts.daemon) {
    mkdirSync(join(app, "Contents/Resources/app/daemon"), { recursive: true });
    for (const [n, c] of Object.entries(opts.daemon)) writeFileSync(join(app, "Contents/Resources/app/daemon", n), c);
  }
  if (opts.cli !== undefined) writeFileSync(join(app, "Contents/Resources/app/bin/agetor"), opts.cli);
  return app;
}

const PROFILE_PLIST = (team: string) => `<plist><dict><key>TeamIdentifier</key>\n<array>\n<string>${team}</string>\n</array></dict></plist>`;

/** A scripted `run`: codesign and security answers a correct build would give. */
function runner(over: { verifyOk?: boolean; sigTeam?: string; profileTeam?: string; entitlements?: string; profileUnreadable?: boolean } = {}) {
  const sigTeam = over.sigTeam ?? TEAM;
  return async (cmd: string[]): Promise<{ code: number; out: string }> => {
    if (cmd[0] === "codesign" && cmd.includes("--verify")) return over.verifyOk === false ? { code: 1, out: "invalid signature" } : { code: 0, out: "valid on disk" };
    if (cmd[0] === "codesign" && cmd.includes("-dvv")) return { code: 0, out: `Authority=Developer ID Application: Someone (${sigTeam})\nTeamIdentifier=${sigTeam}\nflags=0x10000(runtime)` };
    if (cmd[0] === "codesign" && cmd.includes("--entitlements")) return { code: 0, out: over.entitlements ?? `<dict><key>keychain-access-groups</key><array><string>${sigTeam}.sh.alamops.agetor.keyhelper</string></array></dict>` };
    if (cmd[0] === "security") return over.profileUnreadable ? { code: 1, out: "no" } : { code: 0, out: PROFILE_PLIST(over.profileTeam ?? sigTeam) };
    return { code: 127, out: "unexpected command" };
  };
}

const failed = (checks: Array<{ name: string; ok: boolean }>) => checks.filter((c) => !c.ok).map((c) => c.name);

describe("verifyKeyHelperLayout", () => {
  test("a correct bundle passes every check", async () => {
    const checks = await verifyKeyHelperLayout(tree(), { run: runner() });
    expect(failed(checks)).toEqual([]);
    expect(checks.map((c) => c.name)).toEqual(expect.arrayContaining(["key helper exists", "key helper signature valid", "key helper profile embedded", "key helper team matches its profile", "key helper keychain entitlement"]));
  });

  test("a helper under Contents/MacOS fails (and a helper nowhere fails)", async () => {
    expect(failed(await verifyKeyHelperLayout(tree({ helper: "macos" }), { run: runner() }))).toEqual(expect.arrayContaining(["key helper not in Contents/MacOS", "key helper exists"]));
    expect(failed(await verifyKeyHelperLayout(tree({ helper: "none" }), { run: runner() }))).toContain("key helper exists");
  });

  test("no embedded profile fails closed", async () => {
    expect(failed(await verifyKeyHelperLayout(tree({ profile: false }), { run: runner() }))).toContain("key helper profile embedded");
  });

  test("a signature that does not verify fails", async () => {
    expect(failed(await verifyKeyHelperLayout(tree(), { run: runner({ verifyOk: false }) }))).toContain("key helper signature valid");
  });

  test("a profile for another team, or one that cannot be read, fails", async () => {
    expect(failed(await verifyKeyHelperLayout(tree(), { run: runner({ profileTeam: "AAAAAAAAAA" }) }))).toContain("key helper team matches its profile");
    expect(failed(await verifyKeyHelperLayout(tree(), { run: runner({ profileUnreadable: true }) }))).toContain("key helper team matches its profile");
  });

  test("a different release team, or no keychain entitlement for the team's group, fails", async () => {
    expect(failed(await verifyKeyHelperLayout(tree(), { run: runner({ sigTeam: "AAAAAAAAAA" }) }))).toContain("key helper team is the release team");
    expect(failed(await verifyKeyHelperLayout(tree(), { run: runner({ entitlements: "<dict></dict>" }) }))).toContain("key helper keychain entitlement");
    expect(failed(await verifyKeyHelperLayout(tree(), { run: runner({ entitlements: "<dict><key>keychain-access-groups</key><array><string>OTHER.group</string></array></dict>" }) }))).toContain("key helper keychain entitlement");
  });
});

describe("verifyReleaseBundles", () => {
  test("a clean dark release passes: no seam, no companion marker", async () => {
    const checks = await verifyReleaseBundles(tree({ daemon: { "headless.js": "x", "login-daemon.js": "y" }, cli: "z" }));
    expect(failed(checks)).toEqual([]);
    expect(checks.some((c) => c.name === "companion compiled out")).toBe(true);
    expect(checks.filter((c) => c.name.startsWith("no test seam in")).length).toBe(4); // main, two daemons, the CLI
  });

  test("each seam name in any shipped file fails, and names the file", async () => {
    for (const seam of RELEASE_FORBIDDEN_STRINGS) {
      expect(failed(await verifyReleaseBundles(tree({ main: `if (env.${seam}) {}` })))).toEqual(["no test seam in Contents/Resources/app/bun/index.js"]);
      expect(failed(await verifyReleaseBundles(tree({ daemon: { "headless.js": `x ${seam} y` } })))).toEqual(["no test seam in Contents/Resources/app/daemon/headless.js"]);
    }
    expect(failed(await verifyReleaseBundles(tree({ cli: "AGETOR_FAKE_KEY_HELPER_DIR" })))).toEqual(["no test seam in Contents/Resources/app/bin/agetor"]);
  });

  test("the companion marker in a dark release fails (main bundle and daemon bundles)", async () => {
    expect(failed(await verifyReleaseBundles(tree({ main: `log("${COMPANION_MARKER}")` })))).toEqual(["companion compiled out"]);
    expect(failed(await verifyReleaseBundles(tree({ daemon: { "headless.js": COMPANION_MARKER } })))).toEqual(["no companion in Contents/Resources/app/daemon/headless.js"]);
  });

  test("a Companion build must carry the marker, and still no seam", async () => {
    expect(failed(await verifyReleaseBundles(tree({ main: `log("${COMPANION_MARKER}")` }), { companion: true }))).toEqual([]);
    expect(failed(await verifyReleaseBundles(tree(), { companion: true }))).toEqual(["companion compiled in"]);
    expect(failed(await verifyReleaseBundles(tree({ main: `${COMPANION_MARKER} AGETOR_REMOTE_PUSH_URL` }), { companion: true }))).toEqual(["no test seam in Contents/Resources/app/bun/index.js"]);
  });

  test("a missing main bundle fails closed", async () => {
    expect(failed(await verifyReleaseBundles(tree({ main: null })))).toEqual(["main bundle exists"]);
  });
});

describe("the vendored helper's signing rules", () => {
  const good = { authority: "Developer ID Application: A (T)", notifierAuthority: "Developer ID Application: A (T)", hasProfile: true, entitlements: "<key>keychain-access-groups</key>" };
  test("same identity as the notifier, a profile and the keychain entitlement pass", () => {
    expect(checkKeyHelperSigning(good)).toEqual([]);
    expect(checkKeyHelperSigning({ ...good, notifierAuthority: null })).toEqual([]);
  });
  test("each missing piece is its own problem", () => {
    expect(checkKeyHelperSigning({ ...good, authority: "Developer ID Application: B (U)" })[0]).toContain("one identity must sign both");
    expect(checkKeyHelperSigning({ ...good, hasProfile: false })[0]).toContain("embedded.provisionprofile");
    expect(checkKeyHelperSigning({ ...good, entitlements: "" })[0]).toContain("keychain-access-groups");
    expect(checkKeyHelperSigning({ authority: "x", notifierAuthority: "y", hasProfile: false, entitlements: "" })).toHaveLength(3);
  });
});

describe("profileTeamId", () => {
  test("reads the team from a decoded profile, and nothing from garbage", () => {
    expect(profileTeamId(PROFILE_PLIST("ABCDE12345"))).toBe("ABCDE12345");
    expect(profileTeamId("garbage")).toBeNull();
    expect(profileTeamId(PROFILE_PLIST("short"))).toBeNull();
  });
});

describe("M3: a Developer ID without a key-helper profile is a local build", () => {
  test("the helper's signing checks are skipped only for a local build with an ad-hoc helper", () => {
    expect(shouldSkipKeyHelper({ requireDeveloperId: false, helperHasProfile: false })).toBe(true);
    expect(shouldSkipKeyHelper({ requireDeveloperId: false, helperHasProfile: true })).toBe(false);
    // a release never skips it
    expect(shouldSkipKeyHelper({ requireDeveloperId: true, helperHasProfile: false })).toBe(false);
    expect(shouldSkipKeyHelper({ requireDeveloperId: true, helperHasProfile: true })).toBe(false);
  });
});
