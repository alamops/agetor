import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, GitMerge, Loader2 } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { api, type AgentModelMap } from "@/lib/api";
import {
  AGENT_OPTIONS,
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  supportedEfforts,
  supportedModes,
  type AgentKind,
  type AgentStatus,
  type Harness,
} from "../../../shared/types.ts";
import { AgentIcon } from "./AgentIcon";
import { buildResolveConflictsPrompt } from "@/lib/resolve-conflicts-prompt";

const initialMode = (kind: AgentKind) => AGENT_OPTIONS[kind].modes[0]?.id ?? "auto";

export interface ResolveConflictsContext {
  path: string;
  repo: string;
  number: number;
  title: string;
  headRef: string;
  baseRef: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  context: ResolveConflictsContext | null;
  onCreated?: (taskId: string) => void;
}

export function ResolveConflictsDialog({ open, onClose, context, onCreated }: Props) {
  const [harnesses, setHarnesses] = useState<Harness[]>([]);
  const [agents, setAgents] = useState<AgentStatus[]>([]);
  const [agentModels, setAgentModels] = useState<AgentModelMap>({ "claude-code": [], codex: [] });
  const [loadingHarnesses, setLoadingHarnesses] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const availableHarnesses = useMemo(() => harnesses.filter((h) => h.enabled), [harnesses]);

  const [agent, setAgent] = useState<string>("claude-code");
  const selectedHarness = useMemo(
    () => harnesses.find((h) => h.id === agent) ?? null,
    [harnesses, agent],
  );
  const kind: AgentKind = selectedHarness?.kind ?? "claude-code";
  const selectedStatus = agents.find((a) => a.harnessId === agent);

  const [mode, setMode] = useState<string>(initialMode("claude-code"));
  const [model, setModel] = useState<string>(DEFAULT_MODEL["claude-code"]);
  const [effort, setEffort] = useState<string | null>(DEFAULT_EFFORT["claude-code"]);

  const [prompt, setPrompt] = useState("");
  const [promptDirty, setPromptDirty] = useState(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Reset per-open transient state (prompt dirtiness, errors) so a previous
  // PR's edits don't leak into the next one, then self-fetch harness data —
  // mirrors NewTaskForm/App.tsx's own fetch, but scoped to this dialog since
  // it's mounted lazily from GitHubDialog rather than always-on like the
  // sidebar form.
  useEffect(() => {
    if (!open) return;
    setPromptDirty(false);
    setSubmitError(null);
    setLoadError(null);
    setLoadingHarnesses(true);
    let cancelled = false;
    Promise.all([api.listHarnesses(), api.listAgentModels(), api.listPreferences()])
      .then(([payload, models, prefs]) => {
        if (cancelled) return;
        setHarnesses(payload.harnesses);
        setAgents(payload.statuses);
        setAgentModels(models);
        const enabled = payload.harnesses.filter((h) => h.enabled);
        const want = prefs.defaultHarness;
        const nextAgent =
          want && enabled.some((h) => h.id === want)
            ? want
            : (enabled.some((h) => h.id === agent) ? agent : enabled[0]?.id ?? "claude-code");
        const nextHarness = enabled.find((h) => h.id === nextAgent);
        const nextKind: AgentKind = nextHarness?.kind ?? "claude-code";
        setAgent(nextAgent);

        const seedMode = prefs[`lastMode:${nextKind}`];
        const seedModel = prefs[`lastModel:${nextKind}`];
        const seedEffort = prefs[`lastEffort:${nextKind}`];
        const resolvedModel =
          seedModel && AGENT_OPTIONS[nextKind].models.some((m) => m.id === seedModel)
            ? seedModel
            : DEFAULT_MODEL[nextKind];
        const resolvedMode =
          seedMode && supportedModes(nextKind, resolvedModel).some((m) => m.id === seedMode)
            ? seedMode
            : initialMode(nextKind);
        const supportedEff = supportedEfforts(nextKind, resolvedModel);
        const resolvedEffort =
          seedEffort && supportedEff.some((e) => e.id === seedEffort)
            ? seedEffort
            : supportedEff.some((e) => e.id === DEFAULT_EFFORT[nextKind])
              ? DEFAULT_EFFORT[nextKind]
              : (supportedEff[0]?.id ?? null);
        setMode(resolvedMode);
        setModel(resolvedModel);
        setEffort(resolvedEffort);
      })
      .catch((e) => { if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoadingHarnesses(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Seed (and re-seed) the prompt from the context, but only while the user
  // hasn't started editing it — matches the composer's usual "don't clobber
  // what you typed" rule.
  useEffect(() => {
    if (!open || !context || promptDirty) return;
    setPrompt(buildResolveConflictsPrompt(context));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, context, promptDirty]);

  const { models: staticModels } = AGENT_OPTIONS[kind];
  const modes = supportedModes(kind, model);
  const models = useMemo(() => {
    const known = new Set(staticModels.map((m) => m.id));
    const extras = (agentModels[kind] ?? [])
      .filter((m) => !known.has(m.id))
      .map((m): typeof staticModels[number] => ({ id: m.id, label: m.label ?? m.id }));
    return [...staticModels, ...extras];
  }, [staticModels, agentModels, kind]);
  const efforts = supportedEfforts(kind, model);

  useEffect(() => {
    if (efforts.length === 0) {
      if (effort !== null) setEffort(null);
      return;
    }
    if (effort !== null && efforts.some((e) => e.id === effort)) return;
    const fallback = efforts.some((e) => e.id === DEFAULT_EFFORT[kind]) ? DEFAULT_EFFORT[kind] : efforts[0]!.id;
    setEffort(fallback);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, model]);
  useEffect(() => {
    if (!modes.some((m) => m.id === mode)) {
      const fallback = modes[0]?.id;
      if (fallback) setMode(fallback);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, model]);

  const switchAgent = (nextId: string) => {
    if (nextId === agent) return;
    const next = harnesses.find((h) => h.id === nextId);
    const nextKind = next?.kind ?? "claude-code";
    setAgent(nextId);
    if (nextKind !== kind) {
      setMode(initialMode(nextKind));
      setModel(DEFAULT_MODEL[nextKind]);
      setEffort(DEFAULT_EFFORT[nextKind]);
    }
  };

  const canSubmit = !!context && prompt.trim().length > 0 && !!selectedStatus?.available && !submitting;

  const submit = async () => {
    if (!context || !canSubmit) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const input = {
        title: `Resolve conflicts: PR #${context.number} — ${context.title}`,
        prompt: prompt.trim(),
        agent,
        workdir: context.path,
        isolation: "worktree" as const,
        existingBranch: context.headRef,
        mode,
        model,
        effort,
        column: "ready" as const,
      };
      const created = await api.createTask(input);
      await api.startTask(created.id);
      void api.setPreference(`lastMode:${kind}`, mode).catch(() => {});
      void api.setPreference(`lastModel:${kind}`, model).catch(() => {});
      if (effort !== null) void api.setPreference(`lastEffort:${kind}`, effort).catch(() => {});
      onCreated?.(created.id);
      onClose();
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      labelledBy="resolve-conflicts-dialog-title"
      className="flex max-h-[85vh] w-full max-w-lg flex-col p-0"
    >
      <header className="flex items-start justify-between gap-3 border-b border-border/60 p-3">
        <div className="min-w-0">
          <div id="resolve-conflicts-dialog-title" className="flex items-center gap-2 text-sm font-semibold">
            <GitMerge className="size-4 shrink-0 text-muted-foreground" />
            Resolve with Agetor
          </div>
          {context && (
            <div className="mt-0.5 truncate text-xs text-muted-foreground">
              PR #{context.number} — {context.title}
            </div>
          )}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-3 text-xs">
        {loadingHarnesses && (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading harnesses…
          </div>
        )}

        {!loadingHarnesses && loadError && (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-rose-400">
            <AlertCircle className="size-4" /> {loadError}
          </div>
        )}

        {!loadingHarnesses && !loadError && (
          <div className="space-y-3">
            {context && (
              <div className="rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground">
                Merges <span className="font-mono">origin/{context.baseRef}</span> into{" "}
                <span className="font-mono">{context.headRef}</span> in a worktree checked out on that
                branch. The agent commits locally; it never pushes.
              </div>
            )}

            <div className="space-y-1">
              <label className="text-muted-foreground">Prompt</label>
              <Textarea
                ref={promptRef}
                value={prompt}
                onChange={(e) => { setPrompt(e.target.value); setPromptDirty(true); }}
                rows={8}
                className="resize-none"
              />
            </div>

            <div className="space-y-1">
              <label className="text-muted-foreground">Harness</label>
              <div className="grid grid-cols-2 gap-1">
                {availableHarnesses.map((h) => {
                  const status = agents.find((s) => s.harnessId === h.id);
                  const available = status?.available ?? true;
                  return (
                    <Button
                      key={h.id}
                      size="sm"
                      variant={agent === h.id ? "default" : "outline"}
                      onClick={() => switchAgent(h.id)}
                      title={
                        [status?.reason, status?.path, status?.version].filter(Boolean).join(" — ") || h.id
                      }
                      className="justify-start"
                    >
                      <AgentIcon kind={h.kind} className="mr-1" />
                      <span className="truncate">{h.label}</span>
                      <span
                        className={cn(
                          "ml-auto inline-block size-1.5 rounded-full",
                          available ? "bg-emerald-500" : "bg-red-500",
                        )}
                      />
                    </Button>
                  );
                })}
              </div>
              {selectedStatus && !selectedStatus.available && (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-[11px] text-destructive-foreground">
                  <div className="font-medium">{selectedStatus.reason}</div>
                  {selectedStatus.installHint && (
                    <div className="mt-1 font-mono opacity-80">{selectedStatus.installHint}</div>
                  )}
                </div>
              )}
            </div>

            <div className="space-y-1">
              <label className="text-muted-foreground">Mode</label>
              <Select value={mode} onChange={(e) => setMode(e.target.value)} className="h-8">
                {modes.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </Select>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="min-w-0 space-y-1">
                <label className="text-muted-foreground">Model</label>
                <Select value={model} onChange={(e) => setModel(e.target.value)} className="h-8">
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>{m.label}</option>
                  ))}
                </Select>
              </div>
              <div className="min-w-0 space-y-1">
                <label className="text-muted-foreground">Effort</label>
                <Select
                  value={effort ?? ""}
                  onChange={(e) => setEffort(e.target.value)}
                  disabled={efforts.length === 0}
                  className="h-8"
                >
                  {efforts.length === 0 ? (
                    <option value="">n/a</option>
                  ) : (
                    efforts.map((m) => (
                      <option key={m.id} value={m.id}>{m.label}</option>
                    ))
                  )}
                </Select>
              </div>
            </div>

            {submitError && (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-[11px] text-destructive-foreground">
                {submitError}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="flex shrink-0 justify-end gap-2 border-t border-border/60 p-3">
        <Button variant="outline" onClick={onClose} disabled={submitting}>
          Cancel
        </Button>
        <Button onClick={() => void submit()} disabled={!canSubmit}>
          {submitting ? (
            <>
              <Loader2 className="mr-1 size-3.5 animate-spin" /> Creating…
            </>
          ) : (
            "Create & start"
          )}
        </Button>
      </div>
    </Dialog>
  );
}
