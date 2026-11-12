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

/**
 * `"stacks"` is no longer a sidebar entry: stacks live on the Harnesses page
 * (owner decision D19). The id stays accepted as a deep link and
 * `openSection` maps it to Harnesses.
 */
export type SidebarSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];
export type SettingsSectionId = SidebarSectionId | "stacks";

/** The sidebar section a (possibly legacy) section id lands on. */
export function resolveSectionId(section: SettingsSectionId): SidebarSectionId {
  return section === "stacks" ? "harnesses" : section;
}

/**
 * Discriminated-union view state for the Settings dialog's content pane,
 * mirroring `GitHubDialogView` in `github-dialog-view.ts` — "section" is one
 * of the sidebar sections (General/Harnesses/Agents/Git Integration/Saved
 * Prompts — see `SETTINGS_SECTIONS`; stacks are cards on Harnesses), "templates" is the Add-harness
 * template picker, "editor" is the harness create/edit form, and
 * "agent-editor" is the agent-profile create/edit form (`profileId` is null
 * when creating; a null `profileId` with a `duplicateFromId` means "create
 * prefilled from that agent", while a set `profileId` is always an edit
 * with a null `duplicateFromId`). The sidebar itself stays visible across all four kinds
 * (see `activeSection`), unlike the GitHub modal's full-panel subpage
 * replacement.
 */
export type SettingsView =
  | { kind: "section"; section: SidebarSectionId }
  | { kind: "templates" }
  | { kind: "editor"; harnessId: string | null; template: HarnessTemplate }
  | { kind: "agent-editor"; profileId: string | null; duplicateFromId: string | null }
  | { kind: "stack-editor"; stackId: string | null }
  | { kind: "stack-history"; stackId: string };

/** The view shown every time the dialog opens — always General, no persistence. */
export function initialView(): SettingsView {
  return { kind: "section", section: "general" };
}

/** Navigate to a sidebar section. */
export function openSection(section: SettingsSectionId): SettingsView {
  return { kind: "section", section: resolveSectionId(section) };
}

/** Navigate to the Add-harness template picker. */
export function openTemplates(): SettingsView {
  return { kind: "templates" };
}

/** Navigate to the harness editor — `harnessId` is null when creating. */
export function openEditor(harnessId: string | null, template: HarnessTemplate): SettingsView {
  return { kind: "editor", harnessId, template };
}

/** Navigate to the stack editor — `stackId` is null when creating. */
export function openStackEditor(stackId: string | null): SettingsView {
  return { kind: "stack-editor", stackId };
}

/** Navigate to one stack's swap history. */
export function openStackHistory(stackId: string): SettingsView {
  return { kind: "stack-history", stackId };
}

/**
 * Navigate to the agent-profile editor — `profileId` is null when creating.
 * A null `profileId` with a `duplicateFromId` means "create prefilled from
 * that agent"; a set `profileId` is always an edit, so `duplicateFromId` is
 * forced to null in that case.
 */
export function openAgentEditor(
  profileId: string | null,
  duplicateFromId: string | null = null,
): SettingsView {
  return {
    kind: "agent-editor",
    profileId,
    duplicateFromId: profileId === null ? duplicateFromId : null,
  };
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
    case "stack-editor":
    case "stack-history":
      return { kind: "section", section: "harnesses" };
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
export function activeSection(view: SettingsView): SidebarSectionId {
  switch (view.kind) {
    case "section":
      return view.section;
    case "templates":
    case "editor":
      return "harnesses";
    case "agent-editor":
      return "agents";
    case "stack-editor":
    case "stack-history":
      return "harnesses";
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
    case "stack-editor":
    case "stack-history":
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
    case "stack-editor":
      return true;
    case "section":
    case "templates":
    case "stack-history":
      return false;
    default: {
      const _exhaustive: never = view;
      return _exhaustive;
    }
  }
}
