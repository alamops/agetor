import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { rmTestDataDir } from "./test-data-dir.ts";

// Pre-set AGETOR_DATA_DIR before claude-tmux.ts's transitive db.ts import —
// same convention as claude-continuation.test.ts.
const dataDir = mkdtempSync(path.join(tmpdir(), "agetor-compaction-"));
process.env.AGETOR_DATA_DIR = dataDir;

const { __forTest } = await import("./claude-tmux.ts");
import type { ChunkHandler } from "./claude-tmux.ts";

afterAll(() => {
  rmTestDataDir(dataDir);
});

// Mapper-level coverage of the three compaction line shapes claude writes
// (docs/plans/claude-code-placeholder.md P4/P5/P9). All fixtures are synthetic.

interface Recorded { stream: string; data: string; uuid?: string }
function recorder() {
  const out: Recorded[] = [];
  return {
    out,
    onChunk: ((stream, data, uuid) => out.push({ stream, data, uuid })) as ChunkHandler,
  };
}

/** Map one parsed JSONL event straight through the mapper. */
function mapEvent(evt: Record<string, unknown>): { out: Recorded[]; result: { endOfTurn: boolean; lineUuid?: string } } {
  const rec = recorder();
  const result = __forTest.mapParsedEventToChunks(evt as never, rec.onChunk);
  return { out: rec.out, result };
}

function boundary(compactMetadata: Record<string, unknown> | undefined, uuid = "uuid-boundary") {
  return { type: "system", subtype: "compact_boundary", uuid, ...(compactMetadata ? { compactMetadata } : {}) };
}

test("compact_boundary (auto) → one status line with humanised token counts", () => {
  const { out, result } = mapEvent(boundary({ trigger: "auto", preTokens: 450162, postTokens: 8613 }));
  expect(out).toEqual([
    { stream: "status", data: "context compacted · 450k → 8.6k tokens", uuid: "uuid-boundary" },
  ]);
  expect(result.endOfTurn).toBe(false);
});

test("compact_boundary (manual) inserts (manual) after 'compacted'", () => {
  const { out } = mapEvent(boundary({ trigger: "manual", preTokens: 450162, postTokens: 8613 }));
  expect(out.map((r) => r.data)).toEqual(["context compacted (manual) · 450k → 8.6k tokens"]);
});

test("compact_boundary with missing or non-numeric token counts → bare 'context compacted'", () => {
  expect(mapEvent(boundary({ trigger: "auto" })).out.map((r) => r.data)).toEqual(["context compacted"]);
  expect(mapEvent(boundary({ trigger: "auto", preTokens: 450162 })).out.map((r) => r.data)).toEqual(["context compacted"]);
  expect(mapEvent(boundary({ trigger: "auto", preTokens: "x", postTokens: null })).out.map((r) => r.data)).toEqual(["context compacted"]);
  // No compactMetadata object at all.
  expect(mapEvent(boundary(undefined)).out.map((r) => r.data)).toEqual(["context compacted"]);
});

test("informational 'Compacted while idle…' notice → its own verbatim (trimmed) status line", () => {
  const { out } = mapEvent({
    type: "system",
    subtype: "informational",
    level: "notice",
    uuid: "uuid-notice",
    content: "  Compacted while idle, before the prompt cache expired  ",
  });
  expect(out).toEqual([
    { stream: "status", data: "Compacted while idle, before the prompt cache expired", uuid: "uuid-notice" },
  ]);
});

test("a non-compaction informational notice emits nothing", () => {
  const { out } = mapEvent({
    type: "system",
    subtype: "informational",
    level: "notice",
    uuid: "uuid-update",
    content: "A synthetic update is available, run the updater",
  });
  expect(out).toEqual([]);
  // `compacted` must be a leading word, not a substring.
  expect(
    mapEvent({ type: "system", subtype: "informational", uuid: "u2", content: "Nothing was compacted here" }).out,
  ).toEqual([]);
});

test("summary user line (string content with CRLF/CR) → one compaction_summary chunk, CR-normalised, carrying the line uuid, and no user chunk", () => {
  const { out, result } = mapEvent({
    type: "user",
    uuid: "uuid-summary",
    isCompactSummary: true,
    isVisibleInTranscriptOnly: true,
    message: { role: "user", content: "Synthetic summary\r\n\r\n- bullet one\r- bullet two\n- bullet three" },
  });
  expect(out).toEqual([
    {
      stream: "compaction_summary",
      data: "Synthetic summary\n\n- bullet one\n- bullet two\n- bullet three",
      uuid: "uuid-summary",
    },
  ]);
  expect(out.some((r) => r.stream === "user")).toBe(false);
  expect(result).toEqual({ endOfTurn: false, lineUuid: "uuid-summary" });
});

test("summary user line with array content of two text blocks → ONE chunk joined by a blank line", () => {
  const { out } = mapEvent({
    type: "user",
    uuid: "uuid-summary-arr",
    isCompactSummary: true,
    message: {
      role: "user",
      content: [
        { type: "text", text: "First synthetic block" },
        { type: "text", text: "Second synthetic block" },
      ],
    },
  });
  expect(out).toEqual([
    { stream: "compaction_summary", data: "First synthetic block\n\nSecond synthetic block", uuid: "uuid-summary-arr" },
  ]);
});

test("a summary line with no text at all emits nothing", () => {
  const { out } = mapEvent({
    type: "user",
    uuid: "uuid-summary-empty",
    isCompactSummary: true,
    message: { role: "user", content: "" },
  });
  expect(out).toEqual([]);
});

test("a user line with only isVisibleInTranscriptOnly keeps today's rendering: a user chunk", () => {
  const { out } = mapEvent({
    type: "user",
    uuid: "uuid-vis",
    isVisibleInTranscriptOnly: true,
    message: { role: "user", content: "transcript-only synthetic note" },
  });
  expect(out).toEqual([{ stream: "user", data: "transcript-only synthetic note", uuid: "uuid-vis" }]);
});

test("isContinuationContentEvent excludes either flag on a user line but still accepts a plain one", () => {
  const msg = { role: "user", content: "hello" };
  expect(__forTest.isContinuationContentEvent({ type: "user", message: msg } as never)).toBe(true);
  expect(__forTest.isContinuationContentEvent({ type: "user", isCompactSummary: true, message: msg } as never)).toBe(false);
  expect(__forTest.isContinuationContentEvent({ type: "user", isVisibleInTranscriptOnly: true, message: msg } as never)).toBe(false);
  expect(__forTest.isContinuationContentEvent({ type: "system", subtype: "compact_boundary" } as never)).toBe(false);
});

test("dispatchLine replaying the same summary uuid emits exactly once (seenLineUuids dedup) and opens no turn", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-compaction-sess-"));
  const jsonlPath = path.join(dir, `${randomUUID()}.jsonl`);
  writeFileSync(jsonlPath, "");
  const taskId = randomUUID();
  const state = __forTest.installSession(taskId, jsonlPath);
  try {
    const rec = recorder();
    // An in-flight turn slot receives the chunks (mid-turn auto-compaction
    // lands on the active run); a status/summary line must not resolve it.
    const done = __forTest.pushTurnSlot(state, rec.onChunk);
    let settled = false;
    void done.then(() => { settled = true; });

    const summaryLine = JSON.stringify({
      type: "user",
      uuid: "uuid-replayed-summary",
      isCompactSummary: true,
      isVisibleInTranscriptOnly: true,
      message: { role: "user", content: "Synthetic summary body" },
    });
    const boundaryLine = JSON.stringify({
      type: "system",
      subtype: "compact_boundary",
      uuid: "uuid-replayed-boundary",
      compactMetadata: { trigger: "auto", preTokens: 450162, postTokens: 8613 },
    });

    __forTest.dispatchLine(state, boundaryLine);
    __forTest.dispatchLine(state, summaryLine);
    __forTest.dispatchLine(state, boundaryLine);
    __forTest.dispatchLine(state, summaryLine);

    expect(rec.out).toEqual([
      { stream: "status", data: "context compacted · 450k → 8.6k tokens", uuid: "uuid-replayed-boundary" },
      { stream: "compaction_summary", data: "Synthetic summary body", uuid: "uuid-replayed-summary" },
    ]);
    // Still the same single in-flight turn; nothing resolved it.
    expect(state.turnQueue.length).toBe(1);
    expect(settled).toBe(false);
  } finally {
    __forTest.uninstallSession(taskId);
  }
});
