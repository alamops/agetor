import { describe, expect, test } from "bun:test";
import { isMacPlatform, type PlatformNavigator } from "./platform.ts";

describe("isMacPlatform", () => {
  const cases: { name: string; nav: PlatformNavigator; expected: boolean }[] = [
    { name: "MacIntel platform", nav: { platform: "MacIntel" }, expected: true },
    { name: "Win32 platform", nav: { platform: "Win32" }, expected: false },
    { name: "Linux x86_64 platform", nav: { platform: "Linux x86_64" }, expected: false },
    {
      name: "empty platform falls back to userAgent (Macintosh UA)",
      nav: { platform: "", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" },
      expected: true,
    },
    {
      name: "empty platform falls back to userAgent (non-Mac UA)",
      nav: { platform: "", userAgent: "Mozilla/5.0 (X11; Linux x86_64)" },
      expected: false,
    },
    { name: "empty navigator object (no platform, no userAgent) is not a Mac", nav: {}, expected: false },
    {
      name: "case-insensitive match — lowercase 'macintel'",
      nav: { platform: "macintel" },
      expected: true,
    },
    {
      name: "case-insensitive match — uppercase 'MACINTEL'",
      nav: { platform: "MACINTEL" },
      expected: true,
    },
    {
      // The regex is /mac/i, and "iPhone" doesn't contain "mac" — pinned so a
      // future "treat iOS as Mac" change is a deliberate, visible diff here.
      // platform is non-empty ("iPhone"), so userAgent (which does contain
      // "Mac OS X") is never consulted.
      name: "iPhone platform does not match — /mac/i doesn't match 'iPhone', and a non-empty platform wins over userAgent",
      nav: { platform: "iPhone", userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" },
      expected: false,
    },
  ];

  for (const { name, nav, expected } of cases) {
    test(name, () => {
      expect(isMacPlatform(nav)).toBe(expected);
    });
  }

  // The zero-arg default reads the real `navigator`, which Bun reports as
  // "MacIntel" under `bun test` — environment-dependent, so it's deliberately
  // not asserted here (see the module's own doc comment).
  //
  // A finding, not a test: `isMacPlatform(undefined)` — explicitly passing
  // `undefined` — is NOT distinguishable from the zero-arg call at the
  // language level. TS/JS default parameters trigger whenever the argument
  // value is exactly `undefined`, whether omitted or passed literally, so
  // `isMacPlatform(undefined)` re-evaluates the same
  // `typeof navigator !== "undefined" ? navigator : undefined` default and
  // reads the real Bun `navigator` (confirmed empirically: it returns `true`
  // under `bun test`, not `false`). There is no way to pin an explicit-`undefined`
  // case to `false` without it being just as environment-dependent — and just
  // as flaky — as the zero-arg default this suite already excludes. Passing
  // `null` (outside the declared `PlatformNavigator | undefined` type, but the
  // runtime `if (!nav) return false;` guard handles it) is the only way to
  // exercise that guard branch deterministically; it isn't in the required
  // coverage list, so it's omitted rather than added under a different guise.
});
