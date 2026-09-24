import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { SearchSelect } from "@/components/ui/search-select";
import { MultiSearchSelect, type MultiSearchSelectItem } from "@/components/ui/multi-search-select";
import { useConfirm } from "@/components/ui/confirm";
import { cn } from "@/lib/utils";
import { outgoingSteps } from "../../../shared/pipeline.ts";
import { PIPELINE_LIMITS } from "../../../shared/types.ts";
import type { AgentProfile, Harness, PipelineGraph, PipelineStep } from "../../../shared/types.ts";
import { AgentProfilePicker } from "../kanban/AgentProfilePicker";
import { AgentProfileFormDialog } from "../kanban/AgentProfileFormDialog";

interface StepPanelProps {
  step: PipelineStep;
  graph: PipelineGraph;
  profiles: AgentProfile[];
  harnesses: Harness[];
  onChange: (step: PipelineStep) => void;
  onConnect: (toId: string) => void;
  onEdgeLabel: (edgeId: string, label: string) => void;
  onRemoveEdge: (edgeId: string) => void;
  onSetStart: () => void;
  onDelete: () => void;
  onProfilesChanged: () => void;
  className?: string;
}

/**
 * The canvas editor's right-hand side panel for the selected step — name,
 * instructions, agent profile (+ inline "New agent…"), subagent delegation
 * (profiles + cap), transition/join behavior, outgoing connections, and
 * step-level actions (set start, delete). See `docs/plans/pipelines.md` T5.
 */
export function StepPanel({
  step,
  graph,
  profiles,
  harnesses,
  onChange,
  onConnect,
  onEdgeLabel,
  onRemoveEdge,
  onSetStart,
  onDelete,
  onProfilesChanged,
  className,
}: StepPanelProps) {
  const confirm = useConfirm();
  const [newAgentOpen, setNewAgentOpen] = useState(false);

  const subagentItems: MultiSearchSelectItem[] = profiles
    .filter((p) => p.id !== step.agentProfileId)
    .map((p) => ({ value: p.id, label: p.name, hint: p.harness }));

  const connectItems = graph.steps
    .filter((s) => s.id !== step.id)
    .map((s) => ({ value: s.id, label: s.name }));

  const outgoing = outgoingSteps(graph, step.id);
  const isStart = graph.startStepId === step.id;

  const capUnlimited = step.subagents.cap == null;

  const handleDelete = async () => {
    const ok = await confirm({
      title: `Delete step "${step.name}"?`,
      description: "This removes the step and every connection to or from it. This can't be undone.",
      confirmLabel: "Delete step",
      variant: "destructive",
    });
    if (ok) onDelete();
  };

  return (
    <div data-testid="pipeline-step-panel" className={cn("flex h-full flex-col gap-4 overflow-y-auto p-4", className)}>
      <div>
        <label className="text-xs font-medium text-muted-foreground" htmlFor="pipeline-step-name-input">
          Step name
        </label>
        <Input
          id="pipeline-step-name-input"
          data-testid="pipeline-step-name"
          value={step.name}
          maxLength={PIPELINE_LIMITS.stepName}
          onChange={(e) => onChange({ ...step, name: e.target.value })}
          className="mt-1"
        />
      </div>

      <div>
        <label className="text-xs font-medium text-muted-foreground" htmlFor="pipeline-step-instructions-input">
          Instructions
        </label>
        <Textarea
          id="pipeline-step-instructions-input"
          data-testid="pipeline-step-instructions"
          value={step.instructions}
          maxLength={PIPELINE_LIMITS.instructions}
          onChange={(e) => onChange({ ...step, instructions: e.target.value })}
          className="mt-1 min-h-[120px]"
          placeholder="What should this step do?"
        />
      </div>

      <div>
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-muted-foreground">Agent</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="pipeline-step-new-agent"
            className="h-6 gap-1 px-1.5 text-xs"
            onClick={() => setNewAgentOpen(true)}
          >
            <Plus className="size-3" aria-hidden />
            New agent…
          </Button>
        </div>
        <AgentProfilePicker
          value={step.agentProfileId}
          onChange={(id) => onChange({ ...step, agentProfileId: id })}
          profiles={profiles}
          harnesses={harnesses}
          className="mt-1"
        />
        <AgentProfileFormDialog
          open={newAgentOpen}
          profileId={null}
          onClose={() => setNewAgentOpen(false)}
          onSaved={(profile) => {
            onProfilesChanged();
            onChange({ ...step, agentProfileId: profile.id });
            setNewAgentOpen(false);
          }}
        />
      </div>

      <div>
        <span className="text-xs font-medium text-muted-foreground">Subagents this step may delegate to</span>
        <div data-testid="pipeline-step-subagents" className="mt-1">
          <MultiSearchSelect
            values={step.subagents.profileIds}
            onChange={(profileIds) => onChange({ ...step, subagents: { ...step.subagents, profileIds } })}
            items={subagentItems}
            emptyLabel="No subagents allowed"
            placeholder="Search agents…"
          />
        </div>
        <div className="mt-2 flex items-center gap-2">
          <Switch
            data-testid="pipeline-step-cap-unlimited"
            checked={capUnlimited}
            onCheckedChange={(checked) =>
              onChange({ ...step, subagents: { ...step.subagents, cap: checked ? null : 1 } })
            }
          />
          <span className="text-xs text-muted-foreground">No limit</span>
          {!capUnlimited && (
            <Input
              type="number"
              min={1}
              max={PIPELINE_LIMITS.subagentCap}
              data-testid="pipeline-step-cap"
              value={step.subagents.cap ?? 1}
              onChange={(e) => {
                // Clamp into the server's own accepted range so a typed
                // value can't make Save fail validation later.
                const n = Math.min(PIPELINE_LIMITS.subagentCap, Math.max(1, Math.floor(Number(e.target.value) || 1)));
                onChange({ ...step, subagents: { ...step.subagents, cap: n } });
              }}
              className="h-7 w-20"
            />
          )}
        </div>
      </div>

      <div>
        <span className="text-xs font-medium text-muted-foreground">After this step</span>
        <div data-testid="pipeline-step-transition" role="radiogroup" className="mt-1 flex flex-col gap-1.5">
          <RadioRow
            testId="pipeline-step-transition-choose"
            checked={step.transition === "choose"}
            onSelect={() => onChange({ ...step, transition: "choose" })}
            label="Let the agent choose one next step"
          />
          <RadioRow
            testId="pipeline-step-transition-all"
            checked={step.transition === "all"}
            onSelect={() => onChange({ ...step, transition: "all" })}
            label="Run all next steps in parallel"
          />
        </div>
        {step.transition === "all" && (
          <p className="mt-1 text-xs text-warning">
            Parallel steps share this pipeline's worktree — keep their scopes disjoint.
          </p>
        )}
      </div>

      <div>
        <span className="text-xs font-medium text-muted-foreground">Start when</span>
        <div data-testid="pipeline-step-join" role="radiogroup" className="mt-1 flex flex-col gap-1.5">
          <RadioRow
            testId="pipeline-step-join-any"
            checked={step.join === "any"}
            onSelect={() => onChange({ ...step, join: "any" })}
            label="Any incoming step finishes"
          />
          <RadioRow
            testId="pipeline-step-join-all"
            checked={step.join === "all"}
            onSelect={() => onChange({ ...step, join: "all" })}
            label="All incoming steps have finished"
          />
        </div>
      </div>

      <div>
        <span className="text-xs font-medium text-muted-foreground">Connect to…</span>
        <div data-testid="pipeline-step-connect" className="mt-1">
          <SearchSelect
            value=""
            onChange={(toId) => onConnect(toId)}
            items={connectItems}
            placeholder="Pick a step to connect to"
            emptyLabel="Connect to another step…"
          />
        </div>
        {outgoing.length > 0 && (
          <ul className="mt-2 flex flex-col gap-1.5">
            {outgoing.map(({ step: target, edge }) => (
              <li key={edge.id} className="flex items-center gap-1.5" data-testid="pipeline-step-edge-row">
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={target.name}>
                  → {target.name}
                </span>
                <Input
                  value={edge.label}
                  placeholder="label"
                  maxLength={PIPELINE_LIMITS.edgeLabel}
                  onChange={(e) => onEdgeLabel(edge.id, e.target.value)}
                  className="h-7 w-24 text-xs"
                  data-testid="pipeline-step-edge-label"
                />
                <button
                  type="button"
                  title="Remove connection"
                  data-testid="pipeline-step-edge-remove"
                  onClick={() => onRemoveEdge(edge.id)}
                  className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-accent/40 hover:text-danger"
                >
                  <Trash2 className="size-3.5" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mt-auto flex flex-col gap-2 border-t border-border pt-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="pipeline-step-set-start"
          disabled={isStart}
          onClick={onSetStart}
        >
          {isStart ? "Start step" : "Set as start"}
        </Button>
        <Button
          type="button"
          variant="destructive"
          size="sm"
          data-testid="pipeline-step-delete"
          onClick={handleDelete}
        >
          Delete step
        </Button>
      </div>
    </div>
  );
}

function RadioRow({
  testId,
  checked,
  onSelect,
  label,
}: {
  testId: string;
  checked: boolean;
  onSelect: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      data-testid={testId}
      onClick={onSelect}
      className={cn(
        "flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-xs transition-colors",
        checked ? "border-info bg-info/10 text-foreground" : "border-border text-muted-foreground hover:bg-accent/40",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "flex size-3.5 shrink-0 items-center justify-center rounded-full border",
          checked ? "border-info" : "border-muted-foreground",
        )}
      >
        {checked && <span className="size-1.5 rounded-full bg-info" />}
      </span>
      {label}
    </button>
  );
}
