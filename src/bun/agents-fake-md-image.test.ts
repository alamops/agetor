import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentKind, Harness } from "../shared/types.ts";

// agents.ts imports codex-tmux.ts/gemini-tmux.ts, both of which import
// dataDir from db.ts — db.ts opens its sqlite connection at module-load
// time. A plain top-level `import` is hoisted ahead of any other code in
// this file, so AGETOR_DATA_DIR must be set before a *dynamic* import
// instead (same pattern as agents-fake-sent-files.test.ts). Without this,
// this file (or whichever file `bun test` loads first) can silently open
// the real ~/.agetor-dev database.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-agents-md-image-db-"));
const {
  spawnAgent,
  FAKE_CLAUDE_MD_IMAGE_PROMPT_MARKER,
  FAKE_CLAUDE_SENT_FILES_PROMPT_MARKER,
} = await import("./agents.ts");

/** Built-in claude-code harness — same shape as agents-fake-sent-files.test.ts's
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

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

test(
  "AGETOR_CLAUDE_DRIVER=fake + FAKE_CLAUDE_MD_IMAGE_PROMPT_MARKER emits one assistant chunk " +
    "carrying absolute/relative/missing/non-image refs, then settles the turn",
  async () => {
    process.env.AGETOR_CLAUDE_DRIVER = "fake";
    process.env.AGETOR_CLAUDE_BIN = "claude";
    const cwd = mkdtempSync(path.join(tmpdir(), "agetor-md-image-cwd-"));

    const chunks: { stream: string; data: string; lineUuid?: string }[] = [];
    const handle = await spawnAgent({
      taskId: "task-md-image-1",
      runId: "run-md-image-1",
      harness: builtinClaude(),
      prompt: `show me the screenshots ${FAKE_CLAUDE_MD_IMAGE_PROMPT_MARKER}`,
      cwd,
      onChunk: (stream, data, lineUuid) => { chunks.push({ stream, data, lineUuid }); },
      opts: { mode: "auto", model: "opus-4.7", effort: "high" },
    });

    const exitCode = await handle.done;
    expect(exitCode).toBe(0);

    const mdImageDir = path.join(cwd, "agetor-md-images");
    const shotPath = path.join(mdImageDir, "shot.png");
    const missingPath = path.join(mdImageDir, "missing.png");
    const reportPath = path.join(mdImageDir, "report.pdf");

    const assistantChunks = chunks.filter((c) => c.stream === "assistant");
    expect(assistantChunks).toHaveLength(1);
    const text = assistantChunks[0]!.data;

    const absoluteIdx = text.indexOf(`![Absolute shot](${shotPath})`);
    const relativeIdx = text.indexOf("![Relative shot](agetor-md-images/shot.png)");
    const missingIdx = text.indexOf(`![Missing shot](${missingPath})`);
    const reportIdx = text.indexOf(`![The report](${reportPath})`);
    expect(absoluteIdx).toBeGreaterThanOrEqual(0);
    expect(relativeIdx).toBeGreaterThan(absoluteIdx);
    expect(missingIdx).toBeGreaterThan(relativeIdx);
    expect(reportIdx).toBeGreaterThan(missingIdx);

    // A `status` chunk of "turn complete" follows the assistant text.
    const statusChunks = chunks.filter((c) => c.stream === "status").map((c) => c.data);
    expect(statusChunks).toContain("turn complete");
    const assistantEventIdx = chunks.findIndex((c) => c.stream === "assistant");
    const turnCompleteIdx = chunks.findIndex((c) => c.stream === "status" && c.data === "turn complete");
    expect(turnCompleteIdx).toBeGreaterThan(assistantEventIdx);

    // The real file exists and is a genuine PNG (magic bytes), the missing
    // ref and the never-written .pdf ref are not on disk.
    expect(existsSync(shotPath)).toBe(true);
    const shotBytes = readFileSync(shotPath);
    expect(shotBytes.subarray(0, 4)).toEqual(PNG_MAGIC);
    expect(existsSync(missingPath)).toBe(false);
    expect(existsSync(reportPath)).toBe(false);
  },
);

test(
  "AGETOR_CLAUDE_DRIVER=fake without the md-image marker keeps the generic fallback " +
    "(no agetor-md-images directory, no assistant chunk mentions it)",
  async () => {
    process.env.AGETOR_CLAUDE_DRIVER = "fake";
    process.env.AGETOR_CLAUDE_BIN = "claude";
    const cwd = mkdtempSync(path.join(tmpdir(), "agetor-md-image-cwd-"));

    const chunks: { stream: string; data: string; lineUuid?: string }[] = [];
    const handle = await spawnAgent({
      taskId: "task-md-image-2",
      runId: "run-md-image-2",
      harness: builtinClaude(),
      prompt: "just say hello, no scenario marker here",
      cwd,
      onChunk: (stream, data, lineUuid) => { chunks.push({ stream, data, lineUuid }); },
      opts: { mode: "auto", model: "opus-4.7", effort: "high" },
    });

    const exitCode = await handle.done;
    expect(exitCode).toBe(0);

    const mdImageDir = path.join(cwd, "agetor-md-images");
    expect(existsSync(mdImageDir)).toBe(false);

    const assistantChunks = chunks.filter((c) => c.stream === "assistant");
    for (const c of assistantChunks) {
      expect(c.data).not.toContain("agetor-md-images");
    }
    // The generic fallback emits its canned reply on `stdout`, not `assistant`.
    const stdoutChunks = chunks.filter((c) => c.stream === "stdout").map((c) => c.data);
    expect(stdoutChunks).toEqual(["fake response to: just say hello, no scenario marker here"]);
  },
);

test(
  "the md-image marker wins over the sent-files marker when both are present in the prompt " +
    "(md-image branch precedes the env-gated sent-files branch)",
  async () => {
    process.env.AGETOR_CLAUDE_DRIVER = "fake";
    process.env.AGETOR_CLAUDE_BIN = "claude";
    const cwd = mkdtempSync(path.join(tmpdir(), "agetor-md-image-cwd-"));

    const chunks: { stream: string; data: string; lineUuid?: string }[] = [];
    const handle = await spawnAgent({
      taskId: "task-md-image-3",
      runId: "run-md-image-3",
      harness: builtinClaude(),
      prompt: `both markers here ${FAKE_CLAUDE_MD_IMAGE_PROMPT_MARKER} ${FAKE_CLAUDE_SENT_FILES_PROMPT_MARKER}`,
      cwd,
      onChunk: (stream, data, lineUuid) => { chunks.push({ stream, data, lineUuid }); },
      opts: { mode: "auto", model: "opus-4.7", effort: "high" },
    });

    const exitCode = await handle.done;
    expect(exitCode).toBe(0);

    // The md-image scenario ran: its own directory and PNG exist.
    const mdImageDir = path.join(cwd, "agetor-md-images");
    expect(existsSync(path.join(mdImageDir, "shot.png"))).toBe(true);

    const assistantChunks = chunks.filter((c) => c.stream === "assistant");
    expect(assistantChunks).toHaveLength(1);
    expect(assistantChunks[0]!.data).toContain("![Absolute shot]");

    // The sent-files scenario did NOT run: no SendUserFile tool_use chunk,
    // and no `agetor-sent` directory was created.
    const toolUseChunks = chunks.filter((c) => c.stream === "tool_use").map((c) => JSON.parse(c.data));
    const sendUserFileCalls = toolUseChunks.filter((c) => c.name === "SendUserFile");
    expect(sendUserFileCalls).toHaveLength(0);
    expect(existsSync(path.join(cwd, "agetor-sent"))).toBe(false);
  },
);
