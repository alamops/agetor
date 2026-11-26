/**
 * Per-device token buckets (docs/specs/remote-readiness-spec.md "Rate limits"): 6 handshakes a minute, 30 requests a second, 2 heavy
 * reads a second. Stop, cancel, reject and revoke are never limited (invariant 9: removing authority is always easy and immediate):
 * the `stop` class bypasses every bucket, and `revoke` never passes through here at all (it is a session op the session layer ends
 * itself).
 */

export type RateClass = "handshake" | "normal" | "heavy" | "stop";

interface Bucket {
  tokens: number;
  at: number;
}

export interface RateLimits {
  handshakesPerMinute: number;
  requestsPerSecond: number;
  heavyPerSecond: number;
}

export const DEFAULT_RATE_LIMITS: RateLimits = { handshakesPerMinute: 6, requestsPerSecond: 30, heavyPerSecond: 2 };

export type RateDecision = { ok: true } | { ok: false; retryAfterMs: number };

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly limits: RateLimits = DEFAULT_RATE_LIMITS,
  ) {}

  /** Take one token from `kind`'s bucket for `deviceId`. `stop` always passes and touches nothing. */
  check(deviceId: string, kind: RateClass): RateDecision {
    if (kind === "stop") return { ok: true };
    if (kind === "heavy") {
      // A heavy read is also a request: it must clear both buckets, and only spends either when both have a token.
      const normal = this.peek(deviceId, "normal");
      const heavy = this.peek(deviceId, "heavy");
      if (!normal.ok) return normal;
      if (!heavy.ok) return heavy;
      this.take(deviceId, "normal");
      this.take(deviceId, "heavy");
      return { ok: true };
    }
    const d = this.peek(deviceId, kind);
    if (d.ok) this.take(deviceId, kind);
    return d;
  }

  private spec(kind: Exclude<RateClass, "stop">): { capacity: number; perMs: number } {
    switch (kind) {
      case "handshake":
        return { capacity: this.limits.handshakesPerMinute, perMs: this.limits.handshakesPerMinute / 60_000 };
      case "normal":
        return { capacity: this.limits.requestsPerSecond, perMs: this.limits.requestsPerSecond / 1000 };
      case "heavy":
        return { capacity: this.limits.heavyPerSecond, perMs: this.limits.heavyPerSecond / 1000 };
    }
  }

  private refilled(deviceId: string, kind: Exclude<RateClass, "stop">): Bucket {
    const key = `${deviceId}\0${kind}`;
    const { capacity, perMs } = this.spec(kind);
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b) this.buckets.set(key, (b = { tokens: capacity, at: t }));
    else {
      b.tokens = Math.min(capacity, b.tokens + (t - b.at) * perMs);
      b.at = t;
    }
    return b;
  }

  private peek(deviceId: string, kind: Exclude<RateClass, "stop">): RateDecision {
    const b = this.refilled(deviceId, kind);
    if (b.tokens >= 1) return { ok: true };
    return { ok: false, retryAfterMs: Math.ceil((1 - b.tokens) / this.spec(kind).perMs) };
  }

  private take(deviceId: string, kind: Exclude<RateClass, "stop">): void {
    this.refilled(deviceId, kind).tokens -= 1;
  }

  /** Forget a device (revoked): its buckets are dropped. */
  forget(deviceId: string): void {
    for (const k of [...this.buckets.keys()]) if (k.startsWith(`${deviceId}\0`)) this.buckets.delete(k);
  }
}
