// Locates and starts the core worker (`core-worker.ts`, bundled as
// `core-worker.js`). Another build step produces and copies the bundle; this
// module only resolves it.
import { existsSync } from "node:fs";
import path from "node:path";
import type { TranscriptWorkerLike } from "./transcript-client.ts";

export type CoreWorkerRole = "db" | "transcript";

/** The slice of the Worker API the db client uses (Bun's `Worker` satisfies it). */
export interface CoreWorkerLike extends TranscriptWorkerLike {
  addEventListener(type: string, listener: (ev: unknown) => void): void;
}

/** Candidate paths of the worker entry, best first. */
export function coreWorkerCandidates(): string[] {
  const candidates: string[] = [];
  const fromEnv = process.env.AGETOR_CORE_WORKER_ENTRY;
  if (fromEnv) candidates.push(fromEnv);
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

/** The first candidate that exists. Throws when none does. */
export function resolveCoreWorkerEntry(): string {
  const candidates = coreWorkerCandidates();
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`core worker entry not found; looked in: ${candidates.join(", ")}`);
}

/** Start a worker and send its role's init message as the first message. */
export function createCoreWorker(role: CoreWorkerRole, init: Record<string, unknown> = {}): CoreWorkerLike {
  const worker = new Worker(resolveCoreWorkerEntry());
  worker.postMessage({ role, ...init });
  return worker as unknown as CoreWorkerLike;
}

/** For `createTranscriptClient({ workerFactory })`. */
export const transcriptWorkerFactory = (): CoreWorkerLike => createCoreWorker("transcript");
