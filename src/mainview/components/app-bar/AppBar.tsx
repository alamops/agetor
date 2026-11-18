import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { FolderGit2, GitPullRequest, Import, MoreHorizontal, Settings, Workflow, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ContextMenu, type ContextMenuItem } from "@/components/ui/context-menu";
import { Tooltip } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { stepHides } from "@/lib/app-bar-fit";
import { buildHarnessBarModel } from "@/lib/harness-bar";
import { cn } from "@/lib/utils";
import iconUrl from "../../../assets/agetor.iconset/icon_32x32@2x.png";
import type { AgentStatus, Harness, HarnessLimitState, HarnessQuota, HarnessStack, Task } from "../../../shared/types.ts";
import { HarnessesButton } from "./HarnessesButton";
import { HarnessesPanel } from "./HarnessesPanel";
import { useAppBarFit } from "./use-app-bar-fit";
import { useBarClock } from "./use-bar-clock";

export interface AppBarProps {
  agents: AgentStatus[];
  harnesses: Harness[];
  stacks: HarnessStack[];
  limitStates: HarnessLimitState[];
  usage: Record<string, HarnessQuota>;
  tasks: Task[];
  /** The Pipelines page (or a pipeline run) is showing: its button reads as pressed. */
  pipelinesActive: boolean;
  /** Bumped by App when something else took over the screen (a menu action):
   *  closes the panel and the More menu. */
  dismissNonce: number;
  onOpenGit(): void;
  onOpenImportSessions(): void;
  onOpenWorktrees(): void;
  onOpenPipelines(): void;
  onOpenSettings(): void;
  onOpenHarnessSettings(): void;
  onOpenStackHistory(stackId: string): void;
  onOpenFailoverTask(taskId: string): void;
  onRefreshUsage(harnessId: string): Promise<void>;
}

interface ActionSpec {
  key: string;
  label: string;
  tooltip: string;
  icon: LucideIcon;
  onClick: () => void;
  testId?: string;
  pressed?: boolean;
  /** `data-fit-part` on the ghost replica. */
  fitPart?: "import";
}

/** The 32 px px-pinned icon box (D-P1): the bar is 40 px at every UI zoom, so
 *  the control boxes cannot be rem-sized; the glyph inside still scales. */
const ICON_BOX = "h-[32px] w-[32px] shrink-0";

/**
 * The window app bar.
 *
 * Layout: the traffic lights (`titleBarStyle: "hiddenInset"`, offset in
 * `src/bun/index.ts`) sit in an 80 px left inset; then the logo, the wordmark
 * and the Harnesses button; the action buttons sit at the right. The bar is
 * pinned at 40 px and the inset at 80 px at every UI zoom (the zoom scales the
 * root font size, so the control boxes are px, not rem). Keep `pl-[80px]` and
 * `h-[40px]` in sync with `trafficLightOffset` in `src/bun/index.ts`.
 *
 * Drag: the header is a drag region, so empty bar space moves the window.
 * Only the controls carry `electrobun-webkit-app-region-no-drag` (never a
 * wrapper), and a double-click on empty space zooms the window, as AppKit's
 * title bar does (a click on a control must not).
 *
 * Fit: a hidden, inert copy of the bar at step 0 (the ghost) is measured, and
 * `useAppBarFit` picks the collapse step (wordmark → Import into More →
 * Harnesses text → "until"). The ghost renders only through `measure`
 * variants: no testids, names or handlers, so the live bar's locators stay
 * unique. Contract: docs/architecture/app-bar.md.
 */
export const AppBar = memo(function AppBar(p: AppBarProps) {
  const headerRef = useRef<HTMLElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const step = useAppBarFit(headerRef, ghostRef);
  const hides = stepHides(step);
  const panelId = useId();

  const [panelOpen, setPanelOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [moreAt, setMoreAt] = useState<{ x: number; y: number } | null>(null);
  const [tick, setTick] = useState(0);
  const bump = useCallback(() => setTick((t) => t + 1), []);

  // `now` is re-read when the data changes (a fresh poll must not be judged by
  // a clock from minutes ago) and when the bar's own timer fires.
  const { agents, harnesses, stacks, limitStates, usage, tasks } = p;
  const now = useMemo(() => Date.now(), [agents, harnesses, stacks, limitStates, usage, tasks, tick]);
  const model = useMemo(
    () => buildHarnessBarModel({ agents, harnesses, stacks, limitStates, usage, tasks }, now),
    [agents, harnesses, stacks, limitStates, usage, tasks, now],
  );
  useBarClock(model.nextChangeAt, panelOpen, tick, bump);

  // Something else took over the screen (a menu action): close our popovers.
  useEffect(() => {
    setPanelOpen(false);
    setMoreAt(null);
  }, [p.dismissNonce]);
  // The More button disappears below step 2; its menu goes with it.
  useEffect(() => {
    if (!hides.importInMore) setMoreAt(null);
  }, [hides.importInMore]);

  // The Harnesses button, kept as state (the panel positions itself from it)
  // and as a ref (closing with `restoreFocus` focuses it).
  const anchorRef = useRef<HTMLElement | null>(null);
  const setAnchorEl = useCallback((el: HTMLButtonElement | null) => {
    anchorRef.current = el;
    setAnchor(el);
  }, []);
  const closePanel = useCallback((opts?: { restoreFocus: boolean }) => {
    setPanelOpen(false);
    if (opts?.restoreFocus) anchorRef.current?.focus();
  }, []);

  const actions: ActionSpec[] = [
    {
      key: "git",
      label: "Git",
      tooltip: "Git pull requests and issues (GitHub, GitLab, Bitbucket)",
      icon: GitPullRequest,
      onClick: p.onOpenGit,
    },
    {
      key: "import",
      label: "Import Claude Code sessions and OpenCode sessions",
      tooltip: "Import Claude Code sessions and OpenCode sessions",
      icon: Import,
      onClick: p.onOpenImportSessions,
      testId: "import-claude-sessions-open",
      fitPart: "import",
    },
    { key: "worktrees", label: "Worktrees", tooltip: "Worktrees", icon: FolderGit2, onClick: p.onOpenWorktrees },
    {
      key: "pipelines",
      label: "Pipelines",
      tooltip: "Pipelines",
      icon: Workflow,
      onClick: p.onOpenPipelines,
      testId: "pipelines-button",
      pressed: p.pipelinesActive,
    },
    { key: "settings", label: "Settings", tooltip: "Settings", icon: Settings, onClick: p.onOpenSettings },
  ];
  const liveActions = actions.filter((a) => !(a.key === "import" && hides.importInMore));

  const moreItems = useMemo<ContextMenuItem[]>(
    () => [{ id: "import", label: "Import sessions…", icon: Import, onSelect: p.onOpenImportSessions }],
    [p.onOpenImportSessions],
  );

  const toggleMore = () => {
    if (moreAt) {
      setMoreAt(null);
      return;
    }
    const r = moreRef.current?.getBoundingClientRect();
    if (!r) return;
    setPanelOpen(false);
    setMoreAt({ x: r.left, y: r.bottom + 4 });
  };

  return (
    <header
      ref={headerRef}
      data-testid="app-bar"
      data-fit-step={step}
      className="electrobun-webkit-app-region-drag relative flex h-[40px] shrink-0 items-center justify-between gap-3 overflow-x-clip border-b border-border/60 pl-[80px] pr-4"
      onDoubleClick={(e) => {
        if ((e.target as Element).closest(".electrobun-webkit-app-region-no-drag")) return;
        void api.toggleWindowZoom().catch(() => {});
      }}
    >
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex shrink-0 items-center gap-2">
          <img src={iconUrl} alt="" className="block size-[28px] shrink-0 -translate-y-0.5 object-contain" />
          {!hides.wordmark && (
            <h1 className="font-geist text-base font-semibold leading-none tracking-tight">Agetor</h1>
          )}
        </div>
        <HarnessesButton
          button={model.button}
          hide={{ harnessText: hides.harnessText, until: hides.until }}
          open={panelOpen}
          panelId={panelId}
          buttonRef={setAnchorEl}
          now={now}
          onToggle={() => {
            setMoreAt(null);
            setPanelOpen((v) => !v);
          }}
        />
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {liveActions.map((a) => (
          <Tooltip key={a.key} label={a.tooltip} align="end">
            <Button
              variant={a.pressed ? "secondary" : "ghost"}
              size="icon"
              className={cn(ICON_BOX, "electrobun-webkit-app-region-no-drag")}
              onClick={a.onClick}
              aria-label={a.label}
              data-testid={a.testId}
            >
              <a.icon className="size-4" aria-hidden="true" />
            </Button>
          </Tooltip>
        ))}
        {hides.importInMore && (
          <Button
            ref={moreRef}
            variant="ghost"
            size="icon"
            className={cn(ICON_BOX, "electrobun-webkit-app-region-no-drag", moreAt && "bg-accent")}
            aria-label="More actions"
            aria-haspopup="menu"
            aria-expanded={moreAt !== null}
            data-testid="app-bar-more"
            onClick={toggleMore}
          >
            <MoreHorizontal className="size-4" aria-hidden="true" />
          </Button>
        )}
      </div>

      <HarnessesPanel
        open={panelOpen}
        anchor={anchor}
        panelId={panelId}
        model={model}
        now={now}
        onClose={closePanel}
        onRefreshUsage={p.onRefreshUsage}
        onOpenHarnessSettings={p.onOpenHarnessSettings}
        onOpenStackHistory={p.onOpenStackHistory}
        onOpenFailoverTask={p.onOpenFailoverTask}
      />
      <ContextMenu
        open={moreAt !== null}
        x={moreAt?.x ?? 0}
        y={moreAt?.y ?? 0}
        items={moreItems}
        onClose={() => setMoreAt(null)}
        label="More actions"
        testId="app-bar-more-menu"
      />

      {/* The measurement ghost: the whole bar at step 0, invisible and inert.
          Only `measure` variants and bare boxes: no testid, name, id or handler. */}
      <div
        ref={ghostRef}
        data-app-bar-ghost=""
        aria-hidden="true"
        // React 19 renders `inert` as the boolean attribute.
        {...{ inert: true }}
        className="pointer-events-none invisible absolute left-0 top-0 flex h-0 w-max items-center gap-3 overflow-hidden whitespace-nowrap"
      >
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="block size-[28px] shrink-0" />
            <span data-fit-part="wordmark" className="font-geist text-base font-semibold leading-none tracking-tight">
              Agetor
            </span>
          </div>
          <HarnessesButton
            measure
            button={model.button}
            hide={{ harnessText: false, until: false }}
            open={false}
            panelId=""
            onToggle={() => {}}
            now={now}
          />
        </div>
        <div className="flex items-center gap-1">
          {actions.map((a) => (
            <span
              key={a.key}
              className={cn(ICON_BOX, "inline-flex items-center justify-center")}
              {...(a.fitPart ? { "data-fit-part": a.fitPart } : {})}
            >
              <a.icon className="size-4" />
            </span>
          ))}
          <span data-fit-part="more" className={cn(ICON_BOX, "inline-flex items-center justify-center")}>
            <MoreHorizontal className="size-4" />
          </span>
        </div>
      </div>
    </header>
  );
});
