import { describe, expect, test } from "bun:test";
import {
  activeSection,
  backFromSubview,
  initialView,
  openEditor,
  openSection,
  openTemplates,
  resolveEscape,
  SETTINGS_SECTIONS,
  type SettingsSectionId,
  type SettingsView,
} from "./settings-dialog-view.ts";
import type { HarnessTemplate } from "../../shared/types.ts";

function template(overrides: Partial<HarnessTemplate> = {}): HarnessTemplate {
  return {
    id: "claude-code-additional",
    label: "Additional Claude Code",
    description: "Another claude-code harness with its own CLAUDE_CONFIG_DIR.",
    kind: "claude-code",
    suggestedHarnessId: "claude-2",
    home: "{dataDir}/harnesses/claude-2",
    bin: null,
    env: {},
    ...overrides,
  };
}

const SECTION_IDS: SettingsSectionId[] = ["general", "harnesses", "git"];

test("SETTINGS_SECTIONS lists the three sidebar sections in order", () => {
  expect(SETTINGS_SECTIONS).toEqual([
    { id: "general", label: "General" },
    { id: "harnesses", label: "Harnesses" },
    { id: "git", label: "Git Integration" },
  ]);
});

test("initialView opens on the General section", () => {
  expect(initialView()).toEqual({ kind: "section", section: "general" });
});

describe("openSection", () => {
  for (const id of SECTION_IDS) {
    test(`opens the ${id} section`, () => {
      expect(openSection(id)).toEqual({ kind: "section", section: id });
    });
  }
});

describe("openTemplates", () => {
  test("opens the templates picker view", () => {
    expect(openTemplates()).toEqual({ kind: "templates" });
  });
});

describe("openEditor", () => {
  test("opens the editor for a new harness (null id) with the template payload", () => {
    const tpl = template();
    expect(openEditor(null, tpl)).toEqual({ kind: "editor", harnessId: null, template: tpl });
  });

  test("opens the editor for an existing harness id with the template payload", () => {
    const tpl = template({ id: "codex-additional", kind: "codex", suggestedHarnessId: "codex-2" });
    expect(openEditor("codex-2", tpl)).toEqual({
      kind: "editor",
      harnessId: "codex-2",
      template: tpl,
    });
  });
});

test("backFromSubview returns the Harnesses section", () => {
  expect(backFromSubview()).toEqual({ kind: "section", section: "harnesses" });
});

describe("activeSection", () => {
  for (const id of SECTION_IDS) {
    test(`a ${id} section view highlights itself`, () => {
      expect(activeSection(openSection(id))).toBe(id);
    });
  }

  test("the templates view highlights Harnesses", () => {
    expect(activeSection(openTemplates())).toBe("harnesses");
  });

  test("the editor view highlights Harnesses", () => {
    expect(activeSection(openEditor(null, template()))).toBe("harnesses");
  });
});

describe("resolveEscape", () => {
  for (const id of SECTION_IDS) {
    test(`closes the modal from the ${id} section view`, () => {
      expect(resolveEscape(openSection(id))).toBe("close");
    });
  }

  test("pops to Harnesses from the templates view", () => {
    expect(resolveEscape(openTemplates())).toBe("pop");
  });

  test("pops to Harnesses from the editor view", () => {
    expect(resolveEscape(openEditor("claude-2", template()))).toBe("pop");
  });
});

describe("round-trip conventions", () => {
  test("openSection(activeSection(v)) is idempotent for a section view", () => {
    const view = openSection("git");
    expect(openSection(activeSection(view))).toEqual(view);
  });

  test("openSection(activeSection(v)) lands back on Harnesses from templates", () => {
    const view: SettingsView = openTemplates();
    expect(openSection(activeSection(view))).toEqual(backFromSubview());
  });

  test("openSection(activeSection(v)) lands back on Harnesses from the editor", () => {
    const view: SettingsView = openEditor(null, template());
    expect(openSection(activeSection(view))).toEqual(backFromSubview());
  });
});
