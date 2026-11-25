/**
 * Build flags for the Companion (docs/specs/remote-readiness-spec.md, grill D1 and D4).
 *
 * A release build ships the Companion DARK: compiled and tested, but the gateway never starts, pairing, the device
 * routes and the CLI device commands are unavailable, and every test seam is dead code.
 *
 * The values come from Bun's `define` at build time (`AGETOR_RELEASE_BUILD=1`, `AGETOR_COMPANION_BUILD=1`; see
 * `buildFlagDefines`). With no define (`bun test`, dev, e2e) the defaults are RELEASE_BUILD=false, COMPANION_ENABLED=true.
 *
 * DEAD-CODE ELIMINATION. Bun folds `typeof __X__ !== "undefined" && __X__` when `__X__` is defined, and drops an `if`
 * whose condition is then constant, but it does NOT fold through an imported `const` or function. So a test seam is
 * guarded INLINE, with this exact expression, and the seam env var is read only inside the guarded branch:
 *
 *   if (!(typeof __AGETOR_RELEASE_BUILD__ !== "undefined" && __AGETOR_RELEASE_BUILD__) && remoteSeamsAllowed(env) && env.AGETOR_FAKE_KEY_HELPER === "1") { … }
 *
 * `verify-release.ts` greps the shipped bundles for the seam env var names, which proves the branch was removed.
 * `remoteSeamsAllowed` is the runtime half of the same rule (defence in depth, and the single source for what the
 * seams require).
 */

/** True in a build made with `AGETOR_RELEASE_BUILD=1`. */
export const RELEASE_BUILD: boolean = typeof __AGETOR_RELEASE_BUILD__ !== "undefined" ? __AGETOR_RELEASE_BUILD__ : false;

/**
 * Whether the Companion is compiled in and enabled. Dev builds: yes. Release builds: only when the build also set
 * `AGETOR_COMPANION_BUILD=1` (the owner's profile is in place, grill D1).
 */
export const COMPANION_ENABLED: boolean = typeof __AGETOR_COMPANION__ !== "undefined" ? __AGETOR_COMPANION__ : true;

/**
 * Test seams (`AGETOR_FAKE_KEY_HELPER`, `AGETOR_REMOTE_RELAY_URL`, `AGETOR_REMOTE_PUSH_URL`, the fake helper's dir)
 * are honoured only outside a release build and only under `NODE_ENV=test` or `AGETOR_E2E_HARNESS_SEAMS=1`.
 */
export function remoteSeamsAllowed(env: Record<string, string | undefined>): boolean {
  if (RELEASE_BUILD) return false;
  return env.NODE_ENV === "test" || env.AGETOR_E2E_HARNESS_SEAMS === "1";
}

/** The two `define` entries for a build, from the build-time environment. Used by every build script. */
export function buildFlagDefines(env: Record<string, string | undefined>): Record<string, string> {
  const release = env.AGETOR_RELEASE_BUILD === "1";
  const companion = !release || env.AGETOR_COMPANION_BUILD === "1";
  return {
    __AGETOR_RELEASE_BUILD__: String(release),
    __AGETOR_COMPANION__: String(companion),
  };
}
