import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { toast } from "sonner";
import { api, type BranchNamingConfig } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  DEFAULT_BRANCH_CONFIG,
  TASK_TYPES,
  buildBranchName,
  validateBranchConfig,
  validateBranchName,
} from "../../../shared/types.ts";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Absolute path of the project the config belongs to. */
  projectPath: string;
  /** Display name for the header (defaults to the path basename). */
  projectName?: string;
  /** Called with the saved config so the parent can refresh its preview. */
  onSaved: (config: BranchNamingConfig) => void;
}

/** A representative title used only for the per-type live example. */
const EXAMPLE_TITLE = "Add login page";

/**
 * Per-project branch nomenclature editor. One prefix field per task type plus a
 * global "include card slug" toggle, with a live example and git-legal
 * validation. Opened from the gear button in the New Task sidebar header.
 */
export function BranchNamingDialog({ open, onClose, projectPath, projectName, onSaved }: Props) {
  const [config, setConfig] = useState<BranchNamingConfig>(DEFAULT_BRANCH_CONFIG);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const firstFieldRef = useRef<HTMLInputElement | null>(null);

  // Load the project's stored config (server resolves to defaults when unset).
  useEffect(() => {
    if (!open || !projectPath) return;
    let cancelled = false;
    setLoading(true);
    api
      .getProjectBranchConfig(projectPath)
      .then((c) => { if (!cancelled) setConfig(c); })
      .catch(() => { if (!cancelled) setConfig(DEFAULT_BRANCH_CONFIG); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, projectPath]);

  const setPrefix = (typeId: string, prefix: string) =>
    setConfig((c) => ({
      ...c,
      rules: { ...c.rules, [typeId]: { prefix } },
    }));

  const validation = useMemo(() => validateBranchConfig(config), [config]);

  const save = async () => {
    if (!validation.ok) { toast.error(validation.reason); return; }
    setSaving(true);
    try {
      await api.setProjectBranchConfig(projectPath, config);
      toast.success("Branch naming saved");
      onSaved(config);
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      className="max-w-lg"
      labelledBy="branch-naming-title"
      initialFocusRef={firstFieldRef}
    >
      <div className="flex items-center justify-between border-b border-border/60 pb-3">
        <div className="min-w-0">
          <h2 id="branch-naming-title" className="text-base font-semibold">
            Branch naming
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
          When a task runs isolated, agetor creates a git branch named from these
          rules. The prefix is chosen by the task&apos;s type.
        </p>

        <section className="space-y-2.5">
          {TASK_TYPES.map((t, i) => {
            const prefix = config.rules[t.id]?.prefix ?? "";
            const example = buildBranchName(config, t.id, EXAMPLE_TITLE, { token: "a1b2c3" });
            const legal = validateBranchName(example).ok;
            return (
              <div key={t.id} className="grid grid-cols-[4.5rem_1fr] items-center gap-2">
                <label className="text-xs text-muted-foreground" htmlFor={`prefix-${t.id}`}>
                  {t.label}
                </label>
                <div className="space-y-0.5">
                  <Input
                    id={`prefix-${t.id}`}
                    ref={i === 0 ? firstFieldRef : undefined}
                    value={prefix}
                    onChange={(e) => setPrefix(t.id, e.target.value)}
                    placeholder="feature/"
                    spellCheck={false}
                    className="h-8 font-mono text-xs"
                  />
                  <p
                    className={cn(
                      "font-mono text-[10px]",
                      legal ? "text-muted-foreground" : "text-destructive",
                    )}
                  >
                    {example}
                  </p>
                </div>
              </div>
            );
          })}
        </section>

        <label className="flex items-center justify-between gap-3">
          <span className="min-w-0">
            <span className="text-xs">Include card name in the branch</span>
            <span className="block text-[10px] text-muted-foreground">
              Off &rarr; branch body is a short unique id instead of the title slug.
            </span>
          </span>
          <Switch
            checked={config.includeSlug}
            onCheckedChange={(v) => setConfig((c) => ({ ...c, includeSlug: v }))}
          />
        </label>

        {!validation.ok && (
          <p className="text-xs text-destructive">{validation.reason}</p>
        )}

        <div className="flex items-center justify-end gap-2 border-t border-border/60 pt-3">
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={() => void save()} disabled={loading || saving || !validation.ok}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
