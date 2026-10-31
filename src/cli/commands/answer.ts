import * as p from "@clack/prompts";
import { getClient, type Flags } from "../context.ts";
import { usageError } from "../usage.ts";
import { resolveTask } from "../resolve.ts";
import { c, out, isTTY } from "../output.ts";
import { ApiError, type AgetorClient } from "../api-client.ts";
import type {
  AskQuestionsRequest,
  TmuxPromptRequest,
  FxPermissionRequest,
} from "../../bun/interactions.ts";
import { buildAskAnswer, CUSTOM_OPTION } from "../answer-logic.ts";
import { CURSOR_ASK_FREEFORM } from "../../shared/cursor-ask-verdict.ts";
import { cursorAskOptionChoiceLabel, cursorAskOptionValue, cursorAskPicksFromValues } from "../../shared/cursor-ask.ts";

const CURSOR_SKIP = "__cursor_skip__";

export async function cmdAnswer(args: string[], flags: Flags): Promise<void> {
  const ref = args[0];
  if (!ref) throw usageError("answer");
  if (!isTTY) {
    throw new Error("agetor answer needs an interactive terminal (TTY)");
  }
  const client = await getClient(flags);
  const task = await resolveTask(client, ref);
  const pending = await client.pendingInteractions(task.id);
  if (pending.length === 0) {
    out(c.dim("nothing pending for this task"));
    return;
  }

  for (const req of pending) {
    // A pipeline parent's pending list aggregates its hidden step tasks'
    // cards — say which step task this one belongs to when it isn't the
    // task the user named.
    if (req.taskId !== task.id) out(c.dim(`↳ on step task ${req.taskId.slice(0, 8)}`));
    if (req.kind === "ask_questions") {
      const ok = await answerAsk(client, req);
      if (!ok) return; // cancelled
    } else if (req.kind === "tmux_prompt") {
      const ok = await answerTmux(client, req);
      if (!ok) return;
    } else {
      const ok = await answerFx(client, req);
      if (!ok) return;
    }
  }
}

async function answerAsk(client: AgetorClient, req: AskQuestionsRequest): Promise<boolean> {
  const answers: Array<{ selected: string[]; selectedOptionIds?: string[]; custom?: string }> = [];
  if (req.title) out(c.bold(req.title));
  for (const q of req.questions) {
    p.note(q.question, q.header ?? "question");
    const options = [
      ...q.options.map((o) => ({
        value: req.source === "cursor" ? cursorAskOptionValue(o) : o.label,
        label: req.source === "cursor" ? cursorAskOptionChoiceLabel(o, q.options) : o.label,
        hint: o.description,
      })),
      { value: CUSTOM_OPTION, label: "✎ Other — type a custom answer" },
      ...(req.source === "cursor" ? [{ value: CURSOR_SKIP, label: "Skip" }] : []),
    ];
    // Re-prompt this question until it has at least one option or custom text.
    let entry: { selected: string[]; selectedOptionIds?: string[]; custom?: string } | null = null;
    while (entry === null) {
      let picks: string[];
      if (q.multiSelect) {
        const sel = await p.multiselect({ message: "Select (space to pick)", options, required: false });
        if (p.isCancel(sel)) return cancel();
        picks = sel as string[];
      } else {
        const sel = await p.select({ message: "Select", options });
        if (p.isCancel(sel)) return cancel();
        picks = [sel as string];
      }
      if (req.source === "cursor" && picks.includes(CURSOR_SKIP)) {
        try {
          const res = await client.answerAskQuestions(req.id, { skip: true });
          out(res.ok ? c.green("✓ skipped") : c.red("failed to skip"));
        } catch (e) {
          if (e instanceof ApiError && e.status === 409) {
            out(c.dim("already being answered elsewhere"));
            return true;
          }
          // A refused skip (the restart follow-up could not be sent) leaves
          // the card pending. Match submit: print the error, don't throw.
          if (e instanceof ApiError && e.status === 400) {
            out(c.red(e.message || "could not skip"));
            return false;
          }
          throw e;
        }
        return true;
      }
      let custom: string | null = null;
      if (picks.includes(CUSTOM_OPTION)) {
        custom = await promptCustom();
        if (custom === null) return cancel();
      }
      entry = buildAskAnswer(picks, custom);
      if (entry && req.source === "cursor") {
        const mapped = cursorAskPicksFromValues(q.options, entry.selected);
        entry = entry.custom ? { ...mapped, custom: entry.custom } : mapped;
      }
      if (
        entry
        && req.source === "cursor"
        && CURSOR_ASK_FREEFORM === "unsupported"
        && entry.custom
      ) {
        // Multi-select can carry options and typed text together. The typed
        // text cannot be delivered, so accepting the options alone would
        // report the question answered without it.
        p.note("Cursor cannot accept a custom answer — pick an option.", "required");
        entry = null;
      } else if (entry === null) {
        p.note("Pick an option or add a custom answer.", "required");
      }
    }
    answers.push(entry);
  }
  try {
    const res = await client.answerAskQuestions(req.id, answers);
    out(res.ok ? c.green("✓ answered") : c.red("failed to answer"));
  } catch (e) {
    // 409: another client (the app, the TUI, a second `agetor answer`) is
    // answering this same card right now — nothing was sent on our behalf.
    if (e instanceof ApiError && e.status === 409) {
      out(c.dim("already being answered elsewhere"));
      return true;
    }
    // 400: Cursor refused the payload (custom text it cannot deliver). The
    // card stays pending — don't surface that as an uncaught failure.
    if (e instanceof ApiError && e.status === 400 && req.source === "cursor") {
      out(c.red(e.message || "Cursor cannot accept a custom answer — pick an option"));
      return false;
    }
    throw e;
  }
  return true;
}

/** Prompt for a non-empty free-text custom answer. Returns null on cancel. */
async function promptCustom(): Promise<string | null> {
  const text = await p.text({
    message: "Your answer",
    validate: (v) => (v && v.trim() ? undefined : "type an answer (or Esc to cancel)"),
  });
  if (p.isCancel(text)) return null;
  return (text as string).trim();
}

async function answerTmux(client: AgetorClient, req: TmuxPromptRequest): Promise<boolean> {
  out(c.dim(req.paneText));
  const choice = await p.select({
    message: "Choose",
    options: [
      ...req.choices.map((ch) => ({ value: ch.key, label: ch.label })),
      { value: "__reject__", label: "Reject / Esc" },
    ],
  });
  if (p.isCancel(choice)) return cancel();
  const res =
    choice === "__reject__"
      ? await client.answerTmuxPrompt(req.id, { reject: true })
      : await client.answerTmuxPrompt(req.id, { key: choice });
  out(res.ok ? c.green("✓ answered") : c.red(res.error ?? "failed to answer"));
  return true;
}

async function answerFx(client: AgetorClient, req: FxPermissionRequest): Promise<boolean> {
  const title = req.toolCall.title ?? req.toolCall.kind ?? "tool call";
  const kindBadge = req.toolCall.kind ? c.dim(` [${req.toolCall.kind}]`) : "";
  out(`${title}${kindBadge} ${c.dim(`(${req.mode})`)}`);
  // Values are indexes into req.options, not fx's wire-provided optionIds —
  // an fx option literally named "__dismiss__" would otherwise collide with
  // the sentinel and get misread as a rejection. -1 marks the dismiss row.
  const DISMISS = -1;
  const choice = await p.select({
    message: "Choose",
    options: [
      ...req.options.map((o, i) => ({ value: i, label: o.name })),
      { value: DISMISS, label: "Dismiss (reject)" },
    ],
  });
  // Esc mirrors every sibling (answerAsk/answerTmux): it aborts the whole
  // `agetor answer` loop via cancel(), leaving the interaction pending —
  // only the explicit "Dismiss (reject)" row posts `{ cancel: true }`.
  if (p.isCancel(choice)) return cancel();
  const selected = choice === DISMISS ? null : req.options[choice as number];
  const body: { optionId: string } | { cancel: true } = selected
    ? { optionId: selected.optionId }
    : { cancel: true };
  const res = await client.answerFxPermission(req.id, body);
  out(res.ok ? c.green("✓ answered") : c.dim("already resolved (answered elsewhere or cancelled)"));
  return true;
}

function cancel(): boolean {
  p.cancel("cancelled");
  return false;
}
