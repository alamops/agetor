import { ListTodo } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TodoItem, TodoProgress } from "@/lib/todo-progress";

/**
 * Pinned, read-only progress checklist for Claude Code's `TodoWrite` list.
 * Purely presentational — derivation lives in `@/lib/todo-progress`. Renders
 * on both the main stream and read-only subagent tabs, so it must stay free
 * of any interactive/mutating controls.
 */
export function TodoProgressCard({ progress }: { progress: TodoProgress }) {
  return (
    <div className="rounded-md border border-border/60 bg-card">
      <div className="flex items-center gap-2 border-b border-border/40 px-2 py-1.5 text-[11px]">
        <ListTodo className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="truncate font-medium text-foreground">{progress.activeForm ?? "To-dos"}</span>
        <span className="ml-auto shrink-0 text-muted-foreground">
          {progress.completed}/{progress.total}
        </span>
      </div>
      <ul className="max-h-48 space-y-0.5 overflow-y-auto px-2 py-1.5 text-[11px]">
        {progress.todos.map((todo, i) => (
          <TodoRow key={i} todo={todo} />
        ))}
      </ul>
    </div>
  );
}

function TodoRow({ todo }: { todo: TodoItem }) {
  return (
    <li className="flex items-start gap-2">
      <span className="shrink-0 text-muted-foreground">
        {todo.status === "completed" ? "✓" : todo.status === "in_progress" ? "■" : "□"}
      </span>
      <span
        className={cn(
          "break-words",
          todo.status === "completed" && "text-muted-foreground line-through",
          todo.status === "in_progress" && "font-medium text-foreground",
          todo.status === "pending" && "text-muted-foreground",
        )}
      >
        {todo.content}
      </span>
    </li>
  );
}
