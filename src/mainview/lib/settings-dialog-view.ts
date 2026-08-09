import type { HarnessTemplate } from "../../shared/types.ts";

/** The three left-sidebar sections in the Settings dialog. */
export const SETTINGS_SECTIONS = [
  { id: "general", label: "General" },
  { id: "harnesses", label: "Harnesses" },
  { id: "git", label: "Git Integration" },
  { id: "prompts", label: "Saved Prompts" },
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

/**
 * Discriminated-union view state for the Settings dialog's content pane,
 * mirroring `GitHubDialogView` in `github-dialog-view.ts` — "section" is one
 * of the three sidebar sections (General/Harnesses/Git Integration),
 * "templates" is the Add-harness template picker, and "editor" is the
 * harness create/edit form. The sidebar itself stays visible across all
 * three kinds (see `activeSection`), unlike the GitHub modal's full-panel
 * subpage replacement.
 */
export type SettingsView =
  | { kind: "section"; section: SettingsSectionId }
  | { kind: "templates" }
  | { kind: "editor"; harnessId: string | null; template: HarnessTemplate };

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

/**
 * Navigate back from a subview (templates or editor). Both flows are reached
 * from the Harnesses section, so back always lands there.
 */
export function backFromSubview(): SettingsView {
  return { kind: "section", section: "harnesses" };
}

/**
 * Which sidebar item should render as active for the current view. The
 * templates/editor subviews are reached from Harnesses and have no sidebar
 * entry of their own, so they highlight Harnesses.
 */
export function activeSection(view: SettingsView): SettingsSectionId {
  switch (view.kind) {
    case "section":
      return view.section;
    case "templates":
    case "editor":
      return "harnesses";
    default: {
      const _exhaustive: never = view;
      return _exhaustive;
    }
  }
}

/**
 * Resolve what Escape (or a backdrop click) should do given the current
 * view: pop the subpage back to Harnesses, or close the modal outright. Only
 * a section view closes the modal — templates/editor pop first.
 */
export function resolveEscape(view: SettingsView): "pop" | "close" {
  switch (view.kind) {
    case "section":
      return "close";
    case "templates":
    case "editor":
      return "pop";
    default: {
      const _exhaustive: never = view;
      return _exhaustive;
    }
  }
}
