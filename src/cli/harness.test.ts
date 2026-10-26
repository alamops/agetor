import { test, expect, mock, afterAll, beforeEach } from "bun:test";
import type { AgetorClient, CreateHarnessInput, HarnessPatchInput } from "./api-client.ts";
import type { Harness, HarnessStatus } from "../shared/types.ts";

/**
 * `cmdHarness` reaches for a client via `getClient(flags)` — same mocking
 * idiom `ls.test.ts` uses: mock `./context.ts` (for `getClient`) and
 * `./output.ts` (to capture `out()`, with the `c.*` color wrappers as plain
 * identity functions so the printed text has no ANSI codes). Both modules are
 * snapshotted before mocking and restored in `afterAll`, since other test
 * files in the same `bun test` process import them too.
 */

import * as realContext from "./context.ts";
import * as realOutput from "./output.ts";

const realContextSnapshot = { ...realContext };
const realOutputSnapshot = { ...realOutput };

let currentClient: AgetorClient | null = null;
const outputs: string[] = [];

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
  errln: () => {},
}));

afterAll(() => {
  mock.module("./context.ts", () => realContextSnapshot);
  mock.module("./output.ts", () => realOutputSnapshot);
});

const { cmdHarness, parseHarnessFlags, FX_ASK_PROFILE_HINT } = await import("./commands/harness.ts");

const flags = { json: false, plain: true, noDaemon: true } as unknown as Parameters<typeof cmdHarness>[1];

beforeEach(() => {
  outputs.length = 0;
  currentClient = null;
});

function harness(over: Partial<Harness>): Harness {
  return {
    id: "h1",
    kind: "claude-code",
    label: "H1",
    home: null,
    bin: null,
    env: {},
    isBuiltin: false,
    createdAt: 0,
    enabled: true,
    ...over,
  } as Harness;
}

function status(over: Partial<HarnessStatus>): HarnessStatus {
  return {
    harnessId: "h1",
    kind: "claude-code",
    bin: "x",
    available: true,
    path: "/x",
    version: "1.0.0",
    reason: null,
    installHint: null,
    loggedIn: null,
    authHelp: null,
    ...over,
  } as HarnessStatus;
}

/** Rendered table lines (header first) from the single `out()` call that
 *  printed the table. */
function tableLines(): string[] {
  return outputs[0]!.split("\n");
}

function rowFor(id: string): string {
  // Data rows start with the enabled mark, then the id.
  const row = tableLines().slice(1).find((l) => l.trim().split(/\s+/)[1] === id);
  if (!row) throw new Error(`no table row for ${id}`);
  return row;
}

test("parseHarnessFlags parses label / kind / bin", () => {
  const f = parseHarnessFlags(["--label", "My Alias", "--kind", "claude-code", "--bin", "/usr/bin/claude"]);
  expect(f.label).toBe("My Alias");
  expect(f.kind).toBe("claude-code");
  expect(f.bin).toBe("/usr/bin/claude");
  expect(f.binSet).toBe(true);
});

test("parseHarnessFlags: repeated --env builds a map and keeps '=' in values", () => {
  const f = parseHarnessFlags(["--env", "A=1", "--env", "B=x=y"]);
  expect(f.env).toEqual({ A: "1", B: "x=y" });
});

test("parseHarnessFlags: --home none clears to null and marks homeSet", () => {
  const cleared = parseHarnessFlags(["--home", "none"]);
  expect(cleared.home).toBeNull();
  expect(cleared.homeSet).toBe(true);

  const set = parseHarnessFlags(["--home", "/abs/dir"]);
  expect(set.home).toBe("/abs/dir");
  expect(set.homeSet).toBe(true);
});

test("parseHarnessFlags rejects a malformed --env and a missing flag value", () => {
  expect(() => parseHarnessFlags(["--env", "noequals"])).toThrow();
  expect(() => parseHarnessFlags(["--label"])).toThrow(); // flagValue: no value
  expect(() => parseHarnessFlags(["--home", "--bin", "/x"])).toThrow(); // flag-as-value
});

test("parseHarnessFlags: --profile-mcp / --no-profile-mcp set the toggle, last one wins", () => {
  expect(parseHarnessFlags([]).profileMcpServers).toBeUndefined();
  expect(parseHarnessFlags(["--profile-mcp"]).profileMcpServers).toBe(true);
  expect(parseHarnessFlags(["--no-profile-mcp"]).profileMcpServers).toBe(false);
  expect(parseHarnessFlags(["--profile-mcp", "--no-profile-mcp"]).profileMcpServers).toBe(false);
  // A boolean flag never consumes the next argument.
  const f = parseHarnessFlags(["--no-profile-mcp", "--label", "L"]);
  expect(f.profileMcpServers).toBe(false);
  expect(f.label).toBe("L");
});

test("harness add sends profileMcpServers only when a flag was given", async () => {
  const bodies: CreateHarnessInput[] = [];
  currentClient = {
    createHarness: async (input: CreateHarnessInput) => {
      bodies.push(input);
      return harness({ id: input.id, kind: input.kind });
    },
  } as unknown as AgetorClient;

  await cmdHarness(["add", "fx-2", "--kind", "fx", "--no-profile-mcp"], flags);
  await cmdHarness(["add", "fx-3", "--kind", "fx", "--profile-mcp"], flags);
  await cmdHarness(["add", "fx-4", "--kind", "fx"], flags);

  expect(bodies[0]!.profileMcpServers).toBe(false);
  expect(bodies[1]!.profileMcpServers).toBe(true);
  expect("profileMcpServers" in bodies[2]!).toBe(false);
});

test("harness edit: a toggle-only edit patches just profileMcpServers", async () => {
  const patches: Array<{ id: string; patch: HarnessPatchInput }> = [];
  currentClient = {
    patchHarness: async (id: string, patch: HarnessPatchInput) => {
      patches.push({ id, patch });
      return harness({ id, kind: "fx" });
    },
  } as unknown as AgetorClient;

  await cmdHarness(["edit", "fx", "--no-profile-mcp"], flags);
  await cmdHarness(["edit", "fx", "--profile-mcp"], flags);

  expect(patches).toEqual([
    { id: "fx", patch: { profileMcpServers: false } },
    { id: "fx", patch: { profileMcpServers: true } },
  ]);
});

test("harness edit with nothing to change names the profile-mcp flags", async () => {
  currentClient = { patchHarness: async () => harness({}) } as unknown as AgetorClient;
  await expect(cmdHarness(["edit", "fx"], flags)).rejects.toThrow("--no-profile-mcp");
});

test("harness ls: profile-mcp column is on/off for fx rows and '-' for others", async () => {
  currentClient = {
    listHarnesses: async () => ({
      harnesses: [
        harness({ id: "claude-code", kind: "claude-code", isBuiltin: true }),
        harness({ id: "fx", kind: "fx", isBuiltin: true, profileMcpServers: true }),
        harness({ id: "fx-off", kind: "fx", profileMcpServers: false }),
        // Absent ⇒ on.
        harness({ id: "fx-legacy", kind: "fx" }),
      ],
      statuses: [],
    }),
  } as unknown as AgetorClient;

  await cmdHarness(["ls"], flags);

  const header = tableLines()[0]!;
  expect(header).toContain("profile-mcp");
  const col = header.indexOf("profile-mcp");
  const cell = (id: string) => rowFor(id).slice(col).trim().split(/\s+/)[0];
  expect(cell("claude-code")).toBe("-");
  expect(cell("fx")).toBe("on");
  expect(cell("fx-off")).toBe("off");
  expect(cell("fx-legacy")).toBe("on");
});

test("harness ls: the Ask-profile hint prints under an fx row only when permission_mode is ask", async () => {
  currentClient = {
    listHarnesses: async () => ({
      harnesses: [
        harness({ id: "fx", kind: "fx" }),
        harness({ id: "fx-auto", kind: "fx" }),
        harness({ id: "fx-old", kind: "fx" }),
        harness({ id: "claude-code", kind: "claude-code" }),
      ],
      statuses: [
        status({ harnessId: "fx", kind: "fx", fxProfilePermissionMode: "ask" }),
        status({ harnessId: "fx-auto", kind: "fx", fxProfilePermissionMode: "auto" }),
        status({ harnessId: "fx-old", kind: "fx", fxProfilePermissionMode: null }),
        // Never shown for a non-fx kind, whatever the field says.
        status({ harnessId: "claude-code", kind: "claude-code", fxProfilePermissionMode: "ask" }),
      ],
    }),
  } as unknown as AgetorClient;

  await cmdHarness(["ls"], flags);

  const hints = outputs.slice(1).filter((l) => l.includes(FX_ASK_PROFILE_HINT));
  expect(hints).toHaveLength(1);
  expect(hints[0]).toContain(" fx ");
  expect(FX_ASK_PROFILE_HINT).toBe(
    "fx's own profile starts in Ask mode. Agetor sets each task's mode itself; to change fx's default, run `/permissions` inside fx.",
  );
});
