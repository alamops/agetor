import { describe, expect, test } from "bun:test";
import { harnessEditorDirty, type HarnessEditorDraft } from "./harness-editor-dirty.ts";

function draft(overrides: Partial<HarnessEditorDraft> = {}): HarnessEditorDraft {
  return {
    id: "claude-2",
    label: "Additional Claude Code",
    kind: "claude-code",
    home: "~/.agetor/harnesses/claude-2",
    bin: "",
    envText: "FOO=bar",
    ...overrides,
  };
}

describe("harnessEditorDirty", () => {
  test("identical drafts are clean", () => {
    expect(harnessEditorDirty(draft(), draft())).toBe(false);
  });

  const fields: [keyof HarnessEditorDraft, string][] = [
    ["id", "claude-3"],
    ["label", "Claude (work)"],
    ["kind", "codex"],
    ["home", "~/.agetor/harnesses/other"],
    ["bin", "/usr/local/bin/claude"],
    ["envText", "FOO=baz"],
  ];
  for (const [field, value] of fields) {
    test(`a changed ${field} is dirty`, () => {
      expect(harnessEditorDirty(draft({ [field]: value }), draft())).toBe(true);
    });
  }

  test("clearing a field back to its initial value is clean again", () => {
    const edited = draft({ label: "x" });
    expect(harnessEditorDirty(edited, draft())).toBe(true);
    expect(harnessEditorDirty(draft({ label: "Additional Claude Code" }), draft())).toBe(false);
  });
});
