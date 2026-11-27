/**
 * Invariant 1: the relay link is up only while the remote-access switch is on AND (a trusted device exists OR the native pairing window
 * is open). The switch alone never authorizes anything. This is the ONE place that rule is evaluated:
 *
 *   wanted = remoteOn && (hasTrustedDevice() || pairingWindowOpen())
 *
 * Inputs are injected providers; whoever changes one (the switch subscription, the registry, the pairing window) calls `recompute()`,
 * and a one-second safety poll re-reads them anyway, so a transition is emitted within a second of any input change. `onChange` fires
 * only on a flip. Provider failures read as "off" (fail closed).
 */
export interface LinkGateInputs {
  remoteOn(): boolean | Promise<boolean>;
  hasTrustedDevice(): boolean | Promise<boolean>;
  pairingWindowOpen(): boolean | Promise<boolean>;
}

export class LinkGate {
  private current = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private seq = 0;
  private readonly listeners = new Set<(up: boolean) => void>();

  constructor(private readonly inputs: LinkGateInputs) {}

  /** Whether the link may be up right now (as of the last recompute). */
  up(): boolean {
    return this.current;
  }

  onChange(fn: (up: boolean) => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  /** Re-read every input and emit a transition if the answer flipped. A stale recompute (superseded by a newer one) is dropped. */
  async recompute(): Promise<boolean> {
    const mine = ++this.seq;
    let wanted = false;
    try {
      const on = await this.inputs.remoteOn();
      if (on) wanted = (await this.inputs.pairingWindowOpen()) || (await this.inputs.hasTrustedDevice());
    } catch {
      wanted = false;
    }
    if (mine !== this.seq) return this.current;
    if (wanted !== this.current) {
      this.current = wanted;
      for (const fn of [...this.listeners]) {
        try {
          fn(wanted);
        } catch {
          /* a listener must not stop the others */
        }
      }
    }
    return this.current;
  }

  /** Start the safety poll (default every second). */
  start(pollMs = 1000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.recompute(), pollMs);
    void this.recompute();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.seq++;
    if (this.current) {
      this.current = false;
      for (const fn of [...this.listeners]) {
        try {
          fn(false);
        } catch {
          /* ignore */
        }
      }
    }
  }
}
