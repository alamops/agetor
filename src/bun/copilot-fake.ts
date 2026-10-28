import type { SpawnedAgent, ChunkHandler } from "./claude-tmux.ts";
import {
  createCopilotMapCtx,
  finalizeCopilotTurn,
  mapCopilotEvent,
  type CopilotSubagentSink,
} from "./copilot-tmux.ts";

/**
 * Deterministic GitHub Copilot fake (`AGETOR_COPILOT_DRIVER=fake`,
 * docs/plans/github-copilot-harness.md §3.2). It scripts canned Copilot
 * `--output-format json` lines and plays them through the REAL
 * `mapCopilotEvent` + `finalizeCopilotTurn`, so the e2e suite exercises the
 * production mapper, subagent sink, usage sentinel and plan chunk — the
 * cursor-stream precedent (`FAKE_CURSOR_STREAM_PROMPT_MARKER`).
 *
 * Wiring (agents.ts `makeFakeAgent`, copilot branch):
 *   1. `onSessionId?.(resumeSessionId ?? "fake-copilot-session-<taskId>")`
 *   2. `const script = fakeCopilotScript(prompt, { runId, sessionId, model })`
 *   3. `return playFakeCopilotTurn({ script, runId, sessionId, model, mode,
 *        copilotHome, onChunk, sink: args.copilotSubagents })`
 * The returned handle is a `SpawnedAgent` (`kill` / `writeInput` / `done`).
 *
 * This module must not import agents.ts or orchestrator.ts (import cycle).
 */

export const FAKE_COPILOT_STREAM_PROMPT_MARKER = "__agetor_fake_copilot_stream__";
export const FAKE_COPILOT_PLAN_PROMPT_MARKER = "__agetor_fake_copilot_plan__";
export const FAKE_COPILOT_AUTH_PROMPT_MARKER = "__agetor_fake_copilot_auth__";

export type FakeCopilotScenario = "basic" | "stream" | "plan" | "auth";

/** One scripted log line, emitted `delayMs` after the previous one. */
export interface FakeCopilotStep {
  delayMs: number;
  /** A raw log line: JSON for events, plain text for the auth scenario's stderr. */
  line: string;
}

export interface FakeCopilotScript {
  scenario: FakeCopilotScenario;
  steps: FakeCopilotStep[];
  /** The process exit code (the scripted `result.exitCode` mirrors it). */
  exitCode: number;
  /** Text of the `--usage-output-file` the scenario "wrote", or null for none. */
  usageText: string | null;
}

export interface FakeCopilotScriptInput {
  runId: string;
  sessionId: string;
  /** The task's model id; `auto` makes the scripted messages report a concrete one. */
  model: string | null;
  /** Subagent lifetime; defaults to `AGETOR_FAKE_COPILOT_SUBAGENT_MS` / 1500. */
  subagentMs?: number;
}

const DEFAULT_SUBAGENT_MS = 1500;
const FAKE_PICKED_MODEL = "claude-sonnet-5.5";

/** `AGETOR_FAKE_COPILOT_SUBAGENT_MS` (default 1500, clamped 0..60000). */
export function fakeCopilotSubagentMs(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.AGETOR_FAKE_COPILOT_SUBAGENT_MS);
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_SUBAGENT_MS;
  return Math.min(raw, 60_000);
}

/** The scenario the prompt selects (the last-appearing marker wins; none → basic). */
export function detectFakeCopilotScenario(prompt: string): FakeCopilotScenario {
  const hits: Array<[FakeCopilotScenario, number]> = [
    ["stream", prompt.lastIndexOf(FAKE_COPILOT_STREAM_PROMPT_MARKER)],
    ["plan", prompt.lastIndexOf(FAKE_COPILOT_PLAN_PROMPT_MARKER)],
    ["auth", prompt.lastIndexOf(FAKE_COPILOT_AUTH_PROMPT_MARKER)],
  ];
  let best: FakeCopilotScenario = "basic";
  let bestAt = -1;
  for (const [scenario, at] of hits) {
    if (at > bestAt) {
      best = scenario;
      bestAt = at;
    }
  }
  return best;
}

const FAKE_USAGE_TEXT = JSON.stringify({
  modelMetrics: {
    [FAKE_PICKED_MODEL]: {
      usage: {
        inputTokens: 1200,
        outputTokens: 340,
        cacheReadTokens: 800,
        cacheWriteTokens: 0,
        reasoningTokens: 60,
      },
    },
  },
  totalNanoAiu: 2_500_000_000,
  aiCreditsStatus: "available",
  codeChanges: { linesAdded: 0, linesRemoved: 0, filesModified: [] },
});

export function fakeCopilotScript(prompt: string, input: FakeCopilotScriptInput): FakeCopilotScript {
  const scenario = detectFakeCopilotScenario(prompt);

  if (scenario === "auth") {
    return {
      scenario,
      exitCode: 1,
      usageText: null,
      steps: [
        { delayMs: 50, line: "Error: No authentication information found." },
        { delayMs: 0, line: "" },
        { delayMs: 0, line: "Copilot can be authenticated with GitHub using an OAuth Token or a Fine-Grained Personal Access Token." },
        { delayMs: 0, line: "To authenticate, you can use any of the following methods:" },
        { delayMs: 0, line: "  - Start 'copilot' and run the '/login' command" },
        { delayMs: 0, line: "  - Run 'copilot login'" },
      ],
    };
  }

  const model = !input.model || input.model === "auto" ? FAKE_PICKED_MODEL : input.model;
  let seq = 0;
  const ev = (
    type: string,
    data: Record<string, unknown>,
    extra: { ephemeral?: boolean } = {},
  ): string => {
    seq += 1;
    return JSON.stringify({
      type,
      data,
      id: `${input.runId}:e${seq}`,
      timestamp: new Date().toISOString(),
      parentId: null,
      ...(extra.ephemeral ? { ephemeral: true } : {}),
    });
  };
  const step = (line: string, delayMs = 20): FakeCopilotStep => ({ delayMs, line });
  // The real `result` event is the one line with no `data`/`id`: its
  // fields sit at the top level.
  const result = (): string =>
    JSON.stringify({
      type: "result",
      timestamp: new Date().toISOString(),
      sessionId: input.sessionId,
      exitCode: 0,
      usage: { premiumRequests: 1, totalApiDurationMs: 900, sessionDurationMs: 1400 },
    });

  if (scenario === "basic") {
    return {
      scenario,
      exitCode: 0,
      usageText: null,
      steps: [
        step(ev("user.message", { content: prompt }), 0),
        step(ev("assistant.message", { messageId: "m1", content: "Hello from fake GitHub Copilot.", model })),
        step(result()),
      ],
    };
  }

  const subagentMs = input.subagentMs ?? fakeCopilotSubagentMs();
  const steps: FakeCopilotStep[] = [
    step(ev("user.message", { content: prompt }), 0),
    step(ev("assistant.reasoning", { reasoningId: "r1", content: "Let me look at the repository layout first." })),
    step(
      ev("assistant.message", {
        messageId: "m1",
        content: "I'll list the files.",
        model,
        toolRequests: [{ toolCallId: "call_1", name: "bash", arguments: { command: "ls" } }],
      }),
    ),
    step(ev("tool.execution_start", { toolCallId: "call_1", toolName: "bash", arguments: { command: "ls" } })),
    step(ev("tool.execution_complete", { toolCallId: "call_1", success: true, result: { content: "README.md\nsrc" } })),
    // A subagent: the parent `task` tool call, then nested activity that is
    // routed to the sink (a background-agent tab), kept "running" subagentMs.
    step(ev("tool.execution_start", { toolCallId: "call_sub", toolName: "task", arguments: { description: "Scan the repository" } })),
    step(
      ev("subagent.started", {
        toolCallId: "call_sub",
        agentName: "explore",
        agentDisplayName: "Explore",
        agentDescription: "Scan the repository for entry points",
        agentType: "explore",
      }),
    ),
    step(
      ev("tool.execution_start", {
        toolCallId: "call_sub_1",
        toolName: "grep",
        arguments: { pattern: "main" },
        parentToolCallId: "call_sub",
      }),
    ),
    step(
      ev("tool.execution_complete", {
        toolCallId: "call_sub_1",
        success: true,
        result: { content: "src/index.ts:1: main" },
        parentToolCallId: "call_sub",
      }),
    ),
    step(
      ev("assistant.message", {
        messageId: "m_sub",
        content: "Found the entry point at src/index.ts.",
        parentToolCallId: "call_sub",
      }),
      subagentMs,
    ),
    step(ev("subagent.completed", { toolCallId: "call_sub", agentName: "explore", agentDisplayName: "Explore" })),
    step(ev("tool.execution_complete", { toolCallId: "call_sub", success: true, result: { content: "done" } })),
  ];

  if (scenario === "plan") {
    steps.push(
      step(
        ev(
          "exit_plan_mode.requested",
          {
            requestId: "plan_req_1",
            summary: "Fake plan",
            planContent: "# Fake plan\n\n1. Inspect the repository\n2. Make the change\n3. Run the tests\n",
            actions: ["autopilot", "interactive", "exit_only"],
            recommendedAction: "interactive",
          },
          { ephemeral: true },
        ),
      ),
    );
  }

  steps.push(
    step(ev("assistant.message", { messageId: "m2", content: "All done — the fake Copilot turn finished.", model })),
    step(result()),
  );

  return { scenario, exitCode: 0, usageText: FAKE_USAGE_TEXT, steps };
}

export interface PlayFakeCopilotOptions {
  script: FakeCopilotScript;
  runId: string;
  sessionId: string;
  model: string | null;
  /** Agetor mode id; `plan` makes `finalizeCopilotTurn` emit the plan chunk. */
  mode: string | null;
  /** `$COPILOT_HOME` for the plan.md fallback (rarely relevant to the fake). */
  copilotHome: string;
  onChunk: ChunkHandler;
  /** The orchestrator's subagent sink (`SpawnAgentArgs.copilotSubagents`). */
  sink?: CopilotSubagentSink;
}

/**
 * Play a script through the real mapper and settlement. Resolves `done` with
 * the turn's exit code (the `result` event's, else the script's). `kill()`
 * stops playback, settles subagents as `orphaned` and resolves `1`.
 */
export function playFakeCopilotTurn(opts: PlayFakeCopilotOptions): SpawnedAgent {
  const turnStartedAt = Date.now();
  const ctx = createCopilotMapCtx({
    runId: opts.runId,
    model: opts.model,
    mode: opts.mode,
    turnStartedAt,
    sink: opts.sink,
  });
  let killed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let finish: (code: number) => void = () => {};
  const done = new Promise<number>((resolve) => {
    finish = resolve;
  });

  let lineIndex = 0;
  let lastCode: number | null = null;
  let i = 0;

  const settle = (): void => {
    const code = lastCode ?? opts.script.exitCode;
    finalizeCopilotTurn({
      runId: opts.runId,
      code,
      mode: opts.mode,
      sessionId: opts.sessionId,
      copilotHome: opts.copilotHome,
      turnStartedAt,
      ctx,
      usageText: opts.script.usageText,
      emit: opts.onChunk,
      sink: opts.sink,
    });
    finish(code);
  };

  const next = (): void => {
    timer = null;
    if (killed) return;
    if (i >= opts.script.steps.length) {
      settle();
      return;
    }
    const step = opts.script.steps[i++]!;
    timer = setTimeout(() => {
      timer = null;
      if (killed) return;
      if (step.line.trim()) {
        const res = mapCopilotEvent(step.line, lineIndex++, ctx);
        for (const chunk of res.chunks) opts.onChunk(chunk.stream, chunk.data, chunk.lineUuid);
        if (res.done !== undefined && lastCode === null) lastCode = res.done;
      }
      next();
    }, step.delayMs);
  };
  next();

  return {
    kill: () => {
      if (killed) return;
      killed = true;
      if (timer) { clearTimeout(timer); timer = null; }
      try { opts.sink?.settleAll("orphaned"); } catch { /* noop */ }
      finish(1);
    },
    writeInput: () => false,
    done,
  };
}
