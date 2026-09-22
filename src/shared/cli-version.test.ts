import { describe, expect, test } from "bun:test";
import {
  cliVersionSatisfies,
  compareCliVersions,
  formatMinCliVersionError,
  parseCliVersion,
} from "./cli-version.ts";

describe("parseCliVersion", () => {
  test("extracts major.minor.patch from a labeled probe line", () => {
    expect(parseCliVersion("codex-cli 0.155.1")).toEqual({ major: 0, minor: 155, patch: 1 });
  });

  test("extracts from a bare version with nothing else", () => {
    expect(parseCliVersion("0.147.0")).toEqual({ major: 0, minor: 147, patch: 0 });
  });

  test("strips a leading 'v'", () => {
    expect(parseCliVersion("v1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
  });

  test("tolerates trailing text after the version", () => {
    expect(parseCliVersion("gemini 0.54.0 (abc)")).toEqual({ major: 0, minor: 54, patch: 0 });
  });

  test("ignores a pre-release/build suffix after the third number", () => {
    expect(parseCliVersion("0.155.1-beta.2")).toEqual({ major: 0, minor: 155, patch: 1 });
  });

  test("returns null for a line with no major.minor.patch run", () => {
    expect(parseCliVersion("--version")).toBeNull();
  });

  // Fail-open contract: every unparseable-input case below must return null,
  // never throw and never guess — callers (cliVersionSatisfies) treat null
  // as "unknown, do not block" so a stub test binary or a future banner
  // format can never wrongly gate a real run.
  test("returns null for empty string", () => {
    expect(parseCliVersion("")).toBeNull();
  });

  test("returns null for null", () => {
    expect(parseCliVersion(null)).toBeNull();
  });

  test("returns null for undefined", () => {
    expect(parseCliVersion(undefined)).toBeNull();
  });

  test("returns null for a two-component version (major.minor only)", () => {
    expect(parseCliVersion("1.2")).toBeNull();
  });
});

describe("compareCliVersions", () => {
  test("positive when a's major is greater", () => {
    expect(compareCliVersions({ major: 1, minor: 0, patch: 0 }, { major: 0, minor: 9, patch: 9 })).toBeGreaterThan(0);
  });

  test("negative when a's major is smaller", () => {
    expect(compareCliVersions({ major: 0, minor: 9, patch: 9 }, { major: 1, minor: 0, patch: 0 })).toBeLessThan(0);
  });

  test("positive when majors match and a's minor is greater", () => {
    expect(compareCliVersions({ major: 0, minor: 155, patch: 0 }, { major: 0, minor: 147, patch: 9 })).toBeGreaterThan(0);
  });

  test("negative when majors match and a's minor is smaller", () => {
    expect(compareCliVersions({ major: 0, minor: 147, patch: 9 }, { major: 0, minor: 155, patch: 0 })).toBeLessThan(0);
  });

  test("positive when major and minor match and a's patch is greater", () => {
    expect(compareCliVersions({ major: 0, minor: 155, patch: 1 }, { major: 0, minor: 155, patch: 0 })).toBeGreaterThan(0);
  });

  test("negative when major and minor match and a's patch is smaller", () => {
    expect(compareCliVersions({ major: 0, minor: 155, patch: 0 }, { major: 0, minor: 155, patch: 1 })).toBeLessThan(0);
  });

  test("zero when equal", () => {
    expect(compareCliVersions({ major: 0, minor: 155, patch: 0 }, { major: 0, minor: 155, patch: 0 })).toBe(0);
  });
});

describe("cliVersionSatisfies", () => {
  test("true when installed exactly equals the floor", () => {
    expect(cliVersionSatisfies("0.155.0", "0.155.0")).toBe(true);
  });

  test("true when installed patch is above the floor", () => {
    expect(cliVersionSatisfies("0.155.1", "0.155.0")).toBe(true);
  });

  test("false when installed minor is below the floor", () => {
    expect(cliVersionSatisfies("0.147.0", "0.155.0")).toBe(false);
  });

  test("true when installed major is above the floor ('1.0.0' vs '0.155.0')", () => {
    expect(cliVersionSatisfies("1.0.0", "0.155.0")).toBe(true);
  });

  test("proves a numeric, not lexical, compare on the minor component: '0.9.0' < '0.155.0' numerically, even though the string '9' sorts after '1' lexically", () => {
    expect(cliVersionSatisfies("0.9.0", "0.155.0")).toBe(false);
    expect(cliVersionSatisfies("0.200.0", "0.155.0")).toBe(true);
  });

  // Fail-open matrix — unparseable input on either side must yield null,
  // never false, so an unrecognized banner format can never block a run.
  test("null when the installed raw string doesn't parse", () => {
    expect(cliVersionSatisfies("--version", "0.155.0")).toBeNull();
  });

  test("null when the floor doesn't parse", () => {
    expect(cliVersionSatisfies("0.155.1", "latest")).toBeNull();
  });

  test("null when the installed raw is null", () => {
    expect(cliVersionSatisfies(null, "0.155.0")).toBeNull();
  });
});

describe("formatMinCliVersionError", () => {
  test("exact string with an install hint", () => {
    const message = formatMinCliVersionError({
      harnessLabel: "Codex",
      installedRaw: "codex-cli 0.147.0",
      modelLabel: "GPT-6 Sol",
      kind: "codex",
      floor: "0.155.0",
      installHint: "npm install -g @openai/codex-cli@latest",
    });
    expect(message).toBe(
      "Codex 0.147.0 can't run GPT-6 Sol — it needs codex CLI ≥ 0.155.0. " +
        "Upgrade with: npm install -g @openai/codex-cli@latest",
    );
  });

  test("exact string without an install hint (installHint: null omits the upgrade sentence)", () => {
    const message = formatMinCliVersionError({
      harnessLabel: "Codex",
      installedRaw: "codex-cli 0.147.0",
      modelLabel: "GPT-6 Sol",
      kind: "codex",
      floor: "0.155.0",
      installHint: null,
    });
    expect(message).toBe("Codex 0.147.0 can't run GPT-6 Sol — it needs codex CLI ≥ 0.155.0.");
  });

  test("an unparseable installedRaw is rendered verbatim rather than as a parsed version", () => {
    const message = formatMinCliVersionError({
      harnessLabel: "Codex",
      installedRaw: "--version",
      modelLabel: "GPT-6 Sol",
      kind: "codex",
      floor: "0.155.0",
      installHint: null,
    });
    expect(message).toBe("Codex --version can't run GPT-6 Sol — it needs codex CLI ≥ 0.155.0.");
  });
});
