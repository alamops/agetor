// Locates and starts the core worker (`core-worker.ts`, bundled as
// `core-worker.js`). Another build step produces and copies the bundle; this
// module only resolves it.
import { existsSync } from "node:fs";
import path from "node:path";
import { BUILD_ID } from "./build-id.ts";
import type { TranscriptWorkerLike } from "./transcript-client.ts";

export type CoreWorkerRole = "db" | "transcript";

/** The slice of the Worker API the db client uses (Bun's `Worker` satisfies it). */
export interface CoreWorkerLike extends TranscriptWorkerLike {
  addEventListener(type: string, listener: (ev: unknown) => void): void;
}

/** Candidate paths of the worker entry, best first. */
export function coreWorkerCandidates(): string[] {
  const candidates: string[] = [];
  // A test/e2e seam, like the repo's other seams: production ignores it, because
  // whatever path it names is run as code in the core process.
  const fromEnv = process.env.AGETOR_CORE_WORKER_ENTRY;
  if (fromEnv && (process.env.NODE_ENV === "test" || process.env.AGETOR_E2E_HARNESS_SEAMS === "1")) candidates.push(fromEnv);
  // Next to the running bundle.
  candidates.push(path.join(import.meta.dir, "core-worker.js"));
  // The packaged app: the launcher may run our bundle from a temp file, so
  // `import.meta.dir` is not reliable there; the executable's own location is.
  const exeDir = path.dirname(process.execPath);
  candidates.push(path.resolve(exeDir, "../Resources/app/bun/core-worker.js"));
  candidates.push(path.resolve(exeDir, "../Resources/app/daemon/core-worker.js"));
  // Source runs (dev, tests).
  candidates.push(path.join(import.meta.dir, "core-worker.ts"));
  return candidates;
}

let pinnedEntry: string | null = null;

/** The worker entry for this process. The first call resolves it from the
 *  candidates and pins the result; every later start (a restart after a crash,
 *  the lazily created transcript worker) reuses that path, so a file that is
 *  swapped on disk afterwards (an in-place update, a dev rebuild) cannot change
 *  which code a later worker runs. The test/e2e `AGETOR_CORE_WORKER_ENTRY` seam
 *  is read on every call and never pinned. Throws when no candidate exists. */
export function resolveCoreWorkerEntry(candidatesFn: () => string[] = coreWorkerCandidates): string {
  const seam = process.env.AGETOR_CORE_WORKER_ENTRY;
  if (seam && (process.env.NODE_ENV === "test" || process.env.AGETOR_E2E_HARNESS_SEAMS === "1") && existsSync(seam)) {
    return seam;
  }
  if (pinnedEntry !== null) return pinnedEntry;
  const candidates = candidatesFn();
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      pinnedEntry = candidate;
      return candidate;
    }
  }
  throw new Error(`core worker entry not found; looked in: ${candidates.join(", ")}`);
}

/** Test seam: forget the pinned entry. */
export function resetPinnedCoreWorkerEntryForTests(): void {
  pinnedEntry = null;
}

/** Start a worker and send its role's init message as the first message. The
 *  init carries this bundle's build id; the worker refuses to run (before it
 *  opens the database) when its own id differs. `init.buildId` overrides it
 *  (tests). */
export function createCoreWorker(role: CoreWorkerRole, init: Record<string, unknown> = {}): CoreWorkerLike {
  const worker = new Worker(resolveCoreWorkerEntry());
  worker.postMessage({ role, buildId: BUILD_ID, ...init });
  return worker as unknown as CoreWorkerLike;
}

/** For `createTranscriptClient({ workerFactory })`. */
export const transcriptWorkerFactory = (): CoreWorkerLike => createCoreWorker("transcript");
