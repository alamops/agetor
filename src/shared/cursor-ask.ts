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
 * option ids. Duplicate labels bind to the first option with that label
 * that is not yet used, in option order.
 *
 * `verdict` defaults to the wave-0 constant. Tests pass the other two
 * values; production callers leave it unset.
 */
export function cursorAskAnswersFromLabels(
  questions: Array<{
    id: string;
    multiSelect?: boolean;
    options: Array<{ id: string; label: string }>;
  }>,
  answers: Array<{ selected: string[]; custom?: string }>,
  verdict: CursorAskFreeform = CURSOR_ASK_FREEFORM,
): CursorAskLabelMapResult {
  const mapped: CursorAskMappedAnswer[] = [];
  for (let i = 0; i < questions.length; i++) {
    const question = questions[i]!;
    if (!question.id) return { ok: false, error: "Cursor question is missing an id" };
    const answer = answers[i] ?? { selected: [] };
    const custom = typeof answer.custom === "string" ? answer.custom.trim() : "";
    if (verdict === "unsupported" && custom.length > 0) {
      return { ok: false, error: "Cursor cannot accept a custom answer — pick an option" };
    }
    const used = new Set<string>();
    const selectedOptionIds: string[] = [];
    for (const label of answer.selected) {
      const opt = question.options.find((o) => o.label === label && !used.has(o.id));
      if (!opt) continue;
      if (!opt.id) return { ok: false, error: "Cursor option is missing an id" };
      used.add(opt.id);
      selectedOptionIds.push(opt.id);
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

/** Plain lines for logs and the TUI: title (when set), then each question and its option labels. */
export function cursorAskPlainLines(ask: {
  title?: string;
  questions: Array<{
    text?: string;
    prompt?: string;
    promptMarkdown?: string | null;
    options: Array<{ label: string }>;
  }>;
}): string[] {
  const lines: string[] = [];
  if (typeof ask.title === "string" && ask.title.length > 0) lines.push(ask.title);
  for (const question of ask.questions) {
    const text = typeof question.text === "string"
      ? question.text
      : questionText(question.prompt, question.promptMarkdown);
    lines.push(text);
    for (const opt of question.options) lines.push(`  ${opt.label}`);
  }
  return lines;
}
