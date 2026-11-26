/**
 * The session-op registry (docs/plans/remote-readiness.md §3.3, "Session op handlers"). The gateway registers one handler per op type
 * (`request`, `subscribe-task`, `challenge`, `terminal-attach`, ...); the session manager parses each incoming message strictly against
 * its schema and hands the parsed body to the handler of its type. A type with no handler is answered with an error, never ignored.
 *
 * `endDeviceSessions` and `endAllSessions` are the kill switches every other module calls (revoke, Remote access off, Revoke all): they
 * close live sessions through whichever session manager is bound, within a second.
 */
import type { PhoneChannel } from "./types.ts";

export type SessionOpHandler = (channel: PhoneChannel, body: unknown, msgId: string) => Promise<void>;

const handlers = new Map<string, SessionOpHandler>();

/** Register (or replace) the handler of an op type. Returns an unregister function. */
export function registerSessionOp(type: string, handler: SessionOpHandler): () => void {
  handlers.set(type, handler);
  return () => {
    if (handlers.get(type) === handler) handlers.delete(type);
  };
}

export function getSessionOp(type: string): SessionOpHandler | undefined {
  return handlers.get(type);
}

export function registeredSessionOps(): string[] {
  return [...handlers.keys()].sort();
}

export interface SessionEnder {
  endDeviceSessions(deviceId: string, reason: string): void;
  endAllSessions(reason: string): void;
}

let bound: SessionEnder | null = null;

/** The session manager binds itself here when it starts and unbinds when it stops. */
export function bindSessionEnder(ender: SessionEnder | null): void {
  bound = ender;
}

export function endDeviceSessions(deviceId: string, reason: string): void {
  bound?.endDeviceSessions(deviceId, reason);
}

export function endAllSessions(reason: string): void {
  bound?.endAllSessions(reason);
}
