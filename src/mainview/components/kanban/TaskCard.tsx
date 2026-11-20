import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { AWAITING_RING_CLASS } from "@/lib/awaiting";
import { AwaitingGlow } from "@/components/ui/awaiting-glow";
import { taskTypeIcon } from "@/lib/task-type-icon";
import { promptPreview } from "@/lib/prompt-preview";
import { cancelBoardDrag, cancelBoardDragIfGone, handleCardKeyDown, isOutsideCard } from "@/lib/board-keyboard";
import { taskActionFlags } from "@/lib/task-card-actions";
import { PipelineHat } from "@/components/pipelines/PipelineHat";
import { taskTypeMeta, type HarnessLimitState, type HarnessStack, type Task } from "../../../shared/types.ts";
import { TaskCardActions } from "./TaskCardActions";
import { TaskCardMeta } from "./TaskCardMeta";
import { TaskCardIdentity, TaskCardStatus } from "./TaskCardStatus";

/**
 * A kanban card (layout C1; contract: docs/architecture/task-card.md).
 *
 * Order: pipeline hat (pipeline parents) · title with an inline type icon ·
 * identity line · status row · preview · `repo · branch` · actions. Nothing
 * sits in a fixed-width slot beside variable text, so no long name or badge
 * can push a sibling out of the 233 px content box. `e2e/task-card-bounds.spec.ts`
 * enforces that in every state.
 *
 * The card is a labelled `group`, not a button: it holds buttons, and a button
 * in a button is invalid. Enter on the card opens it; Space picks it up for a
 * keyboard drag (see `lib/board-keyboard.ts`).
 */
interface Props {
  task: Task;
  homeDir: string;
  /** Machine-local stacks: a task that has never failed over has no
   *  `harnessState`, so its badge is derived from the account's membership. */
  stacks?: HarnessStack[];
  /** Account-global cooldowns, so the stack chip can mark a cooling current
   *  account even before the task itself blocks (review nit). */
  limitStates?: HarnessLimitState[];
  onStart: (t: Task) => void;
  /** Stop. Does not confirm: App's `stopFromBoard` asks first for a pipeline
   *  parent, for the card's Stop and the menu's Stop alike. */
  onCancel: (t: Task) => void;
  onOpen: (t: Task) => void;
  /** The amber "waiting on you" button (Answer / Answer (N) / Review). Kept
   *  separate from `onOpen` because the two land differently for a
   *  pipeline parent: the card body and the plain Open button browse the
   *  run view, while this one also opens the step that needs the user
   *  (App.tsx's `openAttention`). For any other task App routes both to the
   *  same `openTask`. */
  onOpenAttention: (t: Task) => void;
  /** A pipeline parent in Review with a pending human gate: open the run
   *  view with the gate focused. Separate from `onOpen` so the card can
   *  offer both Open (browse) and Review (decide). */
  onReviewPipeline: (t: Task) => void;
  onMarkDone: (t: Task) => void;
  /** True when this task is the one currently open in the run panel — App.tsx
   *  passes `task.id === selected?.id`. Suppresses the unread dot while the
   *  user is actively watching the task (messages streamed while open are
   *  marked seen on close, not shown as unread in the meantime). */
  isOpen?: boolean;
  /** Opens the task menu (Diff, Archive, Unarchive, Delete…): right-click or
   *  the menu key on the card, or the card's `⋯` button, which anchors it at
   *  the button. Diff/Archive/Delete are no longer card buttons, so there is
   *  no per-action prop for them. `pos` is where App.tsx's task context menu
   *  should anchor — omitted entirely when the caller doesn't wire it up (no
   *  menu to open). */
  onContextMenu?: (t: Task, pos: { x: number; y: number }) => void;
  /** True while this task's menu is open (App's `menuTaskId`): drives the
   *  `⋯` button's `aria-expanded`, per the ARIA menu-button pattern. */
  menuOpen?: boolean;
}

function TaskCardImpl({ task, homeDir, stacks = [], limitStates = [], onStart, onCancel, onOpen, onOpenAttention, onReviewPipeline, onMarkDone, isOpen, onContextMenu, menuOpen = false }: Props) {
  const { archived, awaiting } = taskActionFlags(task);
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, isDragging } = useDraggable({
    id: task.id,
    // Archived cards are immutable until unarchived — block drag-to-column so
    // the user has to take the explicit unarchive action first.
    disabled: archived,
    // A group, not dnd-kit's default `role="button"`: the card contains
    // buttons.
    attributes: { role: "group", roleDescription: "draggable task", tabIndex: 0 },
  });
  // One stable callback ref for both dnd-kit nodes: an inline arrow would be
  // re-attached (null, then the node) on every render and make dnd-kit's
  // node state churn.
  const cardRef = useRef<HTMLDivElement | null>(null);
  const setRefs = useCallback(
    (node: HTMLDivElement | null) => {
      cardRef.current = node;
      setNodeRef(node);
      setActivatorNodeRef(node);
    },
    [setNodeRef, setActivatorNodeRef],
  );
  // dnd-kit's keyboard drag listens on the document and ends only on its own
  // keys, so a drag outlives the card's focus. While this card is held, a press
  // outside it, any press on the held card, or focus leaving it puts it back
  // (`lib/board-keyboard.ts`).
  useEffect(() => {
    if (!isDragging) return;
    const leave = (e: Event) => {
      const card = cardRef.current;
      if (e.type === "focusout") {
        // Only focus leaving THIS card counts, not some other field blurring.
        const next = (e as FocusEvent).relatedTarget;
        if (isOutsideCard(card, e.target) || !isOutsideCard(card, next)) return;
        cancelBoardDrag();
        return;
      }
      // A press anywhere, the held card and its buttons included: a card
      // that stayed held while its Run button acted would keep taking keys.
      cancelBoardDrag();
    };
    document.addEventListener("pointerdown", leave, true);
    document.addEventListener("focusout", leave, true);
    return () => {
      document.removeEventListener("pointerdown", leave, true);
      document.removeEventListener("focusout", leave, true);
    };
  }, [isDragging]);
  // A held card whose task is archived elsewhere while it stays on the board
  // (the archive filter shows archived cards) can't be dragged any more:
  // dnd-kit keeps an active drag even after `disabled` turns on, so end it.
  useEffect(() => {
    if (isDragging && archived) cancelBoardDrag();
  }, [isDragging, archived]);
  // Those listeners leave with the card. If the held task disappears from the
  // board (deleted or archived elsewhere), nothing else would end the drag,
  // and dnd-kit would keep taking Space and the arrows document-wide. A card
  // that only changed columns remounts under the same id and keeps the drag.
  const heldRef = useRef(false);
  useEffect(() => {
    heldRef.current = isDragging;
  }, [isDragging]);
  useEffect(() => {
    const id = task.id;
    return () => {
      if (!heldRef.current) return;
      queueMicrotask(() => cancelBoardDragIfGone(id));
    };
  }, [task.id]);
  const style = transform ? { transform: CSS.Translate.toString(transform) } : undefined;
  const type = taskTypeMeta(task.taskType);
  const TypeIcon = taskTypeIcon(type.icon);
  const preview = useMemo(() => promptPreview(task.prompt), [task.prompt]);

  return (
    <Card
      // The card root is also the keyboard activator. dnd-kit's
      // KeyboardSensor starts a drag only when the key event's target IS the
      // activator node, so Space on a nested button activates that button
      // instead of picking the card up.
      ref={setRefs}
      style={style}
      // Lets the board find this card when it reveals the card the user
      // left from (`lib/board-scroll.ts`), and e2e specs locate it.
      data-task-id={task.id}
      className={cn(
        "relative cursor-grab select-none border-border/60 border-l-4 hover:border-border transition-colors",
        // `[outline-style:solid]`, not Tailwind v3's `outline`: `cn`'s
        // tailwind-merge 3 reads `outline` as a width and drops it beside
        // `outline-2`, which left the browser's own focus ring in place.
        "focus-visible:[outline-style:solid] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        type.borderClass,
        isDragging && "opacity-50",
        awaiting && AWAITING_RING_CLASS,
        archived && "cursor-default opacity-60",
      )}
      // `onClick` (open) stays untouched by the addition below — a
      // right-click never opens the panel, only `onContextMenu` fires for it.
      onClick={() => onOpen(task)}
      // dnd-kit's `useDraggable` above is unaffected by right-click: its
      // `PointerSensor` bails on `event.button !== 0`, so a right-click can
      // never arm a drag — `{...listeners}` and this handler don't fight.
      onContextMenu={(e) => {
        e.preventDefault();
        if (!onContextMenu) return;
        // Keyboard-invoked context menus (Shift+F10 / the menu key) report
        // clientX/Y = 0,0 — anchor those to the card instead of the
        // viewport corner.
        const fromKeyboard = e.clientX === 0 && e.clientY === 0;
        const r = e.currentTarget.getBoundingClientRect();
        onContextMenu(task, fromKeyboard ? { x: r.left, y: r.top } : { x: e.clientX, y: e.clientY });
      }}
      // The card is focusable, so a right-click would otherwise focus it and
      // WebKit scrolls a partially-visible card into view inside
      // `.kanban-scroll`; the board would visibly jump under the freshly-opened
      // menu. Only the right button is suppressed — left-click focus and
      // dnd-kit's `onPointerDown` (from `{...listeners}`) are untouched.
      onMouseDown={(e) => {
        if (e.button === 2) e.preventDefault();
      }}
      {...listeners}
      {...attributes}
      // After the spread: dnd-kit stamps `aria-disabled` from `disabled:
      // archived`, which on a group would mark the archived card's Open and
      // `⋯` buttons disabled too. An archived card can't be dragged, so it
      // drops the drag description and says it is archived in its name.
      aria-disabled={undefined}
      aria-roledescription={archived ? undefined : attributes["aria-roledescription"]}
      aria-describedby={archived ? undefined : attributes["aria-describedby"]}
      aria-label={archived ? `${task.title} (archived)` : task.title}
      // After the spreads, so it composes dnd-kit's key handler instead of
      // replacing it. Enter on the card itself (never on a nested button)
      // opens the task, unless the card is held in a keyboard drag. Space on
      // an archived card (no drag listeners) would scroll the board instead.
      onKeyDown={(e) => {
        if (archived && e.key === " " && e.target === e.currentTarget) e.preventDefault();
        handleCardKeyDown(e, () => onOpen(task), () => listeners?.onKeyDown?.(e), isDragging);
      }}
    >
      {task.unread && !isOpen && (
        // Static dot for "has assistant messages you haven't read yet" —
        // deliberately unanimated (the awaiting pulse is the only animated
        // attention state). It sits on the card corner, over the hat on a
        // pipeline card; the -1.5 offsets keep its halo clear of the awaiting
        // ring instead of notching it.
        <span
          data-card-overlay
          className="absolute -right-1.5 -top-1.5 z-10 size-2.5 rounded-full bg-info ring-2 ring-background"
          title="New messages"
          role="img"
          aria-label="New messages"
        />
      )}
      {/* A pipeline task's header is the hat (name, distinct-step progress,
       *  what it is on); the profile is per step, so the identity line below
       *  drops the agent for it. */}
      {task.pipelineRun && <PipelineHat run={task.pipelineRun} />}
      <div className="flex flex-col gap-2 p-3">
        <h3 data-part="title" data-must-not-truncate className="text-sm font-semibold leading-snug text-card-foreground [overflow-wrap:anywhere]">
          <TypeIcon className={cn("mr-1.5 inline-block size-3.5 align-[-2px]", type.iconClass)} role="img" aria-label={type.label} />
          {task.title}
        </h3>
        <TaskCardIdentity task={task} />
        <TaskCardStatus task={task} stacks={stacks} limitStates={limitStates} />
        {preview && (
          <p data-part="preview" className="line-clamp-2 text-xs leading-normal text-muted-foreground">
            {preview}
          </p>
        )}
        <TaskCardMeta task={task} homeDir={homeDir} />
        <TaskCardActions
          task={task}
          menuOpen={menuOpen}
          onStart={onStart}
          onCancel={onCancel}
          onOpen={onOpen}
          onOpenAttention={onOpenAttention}
          onReviewPipeline={onReviewPipeline}
          onMarkDone={onMarkDone}
          onMore={onContextMenu}
        />
      </div>
      {/* The "waiting on you" glow — an opacity-pulsed overlay (see
          `AwaitingGlow` for why it isn't a filter/box-shadow animation). */}
      {awaiting && <AwaitingGlow />}
    </Card>
  );
}

// Default shallow-props comparator is correct here (unlike Column, which
// needs a custom comparator for its array prop): `task` is a single object
// whose identity App.tsx's `reconcileById` preserves across polls when
// unchanged, and every other prop is either a primitive (`homeDir`,
// `menuOpen`) or a `useCallback`-stabilized handler. dnd-kit's `useDraggable`
// lives inside the component body, so memoizing the outer function doesn't
// interfere with drag state — that's driven by dnd-kit's own context.
export const TaskCard = memo(TaskCardImpl);
