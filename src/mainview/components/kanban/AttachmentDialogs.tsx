// The two "click failed" dialogs shared by every attachment-rendering
// surface (`AttachmentChips`, `SentFilesCard`): the path is genuinely gone
// (a 404 from the server) vs. the server found it but couldn't open it (OS
// declined, headless 501, a relative path with no resolvable cwd, a network
// error). Extracted out of `AttachmentChips.tsx` so both surfaces render
// identical copy/markup/ids instead of drifting apart — NOT a behavior-
// preserving extraction, though: both dialogs' own Close button now routes
// through the same `onClose` prop callers already wire up for Escape/
// backdrop dismissal, where before the Close button had its own separate
// handler. In `AttachmentChips.tsx` this means clicking Close now also
// clears that chip's remembered 404 mark, which previously happened only
// via Escape/backdrop — a deliberate unification, not an accident.
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export const ATTACHMENT_NOT_FOUND_TITLE_ID = "attachment-not-found-title";
export const ATTACHMENT_OPEN_ERROR_TITLE_ID = "attachment-open-error-title";

/** Rendered whenever a click resolves to a definite 404 — the underlying
 *  file/folder no longer exists. `path === null` keeps the dialog closed
 *  (mirrors `Dialog`'s own `open` boolean, but keyed off the path itself so
 *  callers don't need a separate boolean). */
export function AttachmentNotFoundDialog({
  path,
  onClose,
}: {
  path: string | null;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={path !== null}
      onClose={onClose}
      labelledBy={ATTACHMENT_NOT_FOUND_TITLE_ID}
      className="max-w-md"
    >
      <h2 id={ATTACHMENT_NOT_FOUND_TITLE_ID} className="text-sm font-semibold">
        Attachment not found
      </h2>
      <p className="mt-2 break-all font-mono text-xs text-muted-foreground">{path}</p>
      <div className="mt-4 flex justify-end">
        <Button size="sm" variant="outline" onClick={onClose}>
          Close
        </Button>
      </div>
    </Dialog>
  );
}

/** Rendered for any other open failure — the path may well still exist, so
 *  copy is deliberately non-committal about that. */
export function AttachmentOpenErrorDialog({
  path,
  message,
  onClose,
}: {
  path: string | null;
  message: string | null;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={path !== null}
      onClose={onClose}
      labelledBy={ATTACHMENT_OPEN_ERROR_TITLE_ID}
      className="max-w-md"
    >
      <h2 id={ATTACHMENT_OPEN_ERROR_TITLE_ID} className="text-sm font-semibold">
        Couldn't open attachment
      </h2>
      <p className="mt-2 break-all font-mono text-xs text-muted-foreground">{path}</p>
      <p className="mt-2 text-xs text-muted-foreground">{message}</p>
      <div className="mt-4 flex justify-end">
        <Button size="sm" variant="outline" onClick={onClose}>
          Close
        </Button>
      </div>
    </Dialog>
  );
}
