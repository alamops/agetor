import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentKind, Harness } from "../shared/types.ts";

// agents.ts imports codex-tmux.ts/gemini-tmux.ts, both of which import
// dataDir from db.ts — db.ts opens its sqlite connection at module-load
// time. A plain top-level `import` is hoisted ahead of any other code in
// this file, so AGETOR_DATA_DIR must be set before a *dynamic* import
// instead (same pattern as agents-fake-md-image.test.ts). Without this,
// this file (or whichever file `bun test` loads first) can silently open
// the real ~/.agetor-dev database.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-agents-compaction-db-"));
const {
  spawnAgent,
  FAKE_CLAUDE_COMPACTION_PROMPT_MARKER,
  FAKE_CLAUDE_COMPACTION_SUMMARY_FIRST_LINE,
  FAKE_CLAUDE_COMPACTION_NOTICE,
  FAKE_CLAUDE_MD_IMAGE_PROMPT_MARKER,
} = await import("./agents.ts");

/** Built-in claude-code harness — same shape as agents-fake-md-image.test.ts's
 *  `builtinClaude()` helper (kept local: this file owns no import of that test
 *  module). */
function builtinClaude(): Harness {
  return {
    id: "claude-code",
    kind: "claude-code" as AgentKind,
    label: "claude-code",
    isBuiltin: true,
    home: null,
    bin: null,
    env: {},
    enabled: true,
  };
}

test(
  "AGETOR_CLAUDE_DRIVER=fake + FAKE_CLAUDE_COMPACTION_PROMPT_MARKER emits the compaction " +
    "boundary status, the summary, the idle notice, an assistant reply and turn complete, in order",
  async () => {
    process.env.AGETOR_CLAUDE_DRIVER = "fake";
    process.env.AGETOR_CLAUDE_BIN = "claude";
    const cwd = mkdtempSync(path.join(tmpdir(), "agetor-compaction-cwd-"));

    const chunks: { stream: string; data: string; lineUuid?: string }[] = [];
    const handle = await spawnAgent({
      taskId: "task-compaction-1",
      runId: "run-compaction-1",
      harness: builtinClaude(),
      prompt: `keep working ${FAKE_CLAUDE_COMPACTION_PROMPT_MARKER}`,
      cwd,
      onChunk: (stream, data, lineUuid) => { chunks.push({ stream, data, lineUuid }); },
      opts: { mode: "auto", model: "opus-4.7", effort: "high" },
    });

    const exitCode = await handle.done;
    expect(exitCode).toBe(0);

    expect(chunks).toHaveLength(5);
    const [boundary, summary, notice, reply, complete] = chunks;

    expect(boundary!.stream).toBe("status");
    expect(boundary!.data).toContain("450k → 8.6k tokens");

    expect(summary!.stream).toBe("compaction_summary");
    expect(summary!.data.split("\n")[0]).toBe(
      "This session is being continued from a previous conversation that ran out of context.",
    );
    expect(summary!.data.split("\n")[0]).toBe(FAKE_CLAUDE_COMPACTION_SUMMARY_FIRST_LINE);
    expect(summary!.data.length).toBeGreaterThanOrEqual(1500);

    expect(notice!.stream).toBe("status");
    expect(notice!.data).toBe("Compacted while idle, before the prompt cache expired");
    expect(notice!.data).toBe(FAKE_CLAUDE_COMPACTION_NOTICE);

    expect(reply!.stream).toBe("assistant");
    expect(reply!.data.length).toBeGreaterThan(0);

    expect(complete!.stream).toBe("status");
    expect(complete!.data).toBe("turn complete");
  },
);

test(
  "AGETOR_CLAUDE_DRIVER=fake without the compaction marker emits no compaction_summary chunk",
  async () => {
    process.env.AGETOR_CLAUDE_DRIVER = "fake";
    process.env.AGETOR_CLAUDE_BIN = "claude";
    const cwd = mkdtempSync(path.join(tmpdir(), "agetor-compaction-cwd-"));

    const chunks: { stream: string; data: string; lineUuid?: string }[] = [];
    const handle = await spawnAgent({
      taskId: "task-compaction-2",
      runId: "run-compaction-2",
      harness: builtinClaude(),
      prompt: "just say hello, no scenario marker here",
      cwd,
      onChunk: (stream, data, lineUuid) => { chunks.push({ stream, data, lineUuid }); },
      opts: { mode: "auto", model: "opus-4.7", effort: "high" },
    });

    expect(await handle.done).toBe(0);
    expect(chunks.some((c) => c.stream === "compaction_summary")).toBe(false);
    expect(chunks.some((c) => c.data.includes("context compacted"))).toBe(false);
  },
);

test(
  "the md-image marker wins over the compaction marker when both are present " +
    "(md-image branch precedes the compaction branch)",
  async () => {
    process.env.AGETOR_CLAUDE_DRIVER = "fake";
    process.env.AGETOR_CLAUDE_BIN = "claude";
    const cwd = mkdtempSync(path.join(tmpdir(), "agetor-compaction-cwd-"));

    const chunks: { stream: string; data: string; lineUuid?: string }[] = [];
    const handle = await spawnAgent({
      taskId: "task-compaction-3",
      runId: "run-compaction-3",
      harness: builtinClaude(),
      prompt: `both ${FAKE_CLAUDE_MD_IMAGE_PROMPT_MARKER} ${FAKE_CLAUDE_COMPACTION_PROMPT_MARKER}`,
      cwd,
      onChunk: (stream, data, lineUuid) => { chunks.push({ stream, data, lineUuid }); },
      opts: { mode: "auto", model: "opus-4.7", effort: "high" },
    });

    expect(await handle.done).toBe(0);
    expect(chunks.some((c) => c.stream === "compaction_summary")).toBe(false);
    expect(chunks.some((c) => c.stream === "assistant" && c.data.includes("![Absolute shot]"))).toBe(true);
  },
);
