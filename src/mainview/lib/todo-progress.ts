/**
 * Webview-facing re-export of the shared to-do derivation logic. The actual
 * implementation lives in `src/shared/todo-progress.ts` (pure, DOM-free, no
 * runtime imports from either process side) so both the webview
 * (RunPanel/TodoProgressCard) and the Bun orchestrator (board summary
 * persistence) derive to-do state from one implementation. Kept as a
 * thin re-export rather than inlined so existing `@/lib/todo-progress`
 * import sites (RunPanel.tsx, TodoProgressCard.tsx) don't need to change.
 */
export type {
  TodoStatus,
  TodoItem,
  TodoProgress,
  TodoProgressSummary,
  TodoProgressEvent,
} from "../../shared/todo-progress.ts";
export { deriveTodoProgress, summarizeTodoProgress } from "../../shared/todo-progress.ts";
