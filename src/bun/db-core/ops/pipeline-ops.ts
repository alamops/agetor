import { defineOp } from "./define.ts";

export const pipelineOps = {
  /** Every non-archived hidden step task with its pipeline parent, as
   *  `[stepTaskId, parentTaskId]` pairs. One query: the boot preload of the
   *  interaction registry's parent cache (`interactions.ts`). */
  "pipeline.stepParents": defineOp({
    tx: false,
    run: ({ conn }): [string, string][] =>
      (conn
        .query(`SELECT id, pipeline_parent_id FROM tasks WHERE pipeline_parent_id IS NOT NULL AND archived_at IS NULL`)
        .all() as { id: string; pipeline_parent_id: string }[]).map((r) => [r.id, r.pipeline_parent_id]),
  }),
};
