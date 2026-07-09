/**
 * Pure derivation of Claude Code's "current" to-do list from a run's event
 * array. Kept DOM-free (like event-dedup.ts / subagent-tabs.ts) so it can be
 * unit tested with `bun test` — the repo has no jsdom/testing-library, so the
 * TodoProgressCard's behaviour is validated by testing the logic it renders.
 *
 * Claude emits its to-do list as an ordinary `tool_use` event (no dedicated
 * `RunEventStream` member — see the plan's non-goals) whose `data` is a JSON
 * string shaped `{ id, name: "TodoWrite", input: { todos }, serverSide }`.
 * Crucially, Claude re-emits the ENTIRE list every time any item changes, so
 * the event array accumulates one full snapshot per change. There is no
 * "diff" event — the only correct way to know the current state is to take
 * the LAST snapshot and ignore the rest.
 */
import type { RunEvent } from "../../shared/types.ts";

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

const VALID_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "in_progress",
  "completed",
]);

/**
 * Coerce one raw todo entry from parsed JSON into a `TodoItem`, or `null` if
 * it has no usable content. Individual malformed entries are dropped rather
 * than failing the whole snapshot — a single bad item in an otherwise-good
 * list shouldn't hide the rest of the plan.
 */
function coerceTodoItem(raw: unknown): TodoItem | null {
  if (raw == null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.content == null) return null;
  const content = String(r.content);
  // An empty/whitespace-only content would render as a lone checkbox glyph
  // beside a blank line. Drop it, same as a missing `content` — consistent
  // with this module's refusal to render a vacuous card at all.
  if (content.trim() === "") return null;
  const status: TodoStatus =
    typeof r.status === "string" && VALID_STATUSES.has(r.status)
      ? (r.status as TodoStatus)
      : "pending";
  const activeForm = typeof r.activeForm === "string" ? r.activeForm : undefined;
  return { content, status, activeForm };
}

/**
 * Scan `events` for the latest `TodoWrite` tool_use snapshot and derive the
 * current to-do progress from it. Returns `null` when there is no such
 * snapshot at all, or when the LATEST one carries an empty `todos` array —
 * that's how Claude clears the list, so it should render as "no card" even
 * if an earlier snapshot had items. This is why the scan tracks the latest
 * snapshot with *any* array (empty included) rather than only non-empty
 * ones: an empty snapshot must be able to override and blank out an earlier
 * non-empty one, not be skipped in its favor.
 *
 * Single forward pass, O(n) in `events.length`; never throws (malformed JSON
 * or malformed `input.todos` shapes are skipped silently, not fatal to the
 * run panel).
 */
export function deriveTodoProgress(events: RunEvent[]): TodoProgress | null {
  let latestTodos: unknown[] | null = null;

  for (const e of events) {
    if (e.stream !== "tool_use") continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(e.data);
    } catch {
      continue;
    }
    if (parsed == null || typeof parsed !== "object") continue;

    const obj = parsed as Record<string, unknown>;
    if (obj.name !== "TodoWrite") continue;

    const input = obj.input;
    if (input == null || typeof input !== "object") continue;
    const todos = (input as Record<string, unknown>).todos;
    if (!Array.isArray(todos)) continue;

    // Latest wins — keep scanning, overwrite on every further valid
    // TodoWrite snapshot, including an empty one (that's a clear).
    latestTodos = todos;
  }

  if (latestTodos == null || latestTodos.length === 0) return null;

  const todos: TodoItem[] = [];
  for (const raw of latestTodos) {
    const item = coerceTodoItem(raw);
    if (item) todos.push(item);
  }
  // Every entry was malformed and dropped. Treat that the same as an empty
  // snapshot rather than rendering a vacuous "0/0" card.
  if (todos.length === 0) return null;

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
