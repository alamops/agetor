import { describe, expect, test } from "bun:test";
import {
  activeSection,
  backFromSubview,
  initialView,
  isFormSubpage,
  openAgentEditor,
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

const SECTION_IDS: SettingsSectionId[] = ["general", "harnesses", "agents", "pipelines", "git", "prompts"];

test("SETTINGS_SECTIONS lists the six sidebar sections in order", () => {
  expect(SETTINGS_SECTIONS).toEqual([
    { id: "general", label: "General" },
    { id: "harnesses", label: "Harnesses" },
    { id: "agents", label: "Agents" },
    { id: "pipelines", label: "Pipelines" },
    { id: "git", label: "Git Integration" },
    { id: "prompts", label: "Saved Prompts" },
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

describe("openAgentEditor", () => {
  test("opens the editor for a new agent (null id)", () => {
    expect(openAgentEditor(null)).toEqual({ kind: "agent-editor", profileId: null });
  });

  test("opens the editor for an existing agent id", () => {
    expect(openAgentEditor("prof-1")).toEqual({ kind: "agent-editor", profileId: "prof-1" });
  });
});

describe("backFromSubview", () => {
  test("the templates view returns the Harnesses section", () => {
    expect(backFromSubview(openTemplates())).toEqual({ kind: "section", section: "harnesses" });
  });

  test("the harness editor view returns the Harnesses section", () => {
    expect(backFromSubview(openEditor(null, template()))).toEqual({ kind: "section", section: "harnesses" });
  });

  test("the agent editor view returns the Agents section (create and edit)", () => {
    expect(backFromSubview(openAgentEditor(null))).toEqual({ kind: "section", section: "agents" });
    expect(backFromSubview(openAgentEditor("prof-1"))).toEqual({ kind: "section", section: "agents" });
  });

  for (const id of SECTION_IDS) {
    test(`a ${id} section view returns itself`, () => {
      expect(backFromSubview(openSection(id))).toEqual({ kind: "section", section: id });
    });
  }
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

  test("the agent editor view highlights Agents", () => {
    expect(activeSection(openAgentEditor(null))).toBe("agents");
    expect(activeSection(openAgentEditor("prof-1"))).toBe("agents");
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

  test("pops to Agents from the agent editor view", () => {
    expect(resolveEscape(openAgentEditor(null))).toBe("pop");
    expect(resolveEscape(openAgentEditor("prof-1"))).toBe("pop");
  });
});

describe("isFormSubpage", () => {
  test("the harness editor and agent editor hold a draft", () => {
    expect(isFormSubpage(openEditor(null, template()))).toBe(true);
    expect(isFormSubpage(openAgentEditor(null))).toBe(true);
    expect(isFormSubpage(openAgentEditor("prof-1"))).toBe(true);
  });

  test("the templates picker holds no draft", () => {
    expect(isFormSubpage(openTemplates())).toBe(false);
  });

  for (const id of SECTION_IDS) {
    test(`a ${id} section view is not a form subpage`, () => {
      expect(isFormSubpage(openSection(id))).toBe(false);
    });
  }
});

describe("round-trip conventions", () => {
  test("openSection(activeSection(v)) is idempotent for a section view", () => {
    const view = openSection("git");
    expect(openSection(activeSection(view))).toEqual(view);
  });

  test("openSection(activeSection(v)) lands back on Harnesses from templates", () => {
    const view: SettingsView = openTemplates();
    expect(openSection(activeSection(view))).toEqual(backFromSubview(view));
  });

  test("openSection(activeSection(v)) lands back on Harnesses from the editor", () => {
    const view: SettingsView = openEditor(null, template());
    expect(openSection(activeSection(view))).toEqual(backFromSubview(view));
  });

  test("openSection(activeSection(v)) lands back on Agents from the agent editor", () => {
    const view: SettingsView = openAgentEditor("prof-1");
    expect(openSection(activeSection(view))).toEqual(backFromSubview(view));
  });
});
