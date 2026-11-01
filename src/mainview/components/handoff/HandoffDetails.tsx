// The formatted body of the handoff modal (`docs/plans/formatted-handoff.md`
// D5): purpose, summary and reason as markdown (the assistant renderer, so
// links open in the browser and images resolve through `MdImageScopeContext`,
// which crosses the modal's portal), every artifact, and the numbered open
// questions.
import { memo, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Handoff } from "../../../shared/types.ts";
import { ASSISTANT_MD_COMPONENTS, MD_URL_TRANSFORM } from "@/components/kanban/md-components";
import { classifyHandoffArtifact } from "@/lib/handoff-artifacts";
import { HandoffArtifactChips } from "./HandoffArtifactChips";
import { useHandoffView } from "./handoff-context";

function Section({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <section className="space-y-1">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
        {count !== undefined && <span className="ml-1 font-normal normal-case">({count})</span>}
      </h3>
      {children}
    </section>
  );
}

function Markdown({ text }: { text: string }) {
  return (
    <div className="agetor-md text-sm text-foreground">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={ASSISTANT_MD_COMPONENTS} urlTransform={MD_URL_TRANSFORM}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

export const HandoffDetails = memo(function HandoffDetails({ handoff }: { handoff: Handoff }) {
  const { roots, homeDir } = useHandoffView();
  const artifacts = useMemo(
    () => handoff.artifacts.map((entry) => classifyHandoffArtifact(entry, { roots, homeDir })),
    [handoff.artifacts, roots, homeDir],
  );
  const empty = <p className="text-xs italic text-muted-foreground">None</p>;

  return (
    <div className="space-y-4">
      <Section title="Purpose">{handoff.purpose.trim() ? <Markdown text={handoff.purpose} /> : empty}</Section>
      <Section title="Summary">{handoff.summary.trim() ? <Markdown text={handoff.summary} /> : empty}</Section>
      <Section title="Reason">{handoff.reason.trim() ? <Markdown text={handoff.reason} /> : empty}</Section>
      <Section title="Artifacts" count={artifacts.length}>
        {artifacts.length > 0 ? <HandoffArtifactChips variant="list" artifacts={artifacts} /> : empty}
      </Section>
      <Section title="Open questions" count={handoff.openQuestions.length}>
        {handoff.openQuestions.length > 0 ? (
          <ol data-testid="handoff-dialog-questions" className="list-decimal space-y-1 pl-5 text-sm">
            {handoff.openQuestions.map((q, i) => (
              <li key={i} className="whitespace-pre-wrap break-words">
                {q}
              </li>
            ))}
          </ol>
        ) : (
          empty
        )}
      </Section>
    </div>
  );
});
