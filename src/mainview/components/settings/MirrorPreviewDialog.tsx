import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { previewSections } from "@/lib/stack-editor";
import type { MirrorPreview } from "../../../shared/types.ts";

interface Props {
  preview: MirrorPreview | null;
  saving: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

const TITLE_ID = "mirror-preview-title";
const DESC_ID = "mirror-preview-desc";

function Group({ title, items, tone }: { title: string; items: string[]; tone?: "warning" }) {
  if (items.length === 0) return null;
  return (
    <div className="space-y-0.5">
      <p className={tone === "warning" ? "text-xs font-medium text-warning" : "text-xs font-medium"}>{title}</p>
      <ul className="list-disc space-y-0.5 pl-4 text-[11px] text-muted-foreground">
        {items.map((item, i) => (
          // Names come from the account's own config tree: plain text only.
          <li key={`${i}:${item}`} className="break-all">{item}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Shown on Save when the mirror would overwrite or remove something a backup
 * account already had. Portaled to `document.body` like the confirm dialog so
 * it stacks above Settings; `Dialog` gives it Escape and the focus trap, and
 * only the topmost dialog reacts to Escape, so Escape closes this first.
 */
export function MirrorPreviewDialog({ preview, saving, onCancel, onConfirm }: Props) {
  const sections = preview ? previewSections(preview) : [];
  return createPortal(
    <Dialog
      open={preview !== null}
      onClose={() => { if (!saving) onCancel(); }}
      className="max-h-[80vh] w-full max-w-lg overflow-y-auto"
      labelledBy={TITLE_ID}
      describedBy={DESC_ID}
    >
      {preview && (
        <div data-testid="mirror-preview-dialog">
          <h2 id={TITLE_ID} className="text-sm font-semibold">Mirror will change backup accounts</h2>
          <p id={DESC_ID} className="mt-1 text-xs text-muted-foreground">
            Saving copies the primary's config onto each backup. Originals are saved first, and Restore pre-stack
            config on the account puts them back.
          </p>
          <div className="mt-3 space-y-3">
            {sections.map((s) => (
              <section key={s.harnessId} className="space-y-1.5 rounded-md border border-border/60 p-2">
                <p className="text-xs font-semibold">{s.label}</p>
                <Group title="Will be overwritten or removed" items={s.overwrites} tone="warning" />
                <Group title="Backed up first" items={s.backedUp} />
                <Group title="Kept (edited on this account)" items={s.kept} />
                <Group title="Warnings" items={s.warnings} tone="warning" />
              </section>
            ))}
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" onClick={onCancel} disabled={saving}>Cancel</Button>
            <Button onClick={onConfirm} disabled={saving}>{saving ? "Saving…" : "Save and mirror"}</Button>
          </div>
        </div>
      )}
    </Dialog>,
    document.body,
  );
}
