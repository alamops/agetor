import { Fragment, type ReactNode } from "react";
import { splitLinks } from "../../shared/linkify.ts";
import { ExternalLink } from "../components/kanban/md-components.tsx";

/**
 * Render plain (non-markdown) text with any bare `http(s)://` URL turned
 * into a clickable `ExternalLink` (system-browser handoff via
 * `api.openExternal`), everything else left as ordinary text — used for
 * surfaces that are never markdown, so `ReactMarkdown`'s link handling
 * doesn't apply: fx's recovery notices (`RecoveryNotice`/
 * `PausedRecoveryNotice` in `RunPanel.tsx`) and plain transcript `status`
 * lines, both of which can carry a raw Gateway URL straight from fx's own
 * message text.
 *
 * `ExternalLink` is imported from `./md-components.tsx` (its export is
 * shared with `ReactMarkdown`'s `a` renderer) rather than duplicated here,
 * so both link-rendering paths stay byte-identical in behavior (same
 * `safe` scheme check, same `openExternal` + toast-on-failure handling).
 *
 * Returns the exact same single string `text` would have rendered as when
 * `splitLinks` finds no URL (see its doc comment) — so a non-URL line is
 * byte-identical to a bare `{text}` render, no wrapping array/fragment
 * introduced for the common case.
 */
export function renderLinkified(text: string): ReactNode {
  const segments = splitLinks(text);
  if (segments.length === 0) return text;
  if (segments.length === 1 && segments[0]!.type === "text") return segments[0]!.value;
  return segments.map((seg, i) =>
    seg.type === "link"
      ? <ExternalLink key={i} href={seg.value}>{seg.value}</ExternalLink>
      : <Fragment key={i}>{seg.value}</Fragment>
  );
}
