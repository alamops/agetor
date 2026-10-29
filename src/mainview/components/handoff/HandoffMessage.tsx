// Transcript-level entry points for the formatted handoff
// (`docs/plans/formatted-handoff.md` K4/K6, D15, D17):
//
//   - `AssistantHandoffMessage` is what RunPanel's `AssistantBlock` renders:
//     the prose before the message's last real `<handoff>` block, the card
//     (or the Invalid-handoff card), then the prose after it.
//   - `UserHandoffMarkdown` is the markdown body of a step's prompt bubble:
//     each nonce-matched untrusted-handoff span the runner inlined becomes a
//     prompt card, each file placeholder a file card.
//
// Both read `HandoffViewContext`; with it disabled (no provider — a non-step
// task, a subagent tab, a delta-streaming harness) or with nothing to format,
// they render byte-for-byte what RunPanel rendered before this feature, so
// delegating to them is a no-op for every other surface.
import { memo, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { splitHandoffPromptSpans } from "../../../shared/pipeline.ts";
import { ASSISTANT_MD_COMPONENTS, MD_URL_TRANSFORM, USER_MD_COMPONENTS } from "@/components/kanban/md-components";
import { splitHandoffMessageCached } from "@/lib/handoff-view";
import { shortenTaskPaths } from "@/lib/shorten-task-paths";
import { HandoffCard, HandoffFileCard, InvalidHandoffCard } from "./HandoffCard";
import { useHandoffView } from "./handoff-context";

/** The assistant markdown renderer, exactly as `AssistantBlock` used it —
 *  for the prose around a block, and for a message with none. */
export const AssistantMarkdown = memo(function AssistantMarkdown({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={ASSISTANT_MD_COMPONENTS} urlTransform={MD_URL_TRANSFORM}>
      {text}
    </ReactMarkdown>
  );
});

/** Cheap pre-check before the (cached) code-aware split: every real block
 *  contains its open tag, matched case-insensitively like the locator. */
const HANDOFF_OPEN_RE = /<handoff/i;

/**
 * One assistant message, including the `agetor-md text-foreground` wrapper
 * `AssistantBlock` has always rendered. `usage` is the message's D21 usage
 * (computed by `RunEventList` as a primitive, so `memo` holds); it only
 * matters when the message carries a valid block.
 */
export const AssistantHandoffMessage = memo(function AssistantHandoffMessage({
  text,
  usage = null,
}: {
  text: string;
  usage?: "used" | "not-used" | null;
}) {
  const { enabled } = useHandoffView();
  const split = enabled && HANDOFF_OPEN_RE.test(text) ? splitHandoffMessageCached(text) : null;
  const block = split?.block ?? null;

  if (split === null || block === null) {
    return (
      <div className="agetor-md text-foreground">
        <AssistantMarkdown text={text} />
      </div>
    );
  }

  return (
    <div className="agetor-md text-foreground">
      {split.before.trim() !== "" && <AssistantMarkdown text={split.before} />}
      {block.result.ok ? (
        <HandoffCard handoff={block.result.handoff} variant="transcript" usage={usage} />
      ) : (
        <InvalidHandoffCard error={block.result.error} raw={block.result.raw ?? block.inner} />
      )}
      {split.after.trim() !== "" && <AssistantMarkdown text={split.after} />}
    </div>
  );
});

/** Cheap pre-check before splitting a prompt: every span opens with this. */
const SPAN_BEGIN = "--- BEGIN untrusted handoff ";

/**
 * The user-markdown body of a message — the `ReactMarkdown` +
 * `USER_MD_COMPONENTS` + `MD_URL_TRANSFORM` call that `UserMessageBlock`'s
 * ordinary branch and `MessageSegments`' text segments make — with a step
 * prompt's untrusted-handoff spans rendered as cards. Renders no wrapper of
 * its own (the caller's `agetor-md` container stays in charge of spacing).
 *
 * `pathRoots`, when given, means `text` has NOT been path-shortened yet: the
 * spans are split first, then each text part is folded with
 * `shortenTaskPaths` — so a placeholder's handoff-file path stays absolute
 * and its record lookup keeps working. Without it, `text` renders as passed
 * (the caller already folded it; the inlined JSON sits in a fence, which
 * `shortenTaskPaths` never rewrites).
 */
export const UserHandoffMarkdown = memo(function UserHandoffMarkdown({
  text,
  pathRoots,
}: {
  text: string;
  pathRoots?: readonly (string | null | undefined)[];
}) {
  const { enabled } = useHandoffView();
  const parts = useMemo(
    () => (enabled && text.includes(SPAN_BEGIN) ? splitHandoffPromptSpans(text) : null),
    [enabled, text],
  );
  const fold = (s: string) => (pathRoots?.length ? shortenTaskPaths(s, pathRoots) : s);

  if (parts === null || parts.every((p) => p.kind === "text")) {
    return (
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={USER_MD_COMPONENTS} urlTransform={MD_URL_TRANSFORM}>
        {fold(text)}
      </ReactMarkdown>
    );
  }

  return (
    <>
      {parts.map((part, i) => {
        if (part.kind === "text") {
          if (part.text.trim() === "") return null;
          return (
            <ReactMarkdown
              key={i}
              remarkPlugins={[remarkGfm]}
              components={USER_MD_COMPONENTS}
              urlTransform={MD_URL_TRANSFORM}
            >
              {fold(part.text)}
            </ReactMarkdown>
          );
        }
        if (part.kind === "handoff") {
          return (
            <HandoffCard
              key={i}
              handoff={part.handoff}
              variant="prompt"
              fromStepName={part.fromStep}
              untrusted
            />
          );
        }
        return <HandoffFileCard key={i} part={part} />;
      })}
    </>
  );
});
