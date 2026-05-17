import { test, expect, beforeAll, afterAll } from "bun:test";
import path from "node:path";

// Spawn the real MCP server with a stub agetor HTTP endpoint, exchange a few
// JSON-RPC messages, and assert the wire shape claude relies on. The server
// is implemented in pure stdio JSON-RPC so we can drive it from tests
// without an actual claude binary.

const mcpPath = path.join(import.meta.dir, "agetor-mcp.ts");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let server: any;
let nextAnswerBody = JSON.stringify({ selected: ["A"], custom: "and one more thing" });

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      if (req.headers.get("authorization") !== "Bearer mcp-test-token") {
        return new Response("unauthorized", { status: 401 });
      }
      return new Response(nextAnswerBody, {
        headers: { "content-type": "application/json" },
      });
    },
  });
});

afterAll(() => { server?.stop?.(); });

interface Pending {
  resolve: (msg: unknown) => void;
}

interface McpHandle {
  send: (msg: unknown) => void;
  expect: (predicate: (msg: any) => boolean, timeoutMs?: number) => Promise<any>;
  stop: () => void;
}

function spawnMcp(env: Record<string, string>): McpHandle {
  const proc = Bun.spawn(["bun", mcpPath], {
    env: { ...process.env, ...env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  const queue: any[] = [];
  const waiters: { predicate: (m: any) => boolean; resolve: (m: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }[] = [];

  void (async () => {
    const decoder = new TextDecoder();
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        const matched = waiters.findIndex((w) => w.predicate(msg));
        if (matched >= 0) {
          const w = waiters.splice(matched, 1)[0]!;
          clearTimeout(w.timer);
          w.resolve(msg);
        } else {
          queue.push(msg);
        }
      }
    }
  })();

  const writeLine = (s: string) =>
    proc.stdin.write(new TextEncoder().encode(s + "\n"));

  return {
    send(msg) {
      writeLine(JSON.stringify(msg));
    },
    expect(predicate, timeoutMs = 3_000) {
      // Check already-queued messages first.
      const idx = queue.findIndex(predicate);
      if (idx >= 0) {
        return Promise.resolve(queue.splice(idx, 1)[0]);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("expectation timed out")), timeoutMs);
        waiters.push({ predicate, resolve, reject, timer });
      });
    },
    stop() { try { proc.kill(); } catch { /* already gone */ } },
  };
}

test("MCP server lists ask_user in tools/list", async () => {
  const mcp = spawnMcp({
    AGETOR_API_PORT: String(server.port),
    AGETOR_API_TOKEN: "mcp-test-token",
    AGETOR_TASK_ID: "t-mcp-1",
  });
  try {
    mcp.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const res = await mcp.expect((m) => m.id === 1);
    const tools = (res.result.tools as { name: string }[]).map((t) => t.name);
    expect(tools).toContain("ask_user");
  } finally {
    mcp.stop();
  }
});

test("MCP server's ask_user POSTs to agetor and returns the formatted answer", async () => {
  nextAnswerBody = JSON.stringify({ selected: ["A", "C"], custom: "plus this" });
  const mcp = spawnMcp({
    AGETOR_API_PORT: String(server.port),
    AGETOR_API_TOKEN: "mcp-test-token",
    AGETOR_TASK_ID: "t-mcp-2",
  });
  try {
    mcp.send({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "ask_user",
        arguments: { question: "Which?", choices: ["A", "B", "C"], multi: true },
      },
    });
    const res = await mcp.expect((m) => m.id === 7, 5_000);
    const content = res.result.content as { type: string; text: string }[];
    const first = content[0]!;
    expect(first.type).toBe("text");
    expect(first.text).toContain("- A");
    expect(first.text).toContain("- C");
    expect(first.text).toContain("plus this");
  } finally {
    mcp.stop();
  }
});

test("MCP server defense-in-depth: env unset → tools/list still answers, tools/call ask_user → isError", async () => {
  // The launcher (agetor-mcp.sh) is the primary guard — it exits 0 before
  // exec when env is missing or /health doesn't respond. But if someone
  // bypasses the launcher (e.g. `bun agetor-mcp.ts` directly), the per-
  // call env check inside askUser is the defence-in-depth: tools/list
  // still works (claude probes regardless), but tools/call surfaces a
  // clear error instead of crashing the process.
  //
  // Passing empty strings overrides any inherited AGETOR_* env from the
  // parent shell (Bun.spawn does {...process.env, ...env}, so the empty
  // strings win); the askUser env check treats empty as missing.
  const mcp = spawnMcp({
    AGETOR_API_PORT: "",
    AGETOR_API_TOKEN: "",
    AGETOR_TASK_ID: "",
  });
  try {
    // tools/list: still answers.
    mcp.send({ jsonrpc: "2.0", id: 11, method: "tools/list" });
    const listed = await mcp.expect((m) => m.id === 11);
    const toolNames = (listed.result.tools as { name: string }[]).map((t) => t.name);
    expect(toolNames).toContain("ask_user");

    // tools/call: isError result naming the missing env (agent can recover).
    mcp.send({
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: { name: "ask_user", arguments: { question: "anything" } },
    });
    const called = await mcp.expect((m) => m.id === 12, 5_000);
    expect(called.result.isError).toBe(true);
    const text = (called.result.content as { type: string; text: string }[])[0]!.text;
    expect(text).toMatch(/AGETOR_API_PORT|env not set/);
  } finally {
    mcp.stop();
  }
});

test("MCP server rejects ask_user without a question with an isError tool result", async () => {
  const mcp = spawnMcp({
    AGETOR_API_PORT: String(server.port),
    AGETOR_API_TOKEN: "mcp-test-token",
    AGETOR_TASK_ID: "t-mcp-3",
  });
  try {
    mcp.send({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "ask_user", arguments: { question: "" } },
    });
    const res = await mcp.expect((m) => m.id === 9, 5_000);
    expect(res.result.isError).toBe(true);
  } finally {
    mcp.stop();
  }
});
