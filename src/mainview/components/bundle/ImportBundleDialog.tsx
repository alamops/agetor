import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type Dispatch } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, ArrowLeft, FileJson, PackagePlus, ShieldAlert, X } from "lucide-react";
import { toast } from "sonner";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useConfirm } from "@/components/ui/confirm";
import { AgentIcon } from "@/components/kanban/AgentIcon";
import { api, ApiError } from "@/lib/api";
import { useAgentProfiles } from "@/lib/agent-profiles";
import { refreshPipelines } from "@/lib/pipelines";
import {
  EMPTY_IMPORT_OPTIONS,
  countsSummary,
  harnessChoices,
  harnessOptionLabel,
  importOptionsEdited,
  importOptionsReducer,
  importSuccessText,
  toImportOptions,
  type ImportOptionsAction,
  type ImportOptionsState,
} from "@/lib/bundle";
import { cn } from "@/lib/utils";
import { AGENT_PROFILE_LIMITS } from "../../../shared/agent-profile.ts";
import { PIPELINE_LIMITS } from "../../../shared/types.ts";
import type {
  BundleImportPlan,
  BundleIssue,
  PlannedAgent,
  PlannedHarness,
  PlannedPipeline,
} from "../../../shared/bundle-import.ts";
import { useBundleFileDrop } from "./useBundleFileDrop";

const TITLE_ID = "bundle-import-title";
/** Debounce for re-previewing after an option change (typing a name). */
const PREVIEW_DEBOUNCE_MS = 250;

/** One preview the dialog wants: this text with these options, for this
 *  open of the dialog. */
interface PreviewRequest {
  text: string;
  key: string;
  epoch: number;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function Issues({ issues, kind }: { issues: BundleIssue[]; kind: "warning" | "blocking" }) {
  if (issues.length === 0) return null;
  return (
    <ul className="mt-1.5 space-y-1">
      {issues.map((issue, i) => (
        <li
          key={`${issue.code}-${i}`}
          data-testid={kind === "warning" ? "bundle-import-warning" : "bundle-import-blocking"}
          data-code={issue.code}
          className={cn(
            "flex items-start gap-1.5 rounded-md px-2 py-1 text-[11px] leading-snug",
            kind === "warning" ? "bg-warning/10 text-warning" : "bg-danger/10 text-danger",
          )}
        >
          <AlertTriangle className="mt-px size-3 shrink-0" aria-hidden />
          <span>{issue.message}</span>
        </li>
      ))}
    </ul>
  );
}

/** Blocking issues that belong to no row (e.g. a name that can't apply). */
function planLevelIssues(plan: BundleImportPlan): BundleIssue[] {
  const key = (i: BundleIssue) => `${i.code}\u0000${i.message}`;
  const onRows = new Set([...plan.agents.flatMap((a) => a.errors), ...plan.pipelines.flatMap((p) => p.errors)].map(key));
  return plan.blocking.filter((b) => !onRows.has(key(b)));
}

function Collapsed({ label, text, testId }: { label: string; text: string; testId?: string }) {
  if (!text.trim()) return null;
  return (
    <details data-testid={testId} className="mt-1.5 text-[11px]">
      <summary className="cursor-pointer select-none text-muted-foreground">{label}</summary>
      <p className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md border border-border/60 bg-muted/30 p-2 leading-snug">
        {text}
      </p>
    </details>
  );
}

/**
 * Import Agents and/or Pipelines from an agetor bundle
 * (docs/plans/agents-pipelines-import-export.md K5/K6/K8, grill D5/C10):
 * pick the text (Choose file, Paste JSON, or a dropped file via
 * `initialText`/the dialog's own drop zone), then a server-side preview shows
 * what will be created, renamed and bound. Each Agent's name and harness can
 * be changed, a disabled harness can be enabled as part of the import, and
 * every change re-runs the preview (debounced, one request in flight, stale
 * answers dropped). Confirm commits everything in one transaction and stays
 * disabled while the plan is blocked or out of date. Closing after editing
 * asks to discard.
 */
export function ImportBundleDialog({
  open,
  initialText,
  onClose,
  onImported,
}: {
  open: boolean;
  initialText?: string | null;
  onClose: () => void;
  onImported?: (result: { enabledHarnesses: string[] }) => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const [sourceLabel, setSourceLabel] = useState<string>("");
  const [pasteDraft, setPasteDraft] = useState("");
  const [options, dispatch] = useReducer(importOptionsReducer, EMPTY_IMPORT_OPTIONS);
  const [plan, setPlan] = useState<BundleImportPlan | null>(null);
  const [planKey, setPlanKey] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [picking, setPicking] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const confirm = useConfirm();
  const { refresh: refreshProfiles } = useAgentProfiles({ enabled: false });

  // Bumped on every open/close and new text: a preview answer from an older
  // epoch is dropped on arrival.
  const epochRef = useRef(0);
  const wantedRef = useRef<PreviewRequest | null>(null);
  const inFlightRef = useRef(false);

  const optionsKey = useMemo(() => JSON.stringify(toImportOptions(options)), [options]);

  const loadText = useCallback((next: string, label: string) => {
    epochRef.current++;
    wantedRef.current = null;
    dispatch({ type: "reset" });
    setPlan(null);
    setPlanKey(null);
    setPreviewError(null);
    setImportError(null);
    setSourceLabel(label);
    setText(next);
  }, []);

  // Fresh state on every open; a drop that opened the dialog previews at once.
  useEffect(() => {
    epochRef.current++;
    wantedRef.current = null;
    dispatch({ type: "reset" });
    setPlan(null);
    setPlanKey(null);
    setPreviewError(null);
    setImportError(null);
    setImporting(false);
    setPicking(false);
    setPasteDraft("");
    if (open && initialText) {
      setSourceLabel("Dropped file");
      setText(initialText);
    } else {
      setSourceLabel("");
      setText(null);
    }
  }, [open, initialText]);

  /** Preview `want`, keeping at most one request in flight: a newer request
   *  made meanwhile replaces the pending one and runs when this one lands. */
  const runPreview = useCallback(async (want: PreviewRequest) => {
    wantedRef.current = want;
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setPreviewing(true);
    try {
      while (wantedRef.current) {
        const current: PreviewRequest = wantedRef.current;
        let result: { plan: BundleImportPlan } | { error: string };
        try {
          result = { plan: await api.previewBundleImport(current.text, JSON.parse(current.key)) };
        } catch (e) {
          result = { error: message(e) };
        }
        if (wantedRef.current !== current) continue; // superseded — run the newer one
        wantedRef.current = null;
        if (current.epoch !== epochRef.current) break; // dialog closed or text replaced
        if ("plan" in result) {
          setPlan(result.plan);
          setPlanKey(current.key);
          setPreviewError(null);
        } else {
          setPlan(null);
          setPlanKey(null);
          setPreviewError(result.error);
        }
      }
    } finally {
      inFlightRef.current = false;
      setPreviewing(false);
    }
  }, []);

  useEffect(() => {
    if (!open || text === null) return;
    const want = { text, key: optionsKey, epoch: epochRef.current };
    // The first preview of a text runs at once; option edits are debounced.
    const delay = plan === null && previewError === null ? 0 : PREVIEW_DEBOUNCE_MS;
    const handle = setTimeout(() => void runPreview(want), delay);
    return () => clearTimeout(handle);
    // `plan`/`previewError` only pick the delay; re-running on them would
    // re-preview after every answer.
  }, [open, text, optionsKey, runPreview]);

  const { dropProps, dragging } = useBundleFileDrop((dropped) => loadText(dropped, "Dropped file"));

  const requestClose = useCallback(async () => {
    if (importing) return;
    if (importOptionsEdited(options)) {
      const ok = await confirm({
        title: "Discard this import?",
        description: "Your changes to names and harnesses will be lost.",
        confirmLabel: "Discard",
        variant: "destructive",
      });
      if (!ok) return;
    }
    onClose();
  }, [confirm, importing, onClose, options]);

  const chooseFile = async () => {
    setPicking(true);
    try {
      const res = await api.pickBundleFile();
      if ("cancelled" in res) return;
      loadText(res.text, res.filename);
    } catch (e) {
      const description =
        e instanceof ApiError && e.status === 501 ? "Choosing a file isn't available here — paste the JSON instead." : message(e);
      toast.error("Couldn't open the file", { description, duration: Infinity });
    } finally {
      setPicking(false);
    }
  };

  const doImport = async () => {
    if (text === null || !plan?.canImport) return;
    setImporting(true);
    setImportError(null);
    const key = optionsKey;
    try {
      const result = await api.importBundle(text, JSON.parse(key));
      void refreshProfiles();
      void refreshPipelines();
      const warnings = result.warnings.length;
      toast.success(importSuccessText(result), {
        description: warnings > 0 ? `${warnings} warning${warnings === 1 ? "" : "s"} — ${result.warnings[0]!.message}` : undefined,
      });
      onImported?.({ enabledHarnesses: result.enabledHarnesses });
      onClose();
    } catch (e) {
      const body = e instanceof ApiError ? (e.body as { plan?: BundleImportPlan } | null) : null;
      if (e instanceof ApiError && e.status === 409 && body?.plan) {
        setPlan(body.plan);
        setPlanKey(key);
      }
      setImportError(message(e));
    } finally {
      setImporting(false);
    }
  };

  if (!open) return null;

  const planStale = plan !== null && planKey !== optionsKey;
  const canConfirm = plan !== null && plan.canImport && !planStale && !previewing && !importing;
  const showPreview = text !== null;

  return createPortal(
    <Dialog
      open={open}
      onClose={() => void requestClose()}
      labelledBy={TITLE_ID}
      className="flex max-h-[85vh] w-full max-w-2xl flex-col p-0"
    >
      <div
        data-testid="bundle-import-dialog"
        data-dragging={dragging ? "" : undefined}
        className={cn("flex min-h-0 flex-1 flex-col", dragging && "ring-2 ring-inset ring-info")}
        {...dropProps}
      >
        <header className="flex items-start justify-between gap-3 border-b border-border/60 p-3">
          <div className="min-w-0">
            <h2 id={TITLE_ID} className="flex items-center gap-2 text-sm font-semibold">
              <PackagePlus className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              Import Agents and Pipelines
            </h2>
            <p className="mt-1 truncate text-xs text-muted-foreground">
              {showPreview ? (
                <>
                  From <span className="font-medium text-foreground">{sourceLabel}</span>
                </>
              ) : (
                "An agetor bundle (.agetor.json), or a pipeline file from an older version."
              )}
            </p>
          </div>
          <Button variant="ghost" size="icon" onClick={() => void requestClose()} aria-label="Close">
            <X className="size-4" />
          </Button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-3 text-xs">
          {!showPreview ? (
            <SourceStep
              picking={picking}
              pasteDraft={pasteDraft}
              onPasteDraft={setPasteDraft}
              onChooseFile={() => void chooseFile()}
              onPreviewPaste={() => loadText(pasteDraft, "Pasted JSON")}
            />
          ) : (
            <PreviewStep
              plan={plan}
              options={options}
              dispatch={dispatch}
              previewing={previewing}
              error={importError ?? previewError}
            />
          )}
        </div>

        <footer className="flex items-center justify-between gap-2 border-t border-border/60 p-3">
          <div className="min-w-0 text-[11px] text-muted-foreground">
            {showPreview && plan && !plan.canImport && (
              <span className="text-danger">
                {plan.blocking.length} blocking issue{plan.blocking.length === 1 ? "" : "s"} — fix them to import
              </span>
            )}
            {showPreview && (previewing || planStale) && plan?.canImport && <span>Updating preview…</span>}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {showPreview && (
              <Button
                size="sm"
                variant="ghost"
                data-testid="bundle-import-back"
                disabled={importing}
                onClick={() => {
                  epochRef.current++;
                  setText(null);
                  setPlan(null);
                  setPlanKey(null);
                  setPreviewError(null);
                  setImportError(null);
                  dispatch({ type: "reset" });
                }}
              >
                <ArrowLeft className="mr-1 size-3.5" aria-hidden />
                Other file
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={() => void requestClose()} disabled={importing}>
              Cancel
            </Button>
            {showPreview && (
              <Button size="sm" data-testid="bundle-import-confirm" disabled={!canConfirm} onClick={() => void doImport()}>
                {importing
                  ? "Importing…"
                  : plan
                    ? `Import ${countsSummary({ agents: plan.agents.length, pipelines: plan.pipelines.length })}`
                    : "Import"}
              </Button>
            )}
          </div>
        </footer>
      </div>
    </Dialog>,
    document.body,
  );
}

function SourceStep({
  picking,
  pasteDraft,
  onPasteDraft,
  onChooseFile,
  onPreviewPaste,
}: {
  picking: boolean;
  pasteDraft: string;
  onPasteDraft: (v: string) => void;
  onChooseFile: () => void;
  onPreviewPaste: () => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" data-testid="bundle-import-choose-file" disabled={picking} onClick={onChooseFile}>
          <FileJson className="mr-1 size-3.5" aria-hidden />
          {picking ? "Choosing…" : "Choose file…"}
        </Button>
        <span className="text-muted-foreground">or drop a .json file here, or paste the JSON below.</span>
      </div>
      <Textarea
        data-testid="bundle-import-paste"
        aria-label="Bundle JSON"
        value={pasteDraft}
        onChange={(e) => onPasteDraft(e.target.value)}
        placeholder='{ "format": "agetor-bundle", "version": 1, … }'
        className="min-h-40 font-mono text-[11px]"
        spellCheck={false}
      />
      <div className="flex justify-end">
        <Button
          size="sm"
          variant="outline"
          data-testid="bundle-import-paste-preview"
          disabled={!pasteDraft.trim()}
          onClick={onPreviewPaste}
        >
          Preview
        </Button>
      </div>
    </div>
  );
}

function PreviewStep({
  plan,
  options,
  dispatch,
  previewing,
  error,
}: {
  plan: BundleImportPlan | null;
  options: ImportOptionsState;
  dispatch: OptionsDispatch;
  previewing: boolean;
  error: string | null;
}) {
  if (!plan) {
    return error ? (
      <div data-testid="bundle-import-error" className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-danger">
        {error}
      </div>
    ) : (
      <p className="text-muted-foreground">{previewing ? "Reading the file…" : "Preparing the preview…"}</p>
    );
  }

  const harnessesWithNotes = plan.harnesses.filter((h) => h.canEnable || h.warnings.length > 0);

  return (
    <div className="space-y-4">
      {error && (
        <div data-testid="bundle-import-error" className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-danger">
          {error}
        </div>
      )}
      {plan.legacy && (
        <div data-testid="bundle-import-legacy" className="rounded-md bg-info/10 px-3 py-2 text-info">
          Legacy pipeline file — its Agents are matched by name to the Agents already on this machine.
        </div>
      )}
      <div
        data-testid="bundle-import-third-party-note"
        className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-warning"
      >
        <ShieldAlert className="mt-px size-3.5 shrink-0" aria-hidden />
        <span>
          This file is third-party content: its instructions become part of your agents' prompts. Read them
          before importing.
        </span>
      </div>

      {plan.agents.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Agents ({plan.agents.length})
          </h3>
          {plan.agents.map((agent) => (
            <AgentRow key={agent.key} agent={agent} plan={plan} options={options} dispatch={dispatch} />
          ))}
        </section>
      )}

      {harnessesWithNotes.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Harnesses</h3>
          {harnessesWithNotes.map((h) => (
            <HarnessRow key={h.id} harness={h} options={options} dispatch={dispatch} />
          ))}
        </section>
      )}

      {plan.pipelines.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Pipelines ({plan.pipelines.length})
          </h3>
          {plan.pipelines.map((p) => (
            <PipelineRow key={p.index} pipeline={p} options={options} dispatch={dispatch} />
          ))}
        </section>
      )}

      <Issues issues={planLevelIssues(plan)} kind="blocking" />
    </div>
  );
}

type OptionsDispatch = Dispatch<ImportOptionsAction>;

function AgentRow({
  agent,
  plan,
  options,
  dispatch,
}: {
  agent: PlannedAgent;
  plan: BundleImportPlan;
  options: ImportOptionsState;
  dispatch: OptionsDispatch;
}) {
  const choices = harnessChoices(agent, plan);
  const typed = options.agentNames[agent.key];
  const selected = options.agentHarness[agent.key] ?? agent.harnessId ?? "";
  const from = agent.fileHarness;
  return (
    <div
      data-testid="bundle-import-agent-row"
      data-agent-key={agent.key}
      data-resolution={agent.resolution}
      className="rounded-md border border-border/60 p-2.5"
    >
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="space-y-1">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Name</span>
          <Input
            data-testid="bundle-import-agent-name"
            value={typed ?? agent.name}
            placeholder={agent.name}
            maxLength={AGENT_PROFILE_LIMITS.name}
            onChange={(e) => dispatch({ type: "agent-name", key: agent.key, name: e.target.value })}
            className="h-8 text-xs"
          />
        </label>
        <label className="space-y-1">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Harness</span>
          <Select
            data-testid="bundle-import-agent-harness"
            value={selected}
            onChange={(e) => dispatch({ type: "agent-harness", key: agent.key, harnessId: e.target.value })}
            className="h-8 text-xs"
          >
            {selected === "" && <option value="">Pick a harness…</option>}
            {choices.map((h) => (
              <option key={h.id} value={h.id}>
                {harnessOptionLabel(h)}
              </option>
            ))}
          </Select>
        </label>
      </div>
      <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 text-[11px] text-muted-foreground">
        {agent.harnessKind && <AgentIcon kind={agent.harnessKind} className="size-3 shrink-0" />}
        <span>
          {agent.model}
          {agent.effort ? ` · ${agent.effort}` : ""}
          {agent.mode ? ` · ${agent.mode}` : ""}
        </span>
        <span>
          · from{" "}
          <span className="font-mono">
            {from.label && from.label !== from.id ? `${from.label} (${from.id})` : from.id}
          </span>{" "}
          ({from.kind})
        </span>
        {agent.renamed && typed === undefined && <span>· was "{agent.sourceName}"</span>}
      </p>
      {agent.skills.length > 0 && (
        <p className="mt-1 text-[11px] text-muted-foreground">
          Skills: <span className="font-mono">{agent.skills.map((s) => `/${s}`).join(", ")}</span>
        </p>
      )}
      <Collapsed label="Instructions" text={agent.instructions} testId="bundle-import-agent-instructions" />
      <Issues issues={agent.warnings} kind="warning" />
      <Issues issues={agent.errors} kind="blocking" />
    </div>
  );
}

function HarnessRow({
  harness,
  options,
  dispatch,
}: {
  harness: PlannedHarness;
  options: ImportOptionsState;
  dispatch: OptionsDispatch;
}) {
  const on = options.enableHarnesses.includes(harness.id);
  return (
    <div
      data-testid="bundle-import-harness-row"
      data-harness-id={harness.id}
      className="rounded-md border border-border/60 p-2.5"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5 text-xs">
          <AgentIcon kind={harness.kind} className="size-3.5 shrink-0" />
          <span className="truncate">{harness.label}</span>
          <span className="font-mono text-[10px] text-muted-foreground">({harness.id})</span>
        </span>
        {harness.canEnable && (
          <label className="flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground">
            Enable as part of the import
            <Switch
              data-testid="bundle-import-harness-enable"
              checked={on}
              onCheckedChange={(enabled) => dispatch({ type: "enable-harness", harnessId: harness.id, enabled })}
              aria-label={`Enable ${harness.label}`}
            />
          </label>
        )}
      </div>
      <Issues issues={harness.warnings} kind="warning" />
    </div>
  );
}

function PipelineRow({
  pipeline,
  options,
  dispatch,
}: {
  pipeline: PlannedPipeline;
  options: ImportOptionsState;
  dispatch: OptionsDispatch;
}) {
  const typed = options.pipelineNames[String(pipeline.index)];
  return (
    <div data-testid="bundle-import-pipeline-row" className="rounded-md border border-border/60 p-2.5">
      <label className="space-y-1">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Name</span>
        <Input
          data-testid="bundle-import-pipeline-name"
          value={typed ?? pipeline.name}
          placeholder={pipeline.name}
          maxLength={PIPELINE_LIMITS.name}
          onChange={(e) => dispatch({ type: "pipeline-name", index: pipeline.index, name: e.target.value })}
          className="h-8 text-xs"
        />
      </label>
      {pipeline.renamed && typed === undefined && (
        <p className="mt-1 text-[11px] text-muted-foreground">was "{pipeline.sourceName}"</p>
      )}
      <ol className="mt-2 space-y-1">
        {pipeline.steps.map((step) => (
          <li key={step.id} className="rounded-md bg-muted/30 px-2 py-1">
            <div className="flex flex-wrap items-center gap-x-1.5 text-[11px]">
              <span className="font-medium">{step.name}</span>
              <span className="text-muted-foreground">
                →{" "}
                {step.agentName ?? (step.legacy === "dangling" ? "missing Agent" : "no Agent")}
                {step.legacy === "remapped" ? " (matched by name)" : ""}
              </span>
            </div>
            <Collapsed label="Step instructions" text={step.instructions} />
          </li>
        ))}
      </ol>
      <Issues issues={pipeline.warnings} kind="warning" />
      <Issues issues={pipeline.errors} kind="blocking" />
    </div>
  );
}
