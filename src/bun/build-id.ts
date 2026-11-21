// The build id of this code (docs/architecture/core-responsiveness.md, "Worker
// build id"). The core's worker thread runs from its own bundle file
// (`core-worker.js`), which can end up beside a main bundle from a different
// build (a dev watch rebuild, an in-place app update). Both bundles carry the
// same id, the main thread passes its own in the worker's init message, and a
// worker whose id differs refuses before it opens the database or runs a
// migration. The worker also reports its id in `{ ready }`, and the client
// refuses a mismatch there too.
//
// `scripts/build-daemon-bundle.ts` writes `vendor/build-id/build-id.ts` (a hash
// of `src/bun`, `src/shared` and package.json) before it builds the bundles;
// Electrobun's `preBuild` hook runs that script before every dev rebuild too, so
// the main bundle and the worker copy agree. A source run (tests, `bun
// src/bun/headless.ts`) has no generated file and uses the stable marker "dev",
// which is also what a worker started from `core-worker.ts` reports.

/** Marker a source run reports; the generated file replaces it in a bundle. */
export const DEV_BUILD_ID = "dev";

function readGeneratedBuildId(): string {
  try {
    // A relative path, so `Bun.build` inlines the generated file into a bundle.
    const mod = require("../../vendor/build-id/build-id.ts") as { BUILD_ID?: unknown };
    return typeof mod.BUILD_ID === "string" && mod.BUILD_ID !== "" ? mod.BUILD_ID : DEV_BUILD_ID;
  } catch {
    return DEV_BUILD_ID;
  }
}

export const BUILD_ID: string = readGeneratedBuildId();
