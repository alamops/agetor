import { test, expect, beforeAll, afterAll } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import hookSource from "./hooks/agetor-approval-hook.sh" with { type: "text" };

// We exec the real hook script with a stubbed agetor server so we test the
// actual bash + curl path the user runs in production. The script's
// fail-open behaviour and safe-tool shortcuts are both exercised.

let scriptPath: string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let server: any;
let lastBody: string | null = null;
let nextResponseBody: string | null = null;
// Per-test stub-server knobs. Each test resets these in its setup; the
// happy-path default (real-agetor-shape /health, normal /approvals) is the
// baseline so tests that don't reset still pass the bypass check.
let healthBody: string | null = '{"ok":true,"app":"agetor"}';
let approvalsBehaviour: "normal" | "fail" = "normal";

beforeAll(() => {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-hook-"));
  scriptPath = path.join(dir, "agetor-approval-hook.sh");
  writeFileSync(scriptPath, hookSource);
  chmodSync(scriptPath, 0o755);

  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      // /health is unauthenticated (mirrors the real server) — the hook
      // probes it before POSTing as a liveness check. Body MUST include
      // `"app":"agetor"` so the hook can distinguish us from a different
      // service that happens to be listening on the same port.
      if (url.pathname === "/health") {
        if (healthBody === null) return new Response("not found", { status: 404 });
        return new Response(healthBody, { headers: { "content-type": "application/json" } });
      }
      if (req.headers.get("authorization") !== "Bearer test-token") {
        return new Response("unauthorized", { status: 401 });
      }
      if (approvalsBehaviour === "fail") {
        return new Response("server error", { status: 500 });
      }
      lastBody = await req.text();
      return new Response(nextResponseBody ?? "", {
        headers: { "content-type": "application/json" },
      });
    },
  });
});

afterAll(() => {
  server?.stop?.();
});

interface RunOptions {
  agetorReachable?: boolean;
  /** When false, deliberately omit AGETOR_* env vars to simulate claude
   *  running outside agetor (the install-footprint case — `.claude/`
   *  hook entries still present in a user repo). */
  withAgetorEnv?: boolean;
}

async function runHook(input: unknown, opts: RunOptions = {}): Promise<{ stdout: string; exitCode: number }> {
  const env: Record<string, string> = {};
  // Carry forward parent env but strip any AGETOR_* that might be inherited
  // from a parent shell (we sometimes run these tests from inside an agetor
  // session ourselves); each test then re-injects what it needs.
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k.startsWith("AGETOR_")) continue;
    env[k] = v;
  }
  if (opts.withAgetorEnv !== false) {
    env.AGETOR_API_TOKEN = "test-token";
    // Point at our stub when reachable; at an unbound port when not.
    env.AGETOR_API_PORT = opts.agetorReachable === false ? "1" : String(server.port);
    env.AGETOR_TASK_ID = "task-fixture";
  }
  const proc = Bun.spawn(["bash", scriptPath], {
    env,
    stdin: new TextEncoder().encode(JSON.stringify(input)),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { stdout, exitCode };
}

test("Read tool short-circuits to allow without hitting agetor", async () => {
  lastBody = null;
  const { stdout, exitCode } = await runHook({
    tool_name: "Read",
    tool_input: { file_path: "/etc/hosts" },
  });
  expect(exitCode).toBe(0);
  expect(stdout).toContain('"permissionDecision":"allow"');
  expect(lastBody).toBeNull();
});

test("mcp__agetor__ask_user short-circuits to allow without hitting agetor", async () => {
  lastBody = null;
  const { stdout, exitCode } = await runHook({
    tool_name: "mcp__agetor__ask_user",
    tool_input: { question: "?" },
  });
  expect(exitCode).toBe(0);
  expect(stdout).toContain('"permissionDecision":"allow"');
  expect(lastBody).toBeNull();
});

test("Bash tool POSTs to agetor and echoes the server's response verbatim", async () => {
  lastBody = null;
  nextResponseBody = '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}';
  const input = { tool_name: "Bash", tool_input: { command: "git status" } };
  const { stdout, exitCode } = await runHook(input);
  expect(exitCode).toBe(0);
  expect(stdout).toBe(nextResponseBody);
  expect(lastBody).not.toBeNull();
  // The server should see claude's original PreToolUse payload verbatim.
  expect(JSON.parse(lastBody!)).toEqual(input);
});

test("Unreachable agetor → /health bypass kicks in, hook exits silently", async () => {
  // Previously this fell open to permissionDecision="ask", which in
  // --permission-mode auto translates to a hard deny (claude treats hook
  // 'ask' as terminal). Silent exit lets claude's own permission engine
  // handle the tool call as if no hook were installed — which is exactly
  // what a user running claude outside agetor expects.
  lastBody = null;
  const { stdout, exitCode } = await runHook(
    { tool_name: "Bash", tool_input: { command: "rm -rf /" } },
    { agetorReachable: false },
  );
  expect(exitCode).toBe(0);
  expect(stdout).toBe("");
  // /health probe ran but failed before we reached /approvals — server
  // should not have received a POST body.
  expect(lastBody).toBeNull();
});

test("Bypass: AGETOR_* env vars absent → hook exits silently without probing", async () => {
  // The install-footprint case: a user opens a repo where agetor previously
  // installed a hook in .claude/settings.local.json, then runs `claude`
  // directly (no agetor). Env vars unset → exit 0 with empty stdout, claude
  // proceeds with its own permission flow. Critical that we don't even
  // try to curl — a bad port could cause connect-attempt delays.
  lastBody = null;
  const { stdout, exitCode } = await runHook(
    { tool_name: "Bash", tool_input: { command: "ls" } },
    { withAgetorEnv: false },
  );
  expect(exitCode).toBe(0);
  expect(stdout).toBe("");
  expect(lastBody).toBeNull();
});

test("Bypass: env set but /health fails → exit silently (mid-session agetor death)", async () => {
  // Env vars are still in the process tree (claude's tmux session held onto
  // them after agetor crashed mid-run). The /health probe is the
  // authoritative liveness check.
  lastBody = null;
  const { stdout, exitCode } = await runHook(
    { tool_name: "Bash", tool_input: { command: "ls" } },
    { agetorReachable: false },
  );
  expect(exitCode).toBe(0);
  expect(stdout).toBe("");
  expect(lastBody).toBeNull();
});

test("Bypass does not engage when both env AND /health are healthy", async () => {
  // Regression guard for the happy path: a bug in the bypass order could
  // silently disable agetor entirely. Make sure the POST still happens.
  lastBody = null;
  healthBody = '{"ok":true,"app":"agetor"}';
  approvalsBehaviour = "normal";
  nextResponseBody = '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}';
  const { stdout, exitCode } = await runHook(
    { tool_name: "Bash", tool_input: { command: "echo hi" } },
  );
  expect(exitCode).toBe(0);
  expect(stdout).toBe(nextResponseBody);
  expect(lastBody).not.toBeNull();
});

test("Bypass: /health returns 200 but body lacks `app:agetor` → silent exit (port-collision defence)", async () => {
  // Scenario: another local service is listening on AGETOR_API_PORT (4317
  // happens to be the OTLP gRPC default, for example) and responds 200
  // OK to /health with its own body. `curl -f` would accept that — only a
  // body-content check distinguishes us.
  lastBody = null;
  healthBody = '{"ok":true,"service":"some-other-thing"}'; // no app:agetor
  const { stdout, exitCode } = await runHook(
    { tool_name: "Bash", tool_input: { command: "echo collision" } },
  );
  expect(exitCode).toBe(0);
  expect(stdout).toBe("");
  // Never POSTed to /approvals — the body check stopped us at /health.
  expect(lastBody).toBeNull();
  // Reset for subsequent tests.
  healthBody = '{"ok":true,"app":"agetor"}';
});

test("POST failure (mid-call agetor death) → silent exit, not `permissionDecision: ask`", async () => {
  // Critical: `ask` is treated as a hard deny in --permission-mode auto.
  // If agetor dies between /health and /approvals (or returns 5xx during
  // restart), we must degrade the same way as the top-of-script bypass:
  // exit silently so claude's permission engine handles the tool call.
  lastBody = null;
  healthBody = '{"ok":true,"app":"agetor"}'; // /health passes
  approvalsBehaviour = "fail";                // /approvals returns 500
  const { stdout, exitCode } = await runHook(
    { tool_name: "Bash", tool_input: { command: "echo restart" } },
  );
  expect(exitCode).toBe(0);
  expect(stdout).toBe("");
  // Reset for subsequent tests.
  approvalsBehaviour = "normal";
});
