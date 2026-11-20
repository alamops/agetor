// Test fixture (route-db-errors.test.ts): a stand-in for `core-worker.ts`'s `db`
// role that opens no database, reports ready, and exits its thread on the first
// request it receives. Every call in flight then rejects with
// `DbRestartingError` (db-rpc.ts), the client restarts it, and once the restart
// cap is spent the next calls reject with `DbUnavailableError`. Selected through
// `AGETOR_CORE_WORKER_ENTRY`, which only a test or e2e run honors.

declare const self: Worker;

let initialized = false;

self.onmessage = () => {
  if (!initialized) {
    initialized = true;
    self.postMessage({ ready: true });
    return;
  }
  // A request (or the client's close): the "crash". Exits the worker thread only.
  process.exit(1);
};
