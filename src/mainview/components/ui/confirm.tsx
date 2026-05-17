import * as React from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";

export interface ConfirmOptions {
  title: string;
  /** Body content. Plain string or any JSX. */
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** `destructive` paints the confirm button red and defaults focus to Cancel. */
  variant?: "default" | "destructive";
}

type Resolver = (ok: boolean) => void;

const ConfirmContext = React.createContext<
  ((opts: ConfirmOptions) => Promise<boolean>) | null
>(null);

const TITLE_ID = "agetor-confirm-title";
const DESC_ID = "agetor-confirm-desc";

/**
 * Mount once near the React root. Renders a single dialog driven by whatever
 * the latest `useConfirm()` call requested — so callers stay simple:
 *
 *     const confirm = useConfirm();
 *     if (await confirm({ title: "Delete?" })) doIt();
 *
 * The promise resolves `true` on confirm and `false` on Cancel, backdrop click,
 * Escape, or a superseding `confirm()` call. For `variant: "destructive"` we
 * default focus to Cancel so a fat-finger Enter doesn't fire the destructive
 * action.
 */
export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [pending, setPending] = React.useState<ConfirmOptions | null>(null);
  // Single source of truth for the active resolver. `pending` only describes
  // what to render.
  const activeResolver = React.useRef<Resolver | null>(null);

  const cancelBtnRef = React.useRef<HTMLButtonElement>(null);
  const confirmBtnRef = React.useRef<HTMLButtonElement>(null);

  const confirm = React.useCallback((opts: ConfirmOptions) => {
    // If a dialog is already open and a new confirm() is requested, resolve
    // the previous one with `false` so its caller doesn't hang.
    activeResolver.current?.(false);
    return new Promise<boolean>((resolve) => {
      activeResolver.current = resolve;
      setPending(opts);
    });
  }, []);

  const settle = React.useCallback((ok: boolean) => {
    activeResolver.current?.(ok);
    activeResolver.current = null;
    setPending(null);
  }, []);

  // For destructive variants, focus Cancel; otherwise focus Confirm. The ref
  // identity changes between stacked calls, which causes the Dialog to
  // re-apply initial focus correctly.
  const initialFocusRef =
    pending?.variant === "destructive" ? cancelBtnRef : confirmBtnRef;

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Dialog
        open={!!pending}
        onClose={() => settle(false)}
        className="max-w-sm"
        labelledBy={TITLE_ID}
        describedBy={pending?.description !== undefined ? DESC_ID : undefined}
        initialFocusRef={initialFocusRef}
      >
        {pending && (
          <>
            <h2 id={TITLE_ID} className="text-sm font-semibold">{pending.title}</h2>
            {pending.description !== undefined && (
              <div id={DESC_ID} className="mt-2 text-xs text-muted-foreground">
                {pending.description}
              </div>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <Button
                ref={cancelBtnRef}
                variant="outline"
                onClick={() => settle(false)}
              >
                {pending.cancelLabel ?? "Cancel"}
              </Button>
              <Button
                ref={confirmBtnRef}
                variant={pending.variant === "destructive" ? "destructive" : "default"}
                onClick={() => settle(true)}
              >
                {pending.confirmLabel ?? "Confirm"}
              </Button>
            </div>
          </>
        )}
      </Dialog>
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  const ctx = React.useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm must be used inside <ConfirmProvider>");
  return ctx;
}
