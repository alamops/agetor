// StackEditor's save can land after the user left it (review N6): only the
// editor that saved may pop back, never the subpage now on screen.
import { describe, expect, test } from "bun:test";
import { viewAfterSave } from "./SettingsDialog.tsx";
import { openSection, openStackEditor, openStackHistory } from "@/lib/settings-dialog-view";

describe("viewAfterSave", () => {
  test("pops the saving editor back to its section while it is still showing", () => {
    const editor = openStackEditor("s1");
    expect(viewAfterSave(editor, editor)).toEqual(openSection("harnesses"));
  });

  test("leaves another subpage alone: the History page, another stack's editor, a reopened editor", () => {
    const editor = openStackEditor("s1");
    const history = openStackHistory("s1");
    expect(viewAfterSave(history, editor)).toBe(history);
    const other = openStackEditor("s2");
    expect(viewAfterSave(other, editor)).toBe(other);
    // Same stack, but a new navigation: not the editor that saved.
    const reopened = openStackEditor("s1");
    expect(viewAfterSave(reopened, editor)).toBe(reopened);
    const fresh = openStackEditor(null);
    expect(viewAfterSave(fresh, openStackEditor(null))).toBe(fresh);
  });
});
