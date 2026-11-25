import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { COMPANION_ENABLED, RELEASE_BUILD, buildFlagDefines, remoteSeamsAllowed } from "./build-flags.ts";

const REPO = path.resolve(import.meta.dir, "../..");
const SEAM_MARKERS = ["AGETOR_FAKE_KEY_HELPER", "AGETOR_REMOTE_RELAY_URL", "AGETOR_REMOTE_PUSH_URL"];

describe("build flags", () => {
  test("with no define the flags read dev defaults", () => {
    expect(RELEASE_BUILD).toBe(false);
    expect(COMPANION_ENABLED).toBe(true);
  });

  test("the seam guard needs NODE_ENV=test or AGETOR_E2E_HARNESS_SEAMS=1 outside a release", () => {
    expect(remoteSeamsAllowed({ NODE_ENV: "test" })).toBe(true);
    expect(remoteSeamsAllowed({ AGETOR_E2E_HARNESS_SEAMS: "1" })).toBe(true);
    expect(remoteSeamsAllowed({})).toBe(false);
    expect(remoteSeamsAllowed({ NODE_ENV: "production" })).toBe(false);
    expect(remoteSeamsAllowed({ AGETOR_E2E_HARNESS_SEAMS: "true" })).toBe(false);
  });

  test("buildFlagDefines: dev, release, and release with the companion built in", () => {
    expect(buildFlagDefines({})).toEqual({ __AGETOR_RELEASE_BUILD__: "false", __AGETOR_COMPANION__: "true" });
    expect(buildFlagDefines({ AGETOR_RELEASE_BUILD: "1" })).toEqual({ __AGETOR_RELEASE_BUILD__: "true", __AGETOR_COMPANION__: "false" });
    expect(buildFlagDefines({ AGETOR_RELEASE_BUILD: "1", AGETOR_COMPANION_BUILD: "1" })).toEqual({
      __AGETOR_RELEASE_BUILD__: "true",
      __AGETOR_COMPANION__: "true",
    });
    // Only the exact "1" counts, so a stray AGETOR_RELEASE_BUILD=0 never ships dark by accident or lit by accident.
    expect(buildFlagDefines({ AGETOR_RELEASE_BUILD: "0" }).__AGETOR_RELEASE_BUILD__).toBe("false");
  });

  test("Bun.build with the release define removes a guarded seam branch, and keeps it without", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agt-flags-"));
    try {
      // The fixture uses the documented inline guard from build-flags.ts, with the real remoteSeamsAllowed import.
      writeFileSync(
        path.join(dir, "entry.ts"),
        `import { remoteSeamsAllowed } from ${JSON.stringify(path.join(REPO, "src/shared/build-flags.ts"))};
export function pick(env: Record<string, string | undefined>) {
  if (!(typeof __AGETOR_RELEASE_BUILD__ !== "undefined" && __AGETOR_RELEASE_BUILD__) && remoteSeamsAllowed(env) && env.AGETOR_FAKE_KEY_HELPER === "1") return "fake";
  return "real";
}
console.log(pick(process.env));
`,
      );
      const build = async (env: Record<string, string>) => {
        const r = await Bun.build({ entrypoints: [path.join(dir, "entry.ts")], target: "bun", define: buildFlagDefines(env) });
        expect(r.success).toBe(true);
        return await r.outputs[0]!.text();
      };
      const dev = await build({});
      const release = await build({ AGETOR_RELEASE_BUILD: "1" });
      expect(dev).toContain("AGETOR_FAKE_KEY_HELPER");
      expect(release).not.toContain("AGETOR_FAKE_KEY_HELPER");
      // The whole guard went with the branch: nothing of the seam check is left in the release output.
      expect(release).not.toContain("remoteSeamsAllowed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("scripts/build-daemon-bundle.ts with AGETOR_RELEASE_BUILD=1 emits bundles with no seam marker", async () => {
    const out = mkdtempSync(path.join(tmpdir(), "agt-daemon-out-"));
    try {
      const proc = Bun.spawn(["bun", path.join(REPO, "scripts/build-daemon-bundle.ts"), "--out", out], {
        cwd: REPO,
        env: { ...process.env, AGETOR_RELEASE_BUILD: "1" },
        stdout: "pipe",
        stderr: "pipe",
      }); // spawn-exempt(test): runs a repo build script
      const code = await proc.exited;
      expect(code).toBe(0);
      const files = readdirSync(out).filter((f) => f.endsWith(".js"));
      expect(files).toContain("headless.js");
      for (const f of files) {
        const text = readFileSync(path.join(out, f), "utf8");
        for (const marker of SEAM_MARKERS) expect(text).not.toContain(marker);
        // Wherever the flags module made it into a bundle, it was compiled as a release build.
        if (text.includes("var RELEASE_BUILD =")) expect(text).toContain("var RELEASE_BUILD = true");
      }
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 120_000);
});
