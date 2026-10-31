/**
 * Pure Cursor ask-question helpers shared by the driver, the answer route,
 * the card, and the CLI. The freeform branch reads `CURSOR_ASK_FREEFORM`
 * and is not rewritten when that constant changes.
 */
import { CURSOR_ASK_FREEFORM, type CursorAskFreeform } from "./cursor-ask-verdict.ts";

/** `prompt` when it is non-empty, otherwise `promptMarkdown`, otherwise `""`. */
export function questionText(
  prompt: string | null | undefined,
  promptMarkdown?: string | null,
): string {
  if (typeof prompt === "string" && prompt.length > 0) return prompt;
  if (typeof promptMarkdown === "string" && promptMarkdown.length > 0) return promptMarkdown;
  return "";
}

export interface CursorAskOptionView {
  id: string;
  label: string;
}

export interface CursorAskQuestionView {
  id: string;
  /** `questionText(prompt, promptMarkdown)`. Plain text. */
  text: string;
  prompt: string;
  promptMarkdown?: string;
  allowMultiple: boolean;
  options: CursorAskOptionView[];
}

export interface CursorAskView {
  title: string;
  toolCallId: string;
  questions: CursorAskQuestionView[];
}

export interface CursorAskMappedAnswer {
  questionId: string;
  selectedOptionIds: string[];
  freeformText?: string;
}

export type CursorAskLabelMapResult =
  | { ok: true; answers: CursorAskMappedAnswer[] }
  | { ok: false; error: string };

const FREEFORM_OTHER_ID = "__freeform_other__";

export type CursorAskDelivery = "live" | "restart-followup";

/** Why a follow-up card is no longer a live RPC. `"restart"` is a boot
 *  rebuild. `"child-exit"` is the cursor-agent process leaving while Agetor
 *  stayed up. Absent on a follow-up means restart. */
export type CursorAskFollowupCause = "restart" | "child-exit";

/** Card status line. A dead agent must not reuse the boot-restart sentence. */
export function cursorAskCardHeading(
  delivery: CursorAskDelivery | undefined,
  cause?: CursorAskFollowupCause,
): string {
  if (delivery !== "restart-followup") return "Cursor is waiting";
  if (cause === "child-exit") return "Cursor's wait ended when the agent exited";
  return "Cursor's wait ended when Agetor restarted";
}

/** Waiting line under an unanswered `askQuestionToolCall` block. Tracks the
 *  card: a dead agent is not still waiting, and it did not restart Agetor.
 *  A missing delivery means the card is still a live wait. */
export function cursorAskToolBanner(
  delivery: CursorAskDelivery | undefined,
  cause?: CursorAskFollowupCause,
): string {
  if (delivery === "restart-followup" && cause === "child-exit") {
    return "Cursor's wait ended when the agent exited — answer it in the card above.";
  }
  if (delivery === "restart-followup") {
    return "Cursor's wait ended when Agetor restarted — answer it in the card above.";
  }
  return "Cursor is waiting — answer it in the card above.";
}

/** Waiting line for one `askQuestionToolCall`, or null when that tool call
 *  has no card. Stop, archive, delete, and a finished answer drop the card;
 *  a missing card is not still a live wait. */
export function cursorAskToolFooter(
  pending: { delivery?: CursorAskDelivery; followupCause?: CursorAskFollowupCause } | undefined,
): string | null {
  if (!pending) return null;
  return cursorAskToolBanner(pending.delivery, pending.followupCause);
}

/** Picker value for one option. An id keeps two options that share a label
 *  distinct. A scraper option with no id stays the label. */
export function cursorAskOptionValue(option: { id?: string; label: string }): string {
  return option.id && option.id.length > 0 ? option.id : option.label;
}

/** Visible label. A duplicated label gains its id so the second option can
 *  be told apart. Unique labels stay as Cursor sent them. */
export function cursorAskOptionChoiceLabel(
  option: { id?: string; label: string },
  options: ReadonlyArray<{ label: string }>,
): string {
  const duplicated = options.filter((candidate) => candidate.label === option.label).length > 1;
  if (duplicated && option.id) return `${option.label} (${option.id})`;
  return option.label;
}

/**
 * Turn picker values into the answer payload. When every value is an option
 * id, `selectedOptionIds` is the authority and `selected` carries the labels.
 * A label-only pick leaves `selectedOptionIds` unset so the first unused
 * option with that label still binds.
 */
export function cursorAskPicksFromValues(
  options: ReadonlyArray<{ id?: string; label: string }>,
  values: readonly string[],
): { selected: string[]; selectedOptionIds?: string[] } {
  const ids: string[] = [];
  const labels: string[] = [];
  let allIds = values.length > 0;
  for (const value of values) {
    const byId = options.find((option) => option.id !== undefined && option.id.length > 0 && option.id === value);
    if (byId?.id) {
      ids.push(byId.id);
      labels.push(byId.label);
      continue;
    }
    allIds = false;
    labels.push(options.find((option) => option.label === value)?.label ?? value);
  }
  if (allIds) return { selected: labels, selectedOptionIds: ids };
  return { selected: labels };
}

/**
 * Whether every question has an answer Cursor can deliver.
 * Unsupported freeform rejects typed text on its own, and typed text on a
 * multi-select even when options are also picked — that note is part of
 * the answer, and sending the options alone would report it answered.
 * A single-select leftover note does not block the selected option.
 */
export function cursorAskCanAdvance(
  questions: ReadonlyArray<{ multiSelect?: boolean }>,
  answers: ReadonlyArray<{ selected: readonly string[]; custom: string }>,
  freeform: CursorAskFreeform = CURSOR_ASK_FREEFORM,
): boolean {
  return questions.every((question, index) => {
    const answer = answers[index] ?? { selected: [], custom: "" };
    const custom = answer.custom.trim();
    const picked = answer.selected.length > 0;
    if (freeform === "unsupported" && custom.length > 0 && (!picked || question.multiSelect === true)) {
      return false;
    }
    return picked || (freeform !== "unsupported" && custom.length > 0);
  });
}

/**
 * Custom text to send with one question. Unsupported freeform drops a
 * leftover note on a single-select so the selected option still submits.
 * A multi-select note is sent through, and the mapper rejects it, so the
 * card stays up instead of answering without that note.
 */
export function cursorAskWireCustom(
  multiSelect: boolean,
  custom: string,
  freeform: CursorAskFreeform = CURSOR_ASK_FREEFORM,
): string | undefined {
  const trimmed = custom.trim();
  if (!trimmed) return undefined;
  if (freeform === "unsupported" && !multiSelect) return undefined;
  return trimmed;
}

/**
 * The follow-up a restarted Cursor question sends when the user skips.
 * This is the sentence print mode used to auto-reject `askQuestionToolCall`.
 * It does not name Agetor.
 */
export const CURSOR_ASK_SKIP_FOLLOWUP =
  "Questions skipped by the user, continue with the information you already have";

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function parseQuestion(raw: unknown): CursorAskQuestionView | null {
  if (!isRecord(raw)) return null;
  const id = asString(raw.id);
  if (!id) return null;
  const prompt = asString(raw.prompt) ?? "";
  const promptMarkdown = asString(raw.promptMarkdown);
  const optionsRaw = Array.isArray(raw.options) ? raw.options : [];
  const options: CursorAskOptionView[] = [];
  for (const opt of optionsRaw) {
    if (!isRecord(opt)) continue;
    const optId = asString(opt.id);
    const label = asString(opt.label);
    if (!optId || label === undefined) continue;
    options.push({ id: optId, label });
  }
  return {
    id,
    prompt,
    ...(promptMarkdown !== undefined ? { promptMarkdown } : {}),
    text: questionText(prompt, promptMarkdown),
    allowMultiple: raw.allowMultiple === true,
    options,
  };
}

function questionsFromArgs(args: Record<string, unknown>): CursorAskQuestionView[] {
  const raw = Array.isArray(args.questions) ? args.questions : [];
  const out: CursorAskQuestionView[] = [];
  for (const q of raw) {
    const parsed = parseQuestion(q);
    if (parsed) out.push(parsed);
  }
  return out;
}

/**
 * Parse a `tool_use` chunk (or its `input`) for `askQuestionToolCall`.
 * Accepts the pinned envelope and the historical stream-json `tool_call`
 * object `mapCursorEvent` stored as `input`. Returns null when the value
 * is not that tool.
 */
export function cursorAskFromToolUse(raw: unknown): CursorAskView | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.name === "string" && raw.name !== "askQuestionToolCall") return null;

  const input = isRecord(raw.input) ? raw.input : raw;
  const envelope = isRecord(input.askQuestionToolCall) ? input.askQuestionToolCall : null;
  const args = envelope && isRecord(envelope.args)
    ? envelope.args
    : isRecord(input.args)
      ? input.args
      : input._toolName === "askQuestion" || isRecord(input.askQuestionToolCall)
        ? input
        : null;
  if (!args || !isRecord(args)) return null;
  if (!envelope && input._toolName !== "askQuestion" && !isRecord(input.askQuestionToolCall) && typeof raw.name !== "string") {
    return null;
  }

  const questions = questionsFromArgs(args);
  if (!envelope && input._toolName !== "askQuestion" && typeof raw.name !== "string" && questions.length === 0) {
    return null;
  }
  // A name-less object that isn't the ask envelope is not this tool.
  if (!envelope && input._toolName !== "askQuestion" && raw.name !== "askQuestionToolCall") return null;

  const title = asString(args.title) ?? "";
  const toolCallId =
    asString(raw.id)
    ?? asString(input.toolCallId)
    ?? asString(args.toolCallId)
    ?? "";
  return { title, toolCallId, questions };
}

/**
 * Map card answers (option labels + optional custom text) onto Cursor
 * option ids. `selectedOptionIds`, when non-empty, is the authority — that
 * is how the second option with a duplicated label is chosen. Otherwise
 * duplicate labels bind to the first option with that label that is not yet
 * used, in option order.
 *
 * `verdict` defaults to the wave-0 constant. Tests pass the other two
 * values; production callers leave it unset.
 *
 * `"unsupported"` cannot deliver typed text. Custom text with no mapped
 * option is an error. Custom text on a multi-select question is an error
 * too: it is part of the answer, and a success result would drop it while
 * `agetor answer` and the TUI report the question answered. Custom text
 * alongside a mapped option on a single-select question is dropped so a
 * leftover textarea does not reject that pick.
 */
export function cursorAskAnswersFromLabels(
  questions: Array<{
    id: string;
    multiSelect?: boolean;
    options: Array<{ id: string; label: string }>;
  }>,
  answers: Array<{ selected: string[]; selectedOptionIds?: string[]; custom?: string }>,
  verdict: CursorAskFreeform = CURSOR_ASK_FREEFORM,
): CursorAskLabelMapResult {
  const mapped: CursorAskMappedAnswer[] = [];
  for (let i = 0; i < questions.length; i++) {
    const question = questions[i]!;
    if (!question.id) return { ok: false, error: "Cursor question is missing an id" };
    const answer = answers[i] ?? { selected: [] };
    const custom = typeof answer.custom === "string" ? answer.custom.trim() : "";
    const used = new Set<string>();
    const selectedOptionIds: string[] = [];
    const explicitIds = Array.isArray(answer.selectedOptionIds) ? answer.selectedOptionIds : [];
    if (explicitIds.length > 0) {
      for (const id of explicitIds) {
        const opt = question.options.find((o) => o.id === id && !used.has(o.id));
        if (!opt) continue;
        if (!opt.id) return { ok: false, error: "Cursor option is missing an id" };
        used.add(opt.id);
        selectedOptionIds.push(opt.id);
      }
    } else {
      for (const label of answer.selected) {
        const opt = question.options.find((o) => o.label === label && !used.has(o.id));
        if (!opt) continue;
        if (!opt.id) return { ok: false, error: "Cursor option is missing an id" };
        used.add(opt.id);
        selectedOptionIds.push(opt.id);
      }
    }
    if (verdict === "unsupported" && custom.length > 0 && (selectedOptionIds.length === 0 || question.multiSelect)) {
      return { ok: false, error: "Cursor cannot accept a custom answer — pick an option" };
    }
    const item: CursorAskMappedAnswer = { questionId: question.id, selectedOptionIds };
    if (custom.length > 0 && verdict === "freeformText") {
      if (!question.multiSelect) item.selectedOptionIds = [];
      item.freeformText = custom;
    } else if (custom.length > 0 && verdict === "freeformOther") {
      item.selectedOptionIds = [...item.selectedOptionIds, FREEFORM_OTHER_ID];
      item.freeformText = custom;
    }
    mapped.push(item);
  }
  return { ok: true, answers: mapped };
}

/**
 * Follow-up text for a restarted or exited Cursor card. Built from the
 * mapped answers, so a leftover custom string that the mapper dropped does
 * not replace the option the card accepted. A shared label keeps the option
 * id, the same spelling the card shows, so two options with one label stay
 * different answers.
 */
export function formatCursorAskFollowup(
  questions: Array<{ question: string; options: Array<{ id?: string; label: string }> }>,
  answers: CursorAskMappedAnswer[],
): string {
  const escape = (s: string) => s.replace(/"/g, '\\"');
  const parts = questions.map((question, i) => {
    const answer = answers[i];
    const labels: string[] = [];
    for (const id of answer?.selectedOptionIds ?? []) {
      const option = question.options.find((candidate) => (candidate.id ?? "") === id);
      if (!option) continue;
      const shown = cursorAskOptionChoiceLabel(option, question.options);
      if (shown) labels.push(shown);
    }
    const freeform = answer?.freeformText?.trim();
    if (freeform) labels.push(freeform);
    const value = labels.length > 0 ? labels.join(", ") : "(no answer)";
    return `"${escape(question.question)}"="${escape(value)}"`;
  });
  return `Here are my answers: ${parts.join(", ")}.`;
}

/** Plain lines for logs and the TUI: title (when set), then each question
 *  and its options. A shared label keeps its id, matching the card. */
export function cursorAskPlainLines(ask: {
  title?: string;
  questions: Array<{
    text?: string;
    prompt?: string;
    promptMarkdown?: string | null;
    options: Array<{ id?: string; label: string }>;
  }>;
}): string[] {
  const lines: string[] = [];
  if (typeof ask.title === "string" && ask.title.length > 0) lines.push(ask.title);
  for (const question of ask.questions) {
    const text = typeof question.text === "string"
      ? question.text
      : questionText(question.prompt, question.promptMarkdown);
    lines.push(text);
    for (const opt of question.options) {
      lines.push(`  ${cursorAskOptionChoiceLabel(opt, question.options)}`);
    }
  }
  return lines;
}
