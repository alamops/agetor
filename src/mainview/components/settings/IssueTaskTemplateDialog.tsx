import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { toast } from "sonner";
import { api, type IssueTaskTemplate } from "@/lib/api";
import { useAgentProfiles } from "@/lib/agent-profiles";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { validateIssueTaskTemplate, type Harness } from "../../../shared/types.ts";
import {
  ISSUE_TASK_TEMPLATE_PLACEHOLDERS,
  renderIssueTaskTemplate,
  type IssueTaskTemplateVars,
} from "../../../shared/issue-task.ts";
import { AgentProfilePicker } from "@/components/kanban/AgentProfilePicker";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Absolute path of the project the template belongs to. */
  projectPath: string;
  /** Display name for the header (defaults to the path). */
  projectName?: string;
  /** Live harness rows — the profile picker resolves icons/labels from them. */
  harnesses: Harness[];
  /** The issue the dialog was opened from, if any — drives the live preview
   *  so the user sees exactly what this issue's prompt would become. */
  previewIssue?: IssueTaskTemplateVars;
  /** Called with the saved template (`null` after "Reset to default") so the
   *  parent can re-seed its prompt and agent. */
  onSaved: (template: IssueTaskTemplate | null) => void;
}

/**
 * Per-project issue task template editor — the issue-dialog sibling of
 * `BranchNamingDialog`. A prompt textarea (with the placeholder legend and a
 * live preview) plus the shared `AgentProfilePicker`. Save persists via
 * `PUT /projects/issue-template`; "Reset to default" clears the template so
 * "Work on this with Agetor" goes back to the stock issue prompt.
 */
export function IssueTaskTemplateDialog({ open, onClose, projectPath, projectName, harnesses, previewIssue, onSaved }: Props) {
  const [prompt, setPrompt] = useState("");
  const [agentProfileId, setAgentProfileId] = useState<string | null>(null);
  const [hasStored, setHasStored] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const { profiles, loaded } = useAgentProfiles({ enabled: open });

  // Load the stored template each time the dialog opens, so an edit made
  // elsewhere (the CLI, another window) is what the user starts from.
  useEffect(() => {
    if (!open || !projectPath) return;
    let cancelled = false;
    setLoading(true);
    api
      .getProjectIssueTemplate(projectPath)
      .then((t) => {
        if (cancelled) return;
        setPrompt(t?.prompt ?? "");
        setAgentProfileId(t?.agentProfileId ?? null);
        setHasStored(t !== null);
      })
      .catch(() => {
        if (cancelled) return;
        setPrompt("");
        setAgentProfileId(null);
        setHasStored(false);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, projectPath]);

  // A stored profile id that no longer resolves (the profile was deleted) is
  // surfaced with a warning, and dropped on save — the server rejects an
  // unknown id, so keeping it would make the template unsaveable.
  const missingProfile = agentProfileId !== null && loaded && !profiles.some((p) => p.id === agentProfileId);
  const template = useMemo<IssueTaskTemplate>(
    () => ({ prompt: prompt.trim(), agentProfileId: missingProfile ? null : agentProfileId }),
    [prompt, agentProfileId, missingProfile],
  );
  const validation = useMemo(() => validateIssueTaskTemplate(template), [template]);

  const persist = async (next: IssueTaskTemplate | null) => {
    setSaving(true);
    try {
      await api.setProjectIssueTemplate(projectPath, next);
      toast.success(next ? "Issue template saved" : "Issue template reset to default");
      onSaved(next);
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const save = () => {
    if (!validation.ok) { toast.error(validation.reason); return; }
    void persist(template);
  };

  if (!open) return null;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      className="max-w-lg"
      labelledBy="issue-template-title"
      initialFocusRef={promptRef}
    >
      <div data-testid="issue-template-dialog" className="contents">
        <div className="flex items-center justify-between border-b border-border/60 pb-3">
          <div className="min-w-0">
            <h2 id="issue-template-title" className="text-base font-semibold">
              Issue task template
            </h2>
            <p className="truncate text-xs text-muted-foreground" title={projectPath}>
              {projectName || projectPath || "No project selected"}
            </p>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
            <X className="size-4" />
          </Button>
        </div>

        <div className="space-y-4 pt-4 text-sm">
          <p className="text-xs text-muted-foreground">
            Every &ldquo;Work on this with Agetor&rdquo; task in this project starts from this
            prompt and agent instead of the built-in issue prompt. The issue thread is still
            attached as a snapshot file, and the prompt stays editable per task.
          </p>

          <div className="space-y-1">
            <label htmlFor="issue-template-prompt" className="text-xs text-muted-foreground">
              Prompt
            </label>
            <Textarea
              id="issue-template-prompt"
              data-testid="issue-template-prompt"
              ref={promptRef}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="/acme:cards {number}"
              rows={5}
              disabled={loading}
              className="font-mono text-xs"
            />
            <p className="text-[10px] text-muted-foreground">
              Placeholders:{" "}
              {ISSUE_TASK_TEMPLATE_PLACEHOLDERS.map(({ name, description }, i) => (
                <span key={name}>
                  <span className="font-mono">{`{${name}}`}</span> {description}
                  {i < ISSUE_TASK_TEMPLATE_PLACEHOLDERS.length - 1 ? " · " : "."}
                </span>
              ))}{" "}
              Anything else in braces is kept as typed.
            </p>
            {previewIssue && prompt.trim() && (
              <p className="truncate text-[10px] text-muted-foreground" title={renderIssueTaskTemplate(prompt.trim(), previewIssue)}>
                e.g. <span className="font-mono text-foreground/70">{renderIssueTaskTemplate(prompt.trim(), previewIssue)}</span>
              </p>
            )}
          </div>

          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Agent</label>
            <AgentProfilePicker
              value={missingProfile ? null : agentProfileId}
              onChange={setAgentProfileId}
              profiles={profiles}
              harnesses={harnesses}
              disabled={loading}
            />
            {missingProfile && (
              <p className="text-[10px] text-warning">
                The saved agent no longer exists — pick another, or save to keep the template without one.
              </p>
            )}
          </div>

          {!validation.ok && !loading && prompt.length > 0 && (
            <p className="text-xs text-destructive">{validation.reason}</p>
          )}

          <div className="flex items-center justify-between gap-2 border-t border-border/60 pt-3">
            <Button
              variant="ghost"
              size="sm"
              data-testid="issue-template-reset"
              onClick={() => void persist(null)}
              disabled={loading || saving || !hasStored}
              title="Remove the template — issues start from the built-in prompt with no preselected agent"
            >
              Reset to default
            </Button>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
              <Button
                size="sm"
                data-testid="issue-template-save"
                onClick={save}
                disabled={loading || saving || !validation.ok}
              >
                {saving ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
