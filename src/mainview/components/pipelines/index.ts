/**
 * Barrel for the pipelines canvas/run-view component set (T5,
 * `docs/plans/pipelines.md`). Consumed by `App.tsx` (the full-page
 * `pipelines` / `pipeline-run` views), `NewTaskForm` (`PipelinePicker`),
 * Settings → Pipelines (`PipelinesPage`) and `TaskCard` (`PipelineHat`).
 */
export { PipelineEditor } from "./PipelineEditor";
export { PipelinesPage } from "./PipelinesPage";
export { PipelineRunView } from "./PipelineRunView";
export { PipelinePicker } from "./PipelinePicker";
export { PipelineHat } from "./PipelineHat";
export { StepNode, type StepNodeData, type StepFlowNodeType } from "./StepNode";
export { StepEdge, type StepEdgeData, type StepFlowEdgeType } from "./StepEdge";
export { StepPanel } from "./StepPanel";
