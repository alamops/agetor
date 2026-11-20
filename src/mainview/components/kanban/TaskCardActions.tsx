import { ArrowRight, CheckCircle2, Ellipsis, FolderOpen, MessageCircleQuestion, Play, Square, UserCheck } from "lucide-react";
import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { awaitingLabel } from "@/lib/awaiting";
import { cardActions, taskActionFlags, type CardAction } from "@/lib/task-card-actions";
import type { Task } from "../../../shared/types.ts";

interface Props {
  task: Task;
  menuOpen: boolean;
  onStart: (t: Task) => void;
  onCancel: (t: Task) => void;
  onOpen: (t: Task) => void;
  onOpenAttention: (t: Task) => void;
  onReviewPipeline: (t: Task) => void;
  onMarkDone: (t: Task) => void;
  /** Opens the task menu anchored at the `⋯` button. Absent: no `⋯`. */
  onMore?: (t: Task, pos: { x: number; y: number }) => void;
}

// Card-local button sizing: every card button is h-7, with a 3.5 icon.
const BTN = "h-7 gap-1.5 px-2.5 text-xs";

/**
 * The card's action row: the primary action(s) for the task's state
 * (`cardActions`), then `⋯`, which opens the task's full menu (Diff, Archive,
 * Unarchive, the extra Stop, Delete…). Nothing else lives on the card, so the
 * row can never outgrow its 233 px.
 *
 * Colours: Stop is `--danger`, not the shared `destructive` variant (white on
 * it is 3.60:1 in light mode, below AA), and Answer is `--warning-solid` with
 * its own foreground. A stop on a pipeline asks for confirmation in App's
 * `stopFromBoard`, which `onCancel` is; the card has no stop logic of its own.
 */
export function TaskCardActions({ task, menuOpen, onStart, onCancel, onOpen, onOpenAttention, onReviewPipeline, onMarkDone, onMore }: Props) {
  const { pendingCount } = taskActionFlags(task);
  const closedByPress = useRef(false);
  const actions = cardActions(task);
  // Answer (N) next to Done and `⋯` (an awaiting task in Review) needs the
  // 20 px of its trailing arrow: without it the row is 8 px too wide in WebKit.
  const shareRow = actions.length > 1;
  const render = (action: CardAction) => {
    switch (action) {
      case "review-gate":
        // A pending human gate is a decision, not a failure: Review is primary.
        return (
          <Button key={action} size="sm" className={BTN} data-testid="task-card-pipeline-review" onClick={() => onReviewPipeline(task)} title="Open the human review gate">
            <UserCheck className="size-3.5" /> Review
          </Button>
        );
      case "open":
        return (
          <Button key={action} size="sm" variant="secondary" className={BTN} onClick={() => onOpen(task)} title={task.pipelineId ? "Open the pipeline run" : undefined}>
            <FolderOpen className="size-3.5" /> Open
          </Button>
        );
      case "answer":
        return (
          <Button
            key={action}
            size="sm"
            className={`${BTN} bg-warning-solid text-warning-solid-foreground hover:bg-warning-solid/90`}
            onClick={() => onOpenAttention(task)}
            title={pendingCount > 0 ? "Open run panel to answer" : "Agent is waiting on you — open the run panel"}
          >
            <MessageCircleQuestion className="size-3.5" />
            {awaitingLabel(pendingCount)}
            {!shareRow && <ArrowRight className="size-3.5" />}
          </Button>
        );
      case "stop":
        return (
          <Button key={action} size="sm" className={`${BTN} bg-danger text-danger-foreground hover:bg-danger/90`} onClick={() => onCancel(task)}>
            <Square className="size-3.5" /> Stop
          </Button>
        );
      case "run":
        return (
          <Button key={action} size="sm" className={BTN} onClick={() => onStart(task)}>
            <Play className="size-3.5" /> Run
          </Button>
        );
      case "mark-done":
        return (
          <Button key={action} size="sm" variant="outline" className={`${BTN} bg-transparent`} onClick={() => onMarkDone(task)} title="Mark this task as done">
            <CheckCircle2 className="size-3.5" /> Done
          </Button>
        );
    }
  };
  return (
    // The row owns its clicks: nothing in it opens the card.
    <div data-part="actions" className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
      {actions.map(render)}
      {onMore && (
        <Button
          type="button"
          size="icon"
          variant="outline"
          className="ml-auto h-7 w-7 shrink-0 bg-transparent"
          aria-label="More actions"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          title="More actions"
          data-testid="task-card-more"
          // A press on ⋯ while its menu is open closes the menu (the menu's
          // own outside-press handler, on mousedown), and the click that
          // follows must not open it again: ⋯ toggles.
          onPointerDown={() => {
            closedByPress.current = menuOpen;
          }}
          onClick={(e) => {
            // `detail` 0 is a keyboard click, which no press precedes.
            const skip = closedByPress.current && e.detail > 0;
            closedByPress.current = false;
            if (skip) return;
            // WebKit (the app's WKWebView) doesn't focus a button on click, and
            // the menu returns focus to whatever had it when it opened.
            e.currentTarget.focus({ preventScroll: true });
            const r = e.currentTarget.getBoundingClientRect();
            onMore(task, { x: r.left, y: r.bottom + 4 });
          }}
        >
          <Ellipsis className="size-4" />
        </Button>
      )}
    </div>
  );
}
