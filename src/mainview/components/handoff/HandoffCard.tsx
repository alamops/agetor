// The compact handoff card (`docs/plans/formatted-handoff.md` D3/D8/D13–D15,
// D20/D21, K5/K9): a status chip, where `next` leads, an Open button, a
// 4-line summary preview, up to six artifact chips then `+N`, and the
// open-question count. Everything else lives in the modal the card owns
// (mounted only while open, portaled — K5), so a task switch that unmounts the
// card closes it too.
//
// Three variants share it: `transcript` (a step's own final message),
// `prompt` (a previous step's handoff quoted into the next step's prompt —
// untrusted, D17) and `history` (the run view's history row, D1a). Plus two
// siblings: `InvalidHandoffCard` for a real tag pair whose body doesn't parse,
// and `HandoffFileCard` for a prompt placeholder that points at a file.
import { memo, useCallback, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CircleAlert, FileJson, Handshake, Maximize2, Search, ShieldAlert } from "lucide-react";
import type { Handoff } from "../../../shared/types.ts";
import type { HandoffPromptPart } from "../../../shared/pipeline.ts";
import { ASSISTANT_MD_COMPONENTS, MD_URL_TRANSFORM } from "@/components/kanban/md-components";
import { cardArtifacts, classifyHandoffArtifact } from "@/lib/handoff-artifacts";
import { handoffMatchLocation, handoffNextLabel, handoffStatusChip, stepIdForName } from "@/lib/handoff-view";
import type { ExpandOnJumpDetail } from "@/lib/expand-on-jump";
import { useExpandOnJump } from "@/lib/use-expand-on-jump";
import { cn } from "@/lib/utils";
import { HandoffArtifactChips } from "./HandoffArtifactChips";
import { HandoffDialog } from "./HandoffDialog";
import { handoffRecordForFile, RecordHandoffDialog, useFileOpener } from "./HandoffFileChip";
import { stepNameFor, useHandoffView } from "./handoff-context";

const CARD_CLASS = "rounded-md border border-border/60 bg-card p-3 text-foreground";

function StatusChip({ handoff }: { handoff: Handoff }) {
  const chip = handoffStatusChip(handoff);
  return (
    <span
      data-testid="handoff-card-status"
      className={cn(
        "rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
        chip.tone === "success" ? "bg-success/15 text-success" : "bg-warning/15 text-warning",
      )}
    >
      {chip.label}
    </span>
  );
}

function OpenButton({ onClick, testId = "handoff-card-open" }: { onClick: () => void; testId?: string }) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className="ml-auto inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-border/60 px-2 text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground"
    >
      <Maximize2 className="size-3" aria-hidden />
      Open
    </button>
  );
}

/** `Handoff from "<step>" · untrusted` (prompt) or plain `Handoff`. */
function CardLabel({ fromStepName, untrusted }: { fromStepName?: string | null; untrusted?: boolean }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1 text-xs font-medium">
      {untrusted ? (
        <ShieldAlert className="size-3.5 shrink-0 text-warning" aria-hidden />
      ) : (
        <Handshake className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      )}
      <span className="truncate">
        {fromStepName ? `Handoff from "${fromStepName}"` : "Handoff"}
        {untrusted && <span className="text-warning"> · untrusted</span>}
      </span>
    </span>
  );
}

export interface HandoffCardProps {
  handoff: Handoff;
  variant: "transcript" | "prompt" | "history";
  /** Whether the pipeline used this handoff (D21) — `not-used` shows the
   *  muted chip; `null`/absent shows nothing. Also shown in the modal. */
  usage?: "used" | "not-used" | null;
  /** Prompt variant: the step the quoted handoff came from (resolved to its
   *  id through the graph for `next`). History: an optional label override. */
  fromStepName?: string | null;
  /** The data was quoted into a prompt by the runner (D17). */
  untrusted?: boolean;
  /** The step that produced the handoff, overriding the context's own step
   *  (the run view passes each history record's `stepId`). */
  stepId?: string | null;
}

export const HandoffCard = memo(function HandoffCard({
  handoff,
  variant,
  usage = null,
  fromStepName = null,
  untrusted = false,
  stepId,
}: HandoffCardProps) {
  const ctx = useHandoffView();
  const [open, setOpen] = useState(false);
  const [searchHint, setSearchHint] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const sourceStepId =
    stepId !== undefined
      ? stepId
      : variant === "prompt"
        ? fromStepName
          ? stepIdForName(ctx.graph, fromStepName)
          : null
        : ctx.stepId;
  const sourceStepName =
    stepNameFor(ctx.graph, sourceStepId) ??
    (variant === "prompt" ? fromStepName : variant === "transcript" ? ctx.stepName : null);

  const next = useMemo(() => handoffNextLabel(handoff, ctx.graph, sourceStepId), [handoff, ctx.graph, sourceStepId]);
  const { chips, hiddenCount } = useMemo(
    () =>
      cardArtifacts(
        handoff.artifacts.map((entry) => classifyHandoffArtifact(entry, { roots: ctx.roots, homeDir: ctx.homeDir })),
      ),
    [handoff.artifacts, ctx.roots, ctx.homeDir],
  );

  const onJump = useCallback(
    (detail: ExpandOnJumpDetail) => {
      const where = handoffMatchLocation(handoff, detail.query ?? "", { roots: ctx.roots, homeDir: ctx.homeDir });
      setSearchHint(where === "modal");
    },
    [handoff, ctx.roots, ctx.homeDir],
  );
  useExpandOnJump(rootRef, onJump);

  const openModal = useCallback(() => {
    setSearchHint(false);
    setOpen(true);
  }, []);

  const status = handoffStatusChip(handoff).status;
  const questions = handoff.openQuestions.length;
  const label = variant === "history" ? null : variant === "prompt" ? fromStepName : null;
  const title =
    variant === "transcript"
      ? "Handoff"
      : sourceStepName
        ? `Handoff from "${sourceStepName}"`
        : "Handoff";

  return (
    <div
      ref={rootRef}
      data-testid="handoff-card"
      data-variant={variant}
      data-status={status}
      className={cn(CARD_CLASS, untrusted && "border-warning/40")}
    >
      <div className="flex flex-wrap items-center gap-2">
        <CardLabel fromStepName={label} untrusted={untrusted} />
        <StatusChip handoff={handoff} />
        <span
          data-testid="handoff-card-next"
          data-next-kind={next.kind}
          className={cn("min-w-0 truncate text-xs", next.tone === "warning" ? "text-warning" : "text-muted-foreground")}
        >
          {next.text}
        </span>
        {usage === "not-used" && (
          <span
            data-testid="handoff-card-not-used"
            title="The pipeline read a different handoff from this step"
            className="rounded border border-border/60 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground"
          >
            Not used
          </span>
        )}
        <OpenButton onClick={openModal} />
      </div>

      {handoff.summary.trim() !== "" && (
        <div data-testid="handoff-card-summary" className="agetor-md mt-2 line-clamp-4 text-sm">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={ASSISTANT_MD_COMPONENTS} urlTransform={MD_URL_TRANSFORM}>
            {handoff.summary}
          </ReactMarkdown>
        </div>
      )}

      <HandoffArtifactChips variant="card" artifacts={chips} hiddenCount={hiddenCount} onMore={openModal} />

      {questions > 0 && (
        <button
          type="button"
          data-testid="handoff-card-questions"
          onClick={openModal}
          className="mt-2 block text-xs text-muted-foreground hover:text-foreground"
        >
          {`? ${questions} open ${questions === 1 ? "question" : "questions"}`}
        </button>
      )}

      {searchHint && (
        <button
          type="button"
          data-testid="handoff-card-search-hint"
          onClick={openModal}
          className="mt-2 inline-flex items-center gap-1 rounded border border-info/40 bg-info/10 px-1.5 py-0.5 text-[11px] text-info hover:bg-info/15"
        >
          <Search className="size-3" aria-hidden />
          Match in handoff — Open to see it
        </button>
      )}

      {open && (
        <HandoffDialog
          open
          onClose={() => setOpen(false)}
          handoff={handoff}
          title={title}
          untrusted={untrusted}
          stepName={sourceStepName}
          next={next}
          usage={usage}
        />
      )}
    </div>
  );
});

/** A real `<handoff>` tag pair whose body doesn't parse (D8): the error in
 *  the danger tone, the raw body collapsed under it. */
export const InvalidHandoffCard = memo(function InvalidHandoffCard({
  error,
  raw,
}: {
  error: string;
  raw: string | null;
}) {
  return (
    <div data-testid="handoff-invalid-card" className="rounded-md border border-danger/50 bg-danger/10 p-3 text-foreground">
      <div className="flex items-center gap-1.5 text-xs font-medium text-danger">
        <CircleAlert className="size-3.5 shrink-0" aria-hidden />
        Invalid handoff
      </div>
      <p className="mt-1 whitespace-pre-wrap break-words text-xs text-danger">{error}</p>
      {raw !== null && raw !== "" && (
        <details data-testid="handoff-invalid-raw" className="mt-2 text-xs">
          <summary className="cursor-pointer select-none text-muted-foreground hover:text-foreground">Raw handoff</summary>
          <pre className="mt-1 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded border border-border/40 bg-muted/40 p-2 font-mono text-[11px]">
            {raw}
          </pre>
        </details>
      )}
    </div>
  );
});

type HandoffFilePart = Extract<HandoffPromptPart, { kind: "handoff-file" }>;

/** A prompt placeholder for a previous handoff that wasn't inlined (D17):
 *  saved to a file, or too large with no file. Open reaches the modal
 *  through the file's history record (D18), else OS-opens the file. */
export const HandoffFileCard = memo(function HandoffFileCard({ part }: { part: HandoffFilePart }) {
  const ctx = useHandoffView();
  const record = useMemo(
    () => handoffRecordForFile(part.filePath, ctx.parentId, ctx.run),
    [part.filePath, ctx.parentId, ctx.run],
  );
  const { openFile, dialogs } = useFileOpener(ctx.taskId);
  const [open, setOpen] = useState(false);
  const filePath = part.filePath;
  const detail =
    filePath === null
      ? "Too large to inline; no file available"
      : part.tooLarge
        ? "Too large to inline — saved to a file"
        : "Saved to a file";

  return (
    <div data-testid="handoff-file-card" className={cn(CARD_CLASS, "border-warning/40")}>
      <div className="flex flex-wrap items-center gap-2">
        <CardLabel fromStepName={part.fromStep} untrusted />
        {filePath !== null && (
          <OpenButton
            testId="handoff-file-card-open"
            onClick={() => (record ? setOpen(true) : openFile(filePath))}
          />
        )}
      </div>
      <div className="mt-1 flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
        <FileJson className="size-3 shrink-0" aria-hidden />
        <span className="shrink-0">{detail}</span>
        {filePath !== null && (
          <span className="min-w-0 truncate font-mono text-[10px]" title={filePath}>
            {filePath}
          </span>
        )}
      </div>
      {open && record && <RecordHandoffDialog record={record} graph={ctx.graph} onClose={() => setOpen(false)} />}
      {dialogs}
    </div>
  );
});
