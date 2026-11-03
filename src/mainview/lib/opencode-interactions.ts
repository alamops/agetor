/**
 * Pure helpers for the OpenCode permission and question cards: the request
 * bodies for `POST /fx-permissions/:id/answer` and `POST /ask-questions/:id/answer`,
 * and the draft-state transitions that keep a single-select answer to an
 * option XOR typed text (the server refuses both with a 400).
 *
 * Agetor never writes words of its own into an answer: a reason or a typed
 * answer is the user's text, trimmed, and an empty one is omitted from the
 * body (nothing is sent in its place).
 */

/** The text a user typed, trimmed; `undefined` when there is none. */
export function trimmedOrUndefined(text: string | null | undefined): string | undefined {
  const t = (text ?? "").trim();
  return t.length > 0 ? t : undefined;
}

/** Body for answering an OpenCode permission card. A reason rides only with
 *  `reject`, and only when the user typed one. */
export function opencodePermissionBody(
  optionId: string,
  reason: string,
): { optionId: string; message?: string } {
  const message = optionId === "reject" ? trimmedOrUndefined(reason) : undefined;
  return message !== undefined ? { optionId, message } : { optionId };
}

/** Copy shown while a typed reason blocks the Allow options. */
export const OPENCODE_REASON_ALLOW_HINT = "A reason is only sent with Reject — clear it to allow";

/** A typed reason is only ever sent with Reject, so every other option is
 *  unavailable while the reason box holds text (the CLI refuses the same
 *  combination). */
export function opencodePermissionOptionBlocked(optionId: string, reason: string): boolean {
  return optionId !== "reject" && trimmedOrUndefined(reason) !== undefined;
}

/** Body for skipping an OpenCode question card. An empty reason sends none. */
export function opencodeSkipBody(reason: string | null | undefined): { skip: true; message?: string } {
  const message = trimmedOrUndefined(reason);
  return message !== undefined ? { skip: true, message } : { skip: true };
}

/** One question's draft: picked option ids and typed text. */
export interface OpencodeDraft {
  selected: string[];
  custom: string;
}

/** The question fields these helpers read. Structural, so the webview's
 *  `PendingAskQuestions["questions"][number]` fits. */
export interface OpencodeQuestionShape {
  multiSelect?: boolean;
  allowCustom?: boolean;
  options: Array<{ id?: string; label: string }>;
}

/** The value an option answers with: the id the card was registered with. */
export function opencodeOptionValue(opt: { id?: string; label: string }): string {
  return opt.id && opt.id.length > 0 ? opt.id : opt.label;
}

export function emptyOpencodeDrafts(questions: readonly unknown[]): OpencodeDraft[] {
  return questions.map(() => ({ selected: [], custom: "" }));
}

/** Pick or unpick an option. Single-select: the pick replaces any other pick
 *  and clears the typed text, so the answer is the option alone. */
export function opencodeTogglePick(draft: OpencodeDraft, value: string, multi: boolean): OpencodeDraft {
  if (multi) {
    return draft.selected.includes(value)
      ? { ...draft, selected: draft.selected.filter((s) => s !== value) }
      : { ...draft, selected: [...draft.selected, value] };
  }
  return { selected: [value], custom: "" };
}

/** Type into the free-text field. Single-select: any non-empty text clears the
 *  picked option, so the answer is the text alone. Multi-select keeps both. */
export function opencodeSetCustom(draft: OpencodeDraft, text: string, multi: boolean): OpencodeDraft {
  if (!multi && text.trim().length > 0) return { selected: [], custom: text };
  return { ...draft, custom: text };
}

/** The typed text that will actually be sent for a question: none when the
 *  field does not accept typed text. */
function effectiveCustom(q: OpencodeQuestionShape, d: OpencodeDraft): string | undefined {
  return q.allowCustom === true ? trimmedOrUndefined(d.custom) : undefined;
}

/** Every question needs a pick or typed text (where typed text is allowed). */
export function opencodeCanSubmit(questions: readonly OpencodeQuestionShape[], drafts: readonly OpencodeDraft[]): boolean {
  return questions.every((q, i) => {
    const d = drafts[i] ?? { selected: [], custom: "" };
    return d.selected.length > 0 || effectiveCustom(q, d) !== undefined;
  });
}

/** Body for answering an OpenCode question card: one entry per question,
 *  option ids and/or typed text. A single-select never carries both. */
export function opencodeAnswerBody(
  questions: readonly OpencodeQuestionShape[],
  drafts: readonly OpencodeDraft[],
): { answers: Array<{ selected: string[]; selectedOptionIds?: string[]; custom?: string }> } {
  return {
    answers: questions.map((q, i) => {
      const d = drafts[i] ?? { selected: [], custom: "" };
      const custom = effectiveCustom(q, d);
      const entry: { selected: string[]; selectedOptionIds?: string[]; custom?: string } = { selected: [] };
      // A single-select typed answer replaces any pick that slipped through.
      const picks = q.multiSelect !== true && custom !== undefined ? [] : d.selected;
      if (picks.length > 0) entry.selectedOptionIds = [...picks];
      if (custom !== undefined) entry.custom = custom;
      return entry;
    }),
  };
}

/** One-line summary of a question's draft for the review screen. */
export function opencodeAnswerSummary(q: OpencodeQuestionShape, d: OpencodeDraft): string {
  const custom = effectiveCustom(q, d);
  const picks = q.multiSelect !== true && custom !== undefined ? [] : d.selected;
  const pieces = picks.map((v) => q.options.find((o) => opencodeOptionValue(o) === v)?.label ?? v);
  if (custom !== undefined) pieces.push(custom);
  return pieces.length > 0 ? pieces.join(", ") : "(no answer)";
}
