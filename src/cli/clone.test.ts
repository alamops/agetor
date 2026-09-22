import { test, expect, mock, afterAll } from "bun:test";
import path from "node:path";
import { ApiError } from "./api-client.ts";
import type { AgetorClient } from "./api-client.ts";
import type { AppEvent, CloneProgressPhase, GitProvider, Project } from "../shared/types.ts";

/**
 * `cmdClone` (commands/clone.ts) reaches for a client via `getClient(flags)`,
 * same as every other one-shot command — this suite mocks `./context.ts`
 * (for `getClient`), `./output.ts` (to capture `out()`/`errln()`/
 * `printJson()`) and `./sse.ts` (to capture the `/app/events` subscription
 * `cmdClone` opens for clone-progress rendering, the way `logs.test.ts`
 * mocks it for `/tasks/:id/events`) and drives the real `cmdClone` against a
 * fake `AgetorClient`, following the mocking idiom `files.test.ts`/
 * `resume.test.ts` established.
 *
 * All three mocked modules are snapshotted before mocking and restored in
 * `afterAll` — `mock.module` overwrites the module record in place (Bun's
 * documented behavior for already-loaded modules), and other test files in
 * the same `bun test` process import these same modules.
 *
 * The `CloneProgressPrinter`/`formatCloneProgressLine` rendering is itself
 * unit-tested standalone (no client, no SSE, no `cmdClone`) further below;
 * the `cmdClone`-level tests instead spy on the real `process.stderr.write`
 * (via `spyStderr`) since the printer writes there directly, bypassing the
 * mocked `errln`/`out` — mirroring how git's own `--progress` output rides
 * stderr, not the command's normal stdout success line.
 *
 * `AgetorClient.cloneProject`/`cancelClone` are exercised separately below
 * against a bare `Bun.serve` stub (mirrors the `resumeFxRecovery`/
 * `cancelFxAutoResume` request-shape tests in `api-client.test.ts`) — no
 * daemon, no mocked modules involved, since that test imports the real,
 * unmocked client.
 */

import * as realContext from "./context.ts";
import * as realOutput from "./output.ts";
import * as realSse from "./sse.ts";

const realContextSnapshot = { ...realContext };
const realOutputSnapshot = { ...realOutput };
const realSseSnapshot = { ...realSse };

let currentClient: AgetorClient | null = null;
const outputs: string[] = [];
const errOutputs: string[] = [];
const jsonOutputs: unknown[] = [];

// Captured by the `./sse.ts` mock below — reset per test in `reset()`.
let onAppEvents: ((e: AppEvent) => void) | null = null;
let sseCalls: { pathname: string; dataDir?: string }[] = [];
let orderLog: string[] = [];

mock.module("./context.ts", () => ({
  ...realContextSnapshot,
  getClient: async () => {
    if (!currentClient) throw new Error("no fake client set for this test");
    return currentClient;
  },
}));

mock.module("./output.ts", () => ({
  ...realOutputSnapshot,
  c: {
    dim: (s: string) => s,
    bold: (s: string) => s,
    red: (s: string) => s,
    green: (s: string) => s,
    yellow: (s: string) => s,
    cyan: (s: string) => s,
    gray: (s: string) => s,
    magenta: (s: string) => s,
    blue: (s: string) => s,
  },
  out: (msg = "") => {
    outputs.push(msg);
  },
  errln: (msg = "") => {
    errOutputs.push(msg);
  },
  printJson: (data: unknown) => {
    jsonOutputs.push(data);
  },
}));

mock.module("./sse.ts", () => ({
  ...realSseSnapshot,
  streamSse: (
    pathname: string,
    onEvent: (e: unknown) => void,
    opts?: { dataDir?: string },
  ) => {
    sseCalls.push({ pathname, dataDir: opts?.dataDir });
    orderLog.push(`open:${pathname}`);
    if (pathname === "/app/events") onAppEvents = onEvent as (e: AppEvent) => void;
    return {
      close: () => {
        orderLog.push(`close:${pathname}`);
      },
    };
  },
}));

afterAll(() => {
  mock.module("./context.ts", () => realContextSnapshot);
  mock.module("./output.ts", () => realOutputSnapshot);
  mock.module("./sse.ts", () => realSseSnapshot);
});

const { cmdClone, formatCloneProgressLine, CloneProgressPrinter } = await import(
  "./commands/clone.ts"
);

type CloneInput = {
  url: string;
  provider?: GitProvider;
  dest?: string;
  eli5?: boolean;
  cloneId?: string;
};

type CloneResult = {
  project: Project;
  provider?: GitProvider;
  eli5TaskId: string | null;
  eli5Error: string | null;
  cloneId?: string;
};

/** Reads `process.exitCode` through a function call rather than a plain
 *  variable alias — TS's control-flow narrowing otherwise carries the type
 *  from an earlier `process.exitCode = undefined` reset straight through a
 *  `const` alias (even one with an explicit wider annotation) into
 *  `expect(...)`'s inferred generic, making `.toBe(130)` a compile error
 *  even though the reassignment inside the awaited `cmdClone` call already
 *  changed the runtime value by the time this reads it. */
function currentExitCode(): number | string | null | undefined {
  return process.exitCode;
}

/** Spies on the real `process.stderr.write` (restore via the returned
 *  `restore()`) — the `CloneProgressPrinter` writes there directly, not
 *  through the mocked `errln`. */
function spyStderr(): { writes: string[]; restore: () => void } {
  const writes: string[] = [];
  const stream = process.stderr as unknown as { write: (chunk: string) => boolean };
  const orig = stream.write;
  stream.write = (chunk: string) => {
    writes.push(chunk);
    return true;
  };
  return {
    writes,
    restore: () => {
      stream.write = orig;
    },
  };
}

function project(overrides: Partial<Project> = {}): Project {
  return {
    path: "/home/user/repo",
    name: "repo",
    addedAt: 1_700_000_000_000,
    branchConfig: null,
    ...overrides,
  };
}

/** A `clone_progress` event to synthesize, minus `type`/`ts`/`cloneId` —
 *  `cloneId` defaults to whatever the triggering `cloneProject` call carried,
 *  so a test doesn't need to know the minted UUID up front; pass one
 *  explicitly to simulate a foreign/stale event that should be ignored. */
type ProgressEventInput = {
  cloneId?: string;
  phase: CloneProgressPhase;
  percent: number | null;
  line: string;
};

/** Builds a fake client + a capture of every `cloneProject` call (there
 *  should only ever be at most one per test, but keeping a list makes "never
 *  called" assertions trivial: `expect(calls).toHaveLength(0)`).
 *
 *  `progressEvents` (if given) are pushed through the captured `/app/events`
 *  handler — exactly like the server would — right after the call is
 *  recorded and before the result resolves, so a test can assert on what
 *  `cmdClone`'s progress printer did with them. `cancelClone` defaults to a
 *  stub that throws if called, since most tests never trigger Ctrl+C. */
function makeClient(
  result: CloneResult | (() => Promise<CloneResult>),
  calls: CloneInput[],
  opts: {
    progressEvents?: ProgressEventInput[];
    cancelClone?: (cloneId: string) => Promise<{ ok: boolean }>;
  } = {},
): AgetorClient {
  return {
    cloneProject: async (input: CloneInput) => {
      calls.push(input);
      orderLog.push("post");
      for (const ev of opts.progressEvents ?? []) {
        onAppEvents?.({
          type: "clone_progress",
          cloneId: ev.cloneId ?? input.cloneId ?? "",
          phase: ev.phase,
          percent: ev.percent,
          line: ev.line,
          ts: Date.now(),
        });
      }
      if (typeof result === "function") return result();
      return result;
    },
    cancelClone:
      opts.cancelClone ??
      (async () => {
        throw new Error("cancelClone should not have been called in this test");
      }),
  } as unknown as AgetorClient;
}

const flags = { json: false, plain: true, noDaemon: true } as unknown as Parameters<typeof cmdClone>[1];
const jsonFlags = { ...flags, json: true } as unknown as Parameters<typeof cmdClone>[1];

function reset(): void {
  outputs.length = 0;
  errOutputs.length = 0;
  jsonOutputs.length = 0;
  onAppEvents = null;
  sseCalls = [];
  orderLog = [];
}

test("clone owner/repo: forwards {url, eli5: true, cloneId} with provider/dest undefined; progress on stderr, success + provider line on stdout", async () => {
  reset();
  const calls: CloneInput[] = [];
  const stderr = spyStderr();
  try {
    currentClient = makeClient(
      { project: project(), provider: "github", eli5TaskId: null, eli5Error: null },
      calls,
      { progressEvents: [{ phase: "starting", percent: null, line: "" }] },
    );

    await cmdClone(["owner/repo"], flags);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("owner/repo");
    expect(calls[0]!.eli5).toBe(true);
    expect(calls[0]!.provider).toBeUndefined();
    expect(calls[0]!.dest).toBeUndefined();
    expect(calls[0]!.cloneId).toMatch(/^[0-9a-f-]{36}$/);

    // The old static "cloning <url>…" line is gone — the printer's own
    // first rendered line (from the "starting" progress event above) is
    // what tells the user something is happening now.
    expect(stderr.writes.some((l) => l.includes("starting…"))).toBe(true);
    expect(outputs.some((l) => l.includes("repo") && l.includes("/home/user/repo"))).toBe(true);
    expect(outputs).toContain("provider: GitHub");
  } finally {
    stderr.restore();
  }
});

test("--provider gitlab is forwarded verbatim", async () => {
  reset();
  const calls: CloneInput[] = [];
  currentClient = makeClient(
    { project: project(), provider: "gitlab", eli5TaskId: null, eli5Error: null },
    calls,
  );

  await cmdClone(["owner/repo", "--provider", "gitlab"], flags);

  expect(calls).toHaveLength(1);
  expect(calls[0]!.provider).toBe("gitlab");
});

test("--provider svn throws a validation error and never calls the client", async () => {
  reset();
  const calls: CloneInput[] = [];
  currentClient = makeClient(
    { project: project(), provider: "github", eli5TaskId: null, eli5Error: null },
    calls,
  );

  await expect(cmdClone(["owner/repo", "--provider", "svn"], flags)).rejects.toThrow(
    "--provider must be one of github, gitlab, bitbucket",
  );
  expect(calls).toHaveLength(0);
});

test("--provider with no value throws flagValue's error and never calls the client", async () => {
  reset();
  const calls: CloneInput[] = [];
  currentClient = makeClient(
    { project: project(), provider: "github", eli5TaskId: null, eli5Error: null },
    calls,
  );

  await expect(cmdClone(["owner/repo", "--provider"], flags)).rejects.toThrow(/needs a value/);
  expect(calls).toHaveLength(0);
});

test("--dest ./some/rel is resolved to an absolute path", async () => {
  reset();
  const calls: CloneInput[] = [];
  currentClient = makeClient(
    { project: project(), provider: "github", eli5TaskId: null, eli5Error: null },
    calls,
  );

  await cmdClone(["owner/repo", "--dest", "./some/rel"], flags);

  expect(calls).toHaveLength(1);
  expect(calls[0]!.dest).toBe(path.resolve("./some/rel"));
  expect(path.isAbsolute(calls[0]!.dest!)).toBe(true);
});

test("--dest already absolute is passed through unchanged", async () => {
  reset();
  const calls: CloneInput[] = [];
  currentClient = makeClient(
    { project: project(), provider: "github", eli5TaskId: null, eli5Error: null },
    calls,
  );

  await cmdClone(["owner/repo", "--dest", "/tmp/some/abs"], flags);

  expect(calls).toHaveLength(1);
  expect(calls[0]!.dest).toBe(path.resolve("/tmp/some/abs"));
  expect(calls[0]!.dest).toBe("/tmp/some/abs");
});

test("--no-eli5 forwards eli5: false", async () => {
  reset();
  const calls: CloneInput[] = [];
  currentClient = makeClient(
    { project: project(), provider: "github", eli5TaskId: null, eli5Error: null },
    calls,
  );

  await cmdClone(["owner/repo", "--no-eli5"], flags);

  expect(calls).toHaveLength(1);
  expect(calls[0]!.eli5).toBe(false);
});

test("flags may appear in any order relative to each other", async () => {
  reset();
  const calls: CloneInput[] = [];
  currentClient = makeClient(
    { project: project(), provider: "gitlab", eli5TaskId: null, eli5Error: null },
    calls,
  );

  await cmdClone(
    ["owner/repo", "--no-eli5", "--dest", "./x", "--provider", "gitlab"],
    flags,
  );

  expect(calls).toHaveLength(1);
  expect(calls[0]!).toMatchObject({
    url: "owner/repo",
    provider: "gitlab",
    dest: path.resolve("./x"),
    eli5: false,
  });

  reset();
  currentClient = makeClient(
    { project: project(), provider: "gitlab", eli5TaskId: null, eli5Error: null },
    calls,
  );

  await cmdClone(
    ["owner/repo", "--provider", "gitlab", "--dest", "./x", "--no-eli5"],
    flags,
  );

  expect(calls).toHaveLength(2);
  expect(calls[1]!).toMatchObject({
    url: "owner/repo",
    provider: "gitlab",
    dest: path.resolve("./x"),
    eli5: false,
  });
});

test("missing URL throws the clone usage error (first USAGE.clone line) and never calls the client", async () => {
  reset();
  const calls: CloneInput[] = [];
  currentClient = makeClient(
    { project: project(), provider: "github", eli5TaskId: null, eli5Error: null },
    calls,
  );

  await expect(cmdClone([], flags)).rejects.toThrow(
    "usage: agetor clone <url> [--provider github|gitlab|bitbucket] [--dest <path>] [--no-eli5]",
  );
  expect(calls).toHaveLength(0);
});

test("a first arg starting with '-' throws the same usage error and never calls the client", async () => {
  reset();
  const calls: CloneInput[] = [];
  currentClient = makeClient(
    { project: project(), provider: "github", eli5TaskId: null, eli5Error: null },
    calls,
  );

  await expect(cmdClone(["--provider", "github"], flags)).rejects.toThrow(
    "usage: agetor clone <url> [--provider github|gitlab|bitbucket] [--dest <path>] [--no-eli5]",
  );
  expect(calls).toHaveLength(0);
});

test("unknown flag --bogus throws and never calls the client", async () => {
  reset();
  const calls: CloneInput[] = [];
  currentClient = makeClient(
    { project: project(), provider: "github", eli5TaskId: null, eli5Error: null },
    calls,
  );

  await expect(cmdClone(["owner/repo", "--bogus"], flags)).rejects.toThrow(
    "unknown flag: --bogus",
  );
  expect(calls).toHaveLength(0);
});

test("eli5TaskId present: success output includes the explainer task id", async () => {
  reset();
  const calls: CloneInput[] = [];
  currentClient = makeClient(
    { project: project(), provider: "github", eli5TaskId: "task123456", eli5Error: null },
    calls,
  );

  await cmdClone(["owner/repo"], flags);

  expect(outputs.some((l) => l.includes("task123456"))).toBe(true);
  expect(outputs.some((l) => l.includes("explainer task started"))).toBe(true);
});

test("eli5Error present: a yellow warning line includes the error text", async () => {
  reset();
  const calls: CloneInput[] = [];
  currentClient = makeClient(
    {
      project: project(),
      provider: "github",
      eli5TaskId: null,
      eli5Error: "explainer task failed to start: boom",
    },
    calls,
  );

  await cmdClone(["owner/repo"], flags);

  expect(
    outputs.some((l) => l.includes("explainer task failed to start: boom")),
  ).toBe(true);
});

test("response without a `provider` field (older core): no throw, no provider line, success still printed", async () => {
  reset();
  const calls: CloneInput[] = [];
  currentClient = makeClient(
    { project: project(), eli5TaskId: null, eli5Error: null } as CloneResult,
    calls,
  );

  await cmdClone(["owner/repo"], flags);

  expect(outputs.some((l) => l.startsWith("provider:"))).toBe(false);
  expect(outputs.some((l) => l.includes("repo"))).toBe(true);
});

test("--json: printJson receives the raw result and no progress/success lines are emitted, and no SSE connection is opened", async () => {
  reset();
  const calls: CloneInput[] = [];
  const result: CloneResult = {
    project: project(),
    provider: "github",
    eli5TaskId: "task999",
    eli5Error: null,
  };
  currentClient = makeClient(result, calls);

  await cmdClone(["owner/repo"], jsonFlags);

  expect(jsonOutputs).toEqual([result]);
  expect(outputs).toEqual([]);
  expect(errOutputs).toEqual([]);
  expect(sseCalls).toHaveLength(0);
  // `cloneId` is still minted and sent even in --json mode (cancel support
  // doesn't depend on progress rendering).
  expect(calls[0]!.cloneId).toMatch(/^[0-9a-f-]{36}$/);
});

test("a client rejection propagates and prints no success line", async () => {
  reset();
  const calls: CloneInput[] = [];
  currentClient = makeClient(
    () => Promise.reject(new Error("clone failed: repository not found")),
    calls,
  );

  await expect(cmdClone(["owner/repo"], flags)).rejects.toThrow(
    "clone failed: repository not found",
  );
  expect(outputs.some((l) => l.includes("cloned"))).toBe(false);
});

test("streamSse opens /app/events before the POST and closes it after settling", async () => {
  reset();
  const calls: CloneInput[] = [];
  currentClient = makeClient(
    { project: project(), provider: "github", eli5TaskId: null, eli5Error: null },
    calls,
  );

  await cmdClone(["owner/repo"], flags);

  expect(orderLog).toEqual(["open:/app/events", "post", "close:/app/events"]);
});

test("clone_progress events for a foreign cloneId are ignored; only the matching one is rendered", async () => {
  reset();
  const calls: CloneInput[] = [];
  const stderr = spyStderr();
  try {
    currentClient = makeClient(
      { project: project(), provider: "github", eli5TaskId: null, eli5Error: null },
      calls,
      {
        progressEvents: [
          { cloneId: "not-the-real-clone-id", phase: "counting", percent: 10, line: "" },
          { phase: "receiving", percent: 50, line: "" },
        ],
      },
    );

    await cmdClone(["owner/repo"], flags);

    expect(stderr.writes.some((l) => l.includes("counting objects"))).toBe(false);
    expect(stderr.writes.some((l) => l.includes("receiving objects 50%"))).toBe(true);
  } finally {
    stderr.restore();
  }
});

test("a 409 cancelled clone rejection prints 'clone cancelled' and sets exit code 130", async () => {
  reset();
  const calls: CloneInput[] = [];
  const savedExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    currentClient = makeClient(
      () =>
        Promise.reject(
          new ApiError(409, { error: "clone cancelled", cancelled: true, cloneId: "x" }, "clone cancelled"),
        ),
      calls,
    );

    await cmdClone(["owner/repo"], flags);

    expect(errOutputs.some((l) => l.includes("clone cancelled"))).toBe(true);
    expect(outputs.some((l) => l.includes("cloned"))).toBe(false);
    expect(currentExitCode()).toBe(130);
  } finally {
    process.exitCode = savedExitCode;
  }
});

test("--json: a 409 cancelled clone rejection prints the body as JSON and sets exit code 130", async () => {
  reset();
  const calls: CloneInput[] = [];
  const savedExitCode = process.exitCode;
  process.exitCode = undefined;
  const body = { error: "clone cancelled", cancelled: true, cloneId: "x" };
  try {
    currentClient = makeClient(
      () => Promise.reject(new ApiError(409, body, "clone cancelled")),
      calls,
    );

    await cmdClone(["owner/repo"], jsonFlags);

    expect(jsonOutputs).toEqual([body]);
    expect(outputs).toEqual([]);
    expect(currentExitCode()).toBe(130);
  } finally {
    process.exitCode = savedExitCode;
  }
});

test("a non-cancelled 409 rejection propagates as a normal error (no exit-code-130 special-casing)", async () => {
  reset();
  const calls: CloneInput[] = [];
  currentClient = makeClient(
    () => Promise.reject(new ApiError(409, { error: "some other conflict" }, "some other conflict")),
    calls,
  );

  await expect(cmdClone(["owner/repo"], flags)).rejects.toThrow("some other conflict");
});

test("SIGINT calls client.cancelClone with the minted cloneId; a 404 response is swallowed and the pending clone still settles", async () => {
  reset();
  const calls: CloneInput[] = [];
  const cancelCalls: string[] = [];
  let resolveClone!: (v: CloneResult) => void;
  const pending = new Promise<CloneResult>((res) => {
    resolveClone = res;
  });
  currentClient = {
    cloneProject: async (input: CloneInput) => {
      calls.push(input);
      // Simulate Ctrl+C landing while the POST is still held open.
      process.emit("SIGINT", "SIGINT");
      return pending;
    },
    cancelClone: async (cloneId: string) => {
      cancelCalls.push(cloneId);
      throw new ApiError(404, { error: "not found" }, "not found");
    },
  } as unknown as AgetorClient;

  const p = cmdClone(["owner/repo"], flags);
  // Flush the microtask queue so the SIGINT handler's `cancelClone(...)`
  // call (and its `.catch`) has actually run before we assert on it.
  await new Promise((r) => setTimeout(r, 0));

  expect(cancelCalls).toHaveLength(1);
  expect(calls).toHaveLength(1);
  expect(cancelCalls[0]).toBe(calls[0]!.cloneId);

  resolveClone({ project: project(), provider: "github", eli5TaskId: null, eli5Error: null });
  await p;
});

test("SIGINT latch: a second SIGINT prints 'aborted' and calls process.exit(130) without re-calling cancelClone", async () => {
  reset();
  const calls: CloneInput[] = [];
  const cancelCalls: string[] = [];
  const exitCalls: number[] = [];
  const origExit = process.exit;
  process.exit = ((code?: number) => {
    exitCalls.push(code ?? 0);
    return undefined as never;
  }) as typeof process.exit;

  let resolveClone!: (v: CloneResult) => void;
  const pending = new Promise<CloneResult>((res) => {
    resolveClone = res;
  });
  const stderr = spyStderr();
  try {
    currentClient = {
      cloneProject: async (input: CloneInput) => {
        calls.push(input);
        // First SIGINT: cancel + notice, no exit. Second: abort + exit(130).
        process.emit("SIGINT", "SIGINT");
        process.emit("SIGINT", "SIGINT");
        return pending;
      },
      cancelClone: async (cloneId: string) => {
        cancelCalls.push(cloneId);
        return { ok: true };
      },
    } as unknown as AgetorClient;

    const p = cmdClone(["owner/repo"], flags);
    await new Promise((r) => setTimeout(r, 0));

    expect(cancelCalls).toHaveLength(1);
    expect(exitCalls).toEqual([130]);
    expect(
      stderr.writes.some((l) => l.includes("cancelling… (press Ctrl+C again to abort")),
    ).toBe(true);
    expect(stderr.writes.some((l) => l.includes("aborted"))).toBe(true);

    resolveClone({ project: project(), provider: "github", eli5TaskId: null, eli5Error: null });
    await p;
  } finally {
    process.exit = origExit;
    stderr.restore();
  }
});

// ── formatCloneProgressLine / CloneProgressPrinter ──────────────────────────

const ALL_PHASES: CloneProgressPhase[] = [
  "starting",
  "counting",
  "compressing",
  "receiving",
  "resolving",
  "checking-out",
  "done",
  "failed",
  "cancelled",
];

test.each(ALL_PHASES)("formatCloneProgressLine: %s with a percent renders '<label> NN%%'", (phase) => {
  const line = formatCloneProgressLine({ phase, percent: 42, line: "" });
  expect(line.endsWith(" 42%")).toBe(true);
  expect(line).not.toContain("—");
});

test.each(ALL_PHASES)(
  "formatCloneProgressLine: %s with percent null and no line renders the bare label",
  (phase) => {
    const line = formatCloneProgressLine({ phase, percent: null, line: "" });
    expect(line).not.toMatch(/\d+%/);
    expect(line).not.toContain("—");
  },
);

test.each(ALL_PHASES)(
  "formatCloneProgressLine: %s with percent null and a detail line renders '<label> — <line>'",
  (phase) => {
    const line = formatCloneProgressLine({ phase, percent: null, line: "some detail" });
    expect(line.endsWith("— some detail")).toBe(true);
  },
);

test("formatCloneProgressLine: known phase labels", () => {
  expect(formatCloneProgressLine({ phase: "starting", percent: null, line: "" })).toBe("starting…");
  expect(formatCloneProgressLine({ phase: "counting", percent: 5, line: "" })).toBe(
    "counting objects 5%",
  );
  expect(formatCloneProgressLine({ phase: "compressing", percent: 5, line: "" })).toBe(
    "compressing objects 5%",
  );
  expect(formatCloneProgressLine({ phase: "receiving", percent: 5, line: "" })).toBe(
    "receiving objects 5%",
  );
  expect(formatCloneProgressLine({ phase: "resolving", percent: 5, line: "" })).toBe(
    "resolving deltas 5%",
  );
  expect(formatCloneProgressLine({ phase: "checking-out", percent: 5, line: "" })).toBe(
    "checking out files 5%",
  );
  expect(formatCloneProgressLine({ phase: "done", percent: 100, line: "" })).toBe("done 100%");
  expect(formatCloneProgressLine({ phase: "failed", percent: null, line: "boom" })).toBe(
    "failed — boom",
  );
  expect(formatCloneProgressLine({ phase: "cancelled", percent: null, line: "" })).toBe("cancelled");
});

test("CloneProgressPrinter (TTY): overwrites in place with \\r and pads over a longer previous line, emitting \\n only on the terminal phase", () => {
  const writes: string[] = [];
  const printer = new CloneProgressPrinter({ isTTY: true, write: (s) => writes.push(s) });

  // ev1's rendered text is deliberately much longer than ev2's, so the pad
  // behavior (ev2's `\r`-write fully overwriting ev1's leftover tail) is
  // unambiguous rather than relying on the two phase labels' incidental
  // lengths lining up.
  const ev1 = { phase: "counting" as const, percent: null, line: "a".repeat(40) };
  const ev2 = { phase: "receiving" as const, percent: 5, line: "" };
  const ev3 = { phase: "done" as const, percent: 100, line: "" };
  const text1 = formatCloneProgressLine(ev1);
  const text2 = formatCloneProgressLine(ev2);
  const text3 = formatCloneProgressLine(ev3);
  expect(text2.length).toBeLessThan(text1.length);

  printer.update(ev1);
  printer.update(ev2);
  printer.update(ev3);

  expect(writes[0]).toBe(`\r${text1}`);
  // Padded to the previous line's length so it fully overwrites it, with no
  // newline yet (neither `counting` nor `receiving` is a terminal phase).
  expect(writes[1]).toBe(`\r${text2.padEnd(text1.length)}`);
  expect(writes[2]).toBe(`\r${text3.padEnd(text2.length)}`);
  // Only the terminal `done` phase emits the trailing newline.
  expect(writes[3]).toBe("\n");
  expect(writes).toHaveLength(4);
});

test("CloneProgressPrinter (non-TTY): prints one line per phase change only, no per-percent spam", () => {
  const writes: string[] = [];
  const printer = new CloneProgressPrinter({ isTTY: false, write: (s) => writes.push(s) });

  printer.update({ phase: "receiving", percent: 10, line: "" });
  printer.update({ phase: "receiving", percent: 40, line: "" });
  printer.update({ phase: "receiving", percent: 90, line: "" });
  printer.update({ phase: "resolving", percent: 20, line: "" });
  printer.update({ phase: "done", percent: 100, line: "" });

  expect(writes).toEqual([
    "receiving objects 10%\n",
    "resolving deltas 20%\n",
    "done 100%\n",
  ]);
});

test("CloneProgressPrinter (TTY): truncates the rendered text to the injected columns width, and later padding uses the truncated length", () => {
  const writes: string[] = [];
  const columns = 20;
  const printer = new CloneProgressPrinter({ isTTY: true, write: (s) => writes.push(s), columns });

  const ev1 = { phase: "failed" as const, percent: null, line: "x".repeat(100) };
  const full1 = formatCloneProgressLine(ev1);
  const expected1 = full1.slice(0, columns - 1);
  expect(expected1.length).toBeLessThan(full1.length);
  expect(expected1.length).toBe(columns - 1);

  printer.update(ev1);
  expect(writes[0]).toBe(`\r${expected1}`);
  // `failed` is a terminal phase, so it emits its trailing newline too.
  expect(writes[1]).toBe("\n");

  const ev2 = { phase: "done" as const, percent: 100, line: "" };
  const text2 = formatCloneProgressLine(ev2);
  expect(text2.length).toBeLessThan(expected1.length);

  printer.update(ev2);
  // Padded against the *truncated* previous line's length, not the full,
  // untruncated `full1.length`.
  expect(writes[2]).toBe(`\r${text2.padEnd(expected1.length)}`);
});

test("CloneProgressPrinter: columns <= 1 disables truncation rather than slicing to a negative/zero length", () => {
  const writes: string[] = [];
  const printer = new CloneProgressPrinter({ isTTY: true, write: (s) => writes.push(s), columns: 0 });
  const ev = { phase: "failed" as const, percent: null, line: "some detail" };
  const full = formatCloneProgressLine(ev);

  printer.update(ev);

  expect(writes[0]).toBe(`\r${full}`);
});

test("CloneProgressPrinter.notice(): terminates an unfinished \\r progress line with \\n before printing", () => {
  const writes: string[] = [];
  const printer = new CloneProgressPrinter({ isTTY: true, write: (s) => writes.push(s) });
  const ev = { phase: "receiving" as const, percent: 50, line: "" };

  printer.update(ev); // non-terminal → leaves an unfinished `\r` line pending
  printer.notice("cancelling…");

  expect(writes[0]).toBe(`\r${formatCloneProgressLine(ev)}`);
  expect(writes[1]).toBe("\n");
  expect(writes[2]).toBe("cancelling…\n");
});

test("CloneProgressPrinter.notice(): no extra terminator when there's no pending line (fresh printer, after a terminal update, or non-TTY)", () => {
  const writes1: string[] = [];
  new CloneProgressPrinter({ isTTY: true, write: (s) => writes1.push(s) }).notice("hello");
  expect(writes1).toEqual(["hello\n"]);

  const writes2: string[] = [];
  const p2 = new CloneProgressPrinter({ isTTY: true, write: (s) => writes2.push(s) });
  p2.update({ phase: "done", percent: 100, line: "" });
  writes2.length = 0; // discard the update's own writes; only assert on notice()
  p2.notice("hello");
  expect(writes2).toEqual(["hello\n"]);

  const writes3: string[] = [];
  const p3 = new CloneProgressPrinter({ isTTY: false, write: (s) => writes3.push(s) });
  p3.update({ phase: "receiving", percent: 50, line: "" });
  writes3.length = 0;
  p3.notice("hello");
  expect(writes3).toEqual(["hello\n"]);
});

// ── AgetorClient.cloneProject request shape ─────────────────────────────────
//
// Mirrors the `resumeFxRecovery`/`cancelFxAutoResume` request-shape tests in
// `api-client.test.ts`: a bare `Bun.serve` stub stands in for the core, since
// a genuine end-to-end clone needs real network access / a real git repo.
// This pins the method/path/body/auth the CLIENT sends and how it parses
// what comes back — not the server's actual clone behavior.
//
// `CLONE_TIMEOUT_MS` itself (15 minutes, vs. the default 15s request budget)
// has no production seam exposing the per-call timeout an `AgetorClient`
// instance used for a request — `req()` takes it as a plain function
// parameter that isn't observable from outside `cloneProject`'s call site.
// Skipped per the task brief rather than inventing a new seam.
test("AgetorClient.cloneProject: POSTs /projects/clone with the JSON body and bearer token, and parses the response", async () => {
  const { AgetorClient } = await import("./api-client.ts");
  let captured: {
    method: string;
    pathname: string;
    authorization: string | null;
    contentType: string | null;
    body: unknown;
  } | null = null;
  const responseBody: CloneResult = {
    project: project({ path: "/home/user/some-repo", name: "some-repo" }),
    provider: "gitlab",
    eli5TaskId: "eli5-1",
    eli5Error: null,
  };
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      const text = await req.text();
      captured = {
        method: req.method,
        pathname: url.pathname,
        authorization: req.headers.get("authorization"),
        contentType: req.headers.get("content-type"),
        body: text ? JSON.parse(text) : undefined,
      };
      return new Response(JSON.stringify(responseBody), {
        headers: { "content-type": "application/json" },
      });
    },
  });
  try {
    const client = new AgetorClient({ port: server.port!, token: "tok-abc" });
    const input: CloneInput = {
      url: "https://gitlab.com/owner/some-repo",
      provider: "gitlab",
      dest: "/tmp/some-repo",
      eli5: true,
    };
    const res = await client.cloneProject(input);

    expect(res).toEqual(responseBody);
    expect(captured).not.toBeNull();
    expect(captured!.method).toBe("POST");
    expect(captured!.pathname).toBe("/projects/clone");
    expect(captured!.authorization).toBe("Bearer tok-abc");
    expect(captured!.contentType).toBe("application/json");
    expect(captured!.body).toEqual(input);
  } finally {
    server.stop(true);
  }
});

test("AgetorClient.cancelClone: DELETEs /projects/clone/:cloneId with the bearer token, and parses the response", async () => {
  const { AgetorClient } = await import("./api-client.ts");
  let captured: { method: string; pathname: string; authorization: string | null } | null = null;
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      captured = {
        method: req.method,
        pathname: url.pathname,
        authorization: req.headers.get("authorization"),
      };
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      });
    },
  });
  try {
    const client = new AgetorClient({ port: server.port!, token: "tok-xyz" });
    const res = await client.cancelClone("c1234567-89ab-cdef-0123-456789abcdef");

    expect(res).toEqual({ ok: true });
    expect(captured).not.toBeNull();
    expect(captured!.method).toBe("DELETE");
    expect(captured!.pathname).toBe("/projects/clone/c1234567-89ab-cdef-0123-456789abcdef");
    expect(captured!.authorization).toBe("Bearer tok-xyz");
  } finally {
    server.stop(true);
  }
});

test("AgetorClient.cancelClone: a 404 propagates as a thrown ApiError", async () => {
  const { AgetorClient } = await import("./api-client.ts");
  const server = Bun.serve({
    port: 0,
    fetch: async () =>
      new Response(JSON.stringify({ error: "clone not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
  });
  try {
    const client = new AgetorClient({ port: server.port!, token: "tok-xyz" });
    await expect(client.cancelClone("nope")).rejects.toMatchObject({
      name: "ApiError",
      status: 404,
      message: "clone not found",
    });
  } finally {
    server.stop(true);
  }
});
