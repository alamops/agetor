import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureCore, stopCore, stopDaemon } from "./daemon/supervisor.ts";
import { AgetorClient, ApiError, discoverCore } from "./api-client.ts";
import { coreCredsPath, writeCoreCreds } from "../bun/core-creds.ts";

// End-to-end: the supervisor spawns a real headless daemon, the typed client
// talks to it over HTTP, a second ensureCore discovers the SAME daemon (no
// double-spawn), and stopDaemon tears it down.
test("supervisor spawns a daemon and the client talks to it", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-cli-int-"));
  const opts = { dataDir: dir, port: 4489 };
  try {
    const core = await ensureCore(opts);
    expect(core.kind).toBe("cli-daemon");
    expect(core.port).toBe(4489);
    expect(existsSync(coreCredsPath(dir))).toBe(true);

    const client = new AgetorClient(core);
    expect(typeof (await client.info()).version).toBe("string");
    expect(await client.listTasks()).toEqual([]);

    // ensureCore again → discovers the same running daemon, no new process.
    const again = await ensureCore(opts);
    expect(again.pid).toBe(core.pid);

    // discoverCore directly also finds it.
    const found = await discoverCore(dir);
    expect(found?.port).toBe(4489);
  } finally {
    await stopDaemon(dir);
    for (let i = 0; i < 30 && existsSync(coreCredsPath(dir)); i++) {
      await Bun.sleep(100);
    }
    expect(existsSync(coreCredsPath(dir))).toBe(false);
  }
}, 30_000);

// ---------------------------------------------------------------------------
// shutdownCore / stopCore: what goes over the wire for `POST /daemon/shutdown`
// (docs/plans/always-on-host.md §3.3, task I3). A tiny stand-in core on 4488
// answers `/health` and `/info` so `discoverCore` treats it as live, and records
// the shutdown request exactly as it arrived.

interface Captured {
  method: string;
  auth: string | null;
  contentType: string | null;
  body: string;
}

const STUB_PORT = 4488;
const STUB_TOKEN = "stub-cli-token";
let stub: ReturnType<typeof Bun.serve> | null = null;
let stubDir: string | null = null;

afterEach(() => {
  stub?.stop(true);
  stub = null;
  if (stubDir) rmSync(stubDir, { recursive: true, force: true });
  stubDir = null;
});

function startStubCore(opts: { shutdownStatus?: number } = {}): Captured[] {
  const seen: Captured[] = [];
  stub = Bun.serve({
    port: STUB_PORT,
    hostname: "127.0.0.1",
    async fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname === "/health") return Response.json({ app: "agetor" });
      if (pathname === "/info") return Response.json({ version: "0.0.0-stub" });
      if (pathname === "/daemon/shutdown") {
        seen.push({
          method: req.method,
          auth: req.headers.get("authorization"),
          contentType: req.headers.get("content-type"),
          body: await req.text(),
        });
        return Response.json({ ok: true }, { status: opts.shutdownStatus ?? 200 });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return seen;
}

test("shutdownCore() sends no body, and shutdownCore('handoff') sends {\"mode\":\"handoff\"}", async () => {
  const seen = startStubCore();
  const client = new AgetorClient({ port: STUB_PORT, token: STUB_TOKEN });

  await client.shutdownCore();
  await client.shutdownCore("handoff");
  await client.shutdownCore("stop");

  expect(seen).toHaveLength(3);
  for (const r of seen) {
    expect(r.method).toBe("POST");
    expect(r.auth).toBe(`Bearer ${STUB_TOKEN}`);
  }
  // No argument: the core reads an empty body as "stop" (what `agetor daemon
  // stop` relies on), so there must be no body and no JSON content type.
  expect(seen[0]!.body).toBe("");
  expect(seen[0]!.contentType).toBeNull();
  // "handoff": the app taking the port; the exact JSON the server route reads.
  expect(seen[1]!.body).toBe('{"mode":"handoff"}');
  expect(seen[1]!.contentType).toBe("application/json");
  expect(seen[2]!.body).toBe('{"mode":"stop"}');
});

test("stopCore reports a login-item core and sends no body", async () => {
  const seen = startStubCore();
  stubDir = mkdtempSync(path.join(tmpdir(), "agetor-cli-stopcore-"));
  writeCoreCreds(
    {
      port: STUB_PORT,
      token: STUB_TOKEN,
      pid: process.pid,
      kind: "cli-daemon",
      version: "0.0.0-stub",
      startedAt: Date.now(),
      launchedBy: "login-item",
    },
    stubDir,
  );

  expect(await stopCore(stubDir)).toEqual({ stopped: true, launchedBy: "login-item" });
  expect(seen).toHaveLength(1);
  expect(seen[0]!.body).toBe("");

  // An ordinary daemon: stopped, with no launchedBy.
  writeCoreCreds(
    {
      port: STUB_PORT,
      token: STUB_TOKEN,
      pid: process.pid,
      kind: "cli-daemon",
      version: "0.0.0-stub",
      startedAt: Date.now(),
    },
    stubDir,
  );
  expect(await stopCore(stubDir)).toEqual({ stopped: true, launchedBy: undefined });
  expect(await stopDaemon(stubDir)).toBe(true);
});

test("stopCore swallows a failed or dropped shutdown request (the core exits as it answers)", async () => {
  startStubCore({ shutdownStatus: 500 });
  stubDir = mkdtempSync(path.join(tmpdir(), "agetor-cli-stopcore-"));
  writeCoreCreds(
    {
      port: STUB_PORT,
      token: STUB_TOKEN,
      pid: process.pid,
      kind: "cli-daemon",
      version: "0.0.0-stub",
      startedAt: Date.now(),
    },
    stubDir,
  );
  // The client itself surfaces the failure…
  await expect(new AgetorClient({ port: STUB_PORT, token: STUB_TOKEN }).shutdownCore()).rejects.toBeInstanceOf(
    ApiError,
  );
  // …and stopCore, whose caller means "stop it and move on", does not.
  expect((await stopCore(stubDir)).stopped).toBe(true);
});

test("stopCore with no core running reports stopped:false", async () => {
  stubDir = mkdtempSync(path.join(tmpdir(), "agetor-cli-stopcore-"));
  expect(await stopCore(stubDir)).toEqual({ stopped: false });
  expect(await stopDaemon(stubDir)).toBe(false);
});
