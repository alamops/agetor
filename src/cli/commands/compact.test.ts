import { test, expect, mock, afterAll, beforeEach, afterEach, describe } from "bun:test";
import { ApiError, type AgetorClient } from "../api-client.ts";
import type { DbCompactResult, DbStats } from "../../shared/types.ts";

/**
 * `agetor compact` — docs/plans/non-blocking-session-restore.md row TT7.
 * Same mocking idiom as `bundle.test.ts`: `../output.ts` is replaced to
 * capture `out()`/`errln()`/`printJson()` with an identity palette and a
 * pinned non-TTY terminal, and the API client is a hand-rolled fake passed
 * straight to `cmdCompact` (no daemon).
 */

import * as realContext from "../context.ts";
import * as realOutput from "../output.ts";

const realContextSnapshot = { ...realContext };
const realOutputSnapshot = { ...realOutput };

const outputs: string[] = [];
const errors: string[] = [];
const jsonOutputs: unknown[] = [];

mock.module("../context.ts", () => ({
  ...realContextSnapshot,
  getClient: async () => {
    throw new Error("getClient must not be called — the test injects a client");
  },
}));

const id = (s: string) => s;
mock.module("../output.ts", () => ({
  ...realOutputSnapshot,
  isTTY: false,
  c: { dim: id, bold: id, red: id, green: id, yellow: id, cyan: id, gray: id, magenta: id, blue: id },
  out: (msg = "") => {
    outputs.push(msg);
  },
  errln: (msg = "") => {
    errors.push(msg);
  },
  printJson: (data: unknown) => {
    jsonOutputs.push(data);
  },
}));

afterAll(() => {
  mock.module("../context.ts", () => realContextSnapshot);
  mock.module("../output.ts", () => realOutputSnapshot);
});

const { cmdCompact, askCompact, compactStatsLines, formatBytes, interactiveCompact } = await import("./compact.ts");

const flags = { json: false, plain: true, noDaemon: true } as unknown as Parameters<typeof cmdCompact>[1];
const jsonFlags = { ...flags, json: true } as unknown as Parameters<typeof cmdCompact>[1];

const savedExitCode = process.exitCode;
beforeEach(() => {
  outputs.length = 0;
  errors.length = 0;
  jsonOutputs.length = 0;
  // bun does not reset the exit code on `= undefined`; use 0 as "untouched".
  process.exitCode = 0;
});
afterEach(() => {
  process.exitCode = savedExitCode ?? 0;
});

function makeStats(over: Partial<DbStats> = {}): DbStats {
  return {
    fileBytes: 5 * 1024 * 1024,
    walBytes: 1024 * 1024,
    pageSize: 4096,
    pageCount: 1536,
    freelistCount: 256,
    reclaimableBytes: 1024 * 1024,
    compactEstimateSec: 0.2,
    activeRunCount: 0,
    retention: { days: 30, lastRunAt: null, lastFreedBytes: null, lastTrimmedRows: null, running: false },
    ...over,
  };
}

const RESULT: DbCompactResult = { ok: true, beforeBytes: 6 * 1024 * 1024, afterBytes: 4 * 1024 * 1024, durationMs: 2500 };

interface FakeClient {
  client: AgetorClient;
  calls: string[];
}

function fakeClient(opts: {
  stats?: DbStats;
  statsError?: unknown;
  compact?: () => Promise<DbCompactResult>;
} = {}): FakeClient {
  const calls: string[] = [];
  const client = {
    dbStats: async () => {
      calls.push("dbStats");
      if (opts.statsError) throw opts.statsError;
      return opts.stats ?? makeStats();
    },
    compactDb: async () => {
      calls.push("compactDb");
      return (opts.compact ?? (async () => RESULT))();
    },
  } as unknown as AgetorClient;
  return { client, calls };
}

describe("cmdCompact", () => {
  test("off a terminal, without --yes, refuses before touching the core", async () => {
    const { client, calls } = fakeClient();
    await expect(cmdCompact([], flags, client)).rejects.toThrow(/--yes/);
    expect(calls).toEqual([]);
    expect(outputs).toEqual([]);
  });

  test("--yes prints the stats, posts, and prints the result", async () => {
    const { client, calls } = fakeClient();
    await cmdCompact(["--yes"], flags, client);
    expect(calls).toEqual(["dbStats", "compactDb"]);
    const text = outputs.join("\n");
    expect(text).toContain("database");
    expect(text).toContain("6.0 MB on disk");
    expect(text).toContain("reclaimable");
    expect(text).toContain("1.0 MB");
    expect(text).toContain("active runs");
    expect(text).toContain("Compacted: 6.0 MB → 4.0 MB in 2.5 s");
    expect(process.exitCode).toBe(0);
  });

  test("-y is an alias of --yes", async () => {
    const { client, calls } = fakeClient();
    await cmdCompact(["-y"], flags, client);
    expect(calls).toEqual(["dbStats", "compactDb"]);
  });

  test("running tasks add a warning line to the stats block", async () => {
    const { client } = fakeClient({ stats: makeStats({ activeRunCount: 2 }) });
    await cmdCompact(["--yes"], flags, client);
    expect(outputs.join("\n")).toContain("2 task(s) running");
  });

  test("a 409 refusal prints the server message, sets exit status 1, and prints no success line", async () => {
    const message = "2 task(s) running — stop or wait for them first";
    const { client, calls } = fakeClient({
      compact: async () => {
        throw new ApiError(409, { error: message, activeRunCount: 2 }, message);
      },
    });
    await cmdCompact(["--yes"], flags, client);
    expect(calls).toEqual(["dbStats", "compactDb"]);
    expect(errors).toEqual([message]);
    expect(process.exitCode).toBe(1);
    expect(outputs.join("\n")).not.toContain("Compacted");
  });

  test("a 409 under --json prints the raw body", async () => {
    const body = { error: "1 task(s) running — stop or wait for them first", activeRunCount: 1 };
    const { client } = fakeClient({
      compact: async () => {
        throw new ApiError(409, body, body.error);
      },
    });
    await cmdCompact(["--yes"], jsonFlags, client);
    expect(jsonOutputs).toEqual([body]);
    expect(errors).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  test("a non-409 failure propagates", async () => {
    const { client } = fakeClient({
      compact: async () => {
        throw new ApiError(500, { error: "boom" }, "boom");
      },
    });
    await expect(cmdCompact(["--yes"], flags, client)).rejects.toThrow("boom");
  });

  test("an old core without the route (404) gets a plain upgrade hint", async () => {
    const { client } = fakeClient({ statsError: new ApiError(404, {}, "not found") });
    await expect(cmdCompact(["--yes"], flags, client)).rejects.toThrow(/older than this CLI/);
  });

  test("--json without --yes is a read-only report: prints { stats } and compacts nothing", async () => {
    const stats = makeStats();
    const { client, calls } = fakeClient({ stats });
    await cmdCompact([], jsonFlags, client);
    expect(calls).toEqual(["dbStats"]);
    expect(jsonOutputs).toEqual([{ stats }]);
    expect(outputs).toEqual([]);
  });

  test("--json --yes compacts and prints { stats, result } without the human lines", async () => {
    const stats = makeStats();
    const { client, calls } = fakeClient({ stats });
    await cmdCompact(["--yes"], jsonFlags, client);
    expect(calls).toEqual(["dbStats", "compactDb"]);
    expect(jsonOutputs).toEqual([{ stats, result: RESULT }]);
    expect(outputs).toEqual([]);
  });

  test("interactive confirm: yes posts", async () => {
    const { client, calls } = fakeClient();
    const seen: DbStats[] = [];
    await cmdCompact([], flags, client, {
      confirm: async (s) => {
        seen.push(s);
        return true;
      },
    });
    expect(seen).toHaveLength(1);
    expect(calls).toEqual(["dbStats", "compactDb"]);
    expect(outputs.join("\n")).toContain("Compacted");
  });

  test("interactive confirm: no prints cancelled, posts nothing, exits 0", async () => {
    const { client, calls } = fakeClient();
    await cmdCompact([], flags, client, { confirm: async () => false });
    expect(calls).toEqual(["dbStats"]);
    expect(outputs.join("\n")).toContain("cancelled — nothing was compacted");
    expect(process.exitCode).toBe(0);
  });

  test("interactive confirm: Ctrl+C (null) cancels with exit 130", async () => {
    const { client, calls } = fakeClient();
    await cmdCompact([], flags, client, { confirm: async () => null });
    expect(calls).toEqual(["dbStats"]);
    expect(process.exitCode).toBe(130);
  });

  test("an unknown flag throws a usage error before any request", async () => {
    const { client, calls } = fakeClient();
    await expect(cmdCompact(["--bogus"], flags, client)).rejects.toThrow(/usage: agetor compact/);
    expect(calls).toEqual([]);
  });
});

describe("helpers", () => {
  test("interactiveCompact needs a terminal on both ends and no --yes / --json", () => {
    const both = { stdout: true, stdin: true };
    expect(interactiveCompact({ json: false }, { yes: false }, both)).toBe(true);
    expect(interactiveCompact({ json: false }, { yes: true }, both)).toBe(false);
    expect(interactiveCompact({ json: true }, { yes: false }, both)).toBe(false);
    expect(interactiveCompact({ json: false }, { yes: false }, { stdout: true, stdin: false })).toBe(false);
    expect(interactiveCompact({ json: false }, { yes: false }, { stdout: false, stdin: true })).toBe(false);
  });

  test("askCompact maps yes / no / Esc / Ctrl+C", async () => {
    const cancel = Symbol("cancel");
    const listeners = new Set<(chunk: Buffer | string) => void>();
    const stdin = {
      on: (_: string, fn: (chunk: Buffer | string) => void) => {
        listeners.add(fn);
        return stdin;
      },
      off: (_: string, fn: (chunk: Buffer | string) => void) => {
        listeners.delete(fn);
        return stdin;
      },
    } as unknown as NodeJS.ReadStream;
    const io = (answer: boolean | symbol, keys?: string) => ({
      confirm: async () => {
        if (keys) for (const fn of [...listeners]) fn(keys);
        return answer;
      },
      isCancel: (v: unknown): v is symbol => v === cancel,
      stdin,
    });
    const stats = makeStats();
    expect(await askCompact(stats, io(true))).toBe(true);
    expect(await askCompact(stats, io(false))).toBe(false);
    expect(await askCompact(stats, io(cancel, "\u001b"))).toBe(false);
    expect(await askCompact(stats, io(cancel, "\u0003"))).toBeNull();
    expect(listeners.size).toBe(0);
  });

  test("formatBytes and compactStatsLines", () => {
    expect(formatBytes(-1)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 ** 4)).toBe("1.0 TB");
    const lines = compactStatsLines(makeStats({ compactEstimateSec: 0.2 }));
    expect(lines.join("\n")).toContain("~1 s");
    expect(lines).toHaveLength(4);
    expect(compactStatsLines(makeStats({ activeRunCount: 3 }))).toHaveLength(5);
  });
});
