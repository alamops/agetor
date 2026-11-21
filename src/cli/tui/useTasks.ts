import { useCallback, useEffect, useRef, useState } from "react";
import type { AgetorClient } from "../api-client.ts";
import type { Task } from "../../shared/types.ts";
import { createTaskFeed, type TaskFeed } from "./task-feed.ts";

// The dashboard shows only unarchived tasks (`dashboardRows`), so archived ones
// stay server-side instead of riding every tick.
const FILTER = { archived: "exclude" } as const;

/**
 * The task list, kept fresh by a short poll that asks the core only for what
 * changed since the last answer (`GET /tasks?delta=1&since=`; see
 * {@link createTaskFeed}). `onTasksChanged` is for the global event stream's
 * `tasks-changed` push: it fetches at once instead of waiting for the tick. The
 * live conversation, which IS high-volume, streams separately through
 * {@link useCoalescedStream}.
 */
export function useTasks(
  client: AgetorClient,
  intervalMs = 1500,
): { tasks: Task[]; onTasksChanged: (cursor: string) => void } {
  const [tasks, setTasks] = useState<Task[]>([]);
  const feedRef = useRef<TaskFeed | null>(null);
  useEffect(() => {
    const feed = createTaskFeed({
      fetch: (filter, since) => client.listTaskDelta(filter, since),
      filter: FILTER,
      onChange: setTasks,
    });
    feedRef.current = feed;
    void feed.poll();
    const id = setInterval(() => void feed.poll(), intervalMs);
    return () => {
      feed.stop();
      feedRef.current = null;
      clearInterval(id);
    };
  }, [client, intervalMs]);
  const onTasksChanged = useCallback((cursor: string) => {
    void feedRef.current?.notify(cursor);
  }, []);
  return { tasks, onTasksChanged };
}
