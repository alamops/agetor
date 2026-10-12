// Collapsed "Compaction summary" block for a `compaction_summary` run event
// (docs/plans/claude-code-placeholder.md §2.4, P4/P10).
//
// The event's `data` is Claude's OWN compaction summary, verbatim (typically
// ~16 KB of markdown that Claude writes to carry a conversation across a
// context reset). It is deliberately NOT a YOU bubble: the user never typed
// it, so it must not read as their message, be offered for resend, or anchor
// the transcript. Collapsed by default (the body is long and rarely wanted);
// the markdown is only mounted while open so a collapsed block costs nothing.
//
// Styled like `AgentInstructionsBlock` (`MessageSegments.tsx`) with semantic
// tokens only, per the repo's dark/light theming convention.
import { memo, useCallback, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { useExpandOnJump } from "@/lib/use-expand-on-jump";
import { compactionSummaryBytes } from "../../../shared/compaction.ts";
import { formatByteSize } from "../../../shared/sent-files.ts";
import { ASSISTANT_MD_COMPONENTS, MD_URL_TRANSFORM } from "./md-components";

export const CompactionSummaryBlock = memo(function CompactionSummaryBlock({
  text,
}: {
  text: string;
}) {
  const [open, setOpen] = useState(false);
  // The summary is searchable (`searchableEventText`), so a search jump onto it
  // must reveal the body — otherwise it lands on a collapsed header.
  const rootRef = useRef<HTMLDivElement>(null);
  const expand = useCallback(() => setOpen(true), []);
  useExpandOnJump(rootRef, expand);
  const trimmed = text.trim();
  return (
    <div
      ref={rootRef}
      data-testid="compaction-summary-block"
      data-state={open ? "expanded" : "collapsed"}
      className="rounded-md border border-border bg-muted/30"
    >
      <button
        type="button"
        data-testid="compaction-summary-toggle"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-[9px] font-semibold uppercase tracking-wide text-primary/80 hover:bg-muted/40"
      >
        <ChevronRight
          className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")}
          aria-hidden
        />
        Compaction summary
        <span className="ml-1 font-normal normal-case tracking-normal text-muted-foreground">
          {formatByteSize(compactionSummaryBytes(text))}
        </span>
      </button>
      {open && trimmed && (
        <div
          data-testid="compaction-summary-body"
          className="agetor-md px-2 pb-1.5 pt-0.5 text-foreground"
        >
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={ASSISTANT_MD_COMPONENTS}
            urlTransform={MD_URL_TRANSFORM}
          >
            {trimmed}
          </ReactMarkdown>
        </div>
      )}
    </div>
  );
});
