import { randomUUID } from "node:crypto";
import type { BacklogMessage, Task, TaskDraft, TaskReference } from "../../shared/types.ts";
import { sanitizeRefs } from "./task-parsers.ts";
import type { Tasks } from "./tasks.ts";

export function makeBacklog(tasks: Tasks) {
  /**
   * Per-task backlog of saved, not-yet-sent draft messages. Every op is a
   * read-modify-write on the task's `backlog` JSON column (via `tasks.update`)
   * and returns the freshly-updated Task, or null when the task is gone. Item
   * ids are minted here so clients never supply their own. Array order is the
   * display order the UI renders and the user reorders. All ops are pure list
   * transforms — there is no process side effect, so the server can call them
   * directly without going through the orchestrator.
   */
  const backlog = {
    add(taskId: string, input: { text: string; references?: TaskReference[] }): Task | null {
      const task = tasks.get(taskId);
      if (!task) return null;
      const item: BacklogMessage = {
        id: randomUUID(),
        text: input.text,
        references: sanitizeRefs(input.references),
        createdAt: Date.now(),
      };
      // Newest draft on top: the thing you just jotted is the one most likely
      // to be sent or edited next.
      return tasks.update(taskId, { backlog: [item, ...task.backlog] });
    },
    updateItem(
      taskId: string,
      itemId: string,
      patch: { text?: string; references?: TaskReference[] },
    ): Task | null {
      const task = tasks.get(taskId);
      if (!task) return null;
      // Unknown id → return the task unchanged rather than writing a no-op row.
      if (!task.backlog.some((m) => m.id === itemId)) return task;
      const next = task.backlog.map((m) =>
        m.id === itemId
          ? {
              ...m,
              text: patch.text !== undefined ? patch.text : m.text,
              references:
                patch.references !== undefined ? sanitizeRefs(patch.references) : m.references,
            }
          : m,
      );
      return tasks.update(taskId, { backlog: next });
    },
    remove(taskId: string, itemId: string): Task | null {
      const task = tasks.get(taskId);
      if (!task) return null;
      return tasks.update(taskId, {
        backlog: task.backlog.filter((m) => m.id !== itemId),
      });
    },
    /** Reorder the backlog to match `order` (item ids in the desired sequence).
     *  Ids not in the current backlog are ignored; items absent from `order` are
     *  appended in their existing relative order — so a stale or partial `order`
     *  can never silently drop a saved draft. */
    reorder(taskId: string, order: string[]): Task | null {
      const task = tasks.get(taskId);
      if (!task) return null;
      const byId = new Map(task.backlog.map((m) => [m.id, m]));
      const seen = new Set<string>();
      const next: BacklogMessage[] = [];
      for (const id of order) {
        const m = byId.get(id);
        if (m && !seen.has(id)) {
          next.push(m);
          seen.add(id);
        }
      }
      for (const m of task.backlog) if (!seen.has(m.id)) next.push(m);
      return tasks.update(taskId, { backlog: next });
    },
  };
  return backlog;
}

export function makeDrafts(tasks: Tasks) {
  /**
   * The task's single composer draft — a pure wrapper over `tasks.update`, no
   * process side effect. `null` clears it (stored as SQL NULL by `update`).
   * References run through the same `sanitizeRefs` the read path (`parseDraft`)
   * applies, and an effectively-empty draft (blank text, no sanitized refs)
   * normalizes to `null` here too — otherwise a caller with junk refs could
   * write a non-null row that reads back as `null`, a zombie draft that never
   * shows up but never gets treated as absent either.
   */
  const drafts = {
    set(taskId: string, draft: TaskDraft | null): Task | null {
      if (draft) {
        const references = sanitizeRefs(draft.references);
        draft = draft.text.trim() || references.length > 0 ? { text: draft.text, references } : null;
      }
      return tasks.update(taskId, { draft });
    },
  };
  return drafts;
}
