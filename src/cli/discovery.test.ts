import { test, expect } from "bun:test";
import { brief, commandLabel } from "./commands/discovery.ts";

test("commandLabel adds a leading slash only when missing (no doubling)", () => {
  expect(commandLabel("review")).toBe("/review");
  expect(commandLabel("/appstore-review")).toBe("/appstore-review");
});

test("brief collapses whitespace to one line and caps the length", () => {
  expect(brief("a\n  b   c")).toBe("a b c");
  expect(brief("   spaced   ")).toBe("spaced");
  const out = brief("x".repeat(100), 10);
  expect(out.length).toBe(10); // 9 chars + the … ellipsis
  expect(out).toBe("xxxxxxxxx…");
});

test("`agetor commands` unions scopes with the shared merge, not a fork of it", async () => {
  // The CLI and the app composer must list the same entries for a
  // multi-repository task; both call `src/shared/agent-capabilities.ts`.
  // cmdCommands needs a live client, so pin the wiring at the source level.
  const src = await Bun.file(new URL("./commands/discovery.ts", import.meta.url)).text();
  expect(src).toContain('import { mergeAgentCapabilities } from "../../shared/agent-capabilities.ts";');
  expect(src).toContain("mergeAgentCapabilities(results)");
  expect(src).not.toMatch(/new Map</);
});
