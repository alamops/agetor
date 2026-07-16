import { test, expect, afterAll } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";

// db.ts captures AGETOR_DATA_DIR at first import; grok-tmux imports dataDir
// from it. Set a temp dir before importing (mirrors codex-tmux.test.ts).
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-grok-tmux-"));

const {
  mapGrokEvent,
  grokLogPath,
  encodeGrokCwd,
  grokSessionExistsOnDisk,
  spawnGrokViaTmux,
} = await import("./grok-tmux.ts");
import type { RunEventStream } from "../shared/types.ts";

type Chunk = { stream: RunEventStream; data: string; lineUuid?: string };
function collect() {
  const chunks: Chunk[] = [];
  const onChunk = (stream: RunEventStream, data: string, lineUuid?: string) =>
    chunks.push({ stream, data, lineUuid });
  return { chunks, onChunk };
}

/* ────────────────────────────────────────────────────────────────────────── *
 * mapGrokEvent — real xai-org/grok-build streaming-json contract (D1).
 * ────────────────────────────────────────────────────────────────────────── */

test("text event with data maps to an assistant chunk keyed by line index", () => {
  const { chunks, onChunk } = collect();
  const r = mapGrokEvent({ type: "text", data: "hello" }, onChunk, 3);
  expect(chunks).toEqual([{ stream: "assistant", data: "hello", lineUuid: "line:3" }]);
  expect(r).toEqual({});
});

test("text event with empty-string data emits no chunk", () => {
  const { chunks, onChunk } = collect();
  const r = mapGrokEvent({ type: "text", data: "" }, onChunk, 0);
  expect(chunks).toHaveLength(0);
  expect(r).toEqual({});
});

test("thought event with data maps to a thinking chunk keyed by line index", () => {
  const { chunks, onChunk } = collect();
  mapGrokEvent({ type: "thought", data: "pondering" }, onChunk, 2);
  expect(chunks).toEqual([{ stream: "thinking", data: "pondering", lineUuid: "line:2" }]);
});

test("thought event with empty-string data emits no chunk", () => {
  const { chunks, onChunk } = collect();
  const r = mapGrokEvent({ type: "thought", data: "" }, onChunk, 0);
  expect(chunks).toHaveLength(0);
  expect(r).toEqual({});
});

test("end event resolves done=0, carries sessionId, and emits a status chunk with the stop reason", () => {
  const { chunks, onChunk } = collect();
  const r = mapGrokEvent(
    { type: "end", stopReason: "complete", sessionId: "sess-1" },
    onChunk,
    5,
  );
  expect(r).toEqual({ done: 0, sessionId: "sess-1" });
  expect(chunks).toEqual([{ stream: "status", data: "turn ended: complete", lineUuid: "line:5" }]);
});

test("end event with no stopReason falls back to 'unknown'", () => {
  const { onChunk } = collect();
  const r = mapGrokEvent({ type: "end", sessionId: "sess-2" }, onChunk, 0);
  expect(r.sessionId).toBe("sess-2");
});

test("end event with flat spend fields renders them in the status chunk, in flatKeys order", () => {
  const { chunks, onChunk } = collect();
  mapGrokEvent(
    { type: "end", stopReason: "complete", sessionId: "s", cost: 0.05, totalTokens: 123 },
    onChunk,
    0,
  );
  expect(chunks[0]?.data).toBe("turn ended: complete (cost=0.05, totalTokens=123)");
});

test("end event with a nested spend object renders its entries in insertion order", () => {
  const { chunks, onChunk } = collect();
  mapGrokEvent(
    { type: "end", stopReason: "complete", sessionId: "s", spend: { foo: 1, bar: "x" } },
    onChunk,
    0,
  );
  expect(chunks[0]?.data).toBe("turn ended: complete (foo=1, bar=x)");
});

test("end event with no spend fields at all omits the parenthetical entirely", () => {
  const { chunks, onChunk } = collect();
  mapGrokEvent({ type: "end", stopReason: "complete", sessionId: "s" }, onChunk, 0);
  expect(chunks[0]?.data).toBe("turn ended: complete");
});

test("error event with a string message field emits stderr + done=1, no sessionId", () => {
  const { chunks, onChunk } = collect();
  const r = mapGrokEvent({ type: "error", message: "boom", sessionId: "should-be-ignored" }, onChunk, 4);
  expect(r).toEqual({ done: 1 });
  expect(chunks).toEqual([{ stream: "stderr", data: "boom", lineUuid: "line:4" }]);
});

test("error event with only error.message (no message field) still emits stderr + done=1", () => {
  const { chunks, onChunk } = collect();
  const r = mapGrokEvent({ type: "error", error: { message: "model down" } }, onChunk, 0);
  expect(r.done).toBe(1);
  expect(chunks[0]?.data).toBe("model down");
});

test("error event with neither message nor error falls back to a generic message", () => {
  const { chunks, onChunk } = collect();
  const r = mapGrokEvent({ type: "error" }, onChunk, 0);
  expect(r.done).toBe(1);
  expect(chunks[0]?.data).toBe("grok turn failed");
});

test("max_turns_reached emits a status chunk but is NOT terminal", () => {
  const { chunks, onChunk } = collect();
  const r = mapGrokEvent({ type: "max_turns_reached" }, onChunk, 0);
  expect(r.done).toBeUndefined();
  expect(chunks).toEqual([{ stream: "status", data: "max turns reached", lineUuid: "line:0" }]);
});

test("auto_compact_started with percentage renders it in the status chunk", () => {
  const { chunks, onChunk } = collect();
  mapGrokEvent({ type: "auto_compact_started", percentage: 42 }, onChunk, 0);
  expect(chunks[0]?.data).toBe("auto-compacting context (42%)");
});

test("auto_compact_started without percentage omits the parenthetical", () => {
  const { chunks, onChunk } = collect();
  mapGrokEvent({ type: "auto_compact_started" }, onChunk, 0);
  expect(chunks[0]?.data).toBe("auto-compacting context");
});

test("auto_compact_failed with an error field renders it", () => {
  const { chunks, onChunk } = collect();
  mapGrokEvent({ type: "auto_compact_failed", error: "disk full" }, onChunk, 0);
  expect(chunks[0]?.data).toBe("auto-compact failed: disk full");
});

test("auto_compact_completed and auto_compact_cancelled emit their fixed status text", () => {
  const a = collect();
  mapGrokEvent({ type: "auto_compact_completed" }, a.onChunk, 0);
  expect(a.chunks[0]?.data).toBe("auto-compact completed");

  const b = collect();
  mapGrokEvent({ type: "auto_compact_cancelled" }, b.onChunk, 0);
  expect(b.chunks[0]?.data).toBe("auto-compact cancelled");
});

test("auto_continue_completed with total_tokens renders it in the status chunk", () => {
  const { chunks, onChunk } = collect();
  mapGrokEvent({ type: "auto_continue_completed", total_tokens: 999 }, onChunk, 0);
  expect(chunks[0]?.data).toBe("auto-continue completed (999 tokens)");
});

test("image_compressed with a message field uses it; without, falls back to a default", () => {
  const withMsg = collect();
  mapGrokEvent({ type: "image_compressed", message: "shrunk image.png" }, withMsg.onChunk, 0);
  expect(withMsg.chunks[0]?.data).toBe("shrunk image.png");

  const noMsg = collect();
  mapGrokEvent({ type: "image_compressed" }, noMsg.onChunk, 0);
  expect(noMsg.chunks[0]?.data).toBe("image compressed");
});

test("unrecognized event type with text falls back to a generic tool_use chunk", () => {
  const { chunks, onChunk } = collect();
  mapGrokEvent({ type: "custom_event", id: "c1", data: "hello" }, onChunk, 0);
  expect(chunks).toHaveLength(1);
  expect(chunks[0]?.stream).toBe("tool_use");
  expect(chunks[0]?.lineUuid).toBe("custom_event:c1");
  expect(JSON.parse(chunks[0]!.data)).toMatchObject({ name: "custom_event", text: "hello" });
});

test("unrecognized event type with no text anywhere is dropped silently", () => {
  const { chunks, onChunk } = collect();
  const r = mapGrokEvent({ type: "ping" }, onChunk, 0);
  expect(chunks).toHaveLength(0);
  expect(r).toEqual({});
});

/* ────────────────────────────────────────────────────────────────────────── *
 * keyScope (4th param) — namespaces every key mapGrokEvent produces, so the
 * task-scoped dedup set doesn't collide turn 2's line:0 with turn 1's.
 * ────────────────────────────────────────────────────────────────────────── */

test("keyScope prefixes the line-index key: run-a:line:N", () => {
  const { chunks, onChunk } = collect();
  mapGrokEvent({ type: "text", data: "hi" }, onChunk, 5, "run-a");
  expect(chunks[0]?.lineUuid).toBe("run-a:line:5");
});

test("same event + lineIndex + scope produces the IDENTICAL key both times (replay dedup)", () => {
  const { chunks, onChunk } = collect();
  mapGrokEvent({ type: "text", data: "hi" }, onChunk, 5, "run-a");
  mapGrokEvent({ type: "text", data: "hi" }, onChunk, 5, "run-a");
  expect(chunks).toHaveLength(2);
  expect(chunks[0]?.lineUuid).toBe(chunks[1]?.lineUuid);
});

test("same lineIndex under DIFFERENT scopes produces different keys (follow-up-turn collision guard)", () => {
  const a = collect();
  mapGrokEvent({ type: "text", data: "turn one, line 0" }, a.onChunk, 0, "run-a");
  const b = collect();
  mapGrokEvent({ type: "text", data: "turn two, line 0" }, b.onChunk, 0, "run-b");
  expect(a.chunks[0]?.lineUuid).toBe("run-a:line:0");
  expect(b.chunks[0]?.lineUuid).toBe("run-b:line:0");
  expect(a.chunks[0]?.lineUuid).not.toBe(b.chunks[0]?.lineUuid);
});

test("fallback id-based keys (unrecognized type) are also scoped", () => {
  const a = collect();
  mapGrokEvent({ type: "custom_event", id: "x1", data: "hello" }, a.onChunk, 0, "run-a");
  const b = collect();
  mapGrokEvent({ type: "custom_event", id: "x1", data: "hello" }, b.onChunk, 0, "run-b");
  expect(a.chunks[0]?.lineUuid).toBe("run-a:custom_event:x1");
  expect(b.chunks[0]?.lineUuid).toBe("run-b:custom_event:x1");
  expect(a.chunks[0]?.lineUuid).not.toBe(b.chunks[0]?.lineUuid);
});

/* ────────────────────────────────────────────────────────────────────────── *
 * encodeGrokCwd — TS port of the short-path case of encode_cwd_dirname.
 * ────────────────────────────────────────────────────────────────────────── */

test("encodeGrokCwd percent-encodes a path with a space; slashes become %2F", () => {
  const encoded = encodeGrokCwd("/Users/foo/my project");
  expect(encoded).toBe("%2FUsers%2Ffoo%2Fmy%20project");
});

test("encodeGrokCwd encodes !'()* even though encodeURIComponent leaves them bare (Rust urlencoding parity)", () => {
  const encoded = encodeGrokCwd("/tmp/a!b'c(d)e*f");
  expect(encoded).toBe("%2Ftmp%2Fa%21b%27c%28d%29e%2Af");
  // None of the five characters survive un-escaped.
  for (const ch of ["!", "'", "(", ")", "*"]) {
    expect(encoded).not.toContain(ch);
  }
});

test("encodeGrokCwd returns null when the encoded form exceeds 255 bytes", () => {
  const longPath = "/tmp/" + "a".repeat(300);
  expect(encodeGrokCwd(longPath)).toBeNull();
});

test("encodeGrokCwd: a non-ASCII multibyte path under the 255-byte cap still encodes", () => {
  const cwd = "/" + "日".repeat(20); // 20 * 3-byte UTF-8 char -> 20*9=180 encoded bytes + 3 for '/'
  const encoded = encodeGrokCwd(cwd);
  expect(encoded).not.toBeNull();
  expect(Buffer.byteLength(encoded!, "utf8")).toBeLessThanOrEqual(255);
  expect(Buffer.byteLength(encoded!, "utf8")).toBe(183);
});

test("encodeGrokCwd: a non-ASCII multibyte path over the 255-byte cap returns null", () => {
  const cwd = "/" + "日".repeat(30); // 30*9 + 3 = 273 encoded bytes, over the cap
  expect(encodeGrokCwd(cwd)).toBeNull();
});

/* ────────────────────────────────────────────────────────────────────────── *
 * grokSessionExistsOnDisk — direct path check + directory-scan fallback.
 * ────────────────────────────────────────────────────────────────────────── */

test("grokSessionExistsOnDisk: true when <home>/sessions/<encoded-cwd>/<id>/ exists (direct path)", () => {
  const home = mkdtempSync(path.join(tmpdir(), "agetor-grok-home-exists-"));
  const cwd = "/tmp/some/project";
  const sessionId = randomUUID();
  mkdirSync(path.join(home, "sessions", encodeGrokCwd(cwd)!, sessionId), { recursive: true });
  expect(grokSessionExistsOnDisk({ GROK_HOME: home }, cwd, sessionId)).toBe(true);
});

test("grokSessionExistsOnDisk: true via the scan-path fallback when the dirname doesn't match our encoding", () => {
  const home = mkdtempSync(path.join(tmpdir(), "agetor-grok-home-scan-"));
  const cwd = "/tmp/some/project";
  const sessionId = randomUUID();
  // Simulate the blake3 long-path scheme (or any encoding drift): a dirname
  // that does NOT equal encodeGrokCwd(cwd), but still contains sessionId one
  // level down.
  mkdirSync(path.join(home, "sessions", "some-weird-slugified-dirname", sessionId), { recursive: true });
  expect(grokSessionExistsOnDisk({ GROK_HOME: home }, cwd, sessionId)).toBe(true);
});

test("grokSessionExistsOnDisk: false when the sessions dir doesn't exist at all", () => {
  const home = mkdtempSync(path.join(tmpdir(), "agetor-grok-home-missing-"));
  expect(grokSessionExistsOnDisk({ GROK_HOME: home }, "/tmp/x", randomUUID())).toBe(false);
});

test("grokSessionExistsOnDisk: false when sessions dir exists but contains no matching session id", () => {
  const home = mkdtempSync(path.join(tmpdir(), "agetor-grok-home-nomatch-"));
  mkdirSync(path.join(home, "sessions", "some-other-dirname", "some-other-session"), { recursive: true });
  expect(grokSessionExistsOnDisk({ GROK_HOME: home }, "/tmp/x", randomUUID())).toBe(false);
});

/* ────────────────────────────────────────────────────────────────────────── *
 * updates.jsonl mapping (D8) — driven end-to-end through spawnGrokViaTmux +
 * the real tailer, since the line-dispatch function is not exported. Real
 * tmux is used (not stubbed): bun test sets NODE_ENV=test, which isolates
 * every tmux call onto the "agetor-test" socket (tmuxSocketName()), so this
 * can never touch the user's real tmux server. The fake "grok" binary is a
 * `sleep` stub that never writes to stdout, so the stdout log tailer stays
 * silent and every chunk collected below originates from updates.jsonl.
 *
 * Path resolution is lazy but the FIRST flush happens synchronously inside
 * spawnGrokViaTmux (startGrokTailer calls flushGrokUpdates once before
 * returning), and the updates.jsonl file is written to disk BEFORE the spawn
 * call — so assertions can run immediately with no polling/sleep needed.
 * ────────────────────────────────────────────────────────────────────────── */

const TEST_CWD = mkdtempSync(path.join(tmpdir(), "agetor-grok-cwd-"));

const FAKE_GROK_BIN = (() => {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-fake-grok-bin-"));
  const bin = path.join(dir, "fake-grok");
  // Ignores all args (including the spliced --prompt-file), never writes to
  // stdout, and stays alive long enough for the test to make its assertions
  // and then explicitly kill the session.
  writeFileSync(bin, "#!/bin/sh\nsleep 20\n");
  chmodSync(bin, 0o755);
  return bin;
})();

/** Tracks every spawned handle so the file-level afterAll can guarantee no
 *  stray tmux session or timer survives past this file, even if a test fails
 *  its assertions before reaching its own cleanup. */
const spawnedHandles: Array<{ kill: () => void }> = [];

function writeUpdatesFile(grokHome: string, cwd: string, sessionId: string, lines: string[]): void {
  const encoded = encodeGrokCwd(cwd);
  if (!encoded) throw new Error("test setup: cwd must encode to a short path");
  const dir = path.join(grokHome, "sessions", encoded, sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "updates.jsonl"), lines.join("\n") + "\n");
}

function spawnFakeGrokSession(opts: {
  grokHome: string;
  sessionId: string;
  seenLineUuids: Set<string>;
}) {
  const { chunks, onChunk } = collect();
  const handle = spawnGrokViaTmux({
    taskId: randomUUID(),
    runId: randomUUID(),
    argv: [FAKE_GROK_BIN],
    env: { GROK_HOME: opts.grokHome },
    cwd: TEST_CWD,
    promptText: "irrelevant — the fake bin ignores --prompt-file",
    onChunk,
    sessionId: opts.sessionId,
    seenLineUuids: opts.seenLineUuids,
  });
  spawnedHandles.push(handle);
  return { chunks, handle };
}

afterAll(async () => {
  for (const h of spawnedHandles) {
    try { h.kill(); } catch { /* best effort */ }
  }
  // Give kills a moment to land, then nuke the whole isolated test tmux
  // server so nothing lingers past this file (mirrors reconcile.test.ts).
  await new Promise((r) => setTimeout(r, 350));
  try {
    const { resolveTmuxBin, tmuxSocketName, tmuxSocketArgs } = await import("./tmux-resolution.ts");
    if (tmuxSocketName() === null) return;
    Bun.spawnSync([resolveTmuxBin(), ...tmuxSocketArgs(), "kill-server"]);
  } catch {
    // best-effort only
  }
});

test("updates.jsonl: tool_call maps to tool_use (tc: key), + tool_result (tcr:) when rawOutput is present", () => {
  const grokHome = mkdtempSync(path.join(tmpdir(), "agetor-grok-home-tc-"));
  const sessionId = randomUUID();
  writeUpdatesFile(grokHome, TEST_CWD, sessionId, [
    JSON.stringify({
      timestamp: 1, method: "session/update",
      params: { sessionId, update: {
        sessionUpdate: "tool_call", toolCallId: "tc-1", title: "Read file", kind: "read", rawInput: { path: "a.txt" },
      } },
    }),
    JSON.stringify({
      timestamp: 2, method: "session/update",
      params: { sessionId, update: {
        sessionUpdate: "tool_call", toolCallId: "tc-2", title: "Run command", kind: "execute", rawOutput: "some output",
      } },
    }),
  ]);

  const { chunks } = spawnFakeGrokSession({ grokHome, sessionId, seenLineUuids: new Set() });

  expect(chunks.map((c) => c.lineUuid)).toEqual(["tc:tc-1", "tc:tc-2", "tcr:tc-2"]);
  expect(chunks[0]?.stream).toBe("tool_use");
  expect(JSON.parse(chunks[0]!.data)).toMatchObject({ name: "Read file", kind: "read", input: { path: "a.txt" } });
  expect(chunks[1]?.stream).toBe("tool_use");
  expect(JSON.parse(chunks[1]!.data)).toMatchObject({ name: "Run command", kind: "execute" });
  expect(chunks[2]?.stream).toBe("tool_result");
  expect(JSON.parse(chunks[2]!.data)).toMatchObject({ content: "some output" });
});

test("updates.jsonl: tool_call_update completed/failed map to tool_result with isError set from status", () => {
  const grokHome = mkdtempSync(path.join(tmpdir(), "agetor-grok-home-tcu-"));
  const sessionId = randomUUID();
  writeUpdatesFile(grokHome, TEST_CWD, sessionId, [
    JSON.stringify({
      timestamp: 1, method: "session/update",
      params: { sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: "tc-1", status: "completed", rawOutput: "done reading" } },
    }),
    JSON.stringify({
      timestamp: 2, method: "session/update",
      params: { sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: "tc-2", status: "failed", content: { msg: "boom" } } },
    }),
  ]);

  const { chunks } = spawnFakeGrokSession({ grokHome, sessionId, seenLineUuids: new Set() });

  expect(chunks.map((c) => c.lineUuid)).toEqual(["tcu:tc-1:completed", "tcu:tc-2:failed"]);
  expect(chunks[0]?.stream).toBe("tool_result");
  expect(JSON.parse(chunks[0]!.data)).toMatchObject({ content: "done reading", isError: false });
  expect(chunks[1]?.stream).toBe("tool_result");
  expect(JSON.parse(chunks[1]!.data)).toMatchObject({ content: { msg: "boom" }, isError: true });
});

test("updates.jsonl: tool_call_update in_progress/partial statuses are skipped (no chunk)", () => {
  const grokHome = mkdtempSync(path.join(tmpdir(), "agetor-grok-home-partial-"));
  const sessionId = randomUUID();
  writeUpdatesFile(grokHome, TEST_CWD, sessionId, [
    JSON.stringify({
      timestamp: 1, method: "session/update",
      params: { sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: "tc-3", status: "in_progress" } },
    }),
    JSON.stringify({
      timestamp: 2, method: "session/update",
      params: { sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: "tc-4", status: "partial" } },
    }),
  ]);

  const { chunks } = spawnFakeGrokSession({ grokHome, sessionId, seenLineUuids: new Set() });

  expect(chunks).toHaveLength(0);
});

test("updates.jsonl: plan maps to tool_use keyed by line index", () => {
  const grokHome = mkdtempSync(path.join(tmpdir(), "agetor-grok-home-plan-"));
  const sessionId = randomUUID();
  writeUpdatesFile(grokHome, TEST_CWD, sessionId, [
    JSON.stringify({
      timestamp: 1, method: "session/update",
      params: { sessionId, update: { sessionUpdate: "plan", entries: [{ content: "step1", priority: "high", status: "pending" }] } },
    }),
  ]);

  const { chunks } = spawnFakeGrokSession({ grokHome, sessionId, seenLineUuids: new Set() });

  expect(chunks).toHaveLength(1);
  expect(chunks[0]?.stream).toBe("tool_use");
  expect(chunks[0]?.lineUuid).toBe("plan:0");
  expect(JSON.parse(chunks[0]!.data)).toMatchObject({
    name: "plan",
    input: [{ content: "step1", priority: "high", status: "pending" }],
  });
});

test("updates.jsonl: _x.ai/session/update extension lines are skipped entirely", () => {
  const grokHome = mkdtempSync(path.join(tmpdir(), "agetor-grok-home-xai-"));
  const sessionId = randomUUID();
  writeUpdatesFile(grokHome, TEST_CWD, sessionId, [
    JSON.stringify({ timestamp: 1, method: "_x.ai/session/update", params: { sessionId, event: "rewind" } }),
  ]);

  const { chunks } = spawnFakeGrokSession({ grokHome, sessionId, seenLineUuids: new Set() });

  expect(chunks).toHaveLength(0);
});

test("updates.jsonl: agent_message_chunk / user_message_chunk tags are skipped (stdout stream owns them)", () => {
  const grokHome = mkdtempSync(path.join(tmpdir(), "agetor-grok-home-chunks-"));
  const sessionId = randomUUID();
  writeUpdatesFile(grokHome, TEST_CWD, sessionId, [
    JSON.stringify({
      timestamp: 1, method: "session/update",
      params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { text: "hi" } } },
    }),
    JSON.stringify({
      timestamp: 2, method: "session/update",
      params: { sessionId, update: { sessionUpdate: "user_message_chunk", content: { text: "yo" } } },
    }),
  ]);

  const { chunks } = spawnFakeGrokSession({ grokHome, sessionId, seenLineUuids: new Set() });

  expect(chunks).toHaveLength(0);
});

test("updates.jsonl: a legacy no-method params-shaped line is still parsed", () => {
  const grokHome = mkdtempSync(path.join(tmpdir(), "agetor-grok-home-legacy-"));
  const sessionId = randomUUID();
  writeUpdatesFile(grokHome, TEST_CWD, sessionId, [
    JSON.stringify({ update: { sessionUpdate: "tool_call", toolCallId: "tc-legacy", title: "Legacy tool" } }),
  ]);

  const { chunks } = spawnFakeGrokSession({ grokHome, sessionId, seenLineUuids: new Set() });

  expect(chunks).toHaveLength(1);
  expect(chunks[0]?.stream).toBe("tool_use");
  expect(chunks[0]?.lineUuid).toBe("tc:tc-legacy");
  expect(JSON.parse(chunks[0]!.data)).toMatchObject({ name: "Legacy tool" });
});

test("updates.jsonl: malformed JSON lines are skipped silently, without breaking later lines", () => {
  const grokHome = mkdtempSync(path.join(tmpdir(), "agetor-grok-home-malformed-"));
  const sessionId = randomUUID();
  writeUpdatesFile(grokHome, TEST_CWD, sessionId, [
    "{not valid json",
    JSON.stringify({
      timestamp: 1, method: "session/update",
      params: { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "tc-after-garbage", title: "Still works" } },
    }),
  ]);

  const { chunks } = spawnFakeGrokSession({ grokHome, sessionId, seenLineUuids: new Set() });

  expect(chunks).toHaveLength(1);
  expect(chunks[0]?.lineUuid).toBe("tc:tc-after-garbage");
});

test("updates.jsonl: everything together in one file, in line order", () => {
  const grokHome = mkdtempSync(path.join(tmpdir(), "agetor-grok-home-combo-"));
  const sessionId = randomUUID();
  writeUpdatesFile(grokHome, TEST_CWD, sessionId, [
    JSON.stringify({ timestamp: 1, method: "session/update", params: { sessionId, update: {
      sessionUpdate: "tool_call", toolCallId: "tc-1", title: "Read file", kind: "read", rawInput: { path: "a.txt" },
    } } }),
    JSON.stringify({ timestamp: 2, method: "session/update", params: { sessionId, update: {
      sessionUpdate: "tool_call", toolCallId: "tc-2", title: "Run command", kind: "execute", rawOutput: "some output",
    } } }),
    JSON.stringify({ timestamp: 3, method: "session/update", params: { sessionId, update: {
      sessionUpdate: "tool_call_update", toolCallId: "tc-1", status: "completed", rawOutput: "done reading",
    } } }),
    JSON.stringify({ timestamp: 4, method: "session/update", params: { sessionId, update: {
      sessionUpdate: "tool_call_update", toolCallId: "tc-2", status: "failed", content: { msg: "boom" },
    } } }),
    JSON.stringify({ timestamp: 5, method: "session/update", params: { sessionId, update: {
      sessionUpdate: "tool_call_update", toolCallId: "tc-3", status: "in_progress",
    } } }),
    JSON.stringify({ timestamp: 6, method: "session/update", params: { sessionId, update: {
      sessionUpdate: "tool_call_update", toolCallId: "tc-4", status: "partial",
    } } }),
    JSON.stringify({ timestamp: 7, method: "session/update", params: { sessionId, update: {
      sessionUpdate: "plan", entries: [{ content: "step1", priority: "high", status: "pending" }],
    } } }),
    JSON.stringify({ timestamp: 8, method: "_x.ai/session/update", params: { sessionId, event: "rewind" } }),
    JSON.stringify({ timestamp: 9, method: "session/update", params: { sessionId, update: {
      sessionUpdate: "agent_message_chunk", content: { text: "hi" },
    } } }),
    JSON.stringify({ timestamp: 10, method: "session/update", params: { sessionId, update: {
      sessionUpdate: "user_message_chunk", content: { text: "yo" },
    } } }),
    JSON.stringify({ update: { sessionUpdate: "tool_call", toolCallId: "tc-legacy", title: "Legacy tool" } }),
    "{not valid json",
  ]);

  const { chunks } = spawnFakeGrokSession({ grokHome, sessionId, seenLineUuids: new Set() });

  expect(chunks.map((c) => c.lineUuid)).toEqual([
    "tc:tc-1",
    "tc:tc-2", "tcr:tc-2",
    "tcu:tc-1:completed",
    "tcu:tc-2:failed",
    "plan:6",
    "tc:tc-legacy",
  ]);
});

test("updates.jsonl: dedup across a re-read (same seen set) emits nothing twice", () => {
  const grokHome = mkdtempSync(path.join(tmpdir(), "agetor-grok-home-dedup-"));
  const sessionId = randomUUID();
  writeUpdatesFile(grokHome, TEST_CWD, sessionId, [
    JSON.stringify({ timestamp: 1, method: "session/update", params: { sessionId, update: {
      sessionUpdate: "tool_call", toolCallId: "tc-1", title: "Read file",
    } } }),
    JSON.stringify({ timestamp: 2, method: "session/update", params: { sessionId, update: {
      sessionUpdate: "plan", entries: [{ content: "step1", priority: "high", status: "pending" }],
    } } }),
  ]);

  const seenLineUuids = new Set<string>();

  // First "read" of the session's updates.jsonl: fresh spawn, same file.
  const first = spawnFakeGrokSession({ grokHome, sessionId, seenLineUuids });
  expect(first.chunks).toHaveLength(2);

  // Second "read": a brand-new spawn (different task/run — e.g. a follow-up
  // turn, or a restart re-tailing from offset 0) against the SAME session id,
  // cwd, and grokHome, reusing the SAME dedup set. The file on disk is
  // unchanged, so every key was already seen — nothing should be re-emitted.
  const second = spawnFakeGrokSession({ grokHome, sessionId, seenLineUuids });
  expect(second.chunks).toHaveLength(0);
});

/* ────────────────────────────────────────────────────────────────────────── *
 * Path helper (mirrors codexLogPath's reattach-derivability guarantee).
 * ────────────────────────────────────────────────────────────────────────── */

test("grokLogPath is derivable from runId alone (so reattach can recompute it)", () => {
  const p = grokLogPath("run-xyz");
  expect(p.endsWith(path.join("grok-logs", "run-xyz.jsonl"))).toBe(true);
});
