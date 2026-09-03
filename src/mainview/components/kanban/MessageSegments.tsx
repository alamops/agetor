// Renderers for the `MessageSegment[]` model produced by
// `src/shared/user-message.ts`'s `parseMessageSegments` — the general
// "beautify any tag" mechanism described in
// docs/plans/tagged-user-messages.md §3. `RunPanel.tsx`'s `UserMessageBlock`
// is the sole consumer: it recognizes a user turn's overall shape (plain
// command echo, local-command output, or a "tagged" message carrying other
// machine-emitted or user-authored tags) and, for the latter two, hands the
// segment array off to `MessageSegments` below to render as a stack of
// labeled blocks instead of literal `<tag>` text.
//
// Known machine tags (`local-command-stdout`, `forked-skill-launch`,
// `bash-input`, `bash-stdout`, `bash-stderr` — see `MACHINE_TAGS` in the
// shared module) get a dedicated, purpose-built rendering; every other tag
// falls back to `GenericTagBlock`, which pretty-prints a JSON body, renders
// prose as markdown, and recurses into nested tags (depth-capped) — so an
// unrecognized tag never regresses to raw `<name>…</name>` text.
//
// Styled with semantic tokens only (`text-primary`, `text-muted-foreground`,
// `bg-muted`, `border-border`, `text-danger`, …) — never literal palette
// classes — per the repo's dark/light theming convention (CLAUDE.md "UI
// conventions").
import type React from "react";
import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { GitFork, Terminal } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  isMachineEmittedMessage,
  parseForkedSkillLaunch,
  forkedSkillLabel,
  parseMessageSegments,
  stripAnsiSgr,
  tryParseJsonBody,
  type ForkedSkillLaunch,
  type MessageSegment,
  type TagSegment,
} from "../../../shared/user-message.ts";
import { USER_MD_COMPONENTS } from "./md-components";

/** The existing 9px "you" / "command output" style label, hoisted here so
 *  every machine-emitted block (and `UserMessageBlock`'s own header) shares
 *  it instead of re-typing the class string. */
export function MachineLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-0.5 text-[9px] font-semibold uppercase tracking-wide text-primary/80">
      {children}
    </div>
  );
}

/** Body of a `command-output` message / `local-command-stdout` tag — mono,
 *  muted, whitespace preserved. `output` is expected pre-cleaned (ANSI
 *  stripped, trimmed) by the caller; an empty string renders as "—". */
export function CommandOutputBody({ output }: { output: string }) {
  return (
    <div
      data-testid="command-output-block"
      className="whitespace-pre-wrap font-mono text-[11px] text-muted-foreground"
    >
      {output || "—"}
    </div>
  );
}

/** A `<forked-skill-launch>` tag — a background-forkable skill kicked off
 *  from this turn. Renders as a compact card naming the skill (and, when
 *  present, the first 8 chars of the forked agent's id) rather than the raw
 *  JSON body. */
export function ForkedSkillCard({ launch }: { launch: ForkedSkillLaunch }) {
  return (
    <div
      data-testid="forked-skill-card"
      className="inline-flex flex-wrap items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2 py-1 text-[11px]"
    >
      <GitFork className="size-3 text-primary" />
      <span>Skill launched in background</span>
      <span className="rounded-md border border-primary/40 bg-primary/15 px-1.5 py-0.5 font-mono text-[11px] font-medium text-primary">
        {forkedSkillLabel(launch)}
      </span>
      {launch.agentId && (
        <span
          className="font-mono text-[10px] text-muted-foreground"
          title={launch.agentId}
        >
          agent {launch.agentId.slice(0, 8)}
        </span>
      )}
    </div>
  );
}

/** A `<bash-input>` tag — the command line of a `!`-prefixed shell escape. */
export function ShellInputBlock({ command }: { command: string }) {
  return (
    <div data-testid="shell-input-block">
      <MachineLabel>shell</MachineLabel>
      <div className="flex items-start gap-1">
        <Terminal className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
        <span className="whitespace-pre-wrap font-mono text-[11px] text-foreground">
          $ {command.trim()}
        </span>
      </div>
    </div>
  );
}

/** A `<bash-stdout>` / `<bash-stderr>` tag from the same shell escape.
 *  Renders nothing when `body` is empty/whitespace-only — an empty stdout
 *  next to a populated stderr contributes no block at all, mirroring the
 *  existing `parsed.output || "—"` idiom (that fallback lives one level up,
 *  in `parseUserMessage`'s `command-output` kind — this tag-level block has
 *  nothing worth showing for an empty body, so it simply omits itself). */
export function ShellOutputBlock({
  kind,
  body,
}: {
  kind: "stdout" | "stderr";
  body: string;
}) {
  const trimmed = body.trim();
  if (!trimmed) return null;
  const isError = kind === "stderr";
  return (
    <div data-testid="shell-output-block" data-kind={kind}>
      <MachineLabel>{isError ? "shell error" : "shell output"}</MachineLabel>
      <div
        className={cn(
          "whitespace-pre-wrap font-mono text-[11px]",
          isError ? "text-danger" : "text-muted-foreground",
        )}
      >
        {trimmed}
      </div>
    </div>
  );
}

/** Fallback rendering for any tag not otherwise recognized above — including
 *  a `forked-skill-launch` whose body fails to parse as valid JSON. Shows
 *  the raw (lowercase) tag name as a mono pill, any attributes muted beside
 *  it, and the body as: pretty-printed JSON when it parses as an
 *  object/array, a recursive `MessageSegments` pass when nested tags might be
 *  present and the recursion depth budget isn't exhausted, or plain markdown
 *  otherwise. An empty/whitespace-only body renders no body at all — just
 *  the header. */
export function GenericTagBlock({
  segment,
  depth,
}: {
  segment: TagSegment;
  depth: number;
}) {
  const isEmpty = segment.body.trim() === "";
  // Both parses run in the render body, but only ever need to redo the work
  // when the underlying tag body changes — not on every re-render (e.g. a
  // sibling's Show more/less toggle). Hooks are called unconditionally
  // (both memos compute regardless of `isEmpty`/`jsonValue`) and only the
  // JSX below branches on their results.
  const jsonValue = useMemo(
    () => (isEmpty ? undefined : tryParseJsonBody(segment.body)),
    [isEmpty, segment.body],
  );
  const nestedSegments = useMemo(
    () => parseMessageSegments(segment.body),
    [segment.body],
  );

  return (
    <div
      data-testid="user-tag-block"
      data-tag={segment.name}
      className="my-1 rounded-md border border-border bg-muted/30 px-2 py-1"
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="rounded border border-border bg-background/60 px-1 font-mono text-[10px] text-muted-foreground">
          {segment.name}
        </span>
        {segment.attrs && (
          <span className="font-mono text-[10px] text-muted-foreground/70">
            {segment.attrs}
          </span>
        )}
      </div>
      {!isEmpty && (
        <div className="mt-1">
          {jsonValue !== undefined ? (
            <pre className="whitespace-pre-wrap font-mono text-[11px] text-muted-foreground">
              {JSON.stringify(jsonValue, null, 2)}
            </pre>
          ) : depth < 3 ? (
            <MessageSegments segments={nestedSegments} depth={depth + 1} />
          ) : (
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={USER_MD_COMPONENTS}>
              {segment.body.trim()}
            </ReactMarkdown>
          )}
        </div>
      )}
    </div>
  );
}

/** True for a `bash-stdout`/`bash-stderr` segment whose body is empty or
 *  whitespace-only — the two cases `ShellOutputBlock` itself renders as
 *  `null`. Every other segment kind always renders something (a text
 *  segment is never blank per `parseMessageSegments`; every other tag
 *  renders at least its name pill via `GenericTagBlock`, or a card). */
function rendersNothing(seg: MessageSegment): boolean {
  return (
    seg.kind === "tag" &&
    (seg.name === "bash-stdout" || seg.name === "bash-stderr") &&
    seg.body.trim() === ""
  );
}

/**
 * Dispatch a full `MessageSegment[]` — the output of `parseMessageSegments`
 * — into a vertical stack of rendered blocks: text segments as markdown,
 * known machine tags via their dedicated renderer, everything else via
 * `GenericTagBlock`. `depth` bounds `GenericTagBlock`'s recursion into
 * nested tags (see `parseMessageSegments`'s own same-name-nesting handling
 * for why a tag's body can itself contain tags); callers rendering a
 * top-level message omit it (defaults to 0). Keys are index-based — segments
 * are derived fresh from one immutable string on every parse, so there's no
 * stable identity to key on and no reordering to worry about.
 *
 * A silent `!`-shell-escape parses to `<bash-stdout></bash-stdout><bash-stderr>
 * </bash-stderr>` — two segments that each render as `null` (see
 * `ShellOutputBlock`) — which would otherwise leave a bordered, blank "you"
 * bubble with no label at all. `visibleSegments` drops those dead segments
 * up front so that case can be detected: when the input carried at least one
 * segment but nothing is left to render, fall back to a labeled "—" block,
 * mirroring `userMessageLines`'s `cmd› —` guard (shared/user-message.ts).
 *
 * The container itself is `.agetor-md` (see index.css) so a text segment's
 * markdown gets the same heading/paragraph rhythm as everywhere else the
 * class is used — a plain `flex flex-col gap-1` here would collapse that
 * spacing to a uniform 0.25rem gap and keep a leading heading's `margin-top`.
 */
export function MessageSegments({
  segments,
  depth = 0,
}: {
  segments: MessageSegment[];
  depth?: number;
}) {
  const visibleSegments = segments.filter((seg) => !rendersNothing(seg));

  if (segments.length > 0 && visibleSegments.length === 0) {
    return (
      <div data-testid="message-segments">
        <MachineLabel>shell output</MachineLabel>
        <CommandOutputBody output="" />
      </div>
    );
  }

  return (
    <div data-testid="message-segments" className="agetor-md">
      {visibleSegments.map((seg, i) => {
        if (seg.kind === "text") {
          return (
            <ReactMarkdown key={i} remarkPlugins={[remarkGfm]} components={USER_MD_COMPONENTS}>
              {seg.text}
            </ReactMarkdown>
          );
        }

        if (seg.name === "local-command-stdout") {
          return (
            <div key={i}>
              <MachineLabel>command output</MachineLabel>
              <CommandOutputBody output={stripAnsiSgr(seg.body).trim()} />
            </div>
          );
        }

        if (seg.name === "forked-skill-launch") {
          const launch = parseForkedSkillLaunch(seg.body);
          return launch ? (
            <ForkedSkillCard key={i} launch={launch} />
          ) : (
            <GenericTagBlock key={i} segment={seg} depth={depth} />
          );
        }

        if (seg.name === "bash-input") {
          return <ShellInputBlock key={i} command={seg.body} />;
        }

        if (seg.name === "bash-stdout") {
          return <ShellOutputBlock key={i} kind="stdout" body={seg.body} />;
        }

        if (seg.name === "bash-stderr") {
          return <ShellOutputBlock key={i} kind="stderr" body={seg.body} />;
        }

        return <GenericTagBlock key={i} segment={seg} depth={depth} />;
      })}
    </div>
  );
}

/** True when `segments` carries any user-authored text — i.e. it's NOT the
 *  case that every segment is a machine-emitted tag. Drives `UserMessageBlock`'s
 *  header: a purely machine-emitted message (e.g. the forked-skill-launch
 *  fixture) shows no "you" label at all, since every block it renders
 *  already carries its own label. */
export function hasAuthoredContent(segments: MessageSegment[]): boolean {
  return !isMachineEmittedMessage(segments);
}
