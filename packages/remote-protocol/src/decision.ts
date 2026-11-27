/**
 * Signed decisions, the unlock window and the terminal attach (spec "Signed decisions and the unlock window"): the exact bytes
 * the phone's approve key signs, and the verification of the signature. The core's five ordered checks (challenge, session,
 * signature, content, decision) live in `src/bun/remote/decisions.ts`; this module is the part both ends share and the vectors pin.
 */
import { canonicalBytes } from "./canonical-json.ts";
import { sha256Hex } from "./derive.ts";
import { verifyEs256 } from "./es256.ts";
import { fromHex } from "./bytes.ts";
import { DECISIONS, DECISION_PAYLOAD, TERMINAL_ATTACH_PAYLOAD, UNLOCK_PAYLOAD, parseValue } from "./messages.ts";

export interface ContentTargetRef {
  kind: "plan" | "plan-edit" | "claude-plan" | "tmux-card" | "fx-permission" | "gate" | "fx-resume" | "terminal";
  taskId: string;
  [k: string]: unknown;
}

export interface DecisionPayload {
  v: 1;
  kind: "decision";
  deviceId: string;
  sessionHash: string;
  challenge: string;
  route: string;
  target: ContentTargetRef;
  contentHash: string;
  decision: (typeof DECISIONS)[number];
  comment: string | null;
  ts: number;
}

export interface UnlockPayload {
  kind: "unlock";
  sessionHash: string;
  expiresAt: number;
}

export interface TerminalAttachPayload {
  v: 1;
  kind: "terminal-attach";
  deviceId: string;
  sessionHash: string;
  challenge: string;
  taskId: string;
  tmuxSession: string;
  contentHash: string;
  ts: number;
}

/** The decisions each target kind accepts (check 5: "the decision is valid for that target"). */
export const ALLOWED_DECISIONS: Readonly<Record<ContentTargetRef["kind"], readonly (typeof DECISIONS)[number][]>> = {
  plan: ["approve"],
  "plan-edit": ["edit"],
  "claude-plan": ["approve"],
  "tmux-card": ["allow-once"],
  "fx-permission": ["allow-once"],
  gate: ["accept", "return"],
  "fx-resume": ["resume"],
  terminal: ["attach"],
};

/** `sha256:<hex>` of bytes: the content hash every signed decision names. */
export function contentHashOf(bytes: Uint8Array): string {
  return `sha256:${sha256Hex(bytes)}`;
}

/** The canonical bytes the approve key signs for a decision. Validates the shape first. */
export function decisionBytes(payload: DecisionPayload): Uint8Array {
  parseValue(DECISION_PAYLOAD, payload);
  return canonicalBytes(payload);
}

export function unlockBytes(payload: UnlockPayload): Uint8Array {
  parseValue(UNLOCK_PAYLOAD, payload);
  return canonicalBytes(payload);
}

export function terminalAttachBytes(payload: TerminalAttachPayload): Uint8Array {
  parseValue(TERMINAL_ATTACH_PAYLOAD, payload);
  return canonicalBytes(payload);
}

/**
 * Verify an ES256 signature (raw r‖s, hex) by the device's approve key over the canonical bytes of `payload`.
 * Returns false for anything malformed rather than throwing: a verification failure is a refusal, never a crash.
 */
export function verifySigned(
  kind: "decision" | "unlock" | "terminal-attach",
  payload: unknown,
  sigHex: string,
  approvePub: Uint8Array,
): boolean {
  try {
    const bytes =
      kind === "decision" ? decisionBytes(payload as DecisionPayload)
      : kind === "unlock" ? unlockBytes(payload as UnlockPayload)
      : terminalAttachBytes(payload as TerminalAttachPayload);
    return verifyEs256(approvePub, bytes, fromHex(sigHex));
  } catch {
    return false;
  }
}
