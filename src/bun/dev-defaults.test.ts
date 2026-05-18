import { test, expect } from "bun:test";
import pkg from "../../package.json" with { type: "json" };
import { DEV_API_PORT } from "./dev-defaults.ts";

// Why this exists:
//   `package.json`'s `dev` / `dev:hmr` scripts hardcode the port as a
//   literal in their `AGETOR_API_PORT=…` env-var prefix. They can't
//   `import` from a TS module — npm scripts are shell strings. So we
//   keep `DEV_API_PORT` as the single source of truth and rely on these
//   tests to catch drift. Without the test, someone changing
//   `dev-defaults.ts` would silently leave `package.json` pointing at
//   the old port (or vice versa), and the next dev launch would either
//   collide with prod (both on 4317) or have `wipe-dev` look at the
//   wrong port.

function extractPort(script: string): number | null {
  const m = script.match(/AGETOR_API_PORT=(\d+)/);
  return m && m[1] ? Number(m[1]) : null;
}

test("package.json `dev` script embeds DEV_API_PORT", () => {
  const port = extractPort(pkg.scripts.dev);
  expect(port).toBe(DEV_API_PORT);
});

test("package.json `dev:hmr` script embeds DEV_API_PORT", () => {
  const port = extractPort(pkg.scripts["dev:hmr"]);
  expect(port).toBe(DEV_API_PORT);
});

test("DEV_API_PORT differs from the packaged-app default (4317)", () => {
  // The whole point of the split — if these ever line up, dev and prod
  // can collide on the same port and we're back to the original CORS bug.
  expect(DEV_API_PORT).not.toBe(4317);
});
