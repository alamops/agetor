import { removeRunTmpdir } from "../src/test-run-tmpdir.ts";

/** Deletes this e2e run's temp root (created in playwright.config.ts), with
 *  every workdir, repo and stub the specs left in it. */
export default function globalTeardown(): void {
  const root = process.env.AGETOR_E2E_RUN_TMPDIR;
  if (!root || process.env.AGETOR_TEST_RETAIN_TMPDIR === "1") return;
  removeRunTmpdir(root);
}
