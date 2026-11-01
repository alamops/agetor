import { afterEach, describe, expect, test } from "bun:test";
import { assertBrowserSafePort, CHROMIUM_RESTRICTED_PORTS, e2eIntEnv } from "../playwright.config.ts";

/**
 * `e2eIntEnv` reads the e2e port overrides (`AGETOR_E2E_VITE_PORT`,
 * `AGETOR_E2E_PORT_OFFSET` — playwright.config.ts / e2e/fixtures.ts). A typo
 * must fail when the config loads instead of turning every derived port into
 * `NaN` (formatted-handoff review round 4). The e2e specs themselves only run
 * under Playwright, so the helper is pinned here.
 */
const NAME = "AGETOR_TEST_E2E_INT_ENV";

afterEach(() => {
  delete process.env[NAME];
});

function read(raw: string | undefined, fallback = 7, min = 1, max = 100): number {
  if (raw === undefined) delete process.env[NAME];
  else process.env[NAME] = raw;
  return e2eIntEnv(NAME, fallback, min, max);
}

describe("e2eIntEnv", () => {
  test("unset or blank → the fallback", () => {
    expect(read(undefined)).toBe(7);
    expect(read("")).toBe(7);
    expect(read("   ")).toBe(7);
  });

  test("an integer inside the range, surrounding whitespace allowed, both bounds inclusive", () => {
    expect(read("42")).toBe(42);
    expect(read(" 42\n")).toBe(42);
    expect(read("1")).toBe(1);
    expect(read("100")).toBe(100);
    expect(read("0", 7, 0, 10)).toBe(0);
  });

  test("anything else throws, naming the variable, the range and the raw value", () => {
    for (const bad of ["abc", "12abc", "1.5", "-1", "+3", "1e2", "0x10", "4 2"]) {
      expect(() => read(bad)).toThrow(`${NAME} must be an integer from 1 to 100 (got "${bad.trim()}")`);
    }
  });

  test("out of range throws: below min, above max, and past the safe-integer limit", () => {
    expect(() => read("0")).toThrow(`(got "0")`);
    expect(() => read("101")).toThrow(`(got "101")`);
    expect(() => read("9".repeat(20), 7, 0, Number.MAX_SAFE_INTEGER)).toThrow("must be an integer");
  });

  test("the real port bounds: a Vite port must be 1–65535 and a port offset 0–60000", () => {
    expect(e2eIntEnv(NAME, 5173, 1, 65535)).toBe(5173);
    expect(read("65535", 5173, 1, 65535)).toBe(65535);
    expect(() => read("65536", 5173, 1, 65535)).toThrow();
    expect(read("60000", 0, 0, 60_000)).toBe(60_000);
    expect(() => read("60001", 0, 0, 60_000)).toThrow();
  });
});

/**
 * Chromium refuses to connect to a restricted port (`ERR_UNSAFE_PORT`), and a
 * port offset or Vite override can land the API or Vite port on one — e.g.
 * offset 1400 puts worker 0's API port on 6000 (X11). `assertBrowserSafePort`
 * turns that into a clear error and leaves every allowed port alone.
 */
describe("assertBrowserSafePort", () => {
  test("a restricted port throws, naming the variable and the port", () => {
    expect(() => assertBrowserSafePort("AGETOR_E2E_VITE_PORT", 6000)).toThrow(
      "AGETOR_E2E_VITE_PORT resolved to port 6000, which Chromium blocks (ERR_UNSAFE_PORT)",
    );
    for (const port of [5060, 5061, 6566, 6665, 6669, 6697, 10080, 4045, 3659]) {
      expect(() => assertBrowserSafePort("p", port)).toThrow(`port ${port}`);
    }
  });

  test("an allowed port is returned unchanged, including every default e2e port", () => {
    expect(assertBrowserSafePort("p", 5173)).toBe(5173);
    expect(assertBrowserSafePort("p", 65535)).toBe(65535);
    // API, fresh API and both GitHub stub ranges, 16 workers each, offset 0.
    for (const base of [4600, 4700, 4800, 4900]) {
      for (let worker = 0; worker < 16; worker++) {
        expect(assertBrowserSafePort("p", base + worker)).toBe(base + worker);
      }
    }
  });

  test("every listed port is a valid TCP port", () => {
    for (const port of CHROMIUM_RESTRICTED_PORTS) {
      expect(Number.isInteger(port) && port >= 1 && port <= 65535).toBe(true);
    }
  });
});
