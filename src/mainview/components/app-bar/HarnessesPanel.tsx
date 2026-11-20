import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { placeContextMenu } from "@/lib/context-menu";
import type { HarnessBarModel } from "@/lib/harness-bar";
import { AccountUsageRow } from "./AccountUsageRow";
import { FailoverTaskRow, StackSection, type PanelActions } from "./StackSection";

export interface HarnessesPanelBodyProps extends PanelActions {
  model: HarnessBarModel;
  now: number;
  /** Called before every action runs, so the panel is closed first. */
  onClose: (opts?: { restoreFocus: boolean }) => void;
}

/**
 * The panel's content, without the portal: stacks first (the live Harness
 * Stacks), then failover activity outside any live stack, then the other
 * accounts (running → problem → DB order, as `buildHarnessBarModel` ordered
 * them). Exported so a test can render it statically.
 */
export function HarnessesPanelBody({
  model,
  now,
  onClose,
  onRefreshUsage,
  onOpenHarnessSettings,
  onOpenStackHistory,
  onOpenFailoverTask,
}: HarnessesPanelBodyProps) {
  // Every navigating action closes the panel first (focus is not restored: the
  // thing it opens takes focus).
  const closeThen = <A extends unknown[]>(fn: (...args: A) => void) => (...args: A) => {
    onClose({ restoreFocus: false });
    fn(...args);
  };
  const manage = closeThen(onOpenHarnessSettings);
  const history = closeThen(onOpenStackHistory);
  const openTask = closeThen(onOpenFailoverTask);
  const empty = model.stacks.length === 0 && model.accounts.length === 0;
  return (
    <>
      {empty && (
        <div className="space-y-2 px-3 py-4 text-sm">
          <p className="text-muted-foreground">No harnesses enabled</p>
          <Button type="button" variant="outline" size="sm" onClick={manage}>
            Open Settings → Harnesses
          </Button>
        </div>
      )}
      {model.stacks.map((unit) => (
        <StackSection
          key={unit.stack.id}
          unit={unit}
          now={now}
          onRefreshUsage={onRefreshUsage}
          onOpenHarnessSettings={manage}
          onOpenStackHistory={history}
          onOpenFailoverTask={openTask}
        />
      ))}
      {model.otherFailoverTasks.length > 0 && (
        <section aria-label="Other failover activity" className="border-t border-border/60 px-1 py-2">
          <h3 className="px-2 pb-1 text-xs font-semibold text-muted-foreground">Other failover activity</h3>
          {model.otherFailoverTasks.map((t) => (
            <FailoverTaskRow key={t.taskId} task={t} onOpen={openTask} />
          ))}
        </section>
      )}
      {model.accounts.length > 0 && (
        <section
          aria-label={model.stacks.length > 0 ? "Other accounts" : "Accounts"}
          className={model.stacks.length > 0 ? "border-t border-border/60" : undefined}
        >
          {model.stacks.length > 0 && (
            <h3 className="px-3 pb-0 pt-2 text-xs font-semibold text-muted-foreground">Other accounts</h3>
          )}
          <div className="divide-y divide-border/60">
            {model.accounts.map((a) => (
              <AccountUsageRow key={a.harnessId} {...a} now={now} onRefresh={onRefreshUsage} />
            ))}
          </div>
        </section>
      )}
    </>
  );
}

export interface HarnessesPanelProps extends HarnessesPanelBodyProps {
  open: boolean;
  /** The Harnesses button: the panel hangs under it and a press on it is not "outside". */
  anchor: HTMLElement | null;
  panelId: string;
}

/**
 * The portaled Harnesses panel. It renders nothing while closed. Open, it is
 * a non-modal `role="dialog"` fixed under the button, portaled to
 * `document.body` (a `fixed` descendant of RunPanel's transformed `<aside>`
 * would be rebased onto it). It carries `data-popover-open` only while open,
 * so RunPanel and the board's search box yield Escape to it, and
 * `data-popover-keys="escape-only"`, so ⌘F keeps working while it is open
 * (`find-shortcut.ts`).
 *
 * Escape closes it. The listener is on `document` in the bubble phase, so
 * React's root handlers (the search box's marker check) run first; it checks
 * `defaultPrevented` first, then claims the event. A press outside, a window
 * resize and every action also close it.
 */
export function HarnessesPanel({ open, anchor, panelId, onClose, ...body }: HarnessesPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) setPos(null);
  }, [open]);

  // Place under the anchor once the panel has a measured box. Focus waits for
  // the effect below: until `pos` is committed the panel is
  // `visibility: hidden`, and a hidden element cannot take focus.
  useLayoutEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel || !anchor) return;
    const rect = anchor.getBoundingClientRect();
    setPos(
      placeContextMenu({
        x: rect.left,
        y: rect.bottom + 4,
        width: panel.offsetWidth,
        height: panel.offsetHeight,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      }),
    );
  }, [open, anchor]);

  // Take focus once per open, on the commit that makes the panel visible.
  // Keyed on the boolean, so a re-placement while open never steals focus
  // back from a control inside the panel.
  const placed = pos !== null;
  useLayoutEffect(() => {
    if (open && placed) panelRef.current?.focus({ preventScroll: true });
  }, [open, placed]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      const panel = panelRef.current;
      const active = document.activeElement;
      onCloseRef.current({ restoreFocus: !!panel && !!active && panel.contains(active) });
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (panelRef.current?.contains(t) || anchor?.contains(t)) return;
      onCloseRef.current({ restoreFocus: false });
    };
    const onResize = () => onCloseRef.current({ restoreFocus: false });
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("resize", onResize);
    };
  }, [open, anchor]);

  if (!open) return null;
  return createPortal(
    <div
      ref={panelRef}
      id={panelId}
      role="dialog"
      aria-label="Harnesses"
      data-testid="harnesses-panel"
      data-popover-open=""
      data-popover-keys="escape-only"
      tabIndex={-1}
      style={{
        width: "min(24rem, calc(100vw - 16px))",
        ...(pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0, visibility: "hidden" as const }),
      }}
      className="fixed z-50 max-h-[70vh] overflow-y-auto rounded-md border border-border bg-card text-card-foreground shadow-xl outline-none"
    >
      <HarnessesPanelBody onClose={onClose} {...body} />
    </div>,
    document.body,
  );
}
