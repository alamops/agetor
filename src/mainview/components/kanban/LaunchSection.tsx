import { useEffect, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { Disclosure } from "@/components/ui/disclosure";
import { cn } from "@/lib/utils";
import {
  launchMoreKey,
  launchSectionKey,
  readCollapsed,
  writeCollapsed,
  type LaunchSectionId,
  type LaunchSurface,
} from "@/lib/panel-collapse";

/** A persisted boolean (`"1"`/`"0"` in localStorage), read synchronously in the
 *  lazy initializer so the section never paints in the wrong state and snaps.
 *  For a section it means "collapsed", for More options "open"; both default to
 *  false (the section open, More options closed). */
function usePersistedFlag(key: string): [boolean, (v: boolean) => void] {
  const [value, setValue] = useState<boolean>(() => readCollapsed(key));
  useEffect(() => {
    writeCollapsed(key, value);
  }, [key, value]);
  return [value, setValue];
}

export interface LaunchSectionProps {
  id: LaunchSectionId;
  surface: LaunchSurface;
  title: string;
  /** One line shown in the header while the section is collapsed. */
  summary: ReactNode;
  tone?: "default" | "danger";
  children: ReactNode;
  /** Rarely-changed fields behind a "More options" disclosure. `notes` announce
   *  a non-default value (or an error) while it is closed. */
  more?: { notes: string[]; tone?: "default" | "danger"; children: ReactNode };
  className?: string;
}

/**
 * "More options": the rarely-changed fields of a launch section behind a
 * disclosure whose open state persists per surface. `notes` announce a
 * non-default value (or an error, with `tone="danger"`) on the closed row, so
 * nothing that changes the launch hides silently.
 */
export function MoreOptions({
  surface,
  section,
  notes,
  tone = "default",
  children,
}: {
  surface: LaunchSurface;
  section: LaunchSectionId;
  notes: string[];
  tone?: "default" | "danger";
  children: ReactNode;
}) {
  const [open, setOpen] = usePersistedFlag(launchMoreKey(surface, section));
  return (
    <Disclosure
      open={open}
      onOpenChange={setOpen}
      label="More options"
      note={notes.length ? notes.join(" · ") : undefined}
      noteTone={tone}
      testId={`launch-more-${section}`}
    >
      <div className="space-y-3">{children}</div>
    </Disclosure>
  );
}

/**
 * A collapsible group of a launch form (Workspace, Agent). Its header is a
 * button (`aria-expanded` / `aria-controls`) whose summary line keeps the
 * choices readable while collapsed; "More options" hides the rare fields. Both
 * states persist per surface in localStorage (`lib/panel-collapse.ts`).
 */
export function LaunchSection({ id, surface, title, summary, tone = "default", children, more, className }: LaunchSectionProps) {
  const [collapsed, setCollapsed] = usePersistedFlag(launchSectionKey(surface, id));
  const bodyId = `launch-section-${surface}-${id}-body`;
  const toggleId = `launch-section-${surface}-${id}-toggle`;
  return (
    <section
      data-testid={`launch-section-${id}`}
      data-collapsed={collapsed || undefined}
      aria-labelledby={toggleId}
      className={cn("rounded-lg border border-border bg-background/40", className)}
    >
      <button
        type="button"
        id={toggleId}
        data-testid={`launch-section-${id}-toggle`}
        aria-expanded={!collapsed}
        aria-controls={bodyId}
        onClick={() => setCollapsed(!collapsed)}
        className="flex min-h-9 w-full items-center gap-1.5 rounded-lg px-3 py-2 text-left transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronRight aria-hidden className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", !collapsed && "rotate-90")} />
        <span className="text-xs font-semibold">{title}</span>
        {collapsed ? (
          <span
            data-testid={`launch-section-${id}-summary`}
            data-tone={tone}
            className={cn("min-w-0 flex-1 truncate text-right text-2xs", tone === "danger" ? "text-destructive" : "text-muted-foreground")}
          >
            {summary}
          </span>
        ) : null}
      </button>
      {collapsed ? null : (
        <div id={bodyId} className="space-y-3 px-3 pb-3">
          {children}
          {more ? (
            <MoreOptions surface={surface} section={id} notes={more.notes} tone={more.tone}>
              {more.children}
            </MoreOptions>
          ) : null}
        </div>
      )}
    </section>
  );
}
