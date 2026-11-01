import { useRef } from "react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { quitDialogModel, type QuitDialogAction, type QuitRequestEvent } from "@/lib/quit-dialog";

const TITLE_ID = "agetor-quit-dialog-title";
const DESC_ID = "agetor-quit-dialog-desc";

/**
 * Confirm-on-quit modal for a `quit_request` AppEvent (replaces the generic
 * `confirm()` App.tsx used to raise; docs/plans/always-on-host.md §3.6). The
 * wording and the button set come from the pure `quitDialogModel`. A quit
 * button posts `/app/force-quit` — fire-and-forget, the response races the
 * process exit — and Cancel just closes.
 */
export function QuitConfirmDialog({
  request,
  onClose,
}: {
  /** The pending `quit_request`, or `null` while the dialog is closed. */
  request: QuitRequestEvent | null;
  onClose: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const model = request ? quitDialogModel(request) : null;

  const run = (action: QuitDialogAction) => {
    if (!request || action === "cancel") {
      onClose();
      return;
    }
    const completely = action === "quit-completely" || request.completely;
    onClose();
    void api.forceQuit({ completely }).catch(() => { /* response races process exit */ });
  };

  return (
    <Dialog
      open={request !== null}
      onClose={onClose}
      className="max-w-sm"
      labelledBy={TITLE_ID}
      describedBy={DESC_ID}
      initialFocusRef={cancelRef}
    >
      {model && (
        <div data-testid="quit-dialog">
          <h2 id={TITLE_ID} className="text-sm font-semibold">{model.title}</h2>
          <div id={DESC_ID} className="mt-2 space-y-2 text-xs text-muted-foreground">
            <div>{model.body}</div>
            {model.titlesPreview && (
              <div className="font-mono text-foreground/80">{model.titlesPreview}</div>
            )}
          </div>
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            {model.actions.map((action) => (
              <Button
                key={action}
                ref={action === "cancel" ? cancelRef : undefined}
                variant={action === "cancel" ? "outline" : action === "quit-completely" ? "destructive" : "default"}
                data-testid={`quit-dialog-${action}`}
                onClick={() => run(action)}
              >
                {model.labels[action]}
              </Button>
            ))}
          </div>
        </div>
      )}
    </Dialog>
  );
}
