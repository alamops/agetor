import type { Announcements, KeyboardCoordinateGetter } from "@dnd-kit/core";

/**
 * Keyboard dragging for the kanban board (dnd-kit `KeyboardSensor`).
 *
 * Space picks a card up and drops it, ← → jump to the previous / next
 * column, Escape puts it back. Enter is not a drag key: it opens the task
 * (the card's own `onKeyDown`) and is ignored while a drag is held. Tab
 * cancels, like Escape: dnd-kit listens on the document, so a drag that
 * outlived the card's focus would keep taking Space and the arrows typed
 * anywhere else (the run panel's composer) and move the card. dnd-kit only
 * cancels on its own codes, a resize and a hidden tab, so a click elsewhere
 * or focus moving off the card cancels through `cancelBoardDrag`.
 */
export const BOARD_CANCEL_CODE = "AgetorCancelDrag";

export const BOARD_KEYBOARD_CODES = {
  start: ["Space"],
  // The private code is no key a keyboard can send, and unlike a synthetic
  // Escape no other document listener (the run panel's) acts on it.
  cancel: ["Escape", "Tab", BOARD_CANCEL_CODE],
  end: ["Space"],
};

/** Cancels the keyboard drag in progress, if any: dnd-kit's document keydown
 *  listener takes the private cancel code like a key. No drag, no listener,
 *  no effect. */
export function cancelBoardDrag(doc: Document = document): void {
  const view = doc.defaultView;
  if (!view) return;
  doc.dispatchEvent(new view.KeyboardEvent("keydown", { code: BOARD_CANCEL_CODE, key: BOARD_CANCEL_CODE, bubbles: true }));
}

/** After a focus-leave cancel, puts focus back where the user sent it. dnd-kit's
 *  `RestoreFocus` re-focuses the card in a `requestAnimationFrame` when the
 *  active element is elsewhere once the drag ends, which undoes the move that
 *  caused the cancel (Cmd/Ctrl+F to the board search). Two frames later that
 *  restore has run, so the user's target wins. A target that left the document
 *  is skipped. */
export function restoreFocusAfterCancel(target: unknown, doc: Document = document): void {
  const view = doc.defaultView;
  const el = target as { isConnected?: boolean; focus?: () => void } | null;
  if (!view || !el || typeof el.focus !== "function") return;
  view.requestAnimationFrame(() =>
    view.requestAnimationFrame(() => {
      if (el.isConnected && doc.activeElement !== el) el.focus?.();
    }),
  );
}

/** True when a pointer press or a focus change landed outside the held card,
 *  which is when the drag must end. `target` null (focus left the document)
 *  counts as outside. */
export function isOutsideCard(card: { contains(node: never): boolean } | null, target: unknown): boolean {
  if (!card) return false;
  return target == null || !card.contains(target as never);
}

/** Marks the document while any board drag is held, so a document-level
 *  Escape handler that is not part of the drag (the run panel's) leaves the
 *  key to dnd-kit's cancel. */
export const BOARD_DRAG_ATTR = "data-board-drag";
export const BOARD_DRAG_SELECTOR = `[${BOARD_DRAG_ATTR}]`;

export function setBoardDragging(on: boolean, doc: Document = document): void {
  if (on) doc.body.setAttribute(BOARD_DRAG_ATTR, "");
  else doc.body.removeAttribute(BOARD_DRAG_ATTR);
}

export interface BoardColumnRect {
  id: string;
  left: number;
  width: number;
}

/**
 * The `left` coordinate that centres a dragged card of `activeWidth` over the
 * column one step in the arrow's direction, or `null` when there is none (up
 * and down do nothing: columns have no vertical order, and the first and last
 * column are the ends). `currentColumnId` null means "none yet": the card is
 * not over a column, so the first step goes to the nearest end.
 */
export function nextColumnX(
  code: string,
  columns: BoardColumnRect[],
  currentColumnId: string | null,
  activeWidth: number,
): number | null {
  if (code !== "ArrowLeft" && code !== "ArrowRight") return null;
  const ordered = [...columns].sort((a, b) => a.left - b.left);
  if (ordered.length === 0) return null;
  const at = currentColumnId == null ? -1 : ordered.findIndex((c) => c.id === currentColumnId);
  let next: BoardColumnRect | undefined;
  if (at === -1) next = code === "ArrowRight" ? ordered[0] : ordered[ordered.length - 1];
  else next = ordered[at + (code === "ArrowRight" ? 1 : -1)];
  if (!next) return null;
  return next.left + next.width / 2 - activeWidth / 2;
}

/** dnd-kit coordinate getter: ← → move the card to the neighbouring column,
 *  keeping its vertical position. The sensor scrolls the board when the target
 *  column is off-screen. */
export const boardKeyboardCoordinates: KeyboardCoordinateGetter = (event, { context, currentCoordinates }) => {
  if (event.code !== "ArrowLeft" && event.code !== "ArrowRight") {
    // Up / down would otherwise scroll the page under the held card.
    if (event.code === "ArrowUp" || event.code === "ArrowDown") event.preventDefault();
    return;
  }
  event.preventDefault();
  const columns: BoardColumnRect[] = [];
  for (const container of context.droppableContainers.getEnabled()) {
    const rect = context.droppableRects.get(container.id);
    if (rect) columns.push({ id: String(container.id), left: rect.left, width: rect.width });
  }
  const activeWidth = context.collisionRect?.width ?? context.draggingNodeRect?.width ?? 0;
  let current: string | null = context.over ? String(context.over.id) : null;
  if (current == null && context.collisionRect) {
    const centre = context.collisionRect.left + context.collisionRect.width / 2;
    current = columns.find((c) => centre >= c.left && centre <= c.left + c.width)?.id ?? null;
  }
  const x = nextColumnX(event.code, columns, current, activeWidth);
  return x == null ? undefined : { x, y: currentCoordinates.y };
};

export const BOARD_SCREEN_READER_INSTRUCTIONS =
  "To pick up a task, press Space. Use the left and right arrow keys to move it between columns, press Space to drop it, or Escape to cancel. Press Enter to open it.";

/** Live-region announcements that name the task and the column. dnd-kit's
 *  defaults read the draggable's id, which for a task is its UUID. */
export function makeBoardAnnouncements(
  titleOf: (id: string) => string,
  columnLabelOf: (id: string) => string,
): Announcements {
  const title = (id: string | number) => titleOf(String(id)) || "task";
  const column = (id: string | number) => columnLabelOf(String(id)) || "a column";
  return {
    onDragStart: ({ active }) => `Picked up ${title(active.id)}.`,
    onDragOver: ({ active, over }) =>
      over ? `${title(active.id)} is over ${column(over.id)}.` : `${title(active.id)} is not over a column.`,
    onDragEnd: ({ active, over }) =>
      over ? `${title(active.id)} was dropped in ${column(over.id)}.` : `${title(active.id)} was dropped.`,
    onDragCancel: ({ active }) => `Moving ${title(active.id)} was cancelled.`,
  };
}

/**
 * The card root's `onKeyDown`: Enter on the card ITSELF opens the task (Enter
 * on a nested button belongs to that button), and every other key goes on to
 * dnd-kit's own handler, which starts a drag on Space only when the target is
 * the card's activator node. While `isDragging` the card is held, so Enter does
 * not open the task out from under the drag. Returns true when it opened the
 * task.
 */
export function handleCardKeyDown(
  e: { key: string; target: unknown; currentTarget: unknown; preventDefault: () => void },
  open: () => void,
  dragKeyDown?: () => void,
  isDragging = false,
): boolean {
  if (e.key === "Enter" && e.target === e.currentTarget && !isDragging) {
    e.preventDefault();
    open();
    return true;
  }
  dragKeyDown?.();
  return false;
}
