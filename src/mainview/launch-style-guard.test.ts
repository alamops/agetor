// Static style guard for the task-launch surfaces (docs/architecture/task-launch-ui.md):
// the one-pattern rules that a visual review would otherwise have to catch by eye.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dir, "components");
const rel = (f: string) => path.join(ROOT, f);
const read = (f: string) => readFileSync(rel(f), "utf8");

/** The files that make up the launch surfaces (panel, Git dialogs, Select projects, Branch naming,
 *  Clone's Explain block, Settings → Agents form) and the primitives they are built from. */
const IN_SCOPE = [
  "kanban/NewTaskForm.tsx",
  "kanban/TaskLaunchPickers.tsx",
  "kanban/HarnessPicker.tsx",
  "kanban/ModeControl.tsx",
  "kanban/LaunchSection.tsx",
  "kanban/LaunchFooter.tsx",
  "kanban/WorkspaceSection.tsx",
  "kanban/WorktreeOptions.tsx",
  "kanban/ProjectSelection.tsx",
  "kanban/SelectProjectsDialog.tsx",
  "kanban/CreateTaskFromIssueDialog.tsx",
  "kanban/ResolveConflictsDialog.tsx",
  "kanban/CloneProjectDialog.tsx",
  "kanban/AgentProfileFormDialog.tsx",
  "kanban/AgentProfilePicker.tsx",
  "kanban/SpeedPicker.tsx",
  "kanban/TaskTypePicker.tsx",
  "kanban/HarnessAuthHint.tsx",
  "kanban/ExtensionPicker.tsx",
  "settings/BranchNamingDialog.tsx",
  "pipelines/PipelinePicker.tsx",
  "ui/picker.tsx",
  "ui/field.tsx",
  "ui/segmented-control.tsx",
  "ui/disclosure.tsx",
  "ui/notice.tsx",
  "ui/kbd.tsx",
  "ui/resize-handle.tsx",
];

describe("launch style guard", () => {
  test("every in-scope file exists", () => {
    for (const f of IN_SCOPE) expect(() => read(f)).not.toThrow();
  });

  test("no native <select> and no ui/select import, except Clone's provider", () => {
    for (const f of IN_SCOPE) {
      if (f === "kanban/CloneProjectDialog.tsx") continue;
      const src = read(f);
      expect({ f, hit: /<select\b/.test(src) }).toEqual({ f, hit: false });
      expect({ f, hit: /from "@\/components\/ui\/select"/.test(src) }).toEqual({ f, hit: false });
    }
  });

  test("no native checkbox, except the Select projects rows and the agent-copy option", () => {
    const allowed = new Set(["kanban/SelectProjectsDialog.tsx", "kanban/AgentProfileFormDialog.tsx"]);
    for (const f of IN_SCOPE) {
      if (allowed.has(f)) continue;
      expect({ f, hit: /type="checkbox"/.test(read(f)) }).toEqual({ f, hit: false });
    }
  });

  test("rem-based text tokens, not text-[10px] / text-[11px]", () => {
    for (const f of IN_SCOPE) {
      expect({ f, hit: /text-\[1[01]px\]/.test(read(f)) }).toEqual({ f, hit: false });
    }
  });

  test("the old selected-state pattern (filled primary vs outline) is gone", () => {
    for (const f of IN_SCOPE) {
      expect({ f, hit: /variant=\{[^}]*\?\s*"default"\s*:\s*"outline"\s*\}/.test(read(f)) }).toEqual({ f, hit: false });
    }
  });

  test("NewTaskForm keeps no local copy of the launch state", () => {
    const src = read("kanban/NewTaskForm.tsx");
    for (const name of ["agentCache", "pendingSeed", "modelTouched", "prefsLoaded", "setRefreshingModels"]) {
      expect({ name, hit: src.includes(name) }).toEqual({ name, hit: false });
    }
    expect(src).toContain("useTaskLaunch(");
  });

  test("nothing a Git launch dialog renders uses an InfoTip: its portaled panel carries the popover marker outside the dialog", () => {
    // The closure of component imports from the two dialogs, so a component added later is covered
    // without anyone remembering to list it. `PromptComposer` is read with readFileSync because a
    // literal zero-width space makes `grep` treat it as binary.
    const seen = new Set<string>();
    const queue = ["kanban/CreateTaskFromIssueDialog.tsx", "kanban/ResolveConflictsDialog.tsx"];
    const importRe = /from\s+["']((?:@\/components|\.{1,2})\/[^"']+)["']/g;
    while (queue.length > 0) {
      const f = queue.pop() as string;
      if (seen.has(f)) continue;
      seen.add(f);
      for (const m of read(f).matchAll(importRe)) {
        const spec = m[1] as string;
        const target = spec.startsWith("@/components/")
          ? spec.slice("@/components/".length)
          : path.relative(ROOT, path.resolve(path.dirname(rel(f)), spec));
        if (target.startsWith("..")) continue; // lib/, shared/: not components
        for (const ext of [".tsx", ".ts"]) {
          const candidate = target.endsWith(ext) ? target : target + ext;
          try {
            readFileSync(rel(candidate));
            queue.push(candidate);
            break;
          } catch {
            // not this extension
          }
        }
      }
    }
    expect(seen.size).toBeGreaterThan(10); // the walk really followed the imports
    for (const f of seen) {
      if (f === "ui/info-tip.tsx") continue; // the primitive's own definition
      expect({ f, hit: /<InfoTip\b/.test(read(f)) }).toEqual({ f, hit: false });
    }
  });

  test("a new popover goes through ui/picker: the marker is on the root, only while open, never on the portal", () => {
    const src = read("ui/picker.tsx");
    expect(src).toContain('data-popover-open={open ? "" : undefined}');
    expect(src.match(/data-popover-open/g)?.length).toBe(2); // the attribute + the doc comment's mention
  });

  test("color tokens are semantic: no literal palette classes in the new primitives", () => {
    const palette = /\b(?:text|bg|border)-(?:red|rose|emerald|amber|sky|blue|green|yellow|orange)-\d{2,3}\b/;
    for (const f of IN_SCOPE) expect({ f, hit: palette.test(read(f)) }).toEqual({ f, hit: false });
  });
});
