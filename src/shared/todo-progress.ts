/**
 * Pure derivation of Claude Code's "current" to-do list from a run's event
 * array. Shared between the webview (RunPanel/TodoProgressCard) and the Bun
 * orchestrator (board summary persistence) — kept free of any runtime import
 * from either process side, per the shared-module convention (see
 * `src/shared/types.ts`). DOM-free and pure, like the rest of `src/shared/`,
 * so it's unit tested directly.
 *
 * Two independent tool families can produce the current to-do state:
 *
 * 1. **Legacy `TodoWrite`** — a `tool_use` event whose `data` is
 *    `{ id, name: "TodoWrite", input: { todos }, serverSide }`. Claude
 *    re-emits the ENTIRE list on every change (no diff event), so the only
 *    correct read is "take the LAST snapshot and ignore the rest." An empty
 *    snapshot is Claude's clear-list signal and must be able to override an
 *    earlier non-empty one.
 * 2. **Current `TaskCreate` / `TaskUpdate`** ("Task tools") — `TaskCreate`
 *    `tool_use` data is `{ id, name: "TaskCreate", input: { subject,
 *    description, activeForm } }`; its matching `tool_result` (joined by
 *    `toolUseId === TaskCreate's id`, per the wire shape emitted in
 *    `src/bun/claude-tmux.ts` — `tool_result` data is always
 *    `{ toolUseId, content, isError }`, never a bare `id`) carries the
 *    string/text content `"Task #N created successfully: <subject>"`, which
 *    is the ONLY place the task number appears. Absent/unparseable ⇒ the
 *    task is numbered sequentially (1-based, in creation order) instead.
 *    `TaskUpdate` data is `{ id, name: "TaskUpdate", input: { taskId,
 *    status?, subject?, description? } }` and mutates the item addressed by
 *    `taskId` (string-compared against assigned numbers); unknown taskIds
 *    and unknown status values are tolerated (ignored) rather than erroring.
 *
 * **Mixed sessions**: whichever family produced the most recent `tool_use`
 * event wins the final result — a `TodoWrite` snapshot after Task-tool
 * activity replaces the accumulated list wholesale; a `TaskCreate`/
 * `TaskUpdate` after a `TodoWrite` resumes/starts Task-tool accumulation.
 * The two families are accumulated independently in a single pass and only
 * the more-recently-touched one is read out at the end.
 */

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  content: string;
  status: TodoStatus;
  activeForm?: string;
}

export interface TodoProgress {
  todos: TodoItem[];
  /** Count of `status === "completed"`. */
  completed: number;
  /** `todos.length`. */
  total: number;
  /** `activeForm` of the first `in_progress` todo, else `null`. */
  activeForm: string | null;
}

export interface TodoProgressSummary {
  completed: number;
  total: number;
}

/** Minimal shape this module reads off a run event. Callers (webview,
 *  orchestrator) pass richer objects — only `stream` and `data` are read,
 *  everything else is ignored/tolerated. */
export interface TodoProgressEvent {
  stream: string;
  data: string;
}

const VALID_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "in_progress",
  "completed",
]);

function parseJson(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}

/** Plain text of a tool_result's `content` — a string, or an array of
 *  `{ type: "text", text }` blocks (same shape claude-tmux.ts emits for
 *  every tool_result). Mirrors `toolResultText` in `src/bun/claude-tmux.ts`. */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((x) =>
        x && typeof x === "object" && (x as { type?: string }).type === "text"
          ? (x as { text?: string }).text ?? ""
          : "",
      )
      .join("");
  }
  return "";
}

/**
 * Coerce one raw todo entry from parsed `TodoWrite` JSON into a `TodoItem`,
 * or `null` if it has no usable content. Individual malformed entries are
 * dropped rather than failing the whole snapshot — a single bad item in an
 * otherwise-good list shouldn't hide the rest of the plan.
 */
function coerceTodoItem(raw: unknown): TodoItem | null {
  if (raw == null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.content == null) return null;
  const content = String(r.content);
  if (content.trim() === "") return null;
  const status: TodoStatus =
    typeof r.status === "string" && VALID_STATUSES.has(r.status)
      ? (r.status as TodoStatus)
      : "pending";
  const activeForm = typeof r.activeForm === "string" ? r.activeForm : undefined;
  return { content, status, activeForm };
}

const TASK_CREATED_RE = /Task #(\d+) created successfully/;

/**
 * Scan `events` for the current to-do state — either the latest `TodoWrite`
 * snapshot, or the accumulated `TaskCreate`/`TaskUpdate` state, whichever
 * family's `tool_use` most recently fired. Returns `null` when there is no
 * usable state at all (no qualifying events, or the winning family resolves
 * to zero items — e.g. the latest `TodoWrite` is an explicit clear).
 *
 * Single pass over `events` to build a tool_result index (needed because a
 * `TaskCreate`'s task number lives on its *later* `tool_result`, not the
 * `tool_use` itself), then a second forward pass to accumulate both
 * families in event order. Never throws — malformed JSON/shapes are skipped
 * per-event, not fatal to the whole derivation.
 */
export function deriveTodoProgress(events: TodoProgressEvent[]): TodoProgress | null {
  // Pass 1: index tool_result text by the tool_use id it answers, so
  // TaskCreate resolution (pass 2) can look up its result regardless of
  // where in the array the tool_result lands relative to the tool_use.
  const resultTextById = new Map<string, string>();
  for (const e of events) {
    if (e.stream !== "tool_result") continue;
    const parsed = parseJson(e.data);
    if (parsed == null || typeof parsed !== "object") continue;
    const toolUseId = (parsed as Record<string, unknown>).toolUseId;
    if (typeof toolUseId !== "string" || !toolUseId) continue;
    const text = toolResultText((parsed as Record<string, unknown>).content);
    if (text) resultTextById.set(toolUseId, text);
  }

  // Pass 2: forward scan, accumulating both families independently and
  // tracking the event index of each family's most recent contribution.
  let todoWriteSnapshot: unknown[] | null = null;
  let todoWriteLastIndex = -1;

  const taskItems = new Map<number, TodoItem>();
  let taskLastIndex = -1;
  let creationCount = 0;
  // Session-restart scoping: claude's Task-tools numbering is per-SESSION,
  // not per-run — in agetor every follow-up turn opens a NEW run row in the
  // SAME session, and a later turn's TaskCreate CONTINUES the numbering
  // ("Task #9" after 8 exist). Only a re-spawned session (death → restart)
  // restarts numbering at #1, and stale items from the dead session must not
  // linger behind the new numbering inflating the total. So the reset signal
  // is derived from the NUMBERING itself, not from run identity: a
  // result-derived number that lands on an already-occupied slot with
  // DIFFERENT content means the numbering restarted → discard the old
  // accumulation. (Same number + same content is a replayed duplicate of the
  // same create — overwrite in place, no reset.) A restart whose first
  // TaskCreate has no parseable tool_result is inherently ambiguous; those
  // creates take the bump-forward fallback below rather than guessing.

  events.forEach((e, i) => {
    if (e.stream !== "tool_use") return;
    const parsed = parseJson(e.data);
    if (parsed == null || typeof parsed !== "object") return;
    const obj = parsed as Record<string, unknown>;
    const name = obj.name;
    const input = obj.input;

    if (name === "TodoWrite") {
      if (input == null || typeof input !== "object") return;
      const todos = (input as Record<string, unknown>).todos;
      if (!Array.isArray(todos)) return;
      // Latest wins — including an empty array (that's a clear).
      todoWriteSnapshot = todos;
      todoWriteLastIndex = i;
      return;
    }

    if (name === "TaskCreate") {
      if (input == null || typeof input !== "object") return;
      const inputObj = input as Record<string, unknown>;
      if (inputObj.subject == null) return;
      const content = String(inputObj.subject);
      if (content.trim() === "") return;
      const activeForm =
        typeof inputObj.activeForm === "string" ? inputObj.activeForm : undefined;

      creationCount++;
      let taskNum = creationCount;
      let numberedFromResult = false;
      const toolUseId = obj.id;
      if (typeof toolUseId === "string" && toolUseId) {
        const resultText = resultTextById.get(toolUseId);
        if (resultText) {
          const m = TASK_CREATED_RE.exec(resultText);
          const captured = m?.[1];
          if (captured) {
            taskNum = parseInt(captured, 10);
            numberedFromResult = true;
          }
        }
      }

      if (numberedFromResult) {
        const existing = taskItems.get(taskNum);
        if (existing && existing.content !== content) {
          // Numbering restarted (see the session-restart note above): a
          // re-spawned session's "Task #N" landed on a slot the dead
          // session's accumulation still occupies. Discard the stale set;
          // this create is the new session's first observed one.
          taskItems.clear();
          creationCount = 1;
        } else if (existing) {
          // Same number, same content — a replayed duplicate of a create we
          // already counted. Don't let it shift the fallback counter.
          creationCount--;
        }
      } else {
        // Never let a sequential-fallback number silently overwrite an
        // existing entry (e.g. one already claimed by a result-derived
        // number) — that would drop a task rather than just misnumber it.
        // Result-derived numbers are authoritative and always win/overwrite,
        // preserving TaskUpdate-by-taskId matching for the common case.
        while (taskItems.has(taskNum)) taskNum++;
      }

      taskItems.set(taskNum, { content, status: "pending", activeForm });
      taskLastIndex = i;
      return;
    }

    if (name === "TaskUpdate") {
      if (input == null || typeof input !== "object") return;
      const inputObj = input as Record<string, unknown>;
      const taskIdRaw = inputObj.taskId;
      if (taskIdRaw == null) return;
      const taskNum = parseInt(String(taskIdRaw), 10);
      if (Number.isNaN(taskNum)) return;
      const existing = taskItems.get(taskNum);
      // Unknown taskId — nothing to update against. Tolerated, not an error.
      if (!existing) return;

      let status = existing.status;
      if (typeof inputObj.status === "string" && VALID_STATUSES.has(inputObj.status)) {
        status = inputObj.status as TodoStatus;
      }
      // Unknown status values are ignored — the item is left as-is (a
      // subject/description edit on the same call still applies below).
      const content =
        typeof inputObj.subject === "string" && inputObj.subject.trim() !== ""
          ? inputObj.subject
          : existing.content;

      taskItems.set(taskNum, { ...existing, content, status });
      taskLastIndex = i;
      return;
    }
  });

  let todos: TodoItem[] | null = null;

  if (taskLastIndex >= 0 && taskLastIndex > todoWriteLastIndex) {
    const ordered = Array.from(taskItems.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([, item]) => item);
    todos = ordered.length > 0 ? ordered : null;
  } else if (todoWriteLastIndex >= 0) {
    const coerced: TodoItem[] = [];
    for (const raw of todoWriteSnapshot ?? []) {
      const item = coerceTodoItem(raw);
      if (item) coerced.push(item);
    }
    todos = coerced.length > 0 ? coerced : null;
  }

  if (todos == null || todos.length === 0) return null;

  let completed = 0;
  let activeForm: string | null = null;
  for (const t of todos) {
    if (t.status === "completed") completed++;
    if (activeForm === null && t.status === "in_progress") {
      activeForm = t.activeForm ?? null;
    }
  }

  return { todos, completed, total: todos.length, activeForm };
}

/** Reduce a `TodoProgress` (or `null`) to the tiny `{completed,total}` shape
 *  persisted on `tasks.todo_progress` / rendered as the board mini badge. */
export function summarizeTodoProgress(p: TodoProgress | null): TodoProgressSummary | null {
  if (p == null) return null;
  return { completed: p.completed, total: p.total };
}
