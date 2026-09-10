import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { computeAtHighlights, isListedPath } from "@/lib/at-highlight";

interface Props {
  /** The textarea this backdrop mirrors. Read-only here — the backdrop never
   *  touches the textarea's value or selection, only its computed style and
   *  scroll position. */
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  /** Current textarea value — re-segmented into highlight runs on every
   *  change. */
  value: string;
  /** The set of `@`-token paths considered "listed" for this surface's scope
   *  (see `useProjectFiles`); passed through `isListedPath` so a bare
   *  directory token (`@src/bun`, no trailing slash) still highlights when
   *  `src/bun/` is listed. */
  validPaths: Set<string>;
  className?: string;
}

/** Computed-style properties mirrored from the textarea onto this backdrop
 *  so wrapping lines up character-for-character. `font` (the shorthand) is
 *  included alongside its longhands defensively — some engines resolve the
 *  shorthand's computed value slightly differently than reading every
 *  longhand back individually. */
const MIRRORED_PROPERTIES = [
  "font",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "letterSpacing",
  "wordSpacing",
  "lineHeight",
  "textIndent",
  "tabSize",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "borderRadius",
  "boxSizing",
  "textAlign",
] as const;

/** Zero-width space appended after a trailing newline (or when the value is
 *  empty) so the last, otherwise-empty line still occupies a line box —
 *  without it the backdrop's content box would be one line shorter than the
 *  textarea's, and every highlight after the missing line would sit one row
 *  too high. */
const TRAILING_LINE_SENTINEL = "​";

function readTextareaMetrics(el: HTMLTextAreaElement): React.CSSProperties {
  const cs = getComputedStyle(el) as unknown as Record<string, string>;
  const style: Record<string, string> = {
    // Border color transparent (not "none") so the border's *width* still
    // reserves the same box-model space padding does — only its paint is
    // invisible.
    borderStyle: "solid",
    borderColor: "transparent",
    whiteSpace: "pre-wrap",
    overflowWrap: "break-word",
  };
  for (const prop of MIRRORED_PROPERTIES) style[prop] = cs[prop] ?? "";
  return style as React.CSSProperties;
}

/** Shallow key/value equality over the plain string-valued objects
 *  `readTextareaMetrics` produces — used to keep the previous `style` object
 *  identity across a re-read that turned up no actual change, so a
 *  no-op metrics refresh doesn't force a re-render of every highlight
 *  `<mark>` downstream. */
function stylesEqual(a: React.CSSProperties, b: React.CSSProperties): boolean {
  const aRec = a as Record<string, unknown>;
  const bRec = b as Record<string, unknown>;
  const aKeys = Object.keys(aRec);
  if (aKeys.length !== Object.keys(bRec).length) return false;
  for (const key of aKeys) {
    if (aRec[key] !== bRec[key]) return false;
  }
  return true;
}

/**
 * Paints `<mark>` highlight boxes *behind* a textarea's native text. Must be
 * mounted BEFORE the `<textarea>` in DOM source order (not via z-index) so
 * the textarea's own text — and its native caret/selection — render on top
 * of this layer; the textarea itself needs `relative bg-transparent` so its
 * background doesn't hide the marks underneath. This component never
 * renders visible text of its own (every text node here inherits
 * `text-transparent`), so a metrics mismatch between this mirror and the
 * real textarea can only shift a highlight box — it can never move or hide
 * any text the user can actually read. No `<mark>` paints until the first
 * metrics read succeeds, so a box can never appear against the wrong
 * (inherited-ambient) metrics, not even for one frame.
 */
export function AtHighlightBackdrop({ textareaRef, value, validPaths, className }: Props) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<React.CSSProperties | null>(null);

  // Mirror metrics on mount and on every resize of the textarea (font load,
  // container resize, manual textarea resize handle, etc.) — `ResizeObserver`
  // defaults to observing the *content* box, so a scrollbar appearing/
  // disappearing (which shrinks/grows the content box with no border-box
  // change) already fires this without needing a separate value-keyed
  // effect. Deliberately NOT re-read on every `value` change: none of the
  // `MIRRORED_PROPERTIES` (font, padding, border width, …) depend on the
  // textarea's *text* — only on its box/typography, which only mount and a
  // real resize can change — so keying this off `value` was forcing a
  // synchronous `getComputedStyle` + a new style object on every keystroke
  // for no payoff. `setStyle`'s functional form keeps the previous object
  // identity when the freshly-read metrics are unchanged (`stylesEqual`),
  // which is what actually matters here: `ResizeObserver`'s callback still
  // fires on layout thrash even when nothing visibly moved, so the identity
  // check is what stops that from cascading into a re-render.
  //
  // This MUST be a passive effect, not `useLayoutEffect` — React attaches
  // refs and runs layout effects in a single tree-order pass (children
  // before parent, siblings in mount order), and this backdrop is mounted
  // as the textarea's EARLIER sibling on several surfaces (the RunPanel send
  // dock, the backlog-tray inline editor, the DiffDialog compose box,
  // `CreateTaskFromIssueDialog`, `ResolveConflictsDialog`) whose `fileScope`
  // is already known at first render, so the backdrop and its `<textarea>`
  // co-mount in the same commit. A layout effect here would run BEFORE the
  // textarea's ref is attached: `textareaRef.current` would still be null,
  // the effect would bail, and — because its dep is a stable ref object —
  // it would never re-run, leaving `style` at its initial value forever
  // (no metrics, no `ResizeObserver`). The New Task form was the one surface
  // that never surfaced this: its `fileScope` only exists once a workdir is
  // chosen, so its backdrop mounts after the textarea already has a ref.
  // A passive effect runs after the WHOLE commit, once every ref in the
  // subtree — including a later sibling's — is attached, which is what
  // makes co-mount safe. Do not switch this back to `useLayoutEffect`; it
  // would silently reintroduce the bug on every co-mounted surface.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const applyMetrics = () => {
      const next = readTextareaMetrics(el);
      setStyle((prev) => (prev !== null && stylesEqual(prev, next) ? prev : next));
    };
    applyMetrics();
    const ro = new ResizeObserver(applyMetrics);
    ro.observe(el);
    return () => ro.disconnect();
  }, [textareaRef]);

  // Keep the backdrop's scroll position glued to the textarea's — the
  // backdrop itself is `overflow-hidden` (never scrollable on its own), so
  // this is the only thing that keeps a highlight aligned once the user
  // scrolls a tall composer. This one stays a layout effect on purpose: a
  // `value` change can scroll the textarea synchronously (caret pushed into
  // view) and the mirror has to follow before paint. It has the same
  // co-mount exposure as the metrics effect above — on the first pass
  // `textareaRef.current` is still null and it bails — which is why `style`
  // is a dep: `style` flips `null` → object exactly once, after the passive
  // effect ran (ref guaranteed attached) AND the children have rendered
  // (a scrollTop assignment on an empty mirror is a no-op), so that re-run
  // is what attaches the `scroll` listener and does the first real sync on
  // a co-mounted surface — without it a tray editor opened on a multi-line
  // saved draft would keep its marks whole lines off until the first
  // keystroke changed `value`. `stylesEqual`'s identity preservation keeps
  // `style` stable afterwards, so a `ResizeObserver` no-op can't churn this.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    const backdrop = backdropRef.current;
    if (!el || !backdrop) return;
    const sync = () => {
      backdrop.scrollTop = el.scrollTop;
      backdrop.scrollLeft = el.scrollLeft;
    };
    sync();
    el.addEventListener("scroll", sync);
    return () => el.removeEventListener("scroll", sync);
  }, [textareaRef, value, style]);

  const segments = useMemo(
    () => computeAtHighlights(value, (p, isDirectory) => isListedPath(validPaths, p, isDirectory)),
    [value, validPaths],
  );

  return (
    <div
      ref={backdropRef}
      aria-hidden
      data-testid="at-highlight-backdrop"
      className={cn(
        "pointer-events-none absolute inset-0 select-none overflow-hidden whitespace-pre-wrap break-words text-transparent",
        className,
      )}
      style={style ?? undefined}
    >
      {style !== null && (
        <>
          {segments.map((seg, i) =>
            seg.mark
              ? (
                <mark key={i} data-testid="at-highlight-mark" className="rounded-sm bg-info/20 text-transparent">
                  {seg.text}
                </mark>
              )
              : seg.text,
          )}
          {(value.length === 0 || value.endsWith("\n")) && TRAILING_LINE_SENTINEL}
        </>
      )}
    </div>
  );
}
