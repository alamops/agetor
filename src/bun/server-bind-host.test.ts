import { test, expect, beforeAll, afterAll, spyOn } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// The bind address comes from `startApiServer`'s `hostname` dep — only the
// headless core passes one (from a validated AGETOR_API_HOST); everything else
// stays on 127.0.0.1. Every client connects over 127.0.0.1, so each bind must
// keep answering there. Ports 4611/4612 were unused (checked via
// `grep -rhn "AGETOR_API_PORT = " src`).

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-server-bind-host-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;

const savedPort = process.env.AGETOR_API_PORT;
const savedHost = process.env.AGETOR_API_HOST;

let startApiServer: typeof import("./server.ts").startApiServer;
const servers: Array<{ stop: (closeActiveConnections?: boolean) => void }> = [];

function start(port: number, deps: { hostname?: string } = {}) {
  process.env.AGETOR_API_PORT = String(port);
  const server = startApiServer(deps);
  servers.push(server);
  return server;
}

async function healthOverLoopback(port: number): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${port}/health`);
  await res.body?.cancel();
  return res.status;
}

beforeAll(async () => {
  await import("./db.ts");
  ({ startApiServer } = await import("./server.ts"));
});

afterAll(() => {
  for (const s of servers) s.stop(true);
  if (savedPort === undefined) delete process.env.AGETOR_API_PORT;
  else process.env.AGETOR_API_PORT = savedPort;
  if (savedHost === undefined) delete process.env.AGETOR_API_HOST;
  else process.env.AGETOR_API_HOST = savedHost;
});

test("binds 127.0.0.1 without a hostname dep, ignoring AGETOR_API_HOST, and logs no bind warning", async () => {
  process.env.AGETOR_API_HOST = "0.0.0.0";
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const server = start(4611);
    expect(server.hostname).toBe("127.0.0.1");
    expect(await healthOverLoopback(4611)).toBe(200);
    expect(warn.mock.calls.some((args) => String(args[0]).includes("AGETOR_API_HOST"))).toBe(false);
  } finally {
    warn.mockRestore();
    delete process.env.AGETOR_API_HOST;
  }
});

test("binds the hostname dep, stays reachable over 127.0.0.1, and warns once", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const server = start(4612, { hostname: "0.0.0.0" });
    expect(server.hostname).toBe("0.0.0.0");
    expect(await healthOverLoopback(4612)).toBe(200);
    const bindWarnings = warn.mock.calls.filter((args) => String(args[0]).includes("AGETOR_API_HOST"));
    expect(bindWarnings).toHaveLength(1);
    expect(String(bindWarnings[0]![0])).toContain("0.0.0.0:4612");
  } finally {
    warn.mockRestore();
  }
});
