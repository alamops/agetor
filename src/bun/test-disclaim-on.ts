// Test helper: turn `disclaimEnabled()` on for the duration of `fn` without
// spawning anything. `disclaimAvailable()` only checks that the helper path
// exists, so any existing file stands in for it; callers that would actually
// spawn must use a real passthrough stub instead (see discovery-fs.test.ts).
// Restores the env override and the in-memory switch afterwards — bun runs
// every test file in one process.
import { getDisclaimSwitch, setDisclaimSwitch } from "./disclaim.ts";

export async function withDisclaimOn<T>(fn: () => T | Promise<T>): Promise<T> {
  const originalBin = process.env.AGETOR_DISCLAIM_BIN;
  const originalSwitch = getDisclaimSwitch();
  process.env.AGETOR_DISCLAIM_BIN = "/bin/sh";
  setDisclaimSwitch(true);
  try {
    return await fn();
  } finally {
    if (originalBin === undefined) delete process.env.AGETOR_DISCLAIM_BIN;
    else process.env.AGETOR_DISCLAIM_BIN = originalBin;
    setDisclaimSwitch(originalSwitch);
  }
}
