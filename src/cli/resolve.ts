import type { AgetorClient } from "./api-client.ts";
import type { Task } from "../shared/types.ts";

/** Resolve a task by full id or a unique short-id prefix (e.g. the 8 chars
 *  shown in `agetor ls`). Throws a friendly error on no/ambiguous match. */
export async function resolveTask(client: AgetorClient, ref: string): Promise<Task> {
  const tasks = await client.listTasks();
  const exact = tasks.find((t) => t.id === ref);
  if (exact) return exact;
  const matches = tasks.filter((t) => t.id.startsWith(ref));
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) throw new Error(`no task matches "${ref}"`);
  throw new Error(`"${ref}" is ambiguous — ${matches.length} tasks share that prefix; use a longer id`);
}
