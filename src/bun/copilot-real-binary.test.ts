/**
 * TT8 — opt-in integration test that drives the REAL GitHub Copilot CLI binary
 * through agetor's own `buildCommand` + `spawnCopilotViaTmux`, against an
 * in-process fake OpenAI-compatible provider (BYOK). No GitHub auth, no
 * network, no billing.
 *
 * Skipped unless ALL of these hold:
 *   - `AGETOR_COPILOT_REAL_BIN` names an executable whose `--version` output
 *     contains "GitHub Copilot CLI"
 *   - `tmux` is on PATH
 *
 *   AGETOR_COPILOT_REAL_BIN=/path/to/copilot bun test src/bun/copilot-real-binary.test.ts
 *
 * Besides asserting the driver contract it prints `TT8-RECORD:` lines for
 * behaviour the plan only wants recorded (plan §8 A7/A9): whether
 * `assistant.reasoning` appears for a streamed reasoning delta, what a
 * `/<skill>` prompt does, and the shape of any effort notice.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Harness, RunEventStream } from "../shared/types.ts";

// db.ts captures AGETOR_DATA_DIR at first import (agents.ts and copilot-tmux.ts
// import it). The dir holds the db singleton's open sqlite file for the whole
// run, so it is deliberately left for the OS to reap. Paths below are always
// derived through the drivers' own helpers, never from this value, because
// another test file in the same process may have imported db.ts first.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-copilot-tt8-db-"));

const REAL_BIN = process.env.AGETOR_COPILOT_REAL_BIN?.trim() || "";
const realTmux = Bun.which("tmux");

function probeVersion(bin: string): string {
  if (!bin) return "";
  try {
    const res = Bun.spawnSync([bin, "--version"], { stdout: "pipe", stderr: "pipe" });
    return `${res.stdout.toString()}${res.stderr.toString()}`;
  } catch {
    return "";
  }
}
const binVersion = probeVersion(REAL_BIN);
const enabled = binVersion.includes("GitHub Copilot CLI") && realTmux !== null;
const suite = enabled ? describe : describe.skip;

const { buildCommand } = await import("./agents.ts");
const { COPILOT_LOGIN_STATUS_TEXT, copilotUsagePath, dropCopilotSession, spawnCopilotViaTmux } = await import("./copilot-tmux.ts");
const { FX_USAGE_STATUS_PREFIX } = await import("../shared/types.ts");
const { startFakeCopilotProvider } = await import("./test-support/copilot-fake-provider.ts");
import type { FakeProvider } from "./test-support/copilot-fake-provider.ts";

type Chunk = { stream: RunEventStream; data: string; lineUuid?: string };

const scratch = mkdtempSync(path.join(tmpdir(), "agetor-copilot-tt8-"));
const MODEL = "gpt-5.4";
// First launch of the npm loader can be slow; the provider-500 test also
// waits out Copilot's ~16 s retry ladder.
const TURN_T = 120_000;

suite(`copilot real binary (${binVersion.trim().split("\n")[0] ?? ""})`, () => {
  let provider: FakeProvider;
  let prevTmuxBin: string | undefined;
  let prevCopilotBin: string | undefined;
  const taskIds: string[] = [];

  beforeAll(() => {
    // Other test files in the same process leak AGETOR_TMUX_BIN=/bin/echo.
    prevTmuxBin = process.env.AGETOR_TMUX_BIN;
    prevCopilotBin = process.env.AGETOR_COPILOT_BIN;
    process.env.AGETOR_TMUX_BIN = realTmux!;
    process.env.AGETOR_COPILOT_BIN = REAL_BIN;
    provider = startFakeCopilotProvider({ slowMs: 60_000 });
  });

  afterAll(async () => {
    await provider.stop();
    if (prevTmuxBin === undefined) delete process.env.AGETOR_TMUX_BIN;
    else process.env.AGETOR_TMUX_BIN = prevTmuxBin;
    if (prevCopilotBin === undefined) delete process.env.AGETOR_COPILOT_BIN;
    else process.env.AGETOR_COPILOT_BIN = prevCopilotBin;
    rmSync(scratch, { recursive: true, force: true });
  });

  afterEach(async () => {
    for (const id of taskIds.splice(0)) await dropCopilotSession(id);
  });

  function byokEnv(): Record<string, string> {
    return {
      COPILOT_AUTO_UPDATE: "false",
      COPILOT_OFFLINE: "true",
      COPILOT_PROVIDER_BASE_URL: provider.baseUrl,
      COPILOT_PROVIDER_API_KEY: "sk-tt8-not-a-real-key",
      COPILOT_PROVIDER_TYPE: "openai",
    };
  }

  function newWorkspace() {
    const home = mkdtempSync(path.join(scratch, "chome-"));
    const cwd = mkdtempSync(path.join(scratch, "work-"));
    Bun.spawnSync(["git", "init", "-q"], { cwd });
    return { home, cwd };
  }

  interface TurnInput {
    prompt: string;
    mode?: string;
    effort?: string | null;
    taskId?: string;
    /** First turn: fresh id. Follow-up: pass the same id as `resume`. */
    sessionId?: string;
    resume?: boolean;
    home: string;
    cwd: string;
    /** Harness env map; defaults to the BYOK provider env. */
    harnessEnv?: Record<string, string>;
    /** Extra pane env layered over the built command's (e.g. an isolated HOME). */
    paneEnv?: Record<string, string>;
  }

  function startTurn(t: TurnInput) {
    const suffix = randomUUID().slice(0, 8);
    const taskId = t.taskId ?? `tt8${suffix}00`;
    const runId = `run-tt8-${suffix}`;
    const sessionId = t.sessionId ?? randomUUID();
    if (!taskIds.includes(taskId)) taskIds.push(taskId);
    const harness: Harness = {
      id: "copilot",
      kind: "copilot",
      label: "GitHub Copilot",
      isBuiltin: false,
      home: t.home,
      bin: null,
      env: t.harnessEnv ?? byokEnv(),
      enabled: true,
    };
    const mode = t.mode ?? "auto";
    const cmd = buildCommand(harness, t.prompt, {
      model: MODEL,
      effort: t.effort ?? null,
      mode,
      runId,
      ...(t.resume ? { resumeSessionId: sessionId } : { sessionId }),
    });
    const chunks: Chunk[] = [];
    const agentP = spawnCopilotViaTmux({
      taskId,
      runId,
      argv: cmd.cmd,
      env: { ...(cmd.env ?? {}), ...(t.paneEnv ?? {}) },
      cwd: t.cwd,
      promptText: t.prompt,
      onChunk: (stream, data, lineUuid) => chunks.push({ stream, data, lineUuid }),
      sessionId,
      copilotHome: t.home,
      mode,
      model: MODEL,
      stripClassicTokens: cmd.stripClassicTokens ?? [],
    });
    return { taskId, runId, sessionId, chunks, agentP, cmd };
  }

  async function runTurn(t: TurnInput) {
    const turn = startTurn(t);
    const agent = await turn.agentP;
    const code = await agent.done;
    return { ...turn, code };
  }

  const of = (chunks: Chunk[], stream: RunEventStream) => chunks.filter((c) => c.stream === stream);
  const toolUses = (chunks: Chunk[]) => of(chunks, "tool_use").map((c) => JSON.parse(c.data) as { id: string; name: string; input: unknown });
  const toolResults = (chunks: Chunk[]) =>
    of(chunks, "tool_result").map((c) => JSON.parse(c.data) as { toolUseId: string; content: unknown; isError: boolean });
  const flat = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));
  const record = (label: string, value: unknown) => console.log(`TT8-RECORD: ${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`);

  test("text turn: assistant chunk, code 0, BYOK model reaches the provider, usage sentinel", async () => {
    const ws = newWorkspace();
    provider.reset();
    const r = await runTurn({ prompt: "say hi", ...ws });
    expect(r.code).toBe(0);
    const assistant = of(r.chunks, "assistant");
    expect(assistant.length).toBeGreaterThan(0);
    expect(assistant.map((c) => c.data).join("\n")).toContain("Hello from the fake provider");
    expect(provider.requests.length).toBeGreaterThan(0);
    expect(provider.requests.every((q) => q.model === MODEL)).toBe(true);
    // The usage file Copilot wrote to the path buildCommand passed.
    expect(r.cmd.cmd).toContain(copilotUsagePath(r.runId));
    const usage = r.chunks.find((c) => c.data.startsWith(FX_USAGE_STATUS_PREFIX));
    expect(usage).toBeDefined();
    const body = JSON.parse(usage!.data.slice(FX_USAGE_STATUS_PREFIX.length)) as { turn?: Record<string, number> };
    expect(typeof body.turn?.inputTokens).toBe("number");
    expect(body.turn!.inputTokens).toBeGreaterThan(0);
    record("usage sentinel", body);
  }, TURN_T);

  test("Auto runs the shell tool; Read-only (ask) gets a permission-denied result for a write command", async () => {
    const auto = newWorkspace();
    const a = await runTurn({ prompt: "please TOOLCALL now", mode: "auto", ...auto });
    expect(a.code).toBe(0);
    const aUse = toolUses(a.chunks);
    expect(aUse.map((u) => u.name)).toContain("bash");
    const aRes = toolResults(a.chunks);
    expect(aRes.length).toBeGreaterThan(0);
    expect(aRes.every((x) => x.isError === false)).toBe(true);
    expect(aRes.map((x) => flat(x.content)).join("\n")).toContain("hi-from-tool");
    expect(aRes[0]!.toolUseId).toBe(aUse[0]!.id);

    // A write command: Auto performs it, Read-only is denied and nothing lands
    // on disk. (A pure `echo` is a read-only command Copilot approves on its
    // own even without allow-all, so it cannot prove the denial.)
    const autoWrite = newWorkspace();
    const w = await runTurn({ prompt: "WRITECMD now", mode: "auto", ...autoWrite });
    expect(w.code).toBe(0);
    expect(existsSync(path.join(autoWrite.cwd, "spike-created.txt"))).toBe(true);

    const ask = newWorkspace();
    const b = await runTurn({ prompt: "WRITECMD now", mode: "ask", ...ask });
    const bRes = toolResults(b.chunks);
    expect(bRes.length).toBeGreaterThan(0);
    expect(bRes.every((x) => x.isError === true)).toBe(true);
    expect(bRes.map((x) => flat(x.content)).join("\n")).toMatch(/Permission denied/);
    expect(existsSync(path.join(ask.cwd, "spike-created.txt"))).toBe(false);
  }, TURN_T * 2);

  test("a second turn with the same session id resumes (provider sees the prior user message)", async () => {
    const ws = newWorkspace();
    const sessionId = randomUUID();
    const taskId = `tt8res${randomUUID().slice(0, 6)}`;
    provider.reset();
    const first = await runTurn({ prompt: "remember-marker-alpha", sessionId, taskId, ...ws });
    expect(first.code).toBe(0);
    // The orchestrator only resumes an id whose `<COPILOT_HOME>/session-state/<id>/`
    // dir exists (`copilotSessionDirExists`) and otherwise starts fresh, so the
    // real CLI must keep writing exactly that layout under the pinned home.
    expect(existsSync(path.join(ws.home, "session-state", sessionId))).toBe(true);
    provider.reset();
    const second = await runTurn({ prompt: "second-turn-beta", sessionId, taskId, resume: true, ...ws });
    expect(second.code).toBe(0);
    expect(second.cmd.cmd).toContain(sessionId);
    const last = provider.requests.at(-1)!;
    expect(last.lastUser).toContain("second-turn-beta");
    expect(last.allUserText).toContain("remember-marker-alpha");
  }, TURN_T * 2);

  test("--mode plan reaches Copilot ([[PLAN]] prefix on the user message the provider sees)", async () => {
    const ws = newWorkspace();
    provider.reset();
    const r = await runTurn({ prompt: "say hi plan", mode: "plan", ...ws });
    expect(r.code).toBe(0);
    expect(r.cmd.cmd).toContain("plan");
    expect(provider.requests.length).toBeGreaterThan(0);
    expect(provider.requests[0]!.lastUser).toContain("[[PLAN]]");
  }, TURN_T);

  test("kill() mid-turn resolves non-zero", async () => {
    const ws = newWorkspace();
    provider.reset();
    const turn = startTurn({ prompt: "SLOW please", ...ws });
    const agent = await turn.agentP;
    const deadline = Date.now() + 60_000;
    while (!provider.requests.some((q) => q.mode === "slow") && Date.now() < deadline) await Bun.sleep(100);
    expect(provider.requests.some((q) => q.mode === "slow")).toBe(true);
    const t0 = Date.now();
    await agent.kill();
    const code = await agent.done;
    expect(code).not.toBe(0);
    expect(Date.now() - t0).toBeLessThan(15_000);
  }, TURN_T);

  test("provider 500: a '⚠ GitHub Copilot:' status from session.error and a non-zero code", async () => {
    const ws = newWorkspace();
    provider.reset();
    const r = await runTurn({ prompt: "FAIL500 please", ...ws });
    expect(r.code).not.toBe(0);
    const warn = of(r.chunks, "status").find((c) => c.data.startsWith("⚠ GitHub Copilot:"));
    expect(warn).toBeDefined();
    expect(warn!.data).toContain("500");
    expect(of(r.chunks, "assistant")).toHaveLength(0);
  }, TURN_T);

  test("no provider and no auth: the login status line and a non-zero code", async () => {
    const ws = newWorkspace();
    const isolatedHome = mkdtempSync(path.join(scratch, "home-"));
    // Blank every ambient token and move HOME so neither env vars nor the
    // developer's `gh`/keychain login can authenticate the run.
    const r = await runTurn({
      prompt: "say hi",
      harnessEnv: { COPILOT_AUTO_UPDATE: "false", GH_TOKEN: "", GITHUB_TOKEN: "", COPILOT_GITHUB_TOKEN: "" },
      paneEnv: { HOME: isolatedHome },
      ...ws,
    });
    expect(r.code).not.toBe(0);
    expect(of(r.chunks, "status").map((c) => c.data)).toContain(COPILOT_LOGIN_STATUS_TEXT);
  }, TURN_T);

  // ── Recorded, not asserted (plan §8 A7 / A9) ────────────────────────────

  test("RECORD: assistant.reasoning when the provider streams a reasoning delta", async () => {
    const ws = newWorkspace();
    provider.reset();
    const r = await runTurn({ prompt: "REASON about this", ...ws });
    const thinking = of(r.chunks, "thinking");
    record("reasoning delta -> thinking chunks", { code: r.code, thinkingChunks: thinking.map((c) => c.data), assistant: of(r.chunks, "assistant").map((c) => c.data) });
    expect(r.code).toBe(0);
  }, TURN_T);

  test("RECORD: a prompt beginning with /<skill-name> (plan §8 A9)", async () => {
    const ws = newWorkspace();
    const skillDir = path.join(ws.home, "skills", "tt8-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "---\nname: tt8-skill\ndescription: TT8 recorded skill. Replies with TT8-SKILL-BODY-MARKER.\n---\n\nWhen invoked, say TT8-SKILL-BODY-MARKER.\n",
    );
    provider.reset();
    const r = await runTurn({ prompt: "/tt8-skill please do the thing", ...ws });
    const first = provider.requests[0];
    record("slash-skill prompt", {
      code: r.code,
      providerSawLastUser: first?.lastUser.slice(0, 400) ?? null,
      providerSawSkillBody: provider.requests.some((q) => JSON.stringify(q.messages).includes("TT8-SKILL-BODY-MARKER")),
      requests: provider.requests.length,
      statuses: of(r.chunks, "status").map((c) => c.data),
      stderr: of(r.chunks, "stderr").map((c) => c.data.slice(0, 200)),
      assistant: of(r.chunks, "assistant").map((c) => c.data),
    });
    expect(typeof r.code).toBe("number");
  }, TURN_T);

  test("RECORD: --reasoning-effort against a BYOK model (plan §8 A7)", async () => {
    const ws = newWorkspace();
    provider.reset();
    const r = await runTurn({ prompt: "say hi effort", effort: "high", ...ws });
    record("effort high", {
      code: r.code,
      argv: r.cmd.cmd.slice(r.cmd.cmd.indexOf("--reasoning-effort"), r.cmd.cmd.indexOf("--reasoning-effort") + 2),
      providerReasoningEffort: provider.requests[0]?.reasoningEffort ?? null,
      effortStatuses: of(r.chunks, "status").map((c) => c.data).filter((d) => /reasoning|effort/i.test(d)),
    });
    expect(typeof r.code).toBe("number");
  }, TURN_T);
});
