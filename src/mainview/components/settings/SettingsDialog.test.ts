// StackEditor's save can land after the user left it (review N6): only the
// editor that saved may pop back, never the subpage now on screen.
import { describe, expect, test } from "bun:test";
import { entryView, stackSavedHandler, viewAfterSave } from "./SettingsDialog.tsx";
import type { SettingsView } from "@/lib/settings-dialog-view";
import { initialView, openAgentEditor, openSection, openStackEditor, openStackHistory } from "@/lib/settings-dialog-view";

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

describe("stackSavedHandler (the StackEditor onSaved wiring)", () => {
  // A stand-in for React's state: `setView` applies the updater to whatever
  // view is current when the save lands, as React does.
  function viewState(initial: SettingsView) {
    let current = initial;
    return {
      get: () => current,
      set: (next: SettingsView) => {
        current = next;
      },
      setView: (update: (current: SettingsView) => SettingsView) => {
        current = update(current);
      },
    };
  }

  test("a save that lands while its editor is still showing pops back to the section", () => {
    const editor = openStackEditor("s1");
    const state = viewState(editor);
    const onSaved = stackSavedHandler(editor, state.setView);
    onSaved();
    expect(state.get()).toEqual(openSection("harnesses"));
  });

  test("a save that lands after the user moved on leaves the page now on screen alone", () => {
    const editor = openStackEditor("s1");
    const state = viewState(editor);
    // Built at render time, while the editor was showing.
    const onSaved = stackSavedHandler(editor, state.setView);
    const history = openStackHistory("s1");
    state.set(history);
    onSaved();
    expect(state.get()).toBe(history);
    const reopened = openStackEditor("s1");
    state.set(reopened);
    onSaved();
    expect(state.get()).toBe(reopened);
  });
});

describe("entryView (what the modal opens on)", () => {
  test("an agent profile beats a stack history, which beats a section, which beats General", () => {
    expect(entryView("harnesses", "p1", "s1")).toEqual(openAgentEditor("p1"));
    expect(entryView("harnesses", null, "s1")).toEqual(openStackHistory("s1"));
    expect(entryView("harnesses", null, null)).toEqual(openSection("harnesses"));
    expect(entryView(undefined, null, null)).toEqual(initialView());
  });

  test("the stack-history argument is optional (every older call site)", () => {
    expect(entryView("harnesses", undefined)).toEqual(openSection("harnesses"));
    expect(entryView(undefined, undefined)).toEqual(initialView());
  });

  test("reopening with a different stack id lands on that stack's history", () => {
    expect(entryView(undefined, null, "s2")).toEqual(openStackHistory("s2"));
    expect(entryView(undefined, null, "s2")).not.toEqual(entryView(undefined, null, "s1"));
  });
});
