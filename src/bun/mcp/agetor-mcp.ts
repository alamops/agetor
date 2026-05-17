#!/usr/bin/env bun
/**
 * Stdio MCP server claude code spawns as the `agetor` server. Exposes a
 * single `ask_user` tool that pauses execution until the human answers in
 * agetor's run panel — replaces the would-be in-TUI prompt with a structured
 * card (radios / checkboxes / custom textarea).
 *
 * We talk the MCP JSON-RPC dialect over stdin/stdout (newline-delimited
 * JSON). No `@modelcontextprotocol/sdk` dep — we only need three methods
 * (`initialize`, `tools/list`, `tools/call`) so hand-rolling the wire is
 * smaller than the dep + lock-step version upgrades.
 *
 * Env (injected by claude → which inherited from tmux):
 *   AGETOR_API_PORT
 *   AGETOR_API_TOKEN
 *   AGETOR_TASK_ID
 *
 * Without those vars the server still answers `tools/list` (claude probes
 * regardless of whether tools will be used) but a `tools/call` returns an
 * isError tool result so the agent can recover gracefully. The launcher
 * (agetor-mcp.sh) is the primary guard — it exits before exec-ing us when
 * the env isn't present or /health isn't responding — but we keep the
 * per-call check as defence in depth: if someone runs this file directly
 * (`bun agetor-mcp.ts`) bypassing the launcher, individual tool calls
 * fail loudly rather than the whole process crashing at startup.
 */

interface JsonRpcReq {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: unknown;
}
interface JsonRpcRes {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

const MCP_PROTOCOL_VERSION = "2024-11-05";

const ASK_USER_TOOL = {
  name: "ask_user",
  description:
    "Ask the human user a clarifying question and wait for their answer. "
    + "Use this whenever you would otherwise pause to ask in plain text. "
    + "Pass `choices` for closed-set questions (the user gets buttons), and "
    + "`multi: true` to allow multiple selections. The user can also type a "
    + "custom free-text answer in addition to (or instead of) picking choices.",
  inputSchema: {
    type: "object" as const,
    properties: {
      question: {
        type: "string",
        description: "The question to show the user.",
      },
      choices: {
        type: "array",
        items: { type: "string" },
        description: "Preset options to render as radios (or checkboxes when multi=true).",
      },
      multi: {
        type: "boolean",
        description: "When true, the user can select multiple choices. Default false.",
      },
    },
    required: ["question"],
  },
};

interface QuestionAnswer {
  selected: string[];
  custom?: string;
}

/**
 * POST to agetor's /questions endpoint and wait for the user's answer.
 * The server holds the response open until the run panel resolves it.
 * Timeout sits just under claude's tool execution budget so curl gives up
 * before claude reports "tool timed out".
 */
async function askUser(input: { question: string; choices?: string[]; multi?: boolean }): Promise<QuestionAnswer> {
  const port = process.env.AGETOR_API_PORT;
  const token = process.env.AGETOR_API_TOKEN;
  const taskId = process.env.AGETOR_TASK_ID;
  if (!port || !token || !taskId) {
    throw new Error("agetor MCP env not set (AGETOR_API_PORT / AGETOR_API_TOKEN / AGETOR_TASK_ID)");
  }
  const res = await fetch(
    `http://127.0.0.1:${port}/questions?taskId=${encodeURIComponent(taskId)}`,
    {
      method: "POST",
      headers: {
        "authorization": `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
      // Slightly under the documented 600s claude tool timeout.
      signal: AbortSignal.timeout(590_000),
    },
  );
  if (!res.ok) {
    throw new Error(`agetor /questions returned ${res.status}`);
  }
  return await res.json() as QuestionAnswer;
}

/** Format the user's answer as a single text block claude can consume. */
function formatAnswer(a: QuestionAnswer): string {
  const parts: string[] = [];
  if (a.selected.length > 0) {
    parts.push(a.selected.map((s) => `- ${s}`).join("\n"));
  }
  if (a.custom && a.custom.trim()) {
    parts.push((parts.length ? "Custom answer:\n" : "") + a.custom.trim());
  }
  return parts.join("\n\n") || "(no answer)";
}

async function handle(req: JsonRpcReq): Promise<JsonRpcRes | null> {
  const id = req.id ?? null;
  switch (req.method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          // `__AGETOR_VERSION__` is replaced with package.json#version by
          // hook-installer.ts when this file is materialised to
          // `<dataDir>/bin/agetor-mcp.ts`. Tests run this file in-place and
          // will see the literal sentinel — they don't assert on this field.
          serverInfo: { name: "agetor", version: "__AGETOR_VERSION__" },
          capabilities: { tools: {} },
        },
      };

    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: [ASK_USER_TOOL] } };

    case "tools/call": {
      const params = (req.params ?? {}) as { name?: string; arguments?: unknown };
      if (params.name !== "ask_user") {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `unknown tool: ${params.name}` },
        };
      }
      const args = (params.arguments ?? {}) as { question?: string; choices?: string[]; multi?: boolean };
      if (typeof args.question !== "string" || args.question.trim() === "") {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            isError: true,
            content: [{ type: "text", text: "ask_user requires a non-empty `question` string." }],
          },
        };
      }
      try {
        const answer = await askUser({
          question: args.question,
          choices: args.choices,
          multi: args.multi,
        });
        return {
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: formatAnswer(answer) }] },
        };
      } catch (e) {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            isError: true,
            content: [{ type: "text", text: `ask_user failed: ${(e as Error).message}` }],
          },
        };
      }
    }

    case "notifications/initialized":
    case "notifications/cancelled":
      // Notifications carry no id; nothing to respond to.
      return null;

    default:
      // Per JSON-RPC, respond with method-not-found only when the request
      // had an id (i.e. wasn't itself a notification).
      if (req.id === undefined || req.id === null) return null;
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `method not found: ${req.method}` },
      };
  }
}

/**
 * Read newline-delimited JSON-RPC messages from stdin, dispatch each one,
 * and write any response to stdout. Concurrent requests are handled in
 * parallel (a long-running ask_user shouldn't block subsequent metadata
 * queries from claude).
 */
async function main(): Promise<void> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const stdoutWrite = async (line: string) => {
    await Bun.write(Bun.stdout, encoder.encode(line + "\n"));
  };

  let buf = "";
  // Bun's stdin stream exposes async iteration at runtime even though TS's
  // built-in `ReadableStream` types don't include `Symbol.asyncIterator`.
  const stream = Bun.stdin.stream() as unknown as AsyncIterable<Uint8Array>;
  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let req: JsonRpcReq;
      try {
        req = JSON.parse(line);
      } catch {
        // Malformed input. JSON-RPC says respond with -32700 when we can
        // identify the request id; here we can't, so silently drop.
        continue;
      }
      // Fire-and-forget so a slow tool/call doesn't head-of-line block.
      void handle(req).then(async (res) => {
        if (res) await stdoutWrite(JSON.stringify(res));
      });
    }
  }
}

void main();
