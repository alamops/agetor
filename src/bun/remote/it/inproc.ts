/**
 * The in-process rig for the router-level integration suites (TS2, TS3): the REAL API server on a throwaway data dir (so `servedRoutes()` is the
 * table a phone's call really reaches), the real router with the real SQLite audit, idempotency and device stores, real signed decisions, and a
 * test phone's keys. Import this AFTER setting `AGETOR_DATA_DIR` (see `pinDataDir`).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { p256 } from "@noble/curves/nist.js";
import { toHex } from "@agetor/remote-protocol/bytes";
import { decisionBytes, unlockBytes, type DecisionPayload } from "@agetor/remote-protocol/decision";
import { signEs256 } from "@agetor/remote-protocol/es256";
import type { RemoteLevel } from "@agetor/remote-protocol/levels";
import type { ContentTarget, DevicePrincipal } from "../types.ts";

/** Set the data dir at the top of a test file, before importing anything that opens the database. */
export function pinDataDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `agt-it-${prefix}-`));
  process.env.AGETOR_DATA_DIR = dir;
  return dir;
}

export const APPROVE_SK = p256.utils.randomSecretKey();
export const SESSION_HASH = new Uint8Array(32).fill(5);

export function principal(level: RemoteLevel, over: Partial<DevicePrincipal> = {}): DevicePrincipal {
  return { kind: "device", deviceId: "cd".repeat(16), deviceName: "Ana's iPhone", level, sessionId: "s1", sessionHash: SESSION_HASH, approvePub: p256.getPublicKey(APPROVE_SK, false), ...over };
}

/** A concrete path for a route key: every `:param` becomes a harmless id. */
export function concretePath(key: string): string {
  return key.replace(/:[A-Za-z]+/g, "x1");
}

export function signDecision(p: DevicePrincipal, issued: { challenge: string; contentHash: string }, target: ContentTarget, route: string, decision: DecisionPayload["decision"], over: Partial<DecisionPayload> = {}, key = APPROVE_SK) {
  const payload: DecisionPayload = {
    v: 1, kind: "decision", deviceId: p.deviceId, sessionHash: toHex(p.sessionHash), challenge: issued.challenge, route, target: target as DecisionPayload["target"],
    contentHash: issued.contentHash, decision, comment: null, ts: Date.now(), ...over,
  };
  return { payload, sig: toHex(signEs256(key, decisionBytes(payload))) };
}

export function signUnlock(p: DevicePrincipal, ttlMs = 60_000, now = Date.now(), key = APPROVE_SK) {
  const payload = { kind: "unlock" as const, sessionHash: toHex(p.sessionHash), expiresAt: now + ttlMs };
  return { payload, sig: toHex(signEs256(key, unlockBytes(payload))) };
}

export const body = async (r: { body: Uint8Array }) => JSON.parse(new TextDecoder().decode(r.body)) as Record<string, unknown>;
