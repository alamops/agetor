// Per-run ordered append-and-emit (docs/plans/non-blocking-core.md, T10a).
//
// With an async database an insert is a thread hop, so two flows appending to
// the same run could finish out of order and send their live SSE events out of id
// order. `appendAndEmit` chains each call on the previous one for the same run
// id: inserts run one at a time per run, and each emit happens right after its
// own insert resolves, in call order. Different runs never wait on each other.
//
// A failed insert rejects only its own call (and is logged); the chain moves on.
// A run's chain entry is deleted as soon as it settles, so the map stays empty
// when idle and a long-lived core does not leak one entry per run.

const tails = new Map<number | string, Promise<void>>();

export function appendAndEmit<Row>(
  runId: number | string,
  insert: () => Promise<Row>,
  emit: (row: Row) => void,
): Promise<Row> {
  const prev = tails.get(runId) ?? Promise.resolve();
  const result = prev.then(async () => {
    const row = await insert();
    try {
      emit(row);
    } catch (e) {
      // A throwing emitter must not lose the saved row or stall later calls.
      console.error(`[run-emit-queue] emit for run ${String(runId)} threw`, e);
    }
    return row;
  });
  const tail: Promise<void> = result.then(
    () => undefined,
    (e: unknown) => {
      console.error(`[run-emit-queue] insert for run ${String(runId)} failed`, e);
    },
  );
  tails.set(runId, tail);
  void tail.then(() => {
    // Only the latest call for the run clears the entry.
    if (tails.get(runId) === tail) tails.delete(runId);
  });
  return result;
}

/** Number of runs with a call in flight (tests). */
export function pendingRunQueues(): number {
  return tails.size;
}
