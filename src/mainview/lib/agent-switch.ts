/**
 * The PATCH body for switching a task to another account in the RunPanel's
 * Task details. Pure so the same-kind rule is unit-testable.
 */
import type { AgentKind } from "../../shared/types.ts";

/**
 * Switching to an account of a DIFFERENT kind resets mode/model/effort/speed/
 * maxMode to the new kind's defaults (`kindDefaults`), because those ids
 * belong to the old kind's option set. Switching between two accounts of the
 * SAME kind (two Claude logins, a stack's primary and backup) keeps them: the
 * ids are still valid, and a same-stack switch continues the conversation, so
 * resetting the model under it contradicted the header's "continuing this
 * conversation" (review S22). The panel's effort/speed/max-mode cascades
 * still repair a value the new account's catalog does not offer.
 *
 * A kind is passed as null when the harness list does not hold that account
 * yet (the panel's `harnessKindOf` would guess claude-code) — an unknown kind
 * is never treated as "same", so the reset path stays the safe default.
 */
export function agentSwitchPatch<D extends object>(args: {
  nextId: string;
  currentKind: AgentKind | null;
  nextKind: AgentKind | null;
  kindDefaults: () => D;
}): { agent: string } | ({ agent: string } & D) {
  const { nextId, currentKind, nextKind } = args;
  if (currentKind !== null && nextKind !== null && currentKind === nextKind) return { agent: nextId };
  return { agent: nextId, ...args.kindDefaults() };
}
