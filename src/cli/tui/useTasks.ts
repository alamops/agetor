import { useEffect, useState } from "react";
import type { AgetorClient } from "../api-client.ts";
import type { Task } from "../../shared/types.ts";

/**
 * Poll the task list. The board is small data, so a short poll (like the
 * webview's 2s) keeps columns/badges fresh without the complexity of diffing a
 * push stream. The live conversation, which IS high-volume, streams separately
 * through {@link useCoalescedStream}.
 */
export function useTasks(client: AgetorClient, intervalMs = 1500): Task[] {
  const [tasks, setTasks] = useState<Task[]>([]);
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const t = await client.listTasks();
        if (alive) setTasks(t);
      } catch {
        /* transient — keep the last good list */
      }
    };
    void poll();
    const id = setInterval(() => void poll(), intervalMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [client, intervalMs]);
  return tasks;
}
