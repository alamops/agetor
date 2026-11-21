import { defineOp } from "./define.ts";

// Ops that exist so the transaction and rollback contract is testable. `findOp`
// refuses the `__test.` prefix outside NODE_ENV=test.
export const testOps = {
  /** Set several preferences in one transaction; throws after `failAfter`
   *  writes (when given) so a test can prove the earlier ones roll back. */
  "__test.setPreferences": defineOp({
    tx: true,
    run: ({ modules }, entries: [string, string][], failAfter: number | null): number => {
      let written = 0;
      for (const [key, value] of entries) {
        if (failAfter !== null && written >= failAfter) throw new Error("__test.setPreferences: forced failure");
        modules.preferences.set(key, value);
        written++;
      }
      return written;
    },
  }),
  /** Same writes without a transaction, to show `tx: false` does not roll back. */
  "__test.setPreferencesNoTx": defineOp({
    tx: false,
    run: ({ modules }, entries: [string, string][], failAfter: number | null): number => {
      let written = 0;
      for (const [key, value] of entries) {
        if (failAfter !== null && written >= failAfter) throw new Error("__test.setPreferencesNoTx: forced failure");
        modules.preferences.set(key, value);
        written++;
      }
      return written;
    },
  }),
};
