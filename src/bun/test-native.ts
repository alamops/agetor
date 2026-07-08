import type { ApiNative } from "./server.ts";

/**
 * A no-op {@link ApiNative} for tests that exercise native-backed routes
 * without an Electrobun host. Pass overrides to record or inspect specific
 * calls (e.g. `makeTestNative({ openExternal: (u) => { opened.push(u); return true; } })`).
 *
 * Type-only import of `ApiNative` keeps this helper free of any runtime
 * dependency on `server.ts` (so importing it never opens the database).
 */
export function makeTestNative(over: Partial<ApiNative> = {}): ApiNative {
  return {
    openFileDialog: async () => [],
    openPath: () => true,
    openExternal: () => true,
    showNotification: () => {},
    quit: () => {},
    updates: {
      snapshot: () => ({
        status: "idle",
        version: null,
        error: null,
        lastCheckedAt: null,
      }),
      check: async () => {},
      apply: async () => {},
    },
    ...over,
  };
}
