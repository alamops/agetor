/**
 * The worker bundle and the main code must be the same build
 * (docs/architecture/core-responsiveness.md, "Worker build id"): a worker whose id
 * differs is refused before it opens the database or runs a migration; the
 * entry path is resolved once per process; a forwarded log line is redacted
 * before it is cut.
 */
import { test, expect, afterAll, describe } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// db-rpc.ts reads the data dir through db-path.ts; db-path freezes it for the
// whole `bun test` process, so this file must never delete it.
const dataDir = process.env.AGETOR_DATA_DIR ?? mkdtempSync(path.join(tmpdir(), "agetor-worker-build-id-data-"));
process.env.AGETOR_DATA_DIR = dataDir;

const savedEntry = process.env.AGETOR_CORE_WORKER_ENTRY;
process.env.AGETOR_CORE_WORKER_ENTRY = path.join(import.meta.dir, "core-worker.ts");

const { BUILD_ID } = await import("./build-id.ts");
const { createDbRpc, DbUnavailableError } = await import("./db-rpc.ts");
const { createCoreWorker, resolveCoreWorkerEntry, resetPinnedCoreWorkerEntryForTests } = await import("./worker-entry.ts");
const { createTranscriptClient, TranscriptClientError } = await import("./transcript-client.ts");
const { prepareWorkerLogText, LOG_TEXT_MAX_CHARS } = await import("./workers/log-text.ts");

const tmpDirs: string[] = [];
const closers: Array<() => Promise<void> | void> = [];

function tmp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-worker-build-id-"));
  tmpDirs.push(dir);
  return dir;
}

afterAll(async () => {
  for (const c of closers) await c();
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  if (savedEntry === undefined) delete process.env.AGETOR_CORE_WORKER_ENTRY;
  else process.env.AGETOR_CORE_WORKER_ENTRY = savedEntry;
  resetPinnedCoreWorkerEntryForTests();
});

describe("build id handshake", () => {
  test("a db worker with a different build id is refused before the database is opened", async () => {
    const dbPath = path.join(tmp(), "agetor.sqlite");
    let started = 0;
    const rpc = createDbRpc({
      mode: "worker",
      dbPath,
      workerFactory: (p) => {
        started++;
        return createCoreWorker("db", { dbPath: p, buildId: "some-other-build" });
      },
    });
    closers.push(() => rpc.closeDb({ timeoutMs: 500 }));
    const err = await rpc.call("preferences", "get", ["k"]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DbUnavailableError);
    expect((err as Error).message).toContain("build mismatch");
    // The worker never opened the file, so no migration can have run.
    expect(existsSync(dbPath)).toBe(false);
    // And the client does not start another worker from the same bundle.
    const again = await rpc.call("preferences", "get", ["k"]).catch((e: unknown) => e);
    expect(again).toBeInstanceOf(DbUnavailableError);
    expect(started).toBe(1);
    expect(existsSync(dbPath)).toBe(false);
  });

  test("a worker that reports ready with another build id is refused by the client", async () => {
    const listeners = new Map<string, (ev: unknown) => void>();
    const fake = {
      postMessage() {},
      terminate() {},
      addEventListener(type: string, l: (ev: unknown) => void) { listeners.set(type, l); },
    };
    const rpc = createDbRpc({ mode: "worker", dbPath: path.join(tmp(), "x.sqlite"), workerFactory: () => fake });
    closers.push(() => rpc.closeDb({ timeoutMs: 500 }));
    const pending = rpc.call("preferences", "get", ["k"]).catch((e: unknown) => e);
    listeners.get("message")!({ data: { ready: true, buildId: "stale-worker-build" } });
    const err = await pending;
    expect(err).toBeInstanceOf(DbUnavailableError);
    expect((err as Error).message).toContain("stale-worker-build");
  });

  test("a matching worker opens and serves", async () => {
    const rpc = createDbRpc({
      mode: "worker",
      dbPath: path.join(tmp(), "agetor.sqlite"),
      workerFactory: (p) => createCoreWorker("db", { dbPath: p }),
    });
    closers.push(() => rpc.closeDb({ timeoutMs: 1000 }));
    await rpc.dbReady();
    expect(await rpc.call("preferences", "get", ["nothing"])).toBeNull();
    expect(BUILD_ID.length).toBeGreaterThan(0);
  });

  test("a transcript worker with a different build id is refused, for this call and every later one", async () => {
    let started = 0;
    const client = createTranscriptClient({
      mode: "worker",
      workerFactory: () => {
        started++;
        return createCoreWorker("transcript", { buildId: "some-other-build" });
      },
    });
    closers.push(() => client.close());
    const root = tmp();
    const file = path.join(root, "a.jsonl");
    writeFileSync(file, "{}\n");
    const first = await client.readChunk(file, 0, 1024, root).catch((e: unknown) => e);
    expect(first).toBeInstanceOf(TranscriptClientError);
    expect((first as InstanceType<typeof TranscriptClientError>).code).toBe("EBUILDMISMATCH");
    const second = await client.readChunk(file, 0, 1024, root).catch((e: unknown) => e);
    expect((second as InstanceType<typeof TranscriptClientError>).code).toBe("EBUILDMISMATCH");
    expect(started).toBe(1);
  });
});

describe("the worker entry is pinned", () => {
  test("later resolutions reuse the first one, even when the candidates change", () => {
    const saved = process.env.AGETOR_CORE_WORKER_ENTRY;
    delete process.env.AGETOR_CORE_WORKER_ENTRY;
    try {
      resetPinnedCoreWorkerEntryForTests();
      const dir = tmp();
      const first = path.join(dir, "first.js");
      const second = path.join(dir, "second.js");
      writeFileSync(first, "");
      writeFileSync(second, "");
      expect(resolveCoreWorkerEntry(() => [path.join(dir, "missing.js"), first])).toBe(first);
      // A restart or the lazy transcript worker resolves again: still the first.
      expect(resolveCoreWorkerEntry(() => [second])).toBe(first);
      expect(resolveCoreWorkerEntry()).toBe(first);
      rmSync(first);
      expect(resolveCoreWorkerEntry(() => [second])).toBe(first);
    } finally {
      resetPinnedCoreWorkerEntryForTests();
      process.env.AGETOR_CORE_WORKER_ENTRY = saved;
    }
  });
});

describe("worker log text", () => {
  test("a secret that straddles the length cut is redacted, not leaked", () => {
    // URL userinfo is redacted only when its closing `@` is present. The `@` sits
    // past the cut, so cutting first would keep 17 characters of the password.
    const url = "https://user:SUPERSECRETPASSWORD@example.com/x";
    const text = `${"a ".repeat((LOG_TEXT_MAX_CHARS - 30) / 2)}${url}`;
    expect(text.slice(0, LOG_TEXT_MAX_CHARS)).toContain("SUPERSECRETPASSWO");
    const out = prepareWorkerLogText(text);
    expect(out).not.toContain("SUPERSECRET");
  });

  test("short text passes through and long text is cut with a marker", () => {
    expect(prepareWorkerLogText("hello")).toBe("hello");
    const long = prepareWorkerLogText("x".repeat(LOG_TEXT_MAX_CHARS * 2));
    expect(long.endsWith("... [truncated]")).toBe(true);
    expect(long.length).toBeLessThanOrEqual(LOG_TEXT_MAX_CHARS + 20);
  });
});
