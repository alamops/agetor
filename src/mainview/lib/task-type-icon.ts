import { Bug, FlaskConical, Inbox } from "lucide-react";
import type { TaskTypeMeta } from "../../shared/types.ts";

// Resolve a TaskTypeMeta.icon string to its lucide component. The mapping can't
// live in shared/types.ts (it must stay free of runtime/React imports), so this
// is the single webview-side source of truth — keyed on the icon union so it
// stays exhaustive at compile time.
const ICONS = {
  Inbox,
  Bug,
  FlaskConical,
} as const satisfies Record<TaskTypeMeta["icon"], unknown>;

export const taskTypeIcon = (icon: TaskTypeMeta["icon"]) => ICONS[icon];
