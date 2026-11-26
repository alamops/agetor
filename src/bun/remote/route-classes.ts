/**
 * The class rules (docs/specs/remote-readiness-spec.md "Remote router and route policy"; grill D8–D10, D13, D15, E4): what a SPECIFIC call to
 * a remote route is, which a route's static policy cannot say. The base policy (route-policy.ts) gives the lowest level, the step-up and the
 * rate class; this module looks at the request and the live card and answers with a `Classified`:
 *
 *   read     a read; nothing to prove
 *   remove   removes authority or work (a cancel, a bare reject, marking seen): never needs more than the session
 *   action   a session-only mutation (switch account)
 *   content  text that will be acted on (an answer, a follow-up, a backlog entry): the unlock window when the task runs without asking
 *   consent  an allow: a signed decision bound to the exact content shown
 *   never    refused: "answer on your Mac" (an always-allow, an unknown tmux row, the OAuth code card, a cancel of an OpenCode card)
 *
 * It only ever RAISES what the base policy asks (never lowers it) and fails closed: anything not named here keeps the base policy's step-up
 * and gets `content` if the route writes, so a new route cannot become easier than its policy by omission.
 */
import { levelAtLeast, type RemoteLevel } from "@agetor/remote-protocol/levels";
import { classifyTmuxChoice } from "../../shared/tmux-choice-class.ts";
import type { RemotePolicy } from "../route-policy.ts";
import type { Classified, ContentTarget } from "./types.ts";

export interface ClassifyInput {
  method: string;
  /** The route key as written in ROUTE_POLICY (`/tasks/:id/seen`). */
  route: string;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}

/** The live facts the rules need. Every lookup returns null for something that no longer exists. */
export interface ClassifyLookups {
  tmuxPrompt(id: string): Promise<{ taskId: string; paneText: string; choices: Array<{ key: string; label: string }>; answerKind: string | null } | null>;
  fxPermission(id: string): Promise<{ taskId: string; harness: "fx" | "opencode"; options: Array<{ optionId: string; kind?: string }> } | null>;
  /** The task a run belongs to. */
  runTask(runId: string): Promise<string | null>;
  /** The task a pending ask-questions card belongs to (null when the card is gone: a bare Skip then still just removes nothing). */
  askQuestionTask(cardId: string): Promise<string | null>;
  /** Whether `path` is inside the task's own folders (its workdir or worktrees, or a file it sent) (D15). */
  previewInScope(taskId: string, path: string): Promise<boolean>;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

const NEVER_REASON = "answer this on your Mac";

function base(policy: RemotePolicy, over: Partial<Classified> & Pick<Classified, "class">): Classified {
  return { level: policy.level, stepUp: policy.stepUp, rate: policy.rate, ...over };
}

const never = (policy: RemotePolicy, reason: string): Classified => base(policy, { class: "never", stepUp: "none", reason });
const remove = (policy: RemotePolicy, taskId?: string): Classified => base(policy, { class: "remove", stepUp: "none", taskId });
const gone = (policy: RemotePolicy): Classified => never(policy, "gone");

/** Raise a level, never lower it. */
function raise(a: RemoteLevel, b: RemoteLevel): RemoteLevel {
  return levelAtLeast(a, b) ? a : b;
}

export async function classifyRoute(input: ClassifyInput, policy: RemotePolicy, lookups: ClassifyLookups): Promise<Classified> {
  const key = `${input.method} ${input.route}`;
  const body = isObj(input.body) ? input.body : {};
  switch (key) {
    // ── reads ────────────────────────────────────────────────────────────────────────────────────────────────────
    case "GET /tasks/:id/files/preview": {
      const path = input.query.get("path") ?? "";
      const inScope = path.length > 0 && (await lookups.previewInScope(input.params.id!, path));
      // D15: inside the task's folders is an observe read; anything else is an operate read.
      return base(policy, { class: "read", stepUp: "none", level: inScope ? policy.level : raise(policy.level, "operate"), taskId: input.params.id });
    }

    // ── removals ─────────────────────────────────────────────────────────────────────────────────────────────────
    case "POST /runs/:id/cancel":
      return remove(policy, (await lookups.runTask(input.params.id!)) ?? undefined);
    case "POST /tasks/:id/pipeline/cancel":
    case "POST /tasks/:id/seen":
    case "DELETE /tasks/:id/seen":
      return remove(policy, input.params.id);
    case "DELETE /tasks/:id/backlog/:itemId":
      return remove(policy, input.params.id);

    // ── content ──────────────────────────────────────────────────────────────────────────────────────────────────
    case "POST /runs/:id/input": {
      const taskId = await lookups.runTask(input.params.id!);
      return taskId ? base(policy, { class: "content", stepUp: "unlock", taskId }) : gone(policy);
    }
    case "POST /tasks/:id/backlog":
    case "PUT /tasks/:id/backlog":
    case "PATCH /tasks/:id/backlog/:itemId":
      return base(policy, { class: "content", stepUp: "unlock", taskId: input.params.id });

    case "POST /ask-questions/:id/answer": {
      // D10: a Skip with words is content; a bare Skip removes the question and sends nothing.
      const taskId = (await lookups.askQuestionTask(input.params.id!)) ?? undefined;
      if (body.skip === true && !nonEmpty(body.message)) return remove(policy, taskId);
      return base(policy, { class: "content", stepUp: "unlock", taskId });
    }

    case "PATCH /tasks/:id/plans/:planId": {
      // D13/A-5: signed over the EDITED body; the unlock window as well when the task runs without asking.
      // `editedContent: null` drops the edit (back to the plan as written): a removal. A string is the new text.
      if (body.editedContent === null) return remove(policy, input.params.id);
      const text = typeof body.editedContent === "string" ? body.editedContent : null;
      if (text === null) return never(policy, "no edited body");
      const target: ContentTarget = { kind: "plan-edit", taskId: input.params.id!, planId: input.params.planId!, body: text };
      return base(policy, { class: "content", stepUp: "signed", alsoUnlock: true, taskId: input.params.id, target });
    }

    // ── consent ──────────────────────────────────────────────────────────────────────────────────────────────────
    case "POST /tasks/:id/plans/:planId/approve": {
      const target: ContentTarget = { kind: "plan", taskId: input.params.id!, planId: input.params.planId! };
      return base(policy, { class: "consent", stepUp: "signed", taskId: input.params.id, target });
    }
    case "POST /tasks/:id/fx-resume":
      return base(policy, { class: "consent", stepUp: "signed", taskId: input.params.id, target: { kind: "fx-resume", taskId: input.params.id! } });

    case "POST /tasks/:id/pipeline/review": {
      // E4: all six fields. The signature covers the gate (its handoffs, step, seq, next steps, mode) through the content hash and the
      // decision and comment through the payload; the body must repeat the signed decision and comment, and name no next-step subset and
      // no resume mode (v1 sends everything the gate leads to, fresh).
      if (typeof body.stepId !== "string" || typeof body.seq !== "number" || !Number.isSafeInteger(body.seq)) return never(policy, "bad gate");
      if (body.decision !== "accept" && body.decision !== "return") return never(policy, "bad decision");
      if (body.nextStepIds !== undefined || body.mode !== undefined) return never(policy, "this gate option is not available from a phone");
      const comment = typeof body.comment === "string" ? body.comment : null;
      const target: ContentTarget = { kind: "gate", taskId: input.params.id!, stepId: body.stepId, seq: body.seq };
      return base(policy, { class: "consent", stepUp: "signed", taskId: input.params.id, target, bound: { decision: body.decision, comment } });
    }

    case "POST /tmux-prompts/:id/answer":
      return classifyTmuxAnswer(input, body, policy, lookups);
    case "POST /fx-permissions/:id/answer":
      return classifyFxAnswer(input, body, policy, lookups);

    // ── actions ──────────────────────────────────────────────────────────────────────────────────────────────────
    case "POST /tasks/:id/switch-account":
      return base(policy, { class: "action", stepUp: "none", level: raise(policy.level, "operate"), taskId: input.params.id });
  }

  // A remote GET that no rule names is a read. Anything that writes and has no rule is refused rather than guessed.
  if (input.method === "GET") return base(policy, { class: "read", stepUp: "none", taskId: input.params.id });
  return never(policy, "no class rule for this route");
}

async function classifyTmuxAnswer(input: ClassifyInput, body: Record<string, unknown>, policy: RemotePolicy, lookups: ClassifyLookups): Promise<Classified> {
  const card = await lookups.tmuxPrompt(input.params.id!);
  if (!card) return gone(policy);
  const given = ["key", "reject", "enter", "code"].filter((k) => body[k] !== undefined);
  if (given.length !== 1) return never(policy, "exactly one answer");
  // The OAuth code card takes free text typed into the REPL: never from a phone.
  if (body.code !== undefined || card.answerKind === "code") return never(policy, NEVER_REASON);
  const target = (kind: "tmux-card"): ContentTarget => ({ kind, taskId: card.taskId, promptId: input.params.id! });

  if (body.reject !== undefined) return remove(policy, card.taskId);
  if (body.enter !== undefined) {
    if (card.answerKind !== "enter") return never(policy, "not an enter-only card");
    return base(policy, { class: "consent", stepUp: "signed", taskId: card.taskId, target: target("tmux-card") });
  }
  const key = String(body.key);
  const choice = card.choices.find((c) => c.key === key);
  if (!choice) return never(policy, "unknown row");
  const cls = classifyTmuxChoice(card.paneText, choice);
  switch (cls) {
    case "once":
      return base(policy, { class: "consent", stepUp: "signed", taskId: card.taskId, target: target("tmux-card") });
    case "reject":
      return remove(policy, card.taskId);
    case "plan-auto":
      // D9: row 1 switches the task to auto mode, so it is operate-level, signed over the plan, and unlock-gated too.
      return base(policy, {
        class: "consent", stepUp: "signed", alsoUnlock: "always", level: raise(policy.level, "operate"), taskId: card.taskId,
        target: { kind: "claude-plan", taskId: card.taskId, promptId: input.params.id!, row: "auto" },
      });
    case "plan-manual":
      return base(policy, {
        class: "consent", stepUp: "signed", taskId: card.taskId,
        target: { kind: "claude-plan", taskId: card.taskId, promptId: input.params.id!, row: "manual" },
      });
    case "plan-revise":
      return base(policy, { class: "content", stepUp: "unlock", taskId: card.taskId });
    default:
      // always, unknown: fail closed.
      return never(policy, NEVER_REASON);
  }
}

async function classifyFxPermission(card: NonNullable<Awaited<ReturnType<ClassifyLookups["fxPermission"]>>>, optionId: string): Promise<"once" | "always" | "reject" | "unknown"> {
  const opt = card.options.find((o) => o.optionId === optionId);
  if (!opt) return "unknown";
  const k = (opt.kind ?? opt.optionId).toLowerCase();
  if (k === "allow_once" || k === "once") return "once";
  if (k === "allow_always" || k === "always") return "always";
  if (k === "reject_once" || k === "reject") return "reject";
  return "unknown";
}

async function classifyFxAnswer(input: ClassifyInput, body: Record<string, unknown>, policy: RemotePolicy, lookups: ClassifyLookups): Promise<Classified> {
  const card = await lookups.fxPermission(input.params.id!);
  if (!card) return gone(policy);
  // `cancel` is reserved for the internal Stop/delete sweep: not a phone's call.
  if (body.cancel !== undefined) return never(policy, NEVER_REASON);
  if (typeof body.optionId !== "string") return never(policy, "no option");
  const cls = await classifyFxPermission(card, body.optionId);
  switch (cls) {
    case "once":
      if (body.message !== undefined) return never(policy, "a reason goes with a reject");
      return base(policy, { class: "consent", stepUp: "signed", taskId: card.taskId, target: { kind: "fx-permission", taskId: card.taskId, permissionId: input.params.id! } });
    case "reject":
      // D10: a bare reject removes; a reject with words is content and needs the unlock window on an autonomous task.
      return nonEmpty(body.message) ? base(policy, { class: "content", stepUp: "unlock", taskId: card.taskId }) : remove(policy, card.taskId);
    default:
      return never(policy, NEVER_REASON);
  }
}
