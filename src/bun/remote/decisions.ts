/**
 * Challenges, signed decisions and the unlock window (docs/specs/remote-readiness-spec.md "Signed decisions and the unlock window",
 * invariant 8: consent that runs code is signed over the exact content the phone showed).
 *
 * `issueChallenge` builds the exact bytes to show for a target, their SHA-256 and a 120 s challenge bound to THIS session and THIS target.
 * `verifyDecision` then runs the five checks IN ORDER and refuses on the first failure:
 *   1. the challenge was issued to this session for this target less than 120 s ago and is unused (it is consumed now, pass or fail
 *      of the later checks: a challenge answers one attempt);
 *   2. the signed payload's `sessionHash` is this session's handshake hash;
 *   3. the ES256 signature verifies with the device's approve key;
 *   4. the signed `contentHash` equals the hash of what the target holds NOW (a plan revised since, a card answered elsewhere, a gate
 *      whose next steps changed, fail here);
 *   5. the decision is one this target accepts.
 * The unlock window is one approve-key signature over `{kind:"unlock", sessionHash, expiresAt}`, at most 10 minutes ahead; it ends with
 * the session.
 */
import { equalBytes, fromHex, randomBytes, toHex } from "@agetor/remote-protocol/bytes";
import { CHALLENGE_TTL_MS, UNLOCK_MAX_MS } from "@agetor/remote-protocol/constants";
import { ALLOWED_DECISIONS, verifySigned, type DecisionPayload, type TerminalAttachPayload, type UnlockPayload } from "@agetor/remote-protocol/decision";
import { buildContent, createLiveContentSources, targetKey, type ContentSources } from "./content-hash.ts";
import type { ContentTarget, DevicePrincipal } from "./types.ts";

export type DecisionErrorCode = "no-such-content" | "challenge" | "session" | "signature" | "content-changed" | "decision" | "unlock";

export class DecisionError extends Error {
  constructor(
    readonly code: DecisionErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "DecisionError";
  }
}

export interface IssuedChallenge {
  challenge: string;
  contentBytes: Uint8Array;
  contentHash: string;
  expiresAt: number;
}

export interface SignedDecisionInput {
  payload: unknown;
  sig: string;
}

/** The most challenges one session may hold at once (a phone that keeps asking is dropped, never a memory growth). */
export const MAX_OUTSTANDING_CHALLENGES = 64;

interface Outstanding {
  sessionId: string;
  deviceId: string;
  sessionHashHex: string;
  targetKey: string;
  issuedAt: number;
  used: boolean;
}

export interface Decisions {
  issueChallenge(principal: DevicePrincipal, target: ContentTarget): Promise<IssuedChallenge>;
  /**
   * Run the five checks. Resolves with the verified payload; throws `DecisionError` naming the first check that failed. `target` is what
   * the route the call names would act on (the router derives it from the request), and must equal what the challenge was issued for.
   */
  verifyDecision(principal: DevicePrincipal, signed: SignedDecisionInput, target: ContentTarget): Promise<DecisionPayload>;
  /**
   * The same checks for a terminal attach (configure level): challenge, session, signature by the approve key, then the content (the task
   * has a live tmux session of that name). The signed task and tmux session must be the ones asked for.
   */
  verifyTerminalAttach(principal: DevicePrincipal, signed: { payload: unknown; sig: string }, target: Extract<ContentTarget, { kind: "terminal" }>): Promise<TerminalAttachPayload>;
  /** Verify an unlock signature and open the window. Returns its expiry. */
  verifyUnlock(principal: DevicePrincipal, payload: unknown, sigHex: string): number;
  isUnlocked(principal: DevicePrincipal): boolean;
  /** The session ended: its challenges and its unlock window are gone. */
  endSession(sessionId: string): void;
}

export function createDecisions(deps: { sources?: ContentSources; now?: () => number } = {}): Decisions {
  const sources = deps.sources ?? createLiveContentSources();
  const now = deps.now ?? Date.now;
  const challenges = new Map<string, Outstanding>();
  const unlocks = new Map<string, number>();

  const sweep = (t: number) => {
    for (const [k, c] of challenges) if (c.used || t - c.issuedAt >= CHALLENGE_TTL_MS) challenges.delete(k);
  };

  return {
    async issueChallenge(principal, target) {
      const built = await buildContent(target, sources);
      if (!built) throw new DecisionError("no-such-content", "what you are asked to approve no longer exists");
      const t = now();
      sweep(t);
      const mine = [...challenges.values()].filter((c) => c.sessionId === principal.sessionId).length;
      if (mine >= MAX_OUTSTANDING_CHALLENGES) throw new DecisionError("challenge", "too many outstanding challenges");
      const challenge = toHex(randomBytes(16));
      challenges.set(challenge, {
        sessionId: principal.sessionId, deviceId: principal.deviceId, sessionHashHex: toHex(principal.sessionHash),
        targetKey: targetKey(target), issuedAt: t, used: false,
      });
      return { challenge, contentBytes: built.bytes, contentHash: built.hash, expiresAt: t + CHALLENGE_TTL_MS };
    },

    async verifyDecision(principal, signed, target) {
      const payload = signed.payload as DecisionPayload;
      if (typeof payload !== "object" || payload === null) throw new DecisionError("challenge", "malformed decision");
      // 1. the challenge: issued to this session for this target, under 120 s old, unused. Consumed now.
      const rec = typeof payload.challenge === "string" ? challenges.get(payload.challenge) : undefined;
      if (rec) challenges.delete(payload.challenge);
      if (
        !rec || rec.used || rec.sessionId !== principal.sessionId || rec.deviceId !== principal.deviceId ||
        rec.targetKey !== targetKey(target) || now() - rec.issuedAt >= CHALLENGE_TTL_MS
      ) {
        throw new DecisionError("challenge", "the challenge is unknown, expired, used or for something else");
      }
      // 2. the session: the signed hash is this session's handshake hash.
      if (typeof payload.sessionHash !== "string" || !equalBytes(safeHex(payload.sessionHash), principal.sessionHash)) {
        throw new DecisionError("session", "the decision was signed for another session");
      }
      // 3. the signature, by this device's approve key, over the exact canonical payload.
      if (!verifySigned("decision", payload, signed.sig, principal.approvePub)) {
        throw new DecisionError("signature", "the signature does not verify");
      }
      // The signed fields must also say what the call says: the device id and the target.
      if (payload.deviceId !== principal.deviceId || targetKey(payload.target as ContentTarget) !== rec.targetKey) {
        throw new DecisionError("signature", "the signed device or target is not this call's");
      }
      // 4. the content: what the target holds now hashes to what was signed.
      const built = await buildContent(target, sources);
      if (!built || built.hash !== payload.contentHash) throw new DecisionError("content-changed", "the content changed since it was shown");
      // 5. the decision is valid for the target.
      if (!(ALLOWED_DECISIONS[target.kind] as readonly string[]).includes(payload.decision)) {
        throw new DecisionError("decision", `${payload.decision} is not a decision for ${target.kind}`);
      }
      return payload;
    },

    async verifyTerminalAttach(principal, signed, target) {
      const payload = signed.payload as TerminalAttachPayload;
      if (typeof payload !== "object" || payload === null) throw new DecisionError("challenge", "malformed attach");
      const rec = typeof payload.challenge === "string" ? challenges.get(payload.challenge) : undefined;
      if (rec) challenges.delete(payload.challenge);
      if (
        !rec || rec.used || rec.sessionId !== principal.sessionId || rec.deviceId !== principal.deviceId ||
        rec.targetKey !== targetKey(target) || now() - rec.issuedAt >= CHALLENGE_TTL_MS
      ) {
        throw new DecisionError("challenge", "the challenge is unknown, expired, used or for something else");
      }
      if (typeof payload.sessionHash !== "string" || !equalBytes(safeHex(payload.sessionHash), principal.sessionHash)) {
        throw new DecisionError("session", "the attach was signed for another session");
      }
      if (!verifySigned("terminal-attach", payload, signed.sig, principal.approvePub)) throw new DecisionError("signature", "the signature does not verify");
      if (payload.deviceId !== principal.deviceId || payload.taskId !== target.taskId || payload.tmuxSession !== target.tmuxSession) {
        throw new DecisionError("signature", "the signed device, task or session is not this call's");
      }
      const built = await buildContent(target, sources);
      if (!built || built.hash !== payload.contentHash) throw new DecisionError("content-changed", "the terminal is not what it was when it was shown");
      return payload;
    },

    verifyUnlock(principal, payload, sigHex) {
      const p = payload as UnlockPayload;
      const t = now();
      if (
        !p || p.kind !== "unlock" || typeof p.expiresAt !== "number" || p.expiresAt <= t || p.expiresAt > t + UNLOCK_MAX_MS ||
        typeof p.sessionHash !== "string" || !equalBytes(safeHex(p.sessionHash), principal.sessionHash) ||
        !verifySigned("unlock", p, sigHex, principal.approvePub)
      ) {
        throw new DecisionError("unlock", "the unlock signature is not valid");
      }
      unlocks.set(principal.sessionId, p.expiresAt);
      return p.expiresAt;
    },

    isUnlocked(principal) {
      const until = unlocks.get(principal.sessionId);
      if (until === undefined) return false;
      if (until <= now()) {
        unlocks.delete(principal.sessionId);
        return false;
      }
      return true;
    },

    endSession(sessionId) {
      unlocks.delete(sessionId);
      for (const [k, c] of challenges) if (c.sessionId === sessionId) challenges.delete(k);
    },
  };
}

function safeHex(h: string): Uint8Array {
  try {
    return fromHex(h);
  } catch {
    return new Uint8Array(0);
  }
}
