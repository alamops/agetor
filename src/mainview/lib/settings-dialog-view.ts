import type { HarnessTemplate } from "../../shared/types.ts";

/** The left-sidebar sections in the Settings dialog. */
export const SETTINGS_SECTIONS = [
  { id: "general", label: "General" },
  { id: "harnesses", label: "Harnesses" },
  { id: "agents", label: "Agents" },
  { id: "pipelines", label: "Pipelines" },
  { id: "git", label: "Git Integration" },
  { id: "prompts", label: "Saved Prompts" },
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

/**
 * Discriminated-union view state for the Settings dialog's content pane,
 * mirroring `GitHubDialogView` in `github-dialog-view.ts` — "section" is one
 * of the sidebar sections (General/Harnesses/Agents/Git Integration/Saved
 * Prompts — see `SETTINGS_SECTIONS`), "templates" is the Add-harness
 * template picker, "editor" is the harness create/edit form, and
 * "agent-editor" is the agent-profile create/edit form (`profileId` is null
 * when creating). The sidebar itself stays visible across all four kinds
 * (see `activeSection`), unlike the GitHub modal's full-panel subpage
 * replacement.
 */
export type SettingsView =
  | { kind: "section"; section: SettingsSectionId }
  | { kind: "templates" }
  | { kind: "editor"; harnessId: string | null; template: HarnessTemplate }
  | { kind: "agent-editor"; profileId: string | null };

/** The view shown every time the dialog opens — always General, no persistence. */
export function initialView(): SettingsView {
  return { kind: "section", section: "general" };
}

/** Navigate to a sidebar section. */
export function openSection(section: SettingsSectionId): SettingsView {
  return { kind: "section", section };
}

/** Navigate to the Add-harness template picker. */
export function openTemplates(): SettingsView {
  return { kind: "templates" };
}

/** Navigate to the harness editor — `harnessId` is null when creating. */
export function openEditor(harnessId: string | null, template: HarnessTemplate): SettingsView {
  return { kind: "editor", harnessId, template };
}

/** Navigate to the agent-profile editor — `profileId` is null when creating. */
export function openAgentEditor(profileId: string | null): SettingsView {
  return { kind: "agent-editor", profileId };
}

/**
 * Navigate back from a subview. The harness flows (templates, editor) are
 * reached from the Harnesses section and the agent editor from Agents, so
 * back lands on whichever section the subview belongs to. A section view has
 * nothing to pop and returns itself.
 */
export function backFromSubview(view: SettingsView): SettingsView {
  switch (view.kind) {
    case "section":
      return view;
    case "templates":
    case "editor":
      return { kind: "section", section: "harnesses" };
    case "agent-editor":
      return { kind: "section", section: "agents" };
    default: {
      const _exhaustive: never = view;
      return _exhaustive;
    }
  }
}

/**
 * Which sidebar item should render as active for the current view. The
 * subviews have no sidebar entry of their own, so they highlight the section
 * they are reached from: templates/editor → Harnesses, agent-editor → Agents.
 */
export function activeSection(view: SettingsView): SettingsSectionId {
  switch (view.kind) {
    case "section":
      return view.section;
    case "templates":
    case "editor":
      return "harnesses";
    case "agent-editor":
      return "agents";
    default: {
      const _exhaustive: never = view;
      return _exhaustive;
    }
  }
}

/**
 * Resolve what Escape (or a backdrop click) should do given the current
 * view: pop the subpage back to its section (see `backFromSubview`), or
 * close the modal outright. Only a section view closes the modal — every
 * subpage pops first.
 */
export function resolveEscape(view: SettingsView): "pop" | "close" {
  switch (view.kind) {
    case "section":
      return "close";
    case "templates":
    case "editor":
    case "agent-editor":
      return "pop";
    default: {
      const _exhaustive: never = view;
      return _exhaustive;
    }
  }
}

/**
 * Whether the view is a form subpage that holds a draft — the harness editor
 * and the agent editor. Leaving one with unsaved edits needs a discard
 * confirm; the templates picker holds no draft, and a section view is not a
 * subpage at all.
 */
export function isFormSubpage(view: SettingsView): boolean {
  switch (view.kind) {
    case "editor":
    case "agent-editor":
      return true;
    case "section":
    case "templates":
      return false;
    default: {
      const _exhaustive: never = view;
      return _exhaustive;
    }
  }
}
