import { describe, expect, test } from "bun:test";
import { parseThemePreference, readThemeFromHash, resolveTheme } from "./theme.ts";
import type { ResolvedTheme, ThemePreference } from "../../shared/types.ts";

describe("parseThemePreference", () => {
  const cases: { name: string; input: unknown; expected: ThemePreference }[] = [
    { name: "auto passes through", input: "auto", expected: "auto" },
    { name: "dark passes through", input: "dark", expected: "dark" },
    { name: "light passes through", input: "light", expected: "light" },
    { name: "undefined falls back to auto", input: undefined, expected: "auto" },
    { name: "null falls back to auto", input: null, expected: "auto" },
    { name: "empty string falls back to auto", input: "", expected: "auto" },
    { name: "a number falls back to auto", input: 1, expected: "auto" },
    { name: "an object falls back to auto", input: { theme: "dark" }, expected: "auto" },
    { name: "an unknown string falls back to auto", input: "solarized", expected: "auto" },
    // The implementation does an exact-match `includes` check against lowercase
    // literals — it does not normalize case, so "Dark" is an unrecognized string.
    { name: "a differently-cased value falls back to auto (case-sensitive)", input: "Dark", expected: "auto" },
  ];

  for (const { name, input, expected } of cases) {
    test(name, () => {
      expect(parseThemePreference(input)).toBe(expected);
    });
  }
});

describe("resolveTheme", () => {
  const cases: { pref: ThemePreference; systemPrefersDark: boolean; expected: ResolvedTheme }[] = [
    { pref: "auto", systemPrefersDark: true, expected: "dark" },
    { pref: "auto", systemPrefersDark: false, expected: "light" },
    { pref: "dark", systemPrefersDark: true, expected: "dark" },
    { pref: "dark", systemPrefersDark: false, expected: "dark" },
    { pref: "light", systemPrefersDark: true, expected: "light" },
    { pref: "light", systemPrefersDark: false, expected: "light" },
  ];

  for (const { pref, systemPrefersDark, expected } of cases) {
    test(`pref=${pref}, systemPrefersDark=${systemPrefersDark} -> ${expected}`, () => {
      expect(resolveTheme(pref, systemPrefersDark)).toBe(expected);
    });
  }
});

describe("readThemeFromHash", () => {
  const cases: { name: string; hash: string; expected: ThemePreference }[] = [
    // Real boot-hash shape built by `buildWindowHash` in src/bun/index.ts.
    { name: "a realistic boot hash with theme last", hash: "#api=4318&token=abc123&theme=light", expected: "light" },
    { name: "theme first in param order", hash: "#theme=dark&api=4318&token=abc123", expected: "dark" },
    { name: "theme in the middle of param order", hash: "#api=4318&theme=dark&token=abc123", expected: "dark" },
    { name: "no theme key present", hash: "#api=4318&token=abc123", expected: "auto" },
    { name: "empty string", hash: "", expected: "auto" },
    { name: "a bare hash with nothing after it", hash: "#", expected: "auto" },
    { name: "missing the leading #", hash: "api=4318&token=abc123&theme=light", expected: "light" },
    // Malformed query-string-ish input — URLSearchParams parses this leniently
    // rather than throwing, so it still resolves via the normal theme lookup.
    { name: "malformed hash content", hash: "#not a=valid=query&&theme=dark", expected: "dark" },
    { name: "theme set to an unrecognized value", hash: "#api=4318&theme=solarized&token=abc123", expected: "auto" },
    // URLSearchParams.get returns the first occurrence for a duplicated key.
    { name: "duplicated theme param takes the first occurrence", hash: "#theme=dark&theme=light", expected: "dark" },
  ];

  for (const { name, hash, expected } of cases) {
    test(name, () => {
      expect(readThemeFromHash(hash)).toBe(expected);
    });
  }
});
