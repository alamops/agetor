// Terminal WebSocket auth (docs/plans/master-token-agent-read.md, D13/P7/P11):
// the upgrade at `GET /terminals/:id/ws` takes ONLY a single-use ticket minted
// by `POST /terminals/:id/ws-ticket` (desktop-only, master token in a header).
// Neither token is ever accepted in the URL, a ticket is bound to its terminal,
// and the CLI token can't mint one.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-terminal-ws-"));
// Unique port across src/ — grep before reusing.
process.env.AGETOR_API_PORT = "4688";

let server: { stop: () => void; port: number };
let token: string;
let cliToken: string;
let taskId: string;
const SAVED_SHELL = process.env.SHELL;

beforeAll(async () => {
  // A deterministic, fast shell: these tests are about auth, not the user's profile.
  process.env.SHELL = "/bin/sh";
  const { tasks } = await import("./db.ts");
  const { startApiServer } = await import("./server.ts");
  const { API_TOKEN, CLI_TOKEN } = await import("./api-config.ts");
  server = startApiServer() as unknown as { stop: () => void; port: number };
  token = API_TOKEN;
  cliToken = CLI_TOKEN;
  taskId = "term-ws-task";
  tasks.insert({
    id: taskId,
    title: "terminal host",
    prompt: "n/a",
    column: "backlog",
    agent: "codex",
    workdir: tmpdir(),
    isolation: "none",
    taskType: "task",
    branch: null,
    branchSource: "created",
    worktreePath: null,
    baseRef: null,
    prUrl: null,
    mode: null,
    model: null,
    effort: null,
    speed: "off",
    maxMode: false,
    references: [],
    backlog: [],
    plans: [],
    draft: null,
    runId: null,
    hasOpenableRun: false,
    pendingInteractionCount: 0,
    openTerminalCount: 0,
    archivedAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
});

afterAll(async () => {
  const { killTerminalsForTask } = await import("./terminals.ts");
  killTerminalsForTask(taskId);
  server?.stop?.();
  if (SAVED_SHELL === undefined) delete process.env.SHELL;
  else process.env.SHELL = SAVED_SHELL;
});

const url = (p: string) => `http://127.0.0.1:${server.port}${p}`;
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

async function newTerminal(): Promise<string> {
  const res = await fetch(url(`/tasks/${taskId}/terminals`), { method: "POST", headers: bearer(token) });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

async function mintTicket(terminalId: string): Promise<{ ticket: string; expiresAt: number }> {
  const res = await fetch(url(`/terminals/${terminalId}/ws-ticket`), { method: "POST", headers: bearer(token) });
  expect(res.status).toBe(201);
  return (await res.json()) as { ticket: string; expiresAt: number };
}

/** Try the upgrade; resolve "open" when the socket opens, "refused" when the handshake fails. */
function connect(pathAndQuery: string): Promise<"open" | "refused"> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}${pathAndQuery}`);
    const timer = setTimeout(() => {
      ws.close();
      resolve("refused");
    }, 5000);
    ws.onopen = () => {
      clearTimeout(timer);
      ws.close();
      resolve("open");
    };
    ws.onerror = () => {
      clearTimeout(timer);
      resolve("refused");
    };
  });
}

test("POST /terminals/:id/ws-ticket mints a 32-byte hex ticket with a future expiry", async () => {
  const id = await newTerminal();
  const { ticket, expiresAt } = await mintTicket(id);
  expect(ticket).toMatch(/^[0-9a-f]{64}$/);
  expect(expiresAt).toBeGreaterThan(Date.now());
  expect(expiresAt).toBeLessThanOrEqual(Date.now() + 60_000);
});

test("minting a ticket needs the master token: none -> 401, CLI token -> 403, unknown terminal -> 404", async () => {
  const id = await newTerminal();
  expect((await fetch(url(`/terminals/${id}/ws-ticket`), { method: "POST" })).status).toBe(401);
  expect((await fetch(url(`/terminals/${id}/ws-ticket`), { method: "POST", headers: bearer(cliToken) })).status).toBe(403);
  const unknown = await fetch(url("/terminals/no-such-terminal/ws-ticket"), { method: "POST", headers: bearer(token) });
  expect(unknown.status).toBe(404);
});

test("a fresh ticket opens the socket; the same ticket is refused the second time (single use)", async () => {
  const id = await newTerminal();
  const { ticket } = await mintTicket(id);
  expect(await connect(`/terminals/${id}/ws?ticket=${ticket}`)).toBe("open");
  expect(await connect(`/terminals/${id}/ws?ticket=${ticket}`)).toBe("refused");
});

test("a ticket minted for one terminal is refused for another, and is spent by that attempt", async () => {
  const a = await newTerminal();
  const b = await newTerminal();
  const { ticket } = await mintTicket(a);
  expect(await connect(`/terminals/${b}/ws?ticket=${ticket}`)).toBe("refused");
  // Dead even for its own terminal now: a mismatch burns the ticket.
  expect(await connect(`/terminals/${a}/ws?ticket=${ticket}`)).toBe("refused");
});

test("a missing, empty or made-up ticket is refused", async () => {
  const id = await newTerminal();
  expect(await connect(`/terminals/${id}/ws`)).toBe("refused");
  expect(await connect(`/terminals/${id}/ws?ticket=`)).toBe("refused");
  expect(await connect(`/terminals/${id}/ws?ticket=${"0".repeat(64)}`)).toBe("refused");
});

test("?token= (master or CLI) on the WS path is refused, with or without a ticket", async () => {
  const id = await newTerminal();
  expect(await connect(`/terminals/${id}/ws?token=${token}`)).toBe("refused");
  expect(await connect(`/terminals/${id}/ws?token=${cliToken}`)).toBe("refused");
  // A valid ticket is not rescued by, nor poisoned by, an extra token param: it still works alone.
  const { ticket } = await mintTicket(id);
  expect(await connect(`/terminals/${id}/ws?ticket=${ticket}&token=${token}`)).toBe("open");
});

test("the raw refusal is a 401 (unauthorized), not an upgrade", async () => {
  const id = await newTerminal();
  const res = await fetch(url(`/terminals/${id}/ws?token=${token}`));
  expect(res.status).toBe(401);
});
