/**
 * The remote gateway: composition and lifecycle (docs/architecture/remote-gateway.md; plan GW). One call, `startRemoteGateway`, builds the
 * Companion from its parts and ties it to the process:
 *
 *   key helper (lazy) → registry → link gate → relay link → session manager → session ops (router, subscriptions, signed decisions,
 *   push registration, revoke-self, terminal) ; the phone sink on the notification policy ; the daily and minutely schedulers
 *
 * The relay link is up only while the owner's remote switch is on AND (a device is trusted OR the pairing window is open). Anything that
 * turns that false (the switch off, the C3 probe reset, the last device revoked) ends every session and drops the link within a second.
 * A release build ships the Companion dark: with `COMPANION_ENABLED` false this is a no-op that logs once and never touches the key helper.
 *
 * The gateway follows the port owner: it runs in whichever core is serving the API (the app, the login-item core or the CLI daemon),
 * and a handoff is just `stop()` here and `startRemoteGateway()` there; the phone's relay link reconnects and resumes from its cursor.
 * Only the desktop app's core can pair (the helper's window needs a screen).
 */
import { fromHex, toBase64, toHex } from "@agetor/remote-protocol/bytes";
import { mailboxKey, utcDate } from "@agetor/remote-protocol/derive";
import { levelAtLeast, type RemoteLevel } from "@agetor/remote-protocol/levels";
import type { RemoteAuditHead } from "../../shared/remote-types.ts";
import type { AppEvent } from "../../shared/types.ts";
import { COMPANION_ENABLED } from "../../shared/build-flags.ts";
import { getApiPort, nonLoopbackBindWarning, resolveApiHost } from "../api-config.ts";
import { getRemoteAccess, subscribeBackgroundChanges } from "../background.ts";
import { registerLogSecret } from "../core-log.ts";
import { installNotificationPolicy, postDeviceNotification, type NotificationSink } from "../notification-policy.ts";
import { atTheMac } from "../presence.ts";
import { remoteRoutesFor } from "../route-policy.ts";
import { createAudit, createDbAuditStore, type Audit } from "./audit.ts";
import { startAuditRetention } from "./audit-retention.ts";
import { createDecisions, DecisionError, type Decisions } from "./decisions.ts";
import { createIdempotency, type Idempotency } from "./idempotency.ts";
import { getKeyHelper } from "./key-helper-api.ts";
import { LinkGate } from "./link-gate.ts";
import { macName } from "./mac-name.ts";
import { PAIRING_GROUP, createPairing, type Pairing, type PairingDeps } from "./pairing.ts";
import { createPhoneSink, type PhoneSink } from "./push.ts";
import { RateLimiter } from "./rate-limit.ts";
import { createRegistry, type Registry, type RegistryStore } from "./registry.ts";
import { RelayLink, type LinkState } from "./relay-link.ts";
import { relayUrl as defaultRelayUrl } from "./relay-config.ts";
import { createLiveLookups, createRouter, type Router } from "./router.ts";
import { createSessionManager, type SessionManager } from "./session.ts";
import { registerSessionOp } from "./session-dispatch.ts";
import { createSubscriptions, type Subscriptions } from "./subscriptions.ts";
import { createLiveTerminalDeps, createTerminalManager, type TerminalManager } from "./terminal.ts";
import type { ContentTarget, DevicePrincipal, PhoneChannel } from "./types.ts";

export type GatewayMode = "app" | "background" | "headless";

/**
 * Present in the shipped JS only when the Companion is compiled in. The guard is inline on purpose (`src/shared/build-flags.ts`): Bun folds
 * `typeof __AGETOR_COMPANION__ …` when the define is set and drops the string, and `scripts/verify-release.ts` greps the release bundles for
 * it, so a dark release that still carries the Companion fails the release gate.
 */
const COMPANION_BUILD_MARKER = typeof __AGETOR_COMPANION__ === "undefined" || __AGETOR_COMPANION__ ? "agetor-companion-compiled-in" : "";

export interface GatewayOptions {
  mode: GatewayMode;
  /** The app's notification policy, so the phone sink joins the one that already decides. A core without one gets its own. */
  notificationPolicy?: { registerSink(sink: NotificationSink): () => void };
  /** Test and e2e seams; everything defaults to the real thing. */
  deps?: Partial<GatewayDeps>;
}

export interface GatewayDeps {
  /** Whether the Companion is compiled in. Default: the build flag. Injected so a test runs both ways. */
  companionEnabled: boolean;
  remoteOn(): Promise<boolean>;
  subscribeChanges(fn: () => void): () => void;
  relayUrl(): string | null;
  /** The registry's rows (the production default reads the database). The registry itself is always built here so its revoke wiring is the real one. */
  registryStore: RegistryStore;
  audit: Audit;
  decisions: Decisions;
  idempotency: Idempotency;
  limiter: RateLimiter;
  phoneSink: PhoneSink;
  macName(): Promise<string>;
  broadcast(ev: AppEvent): void;
  pairingDeps: Partial<PairingDeps>;
  linkOptions: Partial<ConstructorParameters<typeof RelayLink>[0]>;
  gatePollMs: number;
  /** Do not start the daily and minutely jobs (tests). */
  noSchedulers: boolean;
  log(msg: string): void;
}

export interface GatewayStatus {
  companion: boolean;
  relay: { url: string | null; state: "off" | "unconfigured" | "connecting" | "up" | "down" };
  bindWarning: string | null;
  attachedTerminals: Array<{ taskId: string; deviceId: string; deviceName: string; since: number }>;
  activeSessions: number;
  pairing: { open: boolean; expiresAt: number | null };
}

export interface RemoteGateway {
  readonly enabled: boolean;
  /** Present in `app` mode only. */
  startPairing?(): Promise<{ expiresAt: number; alreadyOpen: boolean }>;
  cancelPairing(): Promise<void>;
  status(): GatewayStatus;
  auditHead(): Promise<RemoteAuditHead | null>;
  registry: Registry | null;
  audit: Audit | null;
  terminals: TerminalManager | null;
  sessions: SessionManager | null;
  /** End every session and drop the link (the owner's kill switches reach it through the registry and the gate too). */
  stop(): Promise<void>;
}

let current: RemoteGateway | null = null;
let loggedDisabled = false;

/** The running gateway, for the HTTP routes that read its status. Null before it starts, after it stops, and when the Companion is off. */
export function currentGateway(): RemoteGateway | null {
  return current;
}

const DISABLED: RemoteGateway = {
  enabled: false,
  cancelPairing: async () => undefined,
  status: () => ({
    companion: false, relay: { url: null, state: "off" }, bindWarning: null, attachedTerminals: [], activeSessions: 0, pairing: { open: false, expiresAt: null },
  }),
  auditHead: async () => null,
  registry: null,
  audit: null,
  terminals: null,
  sessions: null,
  stop: async () => undefined,
};

export const deviceMailboxKeys = (linkSecret: Uint8Array, now: number): Uint8Array[] => [
  mailboxKey(linkSecret, utcDate(now)),
  mailboxKey(linkSecret, utcDate(now - 86_400_000)),
];

const TEXT_TYPE_RE = /^(?:text\/|application\/(?:json|javascript|xml)|image\/svg\+xml)/i;
const decoder = new TextDecoder("utf-8", { fatal: true });

export async function startRemoteGateway(opts: GatewayOptions): Promise<RemoteGateway> {
  const log = opts.deps?.log ?? ((m: string) => console.warn(m));
  const companion = opts.deps?.companionEnabled ?? COMPANION_ENABLED;
  if (!companion) {
    if (!loggedDisabled) {
      loggedDisabled = true;
      log("[agetor] companion disabled in this build");
    }
    return DISABLED;
  }
  if (current) await current.stop();
  log(`[agetor] remote gateway starting in ${opts.mode} mode${COMPANION_BUILD_MARKER ? ` (${COMPANION_BUILD_MARKER})` : ""}`);

  const d = opts.deps ?? {};
  const audit = d.audit ?? createAudit();
  const decisions = d.decisions ?? createDecisions();
  const idempotency = d.idempotency ?? createIdempotency();
  const limiter = d.limiter ?? new RateLimiter();
  const broadcast = d.broadcast ?? ((ev: AppEvent) => void import("../quit-guard.ts").then((m) => m.broadcastAppEvent(ev)));
  const relayUrl = d.relayUrl ?? (() => defaultRelayUrl());
  const remoteOn = d.remoteOn ?? (async () => (await getRemoteAccess()).enabled);
  const subscribeChanges = d.subscribeChanges ?? ((fn: () => void) => subscribeBackgroundChanges(() => fn()));
  const getName = d.macName ?? (() => macName());

  const stopFns: Array<() => void> = [];
  let stopped = false;
  let link: RelayLink | null = null;
  let linkGroups = new Set<string>();
  let relayState: GatewayStatus["relay"]["state"] = "off";
  let trustedKnown = false;
  let lastUnconfigured = false;

  // ── registry and the phone sink ──────────────────────────────────────────────────────────────────────────────────────
  const registry = createRegistry({
      ...(d.registryStore ? { store: d.registryStore } : {}),
      audit,
      notify: (n) => {
        postDeviceNotification({ deviceId: n.deviceId, title: n.title, body: n.body });
        broadcast({ type: "remote_action", taskId: null, deviceName: n.deviceName, action: "device-revoked", ts: Date.now() });
      },
    });
  const phoneSink =
    d.phoneSink ??
    createPhoneSink({
      devices: async () => (await registry.trustedDevices()).trusted,
      atTheMac: () => atTheMac(),
      markDead: async (id) => void (await (await import("../db-async.ts")).remoteDevices.markPushDead(id)),
      setPushRef: async (id, ref, key) => void (await (await import("../db-async.ts")).remoteDevices.setPushRef(id, ref, key)),
    });

  const policy = opts.notificationPolicy ?? ownPolicy(stopFns);
  stopFns.push(policy.registerSink(phoneSink));

  // ── the link ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  let sessions: SessionManager;
  let pairing: Pairing;
  const subsBySession = new Map<string, Subscriptions>();

  const linkAdapter = {
    send: (n: string, m: Uint8Array | null, t: Uint8Array, p: Uint8Array, o?: { priority?: boolean }) => link?.send(n, m, t, p, o) ?? false,
    queuedBytes: (n: string) => link?.queuedBytes(n) ?? 0,
    open: (spec: Parameters<RelayLink["open"]>[0]) => {
      const l = ensureLink();
      if (!l) return;
      l.open(spec);
      linkGroups.add(spec.name);
    },
    close: (name: string) => {
      link?.close(name);
      linkGroups.delete(name);
    },
  };

  function recomputeRelayState(): void {
    if (!link) {
      relayState = lastUnconfigured ? "unconfigured" : "off";
      return;
    }
    const states: LinkState[] = [...linkGroups].map((g) => link!.state(g));
    relayState = states.includes("up") ? "up" : states.includes("connecting") ? "connecting" : "down";
  }

  function ensureLink(): RelayLink | null {
    if (stopped) return null;
    if (link) return link;
    const url = relayUrl();
    if (!url) {
      if (!lastUnconfigured) log("[agetor] remote: no relay is configured; the gateway stays down");
      lastUnconfigured = true;
      recomputeRelayState();
      return null;
    }
    lastUnconfigured = false;
    link = new RelayLink({
      url,
      handlers: {
        onDeliver: (name, frame) => (name === PAIRING_GROUP ? pairing.onFrame(frame) : sessions.onFrame(name, frame)),
        onPeer: (name, _m, present) => sessions.setPeer(name, present),
        isStaleTag: (name, tag) => sessions.isStaleTag(name, tag),
        onState: () => recomputeRelayState(),
        onReplaced: (name) => log(`[agetor] remote: another core took over the mailbox of ${name === PAIRING_GROUP ? "pairing" : "a device"}`),
        onFull: () => undefined,
      },
      ...d.linkOptions,
    });
    return link;
  }

  async function openDeviceGroups(): Promise<void> {
    const l = ensureLink();
    if (!l) return;
    for (const row of (await registry.trustedDevices()).trusted) {
      if (linkGroups.has(row.id)) continue;
      l.open({ name: row.id, keys: (now) => deviceMailboxKeys(row.linkSecret, now) });
      linkGroups.add(row.id);
    }
    recomputeRelayState();
  }

  function dropLink(reason: string): void {
    sessions?.endAllSessions(reason);
    terminals.stop();
    for (const subs of subsBySession.values()) subs.closeAll();
    subsBySession.clear();
    link?.closeAll();
    link = null;
    linkGroups = new Set();
    recomputeRelayState();
  }

  const refreshTrusted = async (): Promise<void> => {
    try {
      trustedKnown = await registry.hasTrustedDevice();
    } catch {
      trustedKnown = false;
    }
    void gate.recompute();
  };

  const gate = new LinkGate({
    remoteOn,
    hasTrustedDevice: () => trustedKnown,
    pairingWindowOpen: () => pairing?.isOpen() ?? false,
  });
  gate.onChange((up) => {
    if (stopped) return;
    if (up) {
      ensureLink();
      void openDeviceGroups().catch((e) => log(`[agetor] remote: opening the relay link failed: ${String(e)}`));
    } else {
      dropLink("remote-off");
    }
  });

  // ── terminals, router, sessions ──────────────────────────────────────────────────────────────────────────────────────
  const terminals = createTerminalManager({ decisions, audit, ...createLiveTerminalDeps(), broadcast });
  const lookups = createLiveLookups();
  const router: Router = createRouter({
    limiter, idempotency, decisions, audit, lookups, broadcast,
    notify: (n) => postDeviceNotification(n),
  });

  sessions = createSessionManager({
    link: linkAdapter,
    helper: () => getKeyHelper(),
    registry,
    audit,
    limiter,
    decisions,
    macName: getName,
    routes: (level) => remoteRoutesFor(level),
    touch: async (id, ts) => void (await (await import("../db-async.ts")).remoteDevices.setLastSeen(id, ts)),
    onOpen: (channel) => {
      const subs = createSubscriptions(channel);
      subsBySession.set(channel.principal.sessionId, subs);
      channel.onClose(() => {
        subs.closeAll();
        subsBySession.delete(channel.principal.sessionId);
      });
    },
  });
  stopFns.push(() => sessions.stop());

  // ── pairing ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  pairing = createPairing({
    helper: () => getKeyHelper(),
    link: linkAdapter,
    audit,
    addDevice: async (device, a) => {
      await (await import("../db-async.ts")).op("remote.addDevice", [device, { ts: a.ts, action: "pair", deviceId: device.id, target: a.target }]);
      await refreshTrusted();
      void openDeviceGroups().catch(() => undefined);
    },
    macName: getName,
    relayUrl,
    enabled: () => companion,
    mode: () => (opts.mode === "app" ? "app" : "headless"),
    onWindowChange: () => void gate.recompute(),
    notify: (n) => postDeviceNotification(n),
    alertOthers: (id, kind) => phoneSink.alertOtherDevices(id, kind),
    broadcast,
    registerSecret: registerLogSecret,
    ...d.pairingDeps,
  });
  stopFns.push(() => void pairing.cancel("gateway-stopped"));

  // ── session ops ──────────────────────────────────────────────────────────────────────────────────────────────────────
  const fail = (ch: PhoneChannel, id: string | null, code: string, message: string): void => ch.send("error", { id, code, message });

  const ops: Array<() => void> = [
    registerSessionOp("request", async (ch, body) => {
      const b = body as { id: string; method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; path: string; query: string | null; body: unknown; idem: string | null; decision: { payload: unknown; sig: string } | null };
      const res = await router.invoke(ch.principal, { method: b.method, path: b.path, query: b.query, body: b.body, idem: b.idem, decision: b.decision });
      const contentType = res.contentType.slice(0, 128);
      let encoding: "utf8" | "base64" = "base64";
      let text = "";
      if (TEXT_TYPE_RE.test(contentType)) {
        try {
          text = decoder.decode(res.body);
          encoding = "utf8";
        } catch {
          encoding = "base64";
        }
      }
      ch.send("response", { id: b.id, status: res.status, contentType, encoding, body: encoding === "utf8" ? text : toBase64(res.body) }, { heavy: b.method === "GET" });
    }),

    registerSessionOp("subscribe-task", async (ch, body) => {
      const b = body as { sub: string; taskId: string; afterId: number | null; maxBytes: number | null };
      try {
        subsBySession.get(ch.principal.sessionId)?.subscribeTask(b.sub, b.taskId, b.afterId, b.maxBytes);
      } catch {
        fail(ch, b.sub, "too-many-subscriptions", "too many subscriptions");
      }
    }),
    registerSessionOp("subscribe-global", async (ch, body) => {
      const b = body as { sub: string };
      try {
        subsBySession.get(ch.principal.sessionId)?.subscribeGlobal(b.sub);
      } catch {
        fail(ch, b.sub, "too-many-subscriptions", "too many subscriptions");
      }
    }),
    registerSessionOp("unsubscribe", async (ch, body) => void subsBySession.get(ch.principal.sessionId)?.unsubscribe((body as { sub: string }).sub)),

    registerSessionOp("challenge", async (ch, body) => {
      const b = body as { id: string; target: ContentTarget };
      if (!levelAtLeast(ch.principal.level, challengeLevel(b.target))) return fail(ch, b.id, "level", "this device's level is too low for that");
      try {
        const issued = await decisions.issueChallenge(ch.principal, b.target);
        ch.send("challenge-issued", { id: b.id, challenge: issued.challenge, contentBytes: toBase64(issued.contentBytes), contentHash: issued.contentHash, expiresAt: issued.expiresAt });
      } catch (e) {
        fail(ch, b.id, e instanceof DecisionError ? (e.code === "no-such-content" ? "gone" : e.code) : "internal", "no challenge could be issued");
      }
    }),

    registerSessionOp("unlock", async (ch, body) => {
      const b = body as { id: string; payload: unknown; sig: string };
      if (!levelAtLeast(ch.principal.level, "respond")) return fail(ch, b.id, "level", "this device's level is too low for that");
      try {
        const expiresAt = decisions.verifyUnlock(ch.principal, b.payload, b.sig);
        await audit.event("unlock", { deviceId: ch.principal.deviceId, sessionHash: toHex(ch.principal.sessionHash), resultCode: "ok" }).catch(() => undefined);
        ch.send("unlock-ok", { id: b.id, expiresAt });
      } catch {
        void audit.refusal(ch.principal.deviceId, "unlock").catch(() => undefined);
        fail(ch, b.id, "unlock", "the unlock was not accepted");
      }
    }),

    registerSessionOp("push-register", async (ch, body) => {
      const b = body as { id: string; pushRef: string; sendKey: string };
      try {
        await phoneSink.registerPush(ch.principal.deviceId, b.pushRef, fromHex(b.sendKey));
        ch.send("ok", { id: b.id });
      } catch {
        fail(ch, b.id, "internal", "the push address could not be saved");
      }
    }),

    registerSessionOp("revoke-self", async (ch, body) => {
      const b = body as { id: string };
      ch.send("ok", { id: b.id });
      // Let the answer leave before the session ends.
      const end = Date.now() + 1500;
      while (ch.queuedBytes() > 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
      await registry.revoke(ch.principal.deviceId, "self");
    }),

    registerSessionOp("terminal-attach", async (ch, body) => {
      const b = body as { id: string; taskId: string; cols: number; rows: number; payload: unknown; sig: string };
      await terminals.attach(ch, b);
    }),
    registerSessionOp("terminal-input", async (ch, body) => terminals.input(ch, body as { taskId: string; data: string })),
    registerSessionOp("terminal-resize", async (ch, body) => terminals.resize(ch, body as { taskId: string; cols: number; rows: number })),
    registerSessionOp("terminal-detach", async (ch, body) => terminals.detach(ch, (body as { taskId: string }).taskId)),
  ];
  stopFns.push(...ops);

  // ── revocation reaches the live session and everything attached to it ─────────────────────────────────────────────────
  stopFns.push(
    registry.onRevoked((deviceId, reason) => {
      sessions.endDeviceSessions(deviceId, "revoked");
      terminals.detachForDevice(deviceId, "revoked");
      linkAdapter.close(deviceId);
      void phoneSink.alertOtherDevices(deviceId, "device-revoked").catch(() => undefined);
      void reason;
      void refreshTrusted();
    }),
    registry.onKeyReplaced(() => {
      // Revoke all: the core key changed, every session and mailbox group is stale.
      dropLink("revoke-all");
      void refreshTrusted();
    }),
  );

  // ── schedulers ────────────────────────────────────────────────────────────────────────────────────────────────────────
  if (!d.noSchedulers) {
    stopFns.push(startAuditRetention({ store: createDbAuditStore(), onError: (e) => log(`[agetor] remote: audit retention failed: ${String(e)}`) }));
    const minute = setInterval(() => void idempotency.prune().catch(() => undefined), 60_000);
    minute.unref();
    stopFns.push(() => clearInterval(minute));
    const expire = () => void registry.expireStale().then((ids) => (ids.length > 0 ? refreshTrusted() : undefined)).catch(() => undefined);
    const first = setTimeout(expire, 60_000);
    first.unref();
    const daily = setInterval(expire, 24 * 3600_000);
    daily.unref();
    stopFns.push(() => (clearTimeout(first), clearInterval(daily)));
  }

  // ── start ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  const host = resolveApiHost();
  const bindWarning = host.ok ? nonLoopbackBindWarning(host.host, getApiPort()) : null;
  if (bindWarning) log(bindWarning);
  stopFns.push(subscribeChanges(() => void gate.recompute()));
  await refreshTrusted();
  gate.start(d.gatePollMs ?? 5000);

  const gateway: RemoteGateway = {
    enabled: true,
    ...(opts.mode === "app" ? { startPairing: () => startPairing() } : {}),
    cancelPairing: () => pairing.cancel(),
    status: () => ({
      companion: true,
      relay: { url: relayUrl(), state: relayState },
      bindWarning,
      attachedTerminals: terminals.attachedTerminals(),
      activeSessions: sessions.activeSessions().length,
      pairing: { open: pairing.isOpen(), expiresAt: pairing.status().expiresAt },
    }),
    auditHead: () => audit.head(),
    registry,
    audit,
    terminals,
    sessions,
    async stop() {
      if (stopped) return;
      stopped = true;
      gate.stop();
      dropLink("gateway-stopped");
      for (const fn of stopFns.splice(0).reverse()) {
        try {
          fn();
        } catch {
          /* a stop step must not stop the others */
        }
      }
      if (current === gateway) current = null;
    },
  };

  async function startPairing(): Promise<{ expiresAt: number; alreadyOpen: boolean }> {
    if (!(await remoteOn())) throw new Error("remote access is off");
    return await pairing.start();
  }

  current = gateway;
  return gateway;
}

/** The lowest device level that may ask for a challenge on a target (the router checks the route's own level again at the call). */
function challengeLevel(t: ContentTarget): RemoteLevel {
  if (t.kind === "terminal") return "configure";
  if (t.kind === "claude-plan" && t.row === "auto") return "operate";
  return "respond";
}

/** A phone-only policy for a core that has no OS notifier (a login-item core with OS notifications off). */
function ownPolicy(stopFns: Array<() => void>): { registerSink(sink: NotificationSink): () => void } {
  const { subscribeGlobal } = require("../orchestrator.ts") as typeof import("../orchestrator.ts");
  const { fetchTaskRows } = require("../headless-notifications.ts") as typeof import("../headless-notifications.ts");
  const p = installNotificationPolicy({ subscribe: subscribeGlobal, loadRows: fetchTaskRows });
  stopFns.push(() => p.dispose());
  return p;
}

