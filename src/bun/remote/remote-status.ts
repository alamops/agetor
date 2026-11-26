/**
 * What the HTTP routes under `/remote-access` (and `DELETE /tasks/:id/phone-terminal`) answer: the status, the device list, revocation and
 * the log page (docs/architecture/remote-gateway.md). They read the running gateway when there is one and fall back to the stores when
 * there is not (the Companion is compiled in but the gateway has not started yet), so Settings and the CLI always see the same rows.
 *
 * Every function here only READS or REMOVES authority. Nothing turns remote access on, pairs a device or raises a level: that is the
 * native box and the key helper's window, pinned by `route-policy.test.ts` TT3(c).
 */
import type { RemoteDeviceDto, RemoteDevicesResult, RemoteLogResult } from "../../shared/remote-types.ts";
import type { RemoteAccessStatus } from "../../shared/types.ts";
import { COMPANION_ENABLED } from "../../shared/build-flags.ts";
import { getRemoteAccess } from "../background.ts";
import { createAudit, type Audit } from "./audit.ts";
import { currentGateway } from "./gateway.ts";
import { macName } from "./mac-name.ts";
import { createRegistry, type Registry } from "./registry.ts";

export const DEVICE_ID_RE = /^[0-9a-f]{32}$/;

let fallbackRegistry: Registry | null = null;
let fallbackAudit: Audit | null = null;
const registry = (): Registry => currentGateway()?.registry ?? (fallbackRegistry ??= createRegistry());
const audit = (): Audit => currentGateway()?.audit ?? (fallbackAudit ??= createAudit());

/** Test seam: forget the fallback stores. */
export function resetRemoteStatusForTests(): void {
  fallbackRegistry = null;
  fallbackAudit = null;
}

const EMPTY: Omit<RemoteAccessStatus, "enabled" | "preview" | "macName"> = {
  companion: false,
  relay: { url: null, state: "off" },
  devices: { trusted: 0, untrusted: 0 },
  bindWarning: null,
  attachedTerminals: [],
  auditHead: null,
};

export async function buildRemoteAccessStatus(): Promise<RemoteAccessStatus> {
  const sw = await getRemoteAccess();
  const name = await macName().catch(() => "Mac");
  if (!COMPANION_ENABLED) return { ...sw, ...EMPTY, macName: name };
  const gw = currentGateway();
  const g = gw?.status();
  let devices = { trusted: 0, untrusted: 0 };
  try {
    const set = await registry().trustedDevices();
    devices = { trusted: set.trusted.length, untrusted: set.untrusted.filter((u) => u.reason !== "revoked").length };
  } catch {
    /* the key helper is unavailable: the counts stay zero and the relay state says why nothing connects */
  }
  return {
    ...sw,
    companion: true,
    relay: g?.relay ?? { url: null, state: "off" },
    devices,
    bindWarning: g?.bindWarning ?? null,
    macName: name,
    attachedTerminals: g?.attachedTerminals ?? [],
    auditHead: (await audit().head().catch(() => null)) ?? null,
  };
}

export async function listDevices(): Promise<RemoteDevicesResult> {
  const set = await registry().trustedDevices();
  const online = new Set(currentGateway()?.sessions?.activeSessions().map((s) => s.deviceId) ?? []);
  const dto = (row: (typeof set.trusted)[number], trust: RemoteDeviceDto["trust"]): RemoteDeviceDto => ({
    id: row.id, name: row.name, platform: row.platform, appVersion: row.appVersion, level: row.level, trust, enrolledAt: row.enrolledAt,
    lastSeenAt: row.lastSeenAt, pushRegistered: row.pushRef !== null && !row.pushDead, online: online.has(row.id),
  });
  return { devices: [...set.trusted.map((r) => dto(r, "trusted")), ...set.untrusted.map((u) => dto(u.row, u.reason))].sort((a, b) => a.enrolledAt - b.enrolledAt) };
}

/** Revoke one device. False when no such device exists. */
export async function revokeDevice(id: string): Promise<boolean> {
  const set = await registry().trustedDevices();
  const known = [...set.trusted, ...set.untrusted.map((u) => u.row)].some((r) => r.id === id);
  if (!known) return false;
  await registry().revoke(id, "revoked");
  return true;
}

export async function revokeAllDevices(): Promise<void> {
  await registry().revokeAll();
}

export async function readLog(opts: { beforeSeq?: number; limit: number }): Promise<RemoteLogResult> {
  const page = await audit().page(opts);
  const last = page.rows.at(-1);
  return { rows: page.rows, chain: page.chain, nextBeforeSeq: page.rows.length >= opts.limit && last ? last.seq : null };
}

/** End the phone's terminal on a task (the Mac's Detach button, or the task going away). False when none was attached. */
export function detachPhoneTerminal(taskId: string, reason = "mac-detach"): boolean {
  return currentGateway()?.terminals?.detachForTask(taskId, reason) ?? false;
}
