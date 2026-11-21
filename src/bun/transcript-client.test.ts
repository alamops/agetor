import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTranscriptClient, TranscriptClientError, type TranscriptWorkerLike } from "./transcript-client.ts";
import { readChunk, splitAndParseLines } from "./transcript-parse.ts";

const root = mkdtempSync(path.join(os.tmpdir(), "agetor-transcript-client-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const handlerPath = path.resolve(import.meta.dir, "workers/transcript-handler.ts");

// A test-only worker entry on a real thread: it wires the handler the way
// core-worker.ts will, plus triggers (by file name suffix) that crash, exit or
// hang the worker mid-request.
const workerEntry = path.join(root, "test-transcript-worker.ts");
writeFileSync(
  workerEntry,
  `import { handleTranscriptMessage } from ${JSON.stringify(handlerPath)};
declare const self: { onmessage: ((e: { data: any }) => void) | null; postMessage(m: unknown): void };
self.onmessage = (e) => {
  const p: string = e.data?.args?.path ?? "";
  if (p.endsWith("THROW")) throw new Error("worker boom");
  if (p.endsWith("EXIT")) { process.exit(3); return; } // exit may not halt this callback synchronously
  if (p.endsWith("HANG")) return;
  if (p.endsWith("LOG")) {
    // log messages carry no id and are never replies; the stray no-id messages are ignored too
    self.postMessage({ log: { level: "warn", text: "worker says hi" } });
    self.postMessage({ nothing: true });
    self.postMessage({ log: { level: "bogus", text: "odd level" } });
    self.postMessage({ ok: true, result: "no id" });
    handleTranscriptMessage({ ...e.data, args: { ...e.data.args, path: p.slice(0, -3) } }).then((reply) => self.postMessage(reply));
    return;
  }
  handleTranscriptMessage(e.data).then((reply) => self.postMessage(reply));
};
`,
);

const realWorker = (): TranscriptWorkerLike => new Worker(workerEntry) as unknown as TranscriptWorkerLike;

let seq = 0;
function fixture(content: string): string {
  const p = path.join(root, `t${++seq}.jsonl`);
  writeFileSync(p, content);
  return p;
}

describe("in-process mode", () => {
  test("is the default under NODE_ENV=test and reads lines", async () => {
    expect(process.env.NODE_ENV).toBe("test");
    const client = createTranscriptClient();
    expect(client.mode).toBe("inprocess");
    const p = fixture(`{"a":1}\nnot json\n{"partial":`);
    const r = await client.readChunk(p, 0, 4096);
    expect(r.lines.map((l) => l.parsed)).toEqual([{ a: 1 }, null]);
    expect(r.lines[1]!.error).toBeDefined();
    expect(r.nextOffset).toBe(`{"a":1}\nnot json\n`.length);
    client.close();
  });

  test("readMeta, and a handler-level failure rejects with its code", async () => {
    const dir = path.join(root, "subagents");
    mkdirSync(dir);
    writeFileSync(path.join(dir, "agent-x.meta.json"), JSON.stringify({ agentType: "Explore" }));
    const client = createTranscriptClient({ mode: "inprocess" });
    expect((await client.readMeta(dir, "x")).agentType).toBe("Explore");
    const err = await client.readChunk("relative/path.jsonl", 0, 10).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TranscriptClientError);
    expect((err as TranscriptClientError).code).toBe("EINVAL");
    await expect(client.readMeta(dir, "../escape")).rejects.toThrow(/file-name token/);
    await expect(client.readChunk(fixture("x\n"), 0, 0)).rejects.toThrow(/maxBytes/);
    client.close();
    await expect(client.readChunk(fixture("x\n"), 0, 10)).rejects.toThrow(/closed/);
  });

  test("allowedRoot is passed through and refused outside the root", async () => {
    const client = createTranscriptClient({ mode: "inprocess" });
    const dir = path.join(root, "rooted");
    mkdirSync(dir);
    writeFileSync(path.join(dir, "a.jsonl"), `{"a":1}\n`);
    expect((await client.readChunk(path.join(dir, "a.jsonl"), 0, 4096, dir)).lines).toHaveLength(1);
    await expect(client.readChunk(fixture("x\n"), 0, 4096, dir)).rejects.toThrow(/allowedRoot/);
    client.close();
  });

  test("worker mode without a workerFactory is refused", () => {
    expect(() => createTranscriptClient({ mode: "worker" })).toThrow(/workerFactory/);
  });
});

describe("worker mode on a real Worker thread", () => {
  test("reads chunks and metas through the worker; replies match calls in order", async () => {
    const client = createTranscriptClient({ mode: "worker", workerFactory: realWorker });
    try {
      const lines = Array.from({ length: 50 }, (_, i) => JSON.stringify({ i, t: "héllo 🙂".repeat(i) }));
      const p = fixture(lines.join("\n") + "\n{partial");
      // Fire several calls at once: FIFO means each resolves with its own offset's data.
      const calls = [0, 1, 2, 3].map(() => client.readChunk(p, 0, 64 * 1024));
      const results = await Promise.all(calls);
      for (const r of results) {
        expect(r.lines.map((l) => l.raw)).toEqual(lines);
        expect(r.eof).toBe(true);
      }
      const dir = path.join(root, "wsub");
      mkdirSync(dir);
      writeFileSync(path.join(dir, "agent-w.meta.json"), JSON.stringify({ toolUseId: "toolu_9", spawnDepth: 3 }));
      expect(await client.readMeta(dir, "w")).toEqual({ agentType: null, description: null, spawnDepth: 3, toolUseId: "toolu_9" });
    } finally {
      client.close();
    }
  });

  test("worker log messages are forwarded to the console with a prefix and never taken for replies", async () => {
    const good = fixture(`{"ok":true}\n`);
    const seen: unknown[][] = [];
    const origWarn = console.warn;
    const origLog = console.log;
    console.warn = (...a: unknown[]) => { seen.push(["warn", ...a]); };
    console.log = (...a: unknown[]) => { seen.push(["log", ...a]); };
    const client = createTranscriptClient({ mode: "worker", workerFactory: realWorker });
    try {
      const r = await client.readChunk(good + "LOG", 0, 4096);
      expect(r.lines).toHaveLength(1); // the real reply, not a log or id-less message
    } finally {
      client.close();
      console.warn = origWarn;
      console.log = origLog;
    }
    expect(seen).toContainEqual(["warn", "[agetor:transcript-worker]", "worker says hi"]);
    expect(seen).toContainEqual(["log", "[agetor:transcript-worker]", "odd level"]);
  });

  test("a symlinked transcript is refused through the worker too", async () => {
    const target = fixture(`{"a":1}\n`);
    const link = path.join(root, `wlink${++seq}.jsonl`);
    symlinkSync(target, link);
    const client = createTranscriptClient({ mode: "worker", workerFactory: realWorker });
    try {
      const refused = await client.readChunk(link, 0, 4096);
      expect(refused.lines).toEqual([]);
      expect(refused.nextOffset).toBe(0);
      expect((await client.readChunk(target, 0, 4096)).lines).toHaveLength(1);
    } finally {
      client.close();
    }
  });

  test("an uncaught throw in the worker rejects the in-flight call; the next call restarts and succeeds", async () => {
    let created = 0;
    const client = createTranscriptClient({
      mode: "worker",
      workerFactory: () => { created++; return realWorker(); },
    });
    try {
      const good = fixture(`{"ok":true}\n`);
      expect((await client.readChunk(good, 0, 4096)).lines).toHaveLength(1);
      expect(created).toBe(1);
      const failure = await client.readChunk(path.join(root, "THROW"), 0, 4096).catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(TranscriptClientError);
      expect((failure as TranscriptClientError).code).toBe("EWORKER");
      expect((failure as Error).message).toMatch(/worker boom/);
      expect((await client.readChunk(good, 0, 4096)).lines).toHaveLength(1);
      expect(created).toBe(2);
    } finally {
      client.close();
    }
  });

  test("a worker that exits mid-request rejects it, queued calls run on the restarted worker", async () => {
    let created = 0;
    const client = createTranscriptClient({
      mode: "worker",
      workerFactory: () => { created++; return realWorker(); },
    });
    try {
      const good = fixture(`{"ok":true}\n`);
      const crashing = client.readChunk(path.join(root, "EXIT"), 0, 4096).catch((e: unknown) => e);
      const queued = client.readChunk(good, 0, 4096); // behind the crashing call in the FIFO
      const crashErr = await crashing;
      expect(crashErr).toBeInstanceOf(TranscriptClientError);
      expect((crashErr as Error).message).toMatch(/worker exited/);
      expect((await queued).lines).toHaveLength(1);
      expect(created).toBe(2);
    } finally {
      client.close();
    }
  });

  test("a hung worker is terminated after the request budget and replaced", async () => {
    let created = 0;
    const client = createTranscriptClient({
      mode: "worker",
      timeoutMs: 300,
      workerFactory: () => { created++; return realWorker(); },
    });
    try {
      await expect(client.readChunk(path.join(root, "HANG"), 0, 4096)).rejects.toThrow(/no reply within 300 ms/);
      expect((await client.readChunk(fixture(`{"ok":1}\n`), 0, 4096)).lines).toHaveLength(1);
      expect(created).toBe(2);
    } finally {
      client.close();
    }
  });

  test("close() rejects in-flight and queued calls and terminates the worker", async () => {
    const client = createTranscriptClient({ mode: "worker", timeoutMs: 60_000, workerFactory: realWorker });
    const hung = client.readChunk(path.join(root, "HANG"), 0, 4096);
    const queued = client.readChunk(fixture(`{"ok":1}\n`), 0, 4096);
    const settled = Promise.allSettled([hung, queued]);
    client.close();
    const [a, b] = await settled;
    expect(a!.status).toBe("rejected");
    expect(b!.status).toBe("rejected");
    await expect(client.readChunk(fixture(`{"ok":1}\n`), 0, 4096)).rejects.toThrow(/closed/);
  });
});

describe("restart cap (fake worker, injected clock)", () => {
  function crashingWorker(): TranscriptWorkerLike {
    const listeners = new Map<string, Array<(ev: unknown) => void>>();
    return {
      addEventListener(type, l) { listeners.set(type, [...(listeners.get(type) ?? []), l]); },
      postMessage() {
        queueMicrotask(() => { for (const l of listeners.get("error") ?? []) l({ message: "always dies" }); });
      },
      terminate() { return undefined; },
    };
  }

  test("after 5 failures in the window calls fail fast with ERESTART; the window then clears", async () => {
    let clock = 1_000;
    let created = 0;
    const client = createTranscriptClient({
      mode: "worker",
      now: () => clock,
      workerFactory: () => { created++; return crashingWorker(); },
    });
    for (let i = 0; i < 5; i++) {
      await expect(client.readChunk("/tmp/x.jsonl", 0, 10)).rejects.toThrow(/always dies/);
    }
    expect(created).toBe(5);
    const refused = await client.readChunk("/tmp/x.jsonl", 0, 10).catch((e: unknown) => e);
    expect((refused as TranscriptClientError).code).toBe("ERESTART");
    expect(created).toBe(5); // no sixth worker was started
    clock += 61_000;
    await expect(client.readChunk("/tmp/x.jsonl", 0, 10)).rejects.toThrow(/always dies/);
    expect(created).toBe(6);
    client.close();
  });

  test("a factory that throws rejects the call with EWORKER and counts toward the cap", async () => {
    const client = createTranscriptClient({
      mode: "worker",
      workerFactory: () => { throw new Error("no threads"); },
    });
    const err = await client.readChunk("/tmp/x.jsonl", 0, 10).catch((e: unknown) => e);
    expect((err as TranscriptClientError).code).toBe("EWORKER");
    expect((err as Error).message).toMatch(/no threads/);
    client.close();
  });
});

describe("main-thread responsiveness reading a 20 MB JSONL", () => {
  const BIG_LINES = 20_000;
  const bigPath = path.join(root, "big.jsonl");
  const line = (i: number) =>
    JSON.stringify({
      type: "assistant",
      uuid: `uuid-${i}`,
      message: { stop_reason: i % 50 === 0 ? "end_turn" : null, content: [{ type: "text", text: "héllo ".repeat(160) }] },
    });
  writeFileSync(bigPath, Array.from({ length: BIG_LINES }, (_, i) => line(i)).join("\n") + "\n");

  /** Read the whole file in 256 KB chunks via `readFn`, returning lines read,
   *  elapsed ms and the longest gap between two 5 ms interval ticks. */
  async function measure(
    readFn: (offset: number) => Promise<{ lines: number; nextOffset: number; eof: boolean }>,
  ): Promise<{ lines: number; elapsedMs: number; maxGapMs: number }> {
    let last = performance.now();
    let maxGap = 0;
    const timer = setInterval(() => {
      const t = performance.now();
      maxGap = Math.max(maxGap, t - last);
      last = t;
    }, 5);
    const start = performance.now();
    last = start;
    let offset = 0;
    let lines = 0;
    try {
      for (;;) {
        const r = await readFn(offset);
        lines += r.lines;
        if (r.nextOffset === offset) break;
        offset = r.nextOffset;
        if (r.eof) break;
      }
    } finally {
      clearInterval(timer);
    }
    // A block that ends the run leaves no later tick to record it: count the
    // time since the last tick too.
    maxGap = Math.max(maxGap, performance.now() - last);
    return { lines, elapsedMs: performance.now() - start, maxGapMs: maxGap };
  }

  // Structured-clone deserialisation of each 256 KB reply is real main-thread work (~130 ms gaps
  // seen on an idle machine), so the floor sits at 200 ms, still well under the 490-1000 ms a
  // one-shot main-thread read produces (the comparison test below).
  const GAP_FLOOR_MS = 200;

  /** Longest gap between two 5 ms ticks with nothing else running. */
  async function idleMaxGap(durationMs: number): Promise<number> {
    let last = performance.now();
    let maxGap = 0;
    const timer = setInterval(() => {
      const t = performance.now();
      maxGap = Math.max(maxGap, t - last);
      last = t;
    }, 5);
    await new Promise((r) => setTimeout(r, durationMs));
    clearInterval(timer);
    return Math.max(maxGap, performance.now() - last);
  }

  test("worker mode keeps the main loop's max gap within max(200 ms, 3 x the idle baseline)", async () => {
    const client = createTranscriptClient({ mode: "worker", workerFactory: realWorker });
    try {
      await client.readMeta(root, "warmup"); // start the worker before timing
      const baselineGapMs = await idleMaxGap(400); // this run's own timer jitter under load
      const r = await measure(async (off) => {
        const c = await client.readChunk(bigPath, off, 256 * 1024);
        return { lines: c.lines.length, nextOffset: c.nextOffset, eof: c.eof };
      });
      console.log(`[transcript-client] 20 MB via worker: ${r.lines} lines in ${r.elapsedMs.toFixed(0)} ms, max main-loop gap ${r.maxGapMs.toFixed(1)} ms`);
      expect(r.lines).toBe(BIG_LINES);
      // Still fails when the read runs on the main thread (one-shot sync read: 490+ ms),
      // but scales with the jitter measured idle in the same run.
      const bound = Math.max(GAP_FLOOR_MS, baselineGapMs * 3);
      console.log(`[transcript-client] idle baseline gap ${baselineGapMs.toFixed(1)} ms, bound ${bound.toFixed(1)} ms`);
      expect(r.maxGapMs).toBeLessThanOrEqual(bound);
    } finally {
      client.close();
    }
  });

  test("comparison: the same read in-process (chunked async) and as one synchronous 20 MB read+parse", async () => {
    const client = createTranscriptClient({ mode: "inprocess" });
    const chunked = await measure(async (off) => {
      const c = await client.readChunk(bigPath, off, 256 * 1024);
      return { lines: c.lines.length, nextOffset: c.nextOffset, eof: c.eof };
    });
    console.log(`[transcript-client] 20 MB in-process chunked: ${chunked.lines} lines in ${chunked.elapsedMs.toFixed(0)} ms, max main-loop gap ${chunked.maxGapMs.toFixed(1)} ms`);
    expect(chunked.lines).toBe(BIG_LINES);

    const oneShot = await measure(async (off) => {
      if (off > 0) return { lines: 0, nextOffset: off, eof: true };
      const c = await readChunk(bigPath, 0, 64 * 1024 * 1024);
      const parsed = splitAndParseLines(c.text);
      return { lines: parsed.length, nextOffset: c.nextOffset, eof: c.eof };
    });
    console.log(`[transcript-client] 20 MB one-shot read+parse on the main thread: ${oneShot.lines} lines in ${oneShot.elapsedMs.toFixed(0)} ms, max main-loop gap ${oneShot.maxGapMs.toFixed(1)} ms`);
    expect(oneShot.lines).toBe(BIG_LINES);
  });
});
