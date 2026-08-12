import { describe, expect, test } from "bun:test";
import {
  fontSizeShortcutAction,
  readFontSizeFromBoot,
  rootFontSizeStyle,
  stepFontSize,
  terminalFontSize,
  type FontSizeAction,
} from "./font-size.ts";
import { clampFontSizePercent, FONT_SIZE_DEFAULT, FONT_SIZE_MAX, FONT_SIZE_MIN } from "../../shared/types.ts";

describe("clampFontSizePercent", () => {
  const cases: { name: string; input: unknown; expected: number }[] = [
    { name: "an in-range integer string passes through", input: "120", expected: 120 },
    // Math.round(120.5) rounds towards +Infinity, not banker's rounding.
    { name: "a fractional string rounds to the nearest integer", input: "120.5", expected: 121 },
    { name: "a fractional string rounding down", input: "120.4", expected: 120 },
    { name: "a plain number passes through", input: 150, expected: 150 },
    { name: "a fractional number rounds", input: 133.6, expected: 134 },
    { name: "a non-numeric string falls back to default", input: "abc", expected: FONT_SIZE_DEFAULT },
    { name: "an empty string falls back to default", input: "", expected: FONT_SIZE_DEFAULT },
    { name: "null falls back to default", input: null, expected: FONT_SIZE_DEFAULT },
    { name: "undefined falls back to default", input: undefined, expected: FONT_SIZE_DEFAULT },
    { name: "an object falls back to default", input: { pct: 120 }, expected: FONT_SIZE_DEFAULT },
    { name: "an array falls back to default", input: [120], expected: FONT_SIZE_DEFAULT },
    { name: "a boolean falls back to default", input: true, expected: FONT_SIZE_DEFAULT },
    { name: "NaN falls back to default", input: NaN, expected: FONT_SIZE_DEFAULT },
    { name: "positive Infinity falls back to default", input: Infinity, expected: FONT_SIZE_DEFAULT },
    { name: "negative Infinity falls back to default", input: -Infinity, expected: FONT_SIZE_DEFAULT },
    { name: "a negative number clamps up to the minimum", input: -50, expected: FONT_SIZE_MIN },
    { name: "zero clamps up to the minimum", input: 0, expected: FONT_SIZE_MIN },
    { name: "a value below the minimum clamps up to the minimum", input: 42, expected: FONT_SIZE_MIN },
    { name: "exactly the minimum passes through", input: 100, expected: FONT_SIZE_MIN },
    { name: "exactly the maximum passes through", input: 170, expected: FONT_SIZE_MAX },
    { name: "a value above the maximum clamps down to the maximum", input: 999, expected: FONT_SIZE_MAX },
    { name: "a numeric string above the maximum clamps down", input: "500", expected: FONT_SIZE_MAX },
    { name: "a numeric string below the minimum clamps up", input: "10", expected: FONT_SIZE_MIN },
    { name: "whitespace-padded numeric string parses (parseFloat trims leading whitespace)", input: "  120  ", expected: 120 },
  ];

  for (const { name, input, expected } of cases) {
    test(name, () => {
      expect(clampFontSizePercent(input)).toBe(expected);
    });
  }
});

describe("stepFontSize", () => {
  const cases: { name: string; pct: number; action: FontSizeAction; expected: number }[] = [
    { name: "increase steps up by FONT_SIZE_STEP", pct: 100, action: "increase", expected: 110 },
    { name: "increase from a mid value", pct: 140, action: "increase", expected: 150 },
    { name: "increase clamps at the maximum", pct: 170, action: "increase", expected: 170 },
    { name: "increase clamps when one more step would overshoot the maximum", pct: 165, action: "increase", expected: 170 },
    { name: "decrease steps down by FONT_SIZE_STEP", pct: 130, action: "decrease", expected: 120 },
    { name: "decrease clamps at the minimum", pct: 100, action: "decrease", expected: 100 },
    { name: "decrease clamps when already below the minimum", pct: 100, action: "decrease", expected: 100 },
    { name: "reset jumps straight to the default regardless of current value", pct: 170, action: "reset", expected: 100 },
    { name: "reset from the minimum is a no-op value-wise", pct: 100, action: "reset", expected: 100 },
    // Callers are documented to hold already-clamped state, but the result is
    // re-clamped anyway so a stray out-of-range input can't escape the bounds.
    { name: "increase re-clamps an out-of-range input from above", pct: 500, action: "increase", expected: 170 },
    { name: "decrease re-clamps an out-of-range input from below", pct: -20, action: "decrease", expected: 100 },
  ];

  for (const { name, pct, action, expected } of cases) {
    test(name, () => {
      expect(stepFontSize(pct, action)).toBe(expected);
    });
  }
});

describe("rootFontSizeStyle", () => {
  test("120% maps to 19.2px", () => {
    expect(rootFontSizeStyle(120)).toBe("19.2px");
  });

  test("exactly the default (100%) returns null so callers remove the inline style", () => {
    expect(rootFontSizeStyle(100)).toBeNull();
  });

  test("the minimum (100%) is treated identically to the default — also null", () => {
    expect(rootFontSizeStyle(FONT_SIZE_DEFAULT)).toBeNull();
  });

  test("the maximum (170%) maps to 27.2px", () => {
    expect(rootFontSizeStyle(170)).toBe("27.2px");
  });

  test("110% maps to 17.6px", () => {
    expect(rootFontSizeStyle(110)).toBe("17.6px");
  });
});

describe("terminalFontSize", () => {
  test("100% maps to the 12px terminal baseline", () => {
    expect(terminalFontSize(100)).toBe(12);
  });

  test("170% rounds Math.round(12 * 1.7) = 20.4 -> 20", () => {
    expect(terminalFontSize(170)).toBe(20);
  });

  test("150% rounds Math.round(18) = 18 exactly", () => {
    expect(terminalFontSize(150)).toBe(18);
  });

  test("110% rounds Math.round(13.2) = 13", () => {
    expect(terminalFontSize(110)).toBe(13);
  });

  test("130% rounds Math.round(15.6) = 16", () => {
    expect(terminalFontSize(130)).toBe(16);
  });
});

describe("readFontSizeFromBoot", () => {
  const cases: { name: string; agetorGlobal: unknown; hash: string; expected: number }[] = [
    { name: "no boot global and no hash falls back to default", agetorGlobal: undefined, hash: "", expected: FONT_SIZE_DEFAULT },
    { name: "null boot global and no hash falls back to default", agetorGlobal: null, hash: "", expected: FONT_SIZE_DEFAULT },
    {
      name: "a numeric __AGETOR.fontSize wins outright, hash is not consulted",
      agetorGlobal: { fontSize: 140 },
      hash: "#fontSize=110",
      expected: 140,
    },
    {
      name: "a string __AGETOR.fontSize wins outright, hash is not consulted",
      agetorGlobal: { fontSize: "150" },
      hash: "#fontSize=110",
      expected: 150,
    },
    {
      name: "__AGETOR.fontSize present but out of range still clamps via the number/string path (not a fall-through)",
      agetorGlobal: { fontSize: 9999 },
      hash: "#fontSize=110",
      expected: FONT_SIZE_MAX,
    },
    {
      name: "a boolean __AGETOR.fontSize is not a recognized type — falls through to the hash",
      agetorGlobal: { fontSize: true },
      hash: "#fontSize=130",
      expected: 130,
    },
    {
      name: "an object __AGETOR.fontSize is not a recognized type — falls through to the hash",
      agetorGlobal: { fontSize: { pct: 130 } },
      hash: "#fontSize=120",
      expected: 120,
    },
    {
      name: "a null __AGETOR.fontSize falls through to the hash",
      agetorGlobal: { fontSize: null },
      hash: "#fontSize=125",
      expected: 125,
    },
    {
      name: "an undefined __AGETOR.fontSize (key present, value undefined) falls through to the hash",
      agetorGlobal: { fontSize: undefined },
      hash: "#fontSize=125",
      expected: 125,
    },
    {
      name: "__AGETOR present but with no fontSize key falls through to the hash",
      agetorGlobal: { theme: "dark" },
      hash: "#fontSize=160",
      expected: 160,
    },
    {
      name: "a malformed-typed __AGETOR global falls through to the hash",
      agetorGlobal: "not-an-object",
      hash: "#fontSize=115",
      expected: 115,
    },
    { name: "only the hash param is present, no leading #", agetorGlobal: undefined, hash: "fontSize=145", expected: 145 },
    {
      name: "a realistic boot hash with fontSize alongside api/token/theme",
      agetorGlobal: undefined,
      hash: "#api=4318&token=abc123&theme=dark&fontSize=140",
      expected: 140,
    },
    { name: "hash present but without a fontSize param falls back to default", agetorGlobal: undefined, hash: "#api=4318&token=abc123", expected: FONT_SIZE_DEFAULT },
    { name: "a bare hash with nothing after it falls back to default", agetorGlobal: undefined, hash: "#", expected: FONT_SIZE_DEFAULT },
    { name: "an out-of-range hash value clamps", agetorGlobal: undefined, hash: "#fontSize=9999", expected: FONT_SIZE_MAX },
    { name: "a garbage hash fontSize value falls back to default via clamp", agetorGlobal: undefined, hash: "#fontSize=abc", expected: FONT_SIZE_DEFAULT },
    // Both boot global and hash absent/invalid entirely.
    { name: "both boot global and hash are absent", agetorGlobal: undefined, hash: "", expected: FONT_SIZE_DEFAULT },
    // Both present: number type on __AGETOR wins even when the hash also has a valid value.
    {
      name: "both present and valid — __AGETOR wins",
      agetorGlobal: { fontSize: 170 },
      hash: "#fontSize=100",
      expected: 170,
    },
  ];

  for (const { name, agetorGlobal, hash, expected } of cases) {
    test(name, () => {
      expect(readFontSizeFromBoot(agetorGlobal, hash)).toBe(expected);
    });
  }

  test("a malformed hash content does not throw — URLSearchParams parses leniently", () => {
    expect(readFontSizeFromBoot(undefined, "#not a=valid=query&&fontSize=120")).toBe(120);
  });
});

describe("fontSizeShortcutAction", () => {
  const base = { key: "=", metaKey: false, ctrlKey: false, altKey: false };

  // --- Mac: metaKey && !ctrlKey ---
  describe("on Mac (isMac = true)", () => {
    test("Cmd+= increases", () => {
      expect(fontSizeShortcutAction({ ...base, key: "=", metaKey: true }, true)).toBe("increase");
    });
    test("Cmd++ increases", () => {
      expect(fontSizeShortcutAction({ ...base, key: "+", metaKey: true }, true)).toBe("increase");
    });
    test("Cmd+- decreases", () => {
      expect(fontSizeShortcutAction({ ...base, key: "-", metaKey: true }, true)).toBe("decrease");
    });
    test("Cmd+_ decreases", () => {
      expect(fontSizeShortcutAction({ ...base, key: "_", metaKey: true }, true)).toBe("decrease");
    });
    test("Cmd+0 resets", () => {
      expect(fontSizeShortcutAction({ ...base, key: "0", metaKey: true }, true)).toBe("reset");
    });
    test("an unrelated key with Cmd held returns null", () => {
      expect(fontSizeShortcutAction({ ...base, key: "a", metaKey: true }, true)).toBeNull();
    });
    test("Ctrl+= without Cmd does not fire on Mac", () => {
      expect(fontSizeShortcutAction({ ...base, key: "=", ctrlKey: true }, true)).toBeNull();
    });
    test("neither modifier held does not fire", () => {
      expect(fontSizeShortcutAction({ ...base, key: "=" }, true)).toBeNull();
    });
    test("Ctrl+Cmd+= (both modifiers) does not fire on Mac — ctrl disqualifies", () => {
      expect(fontSizeShortcutAction({ ...base, key: "=", metaKey: true, ctrlKey: true }, true)).toBeNull();
    });
    test("Alt+Cmd+= does not fire — altKey disqualifies", () => {
      expect(fontSizeShortcutAction({ ...base, key: "=", metaKey: true, altKey: true }, true)).toBeNull();
    });
    test("Alt alone with Cmd+0 does not fire", () => {
      expect(fontSizeShortcutAction({ ...base, key: "0", metaKey: true, altKey: true }, true)).toBeNull();
    });
  });

  // --- non-Mac: ctrlKey && !metaKey ---
  describe("on non-Mac (isMac = false)", () => {
    test("Ctrl+= increases", () => {
      expect(fontSizeShortcutAction({ ...base, key: "=", ctrlKey: true }, false)).toBe("increase");
    });
    test("Ctrl++ increases", () => {
      expect(fontSizeShortcutAction({ ...base, key: "+", ctrlKey: true }, false)).toBe("increase");
    });
    test("Ctrl+- decreases", () => {
      expect(fontSizeShortcutAction({ ...base, key: "-", ctrlKey: true }, false)).toBe("decrease");
    });
    test("Ctrl+_ decreases", () => {
      expect(fontSizeShortcutAction({ ...base, key: "_", ctrlKey: true }, false)).toBe("decrease");
    });
    test("Ctrl+0 resets", () => {
      expect(fontSizeShortcutAction({ ...base, key: "0", ctrlKey: true }, false)).toBe("reset");
    });
    test("an unrelated key with Ctrl held returns null", () => {
      expect(fontSizeShortcutAction({ ...base, key: "z", ctrlKey: true }, false)).toBeNull();
    });
    test("Cmd+= without Ctrl does not fire on non-Mac", () => {
      expect(fontSizeShortcutAction({ ...base, key: "=", metaKey: true }, false)).toBeNull();
    });
    test("neither modifier held does not fire", () => {
      expect(fontSizeShortcutAction({ ...base, key: "=" }, false)).toBeNull();
    });
    test("Ctrl+Cmd+= (both modifiers) does not fire on non-Mac — meta disqualifies", () => {
      expect(fontSizeShortcutAction({ ...base, key: "=", ctrlKey: true, metaKey: true }, false)).toBeNull();
    });
    test("Alt+Ctrl+= does not fire — altKey disqualifies", () => {
      expect(fontSizeShortcutAction({ ...base, key: "=", ctrlKey: true, altKey: true }, false)).toBeNull();
    });
  });
});
