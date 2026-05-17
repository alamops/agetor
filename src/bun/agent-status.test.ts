import { test, expect, beforeEach } from "bun:test";
import { checkHarness } from "./agent-status.ts";
import type { AgentKind, Harness } from "../shared/types.ts";

function builtin(kind: AgentKind): Harness {
  return { id: kind, kind, label: kind, isBuiltin: true, home: null, bin: null, env: {}, enabled: true };
}
const checkAgent = (kind: AgentKind) => checkHarness(builtin(kind));

beforeEach(() => {
  delete process.env.AGETOR_CODEX_BIN;
  delete process.env.AGETOR_CLAUDE_BIN;
  delete process.env.AGETOR_TMUX_BIN;
});

test("returns available=true with version for a real binary (claude needs tmux too)", async () => {
  // /bin/echo stands in for both claude and tmux so the dual probe passes
  // without either CLI installed. We don't assert the version string — just
  // that the probe completes and reports available.
  process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
  process.env.AGETOR_TMUX_BIN = "/bin/echo";
  const status = await checkAgent("claude-code");
  expect(status.available).toBe(true);
  expect(status.path).toBe("/bin/echo");
  expect(status.reason).toBeNull();
});

test("claude-code is unavailable when tmux is missing, with the install hint", async () => {
  process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
  process.env.AGETOR_TMUX_BIN = "definitely-not-tmux-xyz123";
  const status = await checkAgent("claude-code");
  expect(status.available).toBe(false);
  expect(status.reason).toContain("tmux");
  expect(status.installHint).toContain("tmux");
});

test("returns available=false with install hint when the bin is missing", async () => {
  process.env.AGETOR_CODEX_BIN = "definitely-not-a-real-binary-xyz123";
  const status = await checkAgent("codex");
  expect(status.available).toBe(false);
  expect(status.path).toBeNull();
  expect(status.reason).toContain("not found on PATH");
  expect(status.installHint).toContain("codex");
});
