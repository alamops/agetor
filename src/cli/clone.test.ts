import { test, expect, mock, afterAll } from "bun:test";
import path from "node:path";
import type { AgetorClient } from "./api-client.ts";
import type { GitProvider, Project } from "../shared/types.ts";

/**
 * `cmdClone` (commands/clone.ts) reaches for a client via `getClient(flags)`,
 * same as every other one-shot command — this suite mocks `./context.ts`
 * (for `getClient`) and `./output.ts` (to capture `out()`/`errln()`/
 * `printJson()`) and drives the real `cmdClone` against a fake
 * `AgetorClient`, following the mocking idiom `files.test.ts`/
 * `resume.test.ts` established.
 *
 * Both mocked modules are snapshotted before mocking and restored in
 * `afterAll` — `mock.module` overwrites the module record in place (Bun's
 * documented behavior for already-loaded modules), and other test files in
 * the same `bun test` process import these same modules.
 *
 * `AgetorClient.cloneProject` itself is exercised separately below against a
 * bare `Bun.serve` stub (mirrors the `resumeFxRecovery`/`cancelFxAutoResume`
 * request-shape tests in `api-client.test.ts`) — no daemon, no mocked
 * modules involved, since that test imports the real, unmocked client.
 */

import * as realContext from "./context.ts";
import * as realOutput from "./output.ts";

const realContextSnapshot = { ...realContext };
const realOutputSnapshot = { ...realOutput };

let currentClient: AgetorClient | null = null;
const outputs: string[] = [];
const errOutputs: string[] = [];
const jsonOutputs: unknown[] = [];

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

afterAll(() => {
  mock.module("./context.ts", () => realContextSnapshot);
  mock.module("./output.ts", () => realOutputSnapshot);
});

const { cmdClone } = await import("./commands/clone.ts");

type CloneInput = {
  url: string;
  provider?: GitProvider;
  dest?: string;
  eli5?: boolean;
};

type CloneResult = {
  project: Project;
  provider?: GitProvider;
  eli5TaskId: string | null;
  eli5Error: string | null;
};

function project(overrides: Partial<Project> = {}): Project {
  return {
    path: "/home/user/repo",
    name: "repo",
    addedAt: 1_700_000_000_000,
    branchConfig: null,
    ...overrides,
  };
}

/** Builds a fake client + a capture of every `cloneProject` call (there
 *  should only ever be at most one per test, but keeping a list makes "never
 *  called" assertions trivial: `expect(calls).toHaveLength(0)`). */
function makeClient(
  result: CloneResult | (() => Promise<CloneResult>),
  calls: CloneInput[],
): AgetorClient {
  return {
    cloneProject: async (input: CloneInput) => {
      calls.push(input);
      if (typeof result === "function") return result();
      return result;
    },
  } as unknown as AgetorClient;
}

const flags = { json: false, plain: true, noDaemon: true } as unknown as Parameters<typeof cmdClone>[1];
const jsonFlags = { ...flags, json: true } as unknown as Parameters<typeof cmdClone>[1];

function reset(): void {
  outputs.length = 0;
  errOutputs.length = 0;
  jsonOutputs.length = 0;
}

test("clone owner/repo: forwards {url, eli5: true} with provider/dest undefined; progress on stderr, success + provider line on stdout", async () => {
  reset();
  const calls: CloneInput[] = [];
  currentClient = makeClient(
    { project: project(), provider: "github", eli5TaskId: null, eli5Error: null },
    calls,
  );

  await cmdClone(["owner/repo"], flags);

  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe("owner/repo");
  expect(calls[0]!.eli5).toBe(true);
  expect(calls[0]!.provider).toBeUndefined();
  expect(calls[0]!.dest).toBeUndefined();

  expect(errOutputs.some((l) => l.includes("cloning owner/repo"))).toBe(true);
  expect(outputs.some((l) => l.includes("repo") && l.includes("/home/user/repo"))).toBe(true);
  expect(outputs).toContain("provider: GitHub");
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

test("--json: printJson receives the raw result and no progress/success lines are emitted", async () => {
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
