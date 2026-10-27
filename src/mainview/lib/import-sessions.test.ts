import { describe, expect, test } from "bun:test";
import type { OpencodeSessionListItem } from "../../shared/types.ts";
import {
  autoEnabledToastText,
  claudeRowKey,
  groupOpencodeImports,
  joinLabels,
  mergeByActivity,
  OPENCODE_BUSY_COPY,
  OPENCODE_BUSY_UNKNOWN_COPY,
  opencodeBlockedCopy,
  opencodeRowKey,
  opencodeSessionsFoundText,
  opencodeWarningCopy,
} from "./import-sessions.ts";

function row(over: Partial<OpencodeSessionListItem> = {}): OpencodeSessionListItem {
  return {
    sessionId: "ses_aaa",
    harnessId: "opencode",
    harnessLabel: "OpenCode",
    directory: "/work/repo",
    title: "fix the login",
    updatedAt: 1_000,
    createdAt: 500,
    importable: true,
    blockedReason: null,
    ...over,
  };
}

describe("opencodeBlockedCopy / opencodeWarningCopy", () => {
  test("an importable row has no block", () => {
    expect(opencodeBlockedCopy(row())).toBeNull();
    expect(opencodeWarningCopy(row())).toBeNull();
  });

  test("missing folder and busy rows name their reason", () => {
    expect(opencodeBlockedCopy(row({ importable: false, blockedReason: "missing-folder" })))
      .toBe("Session folder no longer exists");
    expect(opencodeBlockedCopy(row({ importable: false, blockedReason: "busy" }))).toBe(OPENCODE_BUSY_COPY);
  });

  test("busyUnknown warns on an importable row only", () => {
    expect(opencodeWarningCopy(row({ busyUnknown: true }))).toBe(OPENCODE_BUSY_UNKNOWN_COPY);
    expect(opencodeWarningCopy(row({ busyUnknown: true, importable: false, blockedReason: "missing-folder" })))
      .toBeNull();
  });
});

describe("row keys", () => {
  test("the harness is part of an OpenCode key", () => {
    expect(opencodeRowKey(row())).not.toBe(opencodeRowKey(row({ harnessId: "opencode-2" })));
    expect(opencodeRowKey(row())).not.toBe(claudeRowKey("ses_aaa"));
  });
});

describe("groupOpencodeImports", () => {
  test("groups by harness in insertion order and drops repeats", () => {
    const groups = groupOpencodeImports([
      row({ sessionId: "ses_1" }),
      row({ sessionId: "ses_2", harnessId: "opencode-2" }),
      row({ sessionId: "ses_3" }),
      row({ sessionId: "ses_1" }),
    ]);
    expect([...groups.entries()]).toEqual([
      ["opencode", ["ses_1", "ses_3"]],
      ["opencode-2", ["ses_2"]],
    ]);
  });
});

describe("mergeByActivity", () => {
  test("interleaves newest first and keeps each list's own order", () => {
    const a = [{ id: "a1", t: 50 }, { id: "a2", t: 10 }, { id: "a3", t: 40 }];
    const b = [{ id: "b1", t: 30 }, { id: "b2", t: 5 }];
    const merged = mergeByActivity(a, (r) => r.t, b, (r) => r.t).map((r) => r.id);
    expect(merged).toEqual(["a1", "b1", "a2", "a3", "b2"]);
  });

  test("ties keep the first list first; a NaN time sorts last", () => {
    const merged = mergeByActivity([{ id: "a", t: Number.NaN }], (r) => r.t, [{ id: "b", t: 1 }], (r) => r.t);
    expect(merged.map((r) => r.id)).toEqual(["b", "a"]);
    const tie = mergeByActivity([{ id: "a", t: 1 }], (r) => r.t, [{ id: "b", t: 1 }], (r) => r.t);
    expect(tie.map((r) => r.id)).toEqual(["a", "b"]);
  });
});

describe("toast copy", () => {
  test("joinLabels", () => {
    expect(joinLabels([])).toBe("");
    expect(joinLabels(["Codex"])).toBe("Codex");
    expect(joinLabels(["Codex", "Cursor"])).toBe("Codex and Cursor");
    expect(joinLabels(["Codex", "Cursor", "OpenCode"])).toBe("Codex, Cursor and OpenCode");
  });

  test("auto-enabled copy agrees in number", () => {
    expect(autoEnabledToastText(["codex"], ["Codex"]))
      .toBe("Turned on Codex because it's installed — turn it off in Settings");
    expect(autoEnabledToastText(["codex", "opencode"], ["Codex", "OpenCode"]))
      .toBe("Turned on Codex and OpenCode because they're installed — turn them off in Settings");
  });

  test("auto-enabled copy falls back to the id and is null when empty", () => {
    expect(autoEnabledToastText(["codex"], [])).toBe("Turned on codex because it's installed — turn it off in Settings");
    expect(autoEnabledToastText([], [])).toBeNull();
  });

  test("sessions-found copy", () => {
    expect(opencodeSessionsFoundText(1)).toBe("1 OpenCode session found outside Agetor — Review");
    expect(opencodeSessionsFoundText(3)).toBe("3 OpenCode sessions found outside Agetor — Review");
  });
});
