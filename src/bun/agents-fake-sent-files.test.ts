import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseSentFilesToolResult, parseSentFilesToolUse } from "../shared/sent-files.ts";
import type { AgentKind, Harness } from "../shared/types.ts";

// agents.ts imports codex-tmux.ts/gemini-tmux.ts, both of which import
// dataDir from db.ts — db.ts opens its sqlite connection at module-load
// time. A plain top-level `import` is hoisted ahead of any other code in
// this file, so AGETOR_DATA_DIR must be set before a *dynamic* import
// instead (same pattern as agents.test.ts / harnesses.test.ts). Without
// this, this file (or whichever file `bun test` loads first) can silently
// open the real ~/.agetor-dev database.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-agents-sent-files-db-"));
const { spawnAgent, FAKE_CLAUDE_SENT_FILES_PROMPT_MARKER } = await import("./agents.ts");

/** Built-in claude-code harness — same shape as agents.test.ts's `builtin()`
 *  helper (kept local: this file owns no import of that test module). */
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
  "AGETOR_CLAUDE_DRIVER=fake + FAKE_CLAUDE_SENT_FILES_PROMPT_MARKER emits a delivered " +
    "two-file SendUserFile call and an errored whole-folder call, in claude-tmux's exact wire shape",
  async () => {
    process.env.AGETOR_CLAUDE_DRIVER = "fake";
    process.env.AGETOR_CLAUDE_BIN = "claude";
    const cwd = mkdtempSync(path.join(tmpdir(), "agetor-sent-files-cwd-"));

    const chunks: { stream: string; data: string; lineUuid?: string }[] = [];
    const handle = await spawnAgent({
      taskId: "task-sent-files-1",
      runId: "run-sent-files-1",
      harness: builtinClaude(),
      prompt: `deliver the files ${FAKE_CLAUDE_SENT_FILES_PROMPT_MARKER}`,
      cwd,
      onChunk: (stream, data, lineUuid) => { chunks.push({ stream, data, lineUuid }); },
      opts: { mode: "auto", model: "opus-4.7", effort: "high" },
    });

    const exitCode = await handle.done;
    expect(exitCode).toBe(0);

    const assistantTexts = chunks.filter((c) => c.stream === "assistant").map((c) => c.data);
    expect(assistantTexts).toEqual(["Sending you the files.", "Done."]);

    const toolUseChunks = chunks.filter((c) => c.stream === "tool_use").map((c) => JSON.parse(c.data));
    const toolResultChunks = chunks.filter((c) => c.stream === "tool_result").map((c) => JSON.parse(c.data));
    expect(toolUseChunks).toHaveLength(2);
    expect(toolResultChunks).toHaveLength(2);

    const sentDir = path.join(cwd, "agetor-sent");
    const pngPath = path.join(sentDir, "chart.png");
    const mdPath = path.join(sentDir, "report.md");

    const [deliveredUse, folderUse] = toolUseChunks;
    const [deliveredResult, folderResult] = toolResultChunks;

    // --- delivered two-file call -----------------------------------------
    expect(deliveredUse.id).toBe("toolu_fake_sent_1");
    expect(deliveredUse.serverSide).toBe(false);
    const deliveredReq = parseSentFilesToolUse(deliveredUse.name, deliveredUse.input);
    expect(deliveredReq).toEqual({
      files: [pngPath, mdPath],
      caption: "Fake delivery — a chart and its report",
      status: "normal",
      display: "render",
    });

    expect(deliveredResult.toolUseId).toBe("toolu_fake_sent_1");
    const deliveredParsed = parseSentFilesToolResult(
      deliveredResult.content,
      deliveredResult.isError,
      deliveredResult.attachments,
    );
    expect(deliveredParsed.delivered).toBe(true);
    expect(deliveredParsed.deliveredCount).toBe(2);
    expect(deliveredParsed.error).toBeNull();
    expect(deliveredParsed.attachments).toHaveLength(2);
    const [pngAttachment, mdAttachment] = deliveredParsed.attachments;
    if (!pngAttachment || !mdAttachment) throw new Error("expected exactly two sanitized attachments");
    expect(pngAttachment).toEqual({
      path: pngPath,
      size: statSync(pngPath).size,
      isImage: true,
      mediaType: "image/png",
    });
    expect(mdAttachment).toEqual({
      path: mdPath,
      size: statSync(mdPath).size,
      isImage: false,
      mediaType: null,
    });

    // --- errored whole-folder call -----------------------------------------
    expect(folderUse.id).toBe("toolu_fake_sent_2");
    expect(folderUse.serverSide).toBe(false);
    const folderReq = parseSentFilesToolUse(folderUse.name, folderUse.input);
    expect(folderReq).toEqual({
      files: [sentDir],
      caption: "Trying to send the whole folder",
      status: "normal",
      display: null,
    });

    expect(folderResult.toolUseId).toBe("toolu_fake_sent_2");
    expect(folderResult.isError).toBe(true);
    expect(folderResult.attachments).toBeUndefined();
    const folderParsed = parseSentFilesToolResult(
      folderResult.content,
      folderResult.isError,
      folderResult.attachments,
    );
    expect(folderParsed.delivered).toBe(false);
    expect(folderParsed.deliveredCount).toBeNull();
    expect(folderParsed.error).toBe(`Attachment "${sentDir}" is not a regular file.`);
    expect(folderParsed.attachments).toEqual([]);

    // --- both files really exist on disk with the reported sizes -----------
    expect(existsSync(pngPath)).toBe(true);
    expect(existsSync(mdPath)).toBe(true);
    if (typeof pngAttachment.size !== "number" || typeof mdAttachment.size !== "number") {
      throw new Error("expected known attachment sizes");
    }
    expect(statSync(pngPath).size).toBe(pngAttachment.size);
    expect(statSync(mdPath).size).toBe(mdAttachment.size);
    // The "folder" the second call points at is a real directory, not a file
    // — this is what makes the error card's tile stat-driven-folder-shaped.
    expect(statSync(sentDir).isDirectory()).toBe(true);
  },
);
