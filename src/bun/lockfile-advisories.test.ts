import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import pkg from "../../package.json" with { type: "json" };

// Why this exists:
//   This repo has no CI/audit step — nothing runs `bun audit` or an
//   equivalent on a schedule or in a pre-merge gate. So when a fixed
//   transitive pin regresses (a future `bun install` / `bun update`
//   re-resolving a vulnerable version because a direct dependency's
//   range loosens, or a lockfile edit undoing the fix), nothing catches
//   it except this test. It's the sole automated backstop.
//
//   The fix for #197 and #196 is a floor, not a pin: `package.json` carries
//   `overrides.shell-quote = "^1.9.0"` (plus `concurrently ^9.2.4`, the
//   first release pinning a safe shell-quote). `shell-quote` is not a
//   direct dependency — it reaches the tree through `concurrently` and
//   `react-devtools-core` — and on bun 1.3.10 no `bun update` variant
//   re-resolves a transitive edge whose dependent's version didn't
//   change, so the override is what actually moves both paths.
//
//   Two checks per guarded package, because they fail at different
//   moments: the lockfile check catches a regressed resolution *after*
//   a reinstall; the package.json check catches the override being
//   dropped or loosened *before* one (the lockfile keeps the old
//   resolution until the next re-resolve, so on its own it would stay
//   green).
//
//   Bun's `overrides` REPLACES every dependent's declared range, so
//   `^1.9.0` also imposes a <2.0.0 ceiling. The override is meant to be
//   temporary: drop it once every dependent's own range floors at
//   >=1.9.0 (today only `react-devtools-core`'s `^1.6.1` doesn't), and
//   revisit it when shell-quote 2.x ships — until then a dependent
//   moving to `^2` would be silently pinned back to 1.x.
//
//   If a guarded package legitimately leaves the dependency tree, the
//   "at least one resolution" test goes red on purpose — delete its
//   FLOORS entry after confirming nothing still depends on it.

const LOCKFILE_PATH = path.resolve(import.meta.dir, "../../bun.lock");

interface AdvisoryFloor {
  /** Package name exactly as it appears in bun.lock resolutions. */
  name: string;
  /** First safe version — every resolution must satisfy `>=min`. */
  min: string;
  /** Highest affected version — the package.json override must exclude it. */
  lastVulnerable: string;
  advisories: string[];
}

const FLOORS: AdvisoryFloor[] = [
  {
    name: "shell-quote",
    min: "1.9.0",
    lastVulnerable: "1.8.4",
    advisories: [
      "GHSA-395f-4hp3-45gv (CVE-2026-13311, quadratic-time parse(); vulnerable through 1.8.4)",
      "GHSA-w7jw-789q-3m8p (CVE-2026-9277, quote() doesn't escape newlines; fixed in 1.8.4)",
    ],
  },
];

let lockTextCache: string | null = null;
function lockText(): string {
  // Read lazily so a missing/unreadable bun.lock fails a *named* test
  // instead of crashing the module at load time.
  lockTextCache ??= readFileSync(LOCKFILE_PATH, "utf8");
  return lockTextCache;
}

// bun.lock is JSONC (trailing commas), so it isn't JSON-imported. Every
// resolution — hoisted or nested (`"a/b/c": ["c@1.2.3", …]`) — is a tuple
// whose first element is `"<name>@<version>"`; that is what this matches,
// so the object key (which differs for nested entries) is irrelevant.
function resolvedVersions(name: string): string[] {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\["${escaped}@([^"]+)"`, "g");
  return [...lockText().matchAll(re)]
    .map((m) => m[1])
    .filter((v): v is string => typeof v === "string");
}

function isPlainSemver(v: string): boolean {
  // git/tarball/alias resolutions and prereleases don't satisfy any plain
  // range — report those as unverifiable rather than as vulnerable.
  return Bun.semver.satisfies(v, ">=0.0.0");
}

for (const floor of FLOORS) {
  test(`bun.lock resolves at least one "${floor.name}" version`, () => {
    // Guards against a renamed/removed package making the floor check
    // below vacuously (and silently) pass.
    expect(resolvedVersions(floor.name).length).toBeGreaterThan(0);
  });

  test(`bun.lock's "${floor.name}" resolutions satisfy the >=${floor.min} floor`, () => {
    const versions = resolvedVersions(floor.name);

    const unverifiable = versions.filter((v) => !isPlainSemver(v));
    if (unverifiable.length > 0) {
      throw new Error(
        `bun.lock resolves "${floor.name}" from a non-registry/prerelease source: ` +
          `${unverifiable.join(", ")} — verify manually that it is >=${floor.min}.`,
      );
    }

    const offenders = versions
      .filter((v) => !Bun.semver.satisfies(v, `>=${floor.min}`))
      .map((v) => `${floor.name}@${v}`);

    if (offenders.length > 0) {
      throw new Error(
        `bun.lock resolves vulnerable "${floor.name}" version(s): ${offenders.join(", ")} ` +
          `(floor is >=${floor.min}). Advisories:\n  - ${floor.advisories.join("\n  - ")}`,
      );
    }

    expect(offenders).toEqual([]);
  });

  test(`package.json still declares an overrides floor for "${floor.name}"`, () => {
    const overrides: Record<string, string | undefined> = pkg.overrides ?? {};
    const range = overrides[floor.name];
    expect(range).toBeString();
    // The declared range must admit the first safe version and reject the
    // last vulnerable one — otherwise the next reinstall can regress.
    expect(Bun.semver.satisfies(floor.min, range!)).toBe(true);
    expect(Bun.semver.satisfies(floor.lastVulnerable, range!)).toBe(false);
  });
}
