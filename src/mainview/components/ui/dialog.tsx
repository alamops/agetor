import * as React from "react";
import { cn } from "@/lib/utils";

interface DialogProps {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  className?: string;
  /** id of the element inside `children` that titles the dialog. */
  labelledBy?: string;
  /** id of the element inside `children` that describes the dialog body. */
  describedBy?: string;
  /**
   * Element to focus when the dialog opens. If omitted (or the ref is null),
   * focus lands on the dialog panel itself so screen readers announce it.
   * Reading this ref is reactive: when its current target changes between
   * stacked open()s, the dialog re-applies focus.
   */
  initialFocusRef?: React.RefObject<HTMLElement | null>;
}

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

// Dialogs can nest (Settings → GitHub setup guide, confirm.tsx overlays over
// another Dialog): each open Dialog registers its own document-level keydown
// listener, and listeners fire in registration order — so the OUTER dialog's
// handler runs first on a shared Escape/Tab keypress. Track panels in
// open-order here so onKey can bail out unless it belongs to the topmost
// (last-registered) panel; that keeps Escape/Tab scoped to the dialog
// actually on top instead of always resolving to the outermost one.
const openDialogStack: HTMLElement[] = [];

/**
 * Overlay dialog with proper modal manners:
 *
 *  - Focus is moved into the dialog on open (consumer-chosen via
 *    `initialFocusRef`, otherwise the panel itself).
 *  - Tab is trapped so focus can't escape into the page behind.
 *  - Escape and backdrop click invoke `onClose`. `onClose` is captured into a
 *    ref so a churning identity on the parent doesn't re-arm the keydown
 *    listener / body-scroll lock every render.
 *  - On close, focus is returned to whatever element triggered the open.
 *
 *  We label the dialog via `aria-labelledby` / `aria-describedby`, pointed at
 *  consumer-rendered ids — so screen readers announce the title and body
 *  text instead of just "dialog".
 */
export function Dialog({
  open,
  onClose,
  children,
  className,
  labelledBy,
  describedBy,
  initialFocusRef,
}: DialogProps) {
  const panelRef = React.useRef<HTMLDivElement>(null);
  const onCloseRef = React.useRef(onClose);
  // Keep the ref current without making it a dep of the effect below.
  onCloseRef.current = onClose;

  // One-shot setup per "open" cycle: keydown trap, scroll lock, focus
  // restoration target. Does NOT depend on initialFocusRef — focus is applied
  // in a separate effect so swapping the focus target on a stacked open()
  // refocuses without tearing down the listener.
  React.useEffect(() => {
    if (!open) return;
    const trigger = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    // Register this panel as the topmost open dialog. Guard for null: the
    // ref is only populated once the panel has rendered, and this effect
    // runs post-render (post-commit) so it's safe here.
    const panel = panelRef.current;
    if (panel) openDialogStack.push(panel);

    const onKey = (e: KeyboardEvent) => {
      // Only the topmost dialog reacts — with dialogs nested (Settings →
      // setup guide, confirm.tsx overlays), document listeners fire in
      // registration order, so the OUTER dialog's handler would otherwise
      // run first and close the wrong layer.
      if (panelRef.current !== openDialogStack[openDialogStack.length - 1]) return;

      // A nested popover (SlashAutocomplete's Escape/Tab/Enter handling) may
      // have already consumed this key for its own purposes — don't also
      // drive the dialog's Escape-close or Tab-trap on top of that.
      if (e.defaultPrevented) return;

      if (e.key === "Escape") {
        // Yield to an open popover so Escape closes IT first, not the whole
        // dialog. `defaultPrevented` above can't catch this case: ExtensionPicker
        // and SearchSelect register their own document-level keydown listeners,
        // but Dialog's listener is registered earlier (it mounted first) and so
        // runs first on the same keydown — by the time theirs would call
        // preventDefault(), Dialog has already acted. The DOM marker is the
        // only thing observable at this point.
        //
        // The query is scoped to THIS panel (`panelRef.current`), not
        // document-wide: a `[data-popover-open]` marker carried by a popover
        // that lives outside the topmost dialog (e.g. an `InfoTip` left open
        // elsewhere on the page while a dialog opens programmatically) must
        // not suppress this dialog's Escape.
        //
        // Full carrier list (verify with `grep -rn "data-popover-open"
        // src/mainview`): `SearchSelect` (ui/search-select.tsx),
        // `MultiSearchSelect` (ui/multi-search-select.tsx), `InfoTip`
        // (ui/info-tip.tsx), `MessageHistoryPicker`, the task context menu
        // (ui/context-menu.tsx — portals to `document.body`, but it's never
        // opened from inside a dialog and owns its own Escape listener),
        // `SlashAutocomplete`, and `ExtensionPicker`. None of these carriers
        // portal out of their parent (the context menu is the one exception,
        // and it doesn't apply here for the reason above), which is what
        // makes panel-scoping safe.
        //
        // Invariant every carrier must uphold: render the marker ONLY while
        // open, and close itself on Escape — otherwise this dialog becomes
        // un-closable by keyboard while that popover happens to be open
        // somewhere on the page.
        //
        // A carrier that wants Escape yielded to it but does NOT want to
        // swallow other document-level shortcuts pairs the marker with
        // `data-popover-keys="escape-only"` — e.g. RunPanel's Cmd/Ctrl+F
        // handler additionally requires
        // `:not([data-popover-keys="escape-only"])` so an open `/`
        // autocomplete or Extensions popover doesn't also block Cmd+F.
        if (panelRef.current?.querySelector("[data-popover-open]")) return;
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const root = panelRef.current;
      if (!root) return;
      const items = root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      if (items.length === 0) {
        // No focusable children — keep focus on the panel itself.
        e.preventDefault();
        root.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      const inside = !!active && root.contains(active);
      if (e.shiftKey) {
        if (!inside || active === first) { e.preventDefault(); last.focus(); }
      } else {
        if (!inside || active === last) { e.preventDefault(); first.focus(); }
      }
    };

    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      // Splice by identity — unmount order isn't guaranteed to match open
      // order (e.g. an inner dialog can close first), so don't assume this
      // panel is last in the stack.
      if (panel) {
        const idx = openDialogStack.indexOf(panel);
        if (idx !== -1) openDialogStack.splice(idx, 1);
      }
      // Return focus to whatever opened us. Guard against the trigger having
      // been removed from the DOM in the meantime.
      if (trigger && document.contains(trigger)) trigger.focus();
    };
  }, [open]);

  // Apply (and re-apply) initial focus. Splitting this out lets confirm.tsx
  // swap its initialFocusRef between Cancel and Confirm without tearing down
  // the scroll lock / keydown listener above.
  React.useEffect(() => {
    if (!open) return;
    const target = initialFocusRef?.current ?? panelRef.current;
    target?.focus();
  }, [open, initialFocusRef]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={() => onCloseRef.current()}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className={cn(
          "w-full max-w-lg rounded-lg border border-border bg-card p-4 text-card-foreground shadow-lg outline-none",
          className,
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
