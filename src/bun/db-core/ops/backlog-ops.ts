import { defineOp } from "./define.ts";

export const backlogOps = {
  /**
   * Put messages back in a task's backlog tray, newest on top: the texts are
   * added in reverse order, so the first text ends up first. A text an item of
   * the tray already carries is not added twice. Read, check and write run in
   * one transaction on the worker, so two concurrent stashes of the same text
   * cannot both see it missing. Returns false when the task is gone (nothing
   * is kept for it), true when it exists (even if every text was a duplicate).
   */
  "backlog.stashTexts": defineOp({
    tx: true,
    run: ({ modules }, taskId: string, texts: string[]): boolean => {
      let saved = false;
      for (const text of [...texts].reverse()) {
        const task = modules.tasks.get(taskId);
        if (!task) break;
        if (!task.backlog.some((item) => item.text === text)) modules.backlog.add(taskId, { text });
        saved = true;
      }
      return saved;
    },
  }),
};
