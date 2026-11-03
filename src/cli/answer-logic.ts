import type { AnyRequest, AskQuestion, AskQuestionsRequest, FxPermissionRequest } from "../bun/interactions.ts";
import { flagValue } from "./args.ts";

/** Sentinel option value for the "type a free-text answer" choice — distinctive
 *  enough that it can't collide with a real option label. Used by `agetor
 *  answer` as the @clack option value; the dashboard overlay handles "Other"
 *  via its own row + text field and never puts the sentinel in its picks. */
export const CUSTOM_OPTION = "__agetor_custom__";

/**
 * Assemble one AskUserQuestion answer from picked option labels plus optional
 * custom free-text. Strips the {@link CUSTOM_OPTION} sentinel from `picks` and
 * trims the custom text. Returns `null` when the result would be empty — the
 * contract requires at least one of `selected` / `custom` per question.
 */
export function buildAskAnswer(
  picks: string[],
  custom: string | null,
): { selected: string[]; custom?: string } | null {
  const selected = picks.filter((p) => p !== CUSTOM_OPTION);
  const text = custom?.trim() ?? "";
  if (selected.length === 0 && text === "") return null;
  return text ? { selected, custom: text } : { selected };
}

/* ────────────────────────────────────────────────────────────────────────── *
 * OpenCode cards (docs/architecture/harness-opencode.md): a permission card
 * whose Reject may carry a reason, and a question card with per-question typed
 * text and a Skip that may carry a reason. Shared by `agetor answer` and the
 * dashboard's AnswerOverlay.
 * ────────────────────────────────────────────────────────────────────────── */

/** Printed when an OpenCode permission is rejected with no reason: OpenCode
 *  ends the turn on a bare reject, and continues when the reject has words. */
export const OPENCODE_REJECT_NO_REASON_NOTICE =
  "Rejected without a reason: the agent's turn stops. Reject with a reason and it continues.";

/** The permission card's Reject option id (`opencodePermissionOptions`). */
export const OPENCODE_REJECT_OPTION = "reject";

/** An OpenCode permission card whose Reject takes a reason. */
export function isOpencodePermission(req: AnyRequest): req is FxPermissionRequest & { harness: "opencode" } {
  return req.kind === "fx_permission" && req.harness === "opencode";
}

/** An OpenCode question card. */
export function isOpencodeAsk(req: AnyRequest): req is AskQuestionsRequest & { source: "opencode" } {
  return req.kind === "ask_questions" && req.source === "opencode";
}

/** The `agetor answer` flags. */
export interface AnswerArgs {
  ref?: string;
  /** `--reason <text>` (empty after trimming = none given). */
  reason?: string;
  /** `--skip`: skip an OpenCode question without the picker. */
  skip: boolean;
}

/** Pure parser for `agetor answer <task-id> [--reason <text>] [--skip]`. The
 *  first non-flag argument is the task ref; an unknown flag is ignored, like
 *  the sibling commands. */
export function parseAnswerArgs(args: string[]): AnswerArgs {
  const o: AnswerArgs = { skip: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--reason") o.reason = flagValue(args, ++i, a);
    else if (a === "--skip") o.skip = true;
    else if (!a.startsWith("-") && o.ref === undefined) o.ref = a;
  }
  return o;
}

/** Refuse a flag combination before any card is shown or answered, so an
 *  earlier card is never answered and a later one refused. `--reason` must be
 *  something every pending card can use (an OpenCode permission, where it goes
 *  with Reject, or an OpenCode question with `--skip`); `--skip` skips OpenCode
 *  questions only. Returns the error text, or null. */
export function answerFlagsError(pending: readonly AnyRequest[], o: AnswerArgs): string | null {
  if (o.skip && !pending.every(isOpencodeAsk)) return "--skip only skips an OpenCode question";
  if (o.reason === undefined) return null;
  for (const req of pending) {
    if (isOpencodePermission(req)) {
      if (o.skip) return "--reason with --skip applies to an OpenCode question, not a permission request";
    } else if (isOpencodeAsk(req)) {
      if (!o.skip) return "--reason on an OpenCode question needs --skip (an answered question takes no reason)";
      if (req.allowReason !== true) return "this OpenCode question takes no reason";
    } else {
      return "--reason applies only to an OpenCode permission request (with Reject) or a skipped OpenCode question";
    }
  }
  return null;
}

/** The body to POST for an OpenCode permission answer. `--reason` rides only
 *  with Reject; Allow once / Always allow with one is refused before sending.
 *  A reason that is empty after trimming is omitted. */
export function planOpencodePermissionReply(
  optionId: string,
  reason: string | undefined,
): { ok: true; body: { optionId: string; message?: string } } | { ok: false; error: string } {
  const text = reason?.trim() ?? "";
  if (optionId !== OPENCODE_REJECT_OPTION) {
    if (text !== "") return { ok: false, error: "--reason can only be used when rejecting, not with Allow once or Always allow" };
    return { ok: true, body: { optionId } };
  }
  return { ok: true, body: text !== "" ? { optionId, message: text } : { optionId } };
}

/** One OpenCode question's answer from the picks (option ids, plus
 *  {@link CUSTOM_OPTION} for the typed-text row) and the typed text. Ids go
 *  out as `selectedOptionIds` (the labels too, for older readers). A
 *  single-select takes an option or typed text, never both; typed text needs
 *  the question's `allowCustom`. */
export function buildOpencodeAnswer(
  q: AskQuestion,
  picks: string[],
  custom: string | null,
): { ok: true; entry: { selected: string[]; selectedOptionIds?: string[]; custom?: string } } | { ok: false; error: string } {
  const base = buildAskAnswer(picks, custom);
  if (!base) return { ok: false, error: "Pick an option or type an answer." };
  const text = base.custom;
  if (text !== undefined && q.allowCustom !== true) {
    return { ok: false, error: "This question does not take a typed answer — pick an option." };
  }
  if (!q.multiSelect && base.selected.length > 0 && text !== undefined) {
    return { ok: false, error: "Pick an option or type an answer, not both." };
  }
  const opts = base.selected.map((pick) => q.options.find((o) => (o.id ?? o.label) === pick));
  const labels = base.selected.map((pick, i) => opts[i]?.label ?? pick);
  const ids = opts.every((o) => o?.id !== undefined) ? opts.map((o) => o!.id!) : undefined;
  return {
    ok: true,
    entry: {
      selected: labels,
      ...(ids && ids.length > 0 ? { selectedOptionIds: ids } : {}),
      ...(text !== undefined ? { custom: text } : {}),
    },
  };
}
