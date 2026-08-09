import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useConfirm } from "@/components/ui/confirm";
import type { SavedPrompt } from "../../../shared/types.ts";

type FormState = { id: string | null; name: string; content: string };

/**
 * "Saved Prompts" Settings section — a flat CRUD list of reusable prompt
 * snippets, not tied to any task or project. Mirrors GitHubTokensSection's
 * load/save/delete shape; the add/edit form is a single inline component
 * (`PromptForm`) shared by both flows rather than a separate create vs.
 * edit path, since the fields are identical.
 */
export function SavedPromptsSection() {
  const [prompts, setPrompts] = useState<SavedPrompt[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const confirm = useConfirm();

  const refresh = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const result = await api.listSavedPrompts();
      setPrompts(result);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const save = async () => {
    if (!form) return;
    const name = form.name.trim();
    const content = form.content.trim();
    if (!name || !content) return;
    setSaving(true);
    setSaveError(null);
    try {
      const saved = form.id
        ? await api.updateSavedPrompt(form.id, { name, content })
        : await api.createSavedPrompt({ name, content });
      setPrompts((prev) => {
        const idx = prev.findIndex((p) => p.id === saved.id);
        if (idx === -1) return [...prev, saved];
        const next = [...prev];
        next[idx] = saved;
        return next;
      });
      setForm(null);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (p: SavedPrompt) => {
    const ok = await confirm({
      title: `Delete "${p.name}"?`,
      description: "The prompt will be removed permanently.",
      confirmLabel: "Delete",
      variant: "destructive",
    });
    if (!ok) return;
    setDeletingId(p.id);
    setDeleteError(null);
    try {
      await api.deleteSavedPrompt(p.id);
      setPrompts((prev) => prev.filter((x) => x.id !== p.id));
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="space-y-4 pt-3 text-sm">
      <div className="flex items-center justify-between">
        <label className="text-xs text-muted-foreground">Saved Prompts</label>
        {!form && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setForm({ id: null, name: "", content: "" })}
          >
            <Plus className="mr-1 size-3.5" /> Add prompt
          </Button>
        )}
      </div>

      {loadError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive-foreground">
          {loadError}
        </div>
      )}

      {!loading && (
        <div className="space-y-1.5">
          {prompts.map((p) => (
            <div
              key={p.id}
              className="flex items-center gap-2 rounded-md border border-border/60 px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{p.name}</div>
                <div className="truncate text-[11px] text-muted-foreground">{p.content}</div>
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setForm({ id: p.id, name: p.name, content: p.content })}
                disabled={form !== null}
              >
                Edit
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void remove(p)}
                disabled={deletingId === p.id}
              >
                Delete
              </Button>
            </div>
          ))}
          {prompts.length === 0 && (
            <p className="text-xs text-muted-foreground">No saved prompts yet.</p>
          )}
        </div>
      )}

      {deleteError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive-foreground">
          {deleteError}
        </div>
      )}

      {form && (
        <PromptForm
          form={form}
          saving={saving}
          error={saveError}
          onChange={setForm}
          onSave={() => void save()}
          onCancel={() => {
            setForm(null);
            setSaveError(null);
          }}
        />
      )}
    </div>
  );
}

function PromptForm({
  form,
  saving,
  error,
  onChange,
  onSave,
  onCancel,
}: {
  form: FormState;
  saving: boolean;
  error: string | null;
  onChange: (next: FormState) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const disabled = saving || !form.name.trim() || !form.content.trim();
  return (
    <div className="space-y-2 rounded-md border border-border/60 p-3">
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">Name</label>
        <Input
          value={form.name}
          onChange={(e) => onChange({ ...form, name: e.target.value })}
          placeholder="Bug repro checklist"
        />
      </div>
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">Content</label>
        <Textarea
          value={form.content}
          onChange={(e) => onChange({ ...form, content: e.target.value })}
          rows={5}
        />
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive-foreground">
          {error}
        </div>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button size="sm" onClick={onSave} disabled={disabled}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}
