import type { GitHubListItem } from "../../shared/types.ts";

/**
 * The 7 repo-scoped manager panels toggled from the modal's header toolbar.
 * Formerly 7 independent booleans in `GitHubDialog.tsx` with ~120 lines of
 * repeated "close the other six" logic on every toggle; folded into the
 * `GitHubDialogView` union below so opening one is a single `setView` call.
 */
export type GitHubPanelKind =
  | "labels"
  | "milestones"
  | "releases"
  | "notifications"
  | "actions"
  | "projects"
  | "discussions";

/**
 * Discriminated-union view state for the GitHub modal's body, mirroring the
 * `View` pattern in `SettingsDialog.tsx` — "list" is the default kanban-style
 * PR/issue browser, "detail" is the full-panel subpage for a single item
 * (replaces the old inline accordion expansion), "panel" is one of the 7
 * manager panels (labels, milestones, releases, notifications, actions,
 * projects, discussions).
 */
export type GitHubDialogView =
  | { kind: "list" }
  | { kind: "detail"; item: GitHubListItem }
  | { kind: "panel"; panel: GitHubPanelKind };

/** Navigate to the detail subpage for `item`. */
export function openDetail(item: GitHubListItem): GitHubDialogView {
  return { kind: "detail", item };
}

/** Navigate to a manager panel. */
export function openPanel(panel: GitHubPanelKind): GitHubDialogView {
  return { kind: "panel", panel };
}

/** Navigate back to the list view. */
export function backToList(): GitHubDialogView {
  return { kind: "list" };
}

/**
 * Toggle a manager panel from a toolbar icon click: re-clicking the panel
 * that's already open closes it back to the list (preserving the old
 * booleans' toggle-off behavior); clicking a different panel switches to it
 * directly, with no need to separately close the other six.
 */
export function togglePanel(view: GitHubDialogView, panel: GitHubPanelKind): GitHubDialogView {
  return view.kind === "panel" && view.panel === panel ? backToList() : openPanel(panel);
}

/**
 * Resolve what Escape (or a backdrop click) should do given the current view:
 * pop the subpage back to the list, or close the modal outright. Only the
 * list view closes the modal — any other view (detail or panel) pops to the
 * list first.
 */
export function resolveEscape(view: GitHubDialogView): "pop" | "close" {
  return view.kind === "list" ? "close" : "pop";
}
