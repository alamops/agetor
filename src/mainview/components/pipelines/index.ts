/**
 * Barrel for the pipelines canvas/run-view component set (T5,
 * `docs/plans/pipelines.md`). Consumed by `App.tsx` (the full-page
 * `pipelines` / `pipeline-run` views), `NewTaskForm` (`PipelinePicker`),
 * Settings → Pipelines (`PipelinesPage`) and `TaskCard` (`PipelineBadge`).
 */
export { PipelineEditor } from "./PipelineEditor";
export { PipelinesPage } from "./PipelinesPage";
export { PipelineRunView } from "./PipelineRunView";
export { PipelinePicker } from "./PipelinePicker";
export { PipelineBadge } from "./PipelineBadge";
export { StepNode, type StepNodeData, type StepFlowNodeType } from "./StepNode";
export { StepEdge, type StepEdgeData, type StepFlowEdgeType } from "./StepEdge";
export { StepPanel } from "./StepPanel";
