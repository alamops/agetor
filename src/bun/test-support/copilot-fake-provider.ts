/**
 * In-process fake OpenAI-compatible chat-completions provider for driving the
 * REAL GitHub Copilot CLI in BYOK mode (`COPILOT_OFFLINE=true`,
 * `COPILOT_PROVIDER_BASE_URL`, `COPILOT_PROVIDER_TYPE=openai`) with no auth,
 * no network and no billing. Ported from the TT8 spike server.
 *
 * Behaviour is selected by a marker in the LATEST user message (a tool-result
 * continuation always answers with plain text, so a tool loop terminates):
 *
 *   TOOLCALL  answer with one call to the shell tool (`echo hi-from-tool`),
 *             then "The command printed hi. All done." after the tool result
 *   WRITECMD  same, but the shell command creates `spike-created.txt`
 *   FAIL500   answer HTTP 500 (Copilot retries ~5x, ~16 s, then session.error)
 *   SLOW      hold the response for `slowMs` (default 20 s; released on abort)
 *   REASON    stream a reasoning delta (`reasoning_content` AND `reasoning`)
 *             before the text, to record whether Copilot surfaces
 *             `assistant.reasoning`
 *   (none)    plain text: "Hello from the fake provider (req N)."
 *
 * Every request body is recorded for the test to inspect.
 */

export interface FakeProviderRequest {
  id: number;
  path: string;
  model: string | undefined;
  stream: boolean | undefined;
  /** The full `messages` array as sent. */
  messages: Array<{ role?: string; content?: unknown; [k: string]: unknown }>;
  /** `function.name` of each tool offered. */
  toolNames: string[];
  reasoningEffort: unknown;
  lastRole: string | undefined;
  /** Text of the latest user message. */
  lastUser: string;
  /** Concatenated text of EVERY user message (resume / plan-prefix checks). */
  allUserText: string;
  mode: "text" | "tool" | "fail500" | "slow" | "reason";
}

export interface FakeProvider {
  /** OpenAI-style base URL including `/v1`, for `COPILOT_PROVIDER_BASE_URL`. */
  baseUrl: string;
  port: number;
  /** Recorded `/chat/completions` requests, oldest first. */
  requests: FakeProviderRequest[];
  /** Forget recorded requests (the request counter keeps counting). */
  reset(): void;
  stop(): Promise<void>;
}

export interface FakeProviderOptions {
  /** How long `SLOW` holds a response. Default 20_000 ms. */
  slowMs?: number;
}

type Msg = FakeProviderRequest["messages"][number];

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : ""))
      .join(" ");
  }
  return "";
}

function lastUserText(messages: Msg[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") return contentText(messages[i]!.content);
  }
  return "";
}

type ToolDef = { function?: { name?: string; parameters?: { properties?: Record<string, { type?: string }>; required?: string[] } } };

/** Minimal args satisfying the tool's required schema. */
function argsFor(tool: ToolDef, command: string): Record<string, unknown> {
  const params = tool.function?.parameters ?? {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params.properties ?? {})) {
    if (!(params.required ?? []).includes(k)) continue;
    if (k === "command") out[k] = command;
    else if (v.type === "string") out[k] = "say hi";
    else if (v.type === "boolean") out[k] = false;
    else if (v.type === "number" || v.type === "integer") out[k] = 10;
    else out[k] = null;
  }
  return out;
}

function sse(delta: Record<string, unknown>, finish: string | null, usage?: unknown): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-fake",
    object: "chat.completion.chunk",
    created: 0,
    model: "fake",
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  })}\n\n`;
}

const USAGE = { prompt_tokens: 1234, completion_tokens: 56, total_tokens: 1290 };

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

export function startFakeCopilotProvider(options: FakeProviderOptions = {}): FakeProvider {
  const slowMs = options.slowMs ?? 20_000;
  const requests: FakeProviderRequest[] = [];
  let counter = 0;

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    // SLOW and the 500 retry ladder hold connections for many seconds.
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith("/models")) {
        return Response.json({ object: "list", data: [{ id: "gpt-5.4", object: "model" }] });
      }
      if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });

      let body: any = null;
      try { body = await req.json(); } catch { body = null; }
      const id = ++counter;
      const messages: Msg[] = Array.isArray(body?.messages) ? body.messages : [];
      const tools: ToolDef[] = Array.isArray(body?.tools) ? body.tools : [];
      const last = messages.at(-1);
      const user = lastUserText(messages);
      const afterTool = last?.role === "tool";

      let mode: FakeProviderRequest["mode"] = "text";
      if (!afterTool) {
        if (user.includes("FAIL500")) mode = "fail500";
        else if (user.includes("SLOW")) mode = "slow";
        else if (user.includes("TOOLCALL") || user.includes("WRITECMD")) mode = "tool";
        else if (user.includes("REASON")) mode = "reason";
      }

      requests.push({
        id,
        path: url.pathname,
        model: body?.model,
        stream: body?.stream,
        messages,
        toolNames: tools.map((t) => t.function?.name ?? "").filter(Boolean),
        reasoningEffort: body?.reasoning_effort,
        lastRole: last?.role,
        lastUser: user,
        allUserText: messages.filter((m) => m.role === "user").map((m) => contentText(m.content)).join("\n"),
        mode,
      });

      if (mode === "fail500") {
        return new Response(JSON.stringify({ error: { message: "tt8 forced failure" } }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      if (mode === "slow") await sleep(slowMs, req.signal);

      const shell = tools.find((t) => /^(bash|shell|powershell)$/.test(t.function?.name ?? ""));
      const wantTool = mode === "tool" && shell !== undefined;
      let parts: string[];
      if (wantTool) {
        const command = user.includes("WRITECMD")
          ? "rm -f spike-created.txt && touch spike-created.txt && echo made"
          : "echo hi-from-tool";
        parts = [
          sse({ role: "assistant", content: "Running a command." }, null),
          sse({ tool_calls: [{ index: 0, id: `call_${id}`, type: "function", function: { name: shell!.function!.name, arguments: JSON.stringify(argsFor(shell!, command)) } }] }, null),
          sse({}, "tool_calls", USAGE),
        ];
      } else {
        const text = afterTool ? "The command printed hi. All done." : `Hello from the fake provider (req ${id}).`;
        parts = [];
        if (mode === "reason") {
          // Both spellings in use by OpenAI-compatible servers.
          parts.push(sse({ role: "assistant", reasoning_content: "pondering the request", reasoning: "pondering the request" }, null));
          parts.push(sse({ content: text }, null));
        } else {
          parts.push(sse({ role: "assistant", content: text.slice(0, 10) }, null));
          parts.push(sse({ content: text.slice(10) }, null));
        }
        parts.push(sse({}, "stop", USAGE));
      }

      if (body?.stream) {
        return new Response(parts.join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
      }
      const content = wantTool ? "Running a command." : afterTool ? "The command printed hi. All done." : `Hello from the fake provider (req ${id}).`;
      const message: Record<string, unknown> = { role: "assistant", content };
      if (wantTool) {
        message.tool_calls = [{ id: `call_${id}`, type: "function", function: { name: shell!.function!.name, arguments: JSON.stringify(argsFor(shell!, "echo hi-from-tool")) } }];
      }
      return Response.json({
        id: "chatcmpl-fake",
        object: "chat.completion",
        created: 0,
        model: "fake",
        choices: [{ index: 0, message, finish_reason: wantTool ? "tool_calls" : "stop" }],
        usage: USAGE,
      });
    },
  });

  const port = server.port as number;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    port,
    requests,
    reset: () => { requests.length = 0; },
    stop: async () => { await server.stop(true); },
  };
}
