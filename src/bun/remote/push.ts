/**
 * The phone push sink (docs/specs/remote-readiness-spec.md "Push notifications"). The core's notification policy decides once
 * (`src/bun/notification-policy.ts`) and tells every sink; this one turns a decision into a SEALED push for each paired device.
 *
 *  - Only `needs-you` kinds, and nothing while the Mac window had focus in the last 2 minutes (`presence.atTheMac`; a background core
 *    with no app counts as away).
 *  - The payload `{v, taskId, kind, title, subtitle, ts}` is padded to 1 KB and sealed with HPKE to the device's push key; the
 *    gateway, Apple and Google see ciphertext, one constant size and timing, never a title, a path or a plan. The collapse id is an HMAC of
 *    the task id under the device's link secret: opaque and stable, so one task keeps one lock-screen entry.
 *  - The request to the gateway names the device's opaque `push_ref` and is authenticated by an HMAC under the device's push send key
 *    (registered with the phone over its session). A 410 means the token is dead: the device is marked and skipped until it registers again.
 *  - No gateway configured (`pushUrl()` null, the state of this change outside tests): nothing is sent, and `status()` says why.
 */
import { toBase64, toBase64Url, toHex, fromHex, randomBytes, utf8 } from "@agetor/remote-protocol/bytes";
import { canonicalBytes } from "@agetor/remote-protocol/canonical-json";
import { collapseId, pushRequestMac } from "@agetor/remote-protocol/derive";
import { sealPush } from "@agetor/remote-protocol/push-payload";
import { notificationUrgency } from "../../shared/os-notification.ts";
import type { RemoteDeviceRow } from "../../shared/remote-types.ts";
import { registerLogSecret } from "../core-log.ts";
import type { NotificationDecision, NotificationSink } from "../notification-policy.ts";
import { atTheMac } from "../presence.ts";
import { pushUrl as defaultPushUrl } from "./relay-config.ts";

export interface PushDeps {
  /** The trusted, active devices (registry), each with its push registration. */
  devices(): Promise<RemoteDeviceRow[]>;
  /** The gateway's base URL, or null. */
  pushUrl?: () => string | null;
  fetch?: typeof fetch;
  now?: () => number;
  /** Whether someone is at the Mac (window focus within 2 minutes). Default: `presence.atTheMac`. */
  atTheMac?: () => boolean;
  markDead?(deviceId: string): Promise<void>;
  setPushRef?(deviceId: string, pushRef: string, sendKey: Uint8Array): Promise<void>;
  /** Test seam: a fixed ephemeral key so a seal is reproducible. */
  ephemeral?: () => Uint8Array | undefined;
}

export interface PushBody {
  push_ref: string;
  kind: "needs-you" | "alert";
  collapse: string;
  sealed: string;
  ts: number;
  nonce: string;
}

export interface PhoneSink extends NotificationSink {
  /** A generic sealed alert to every device but one: "a device was paired", "a device was revoked". */
  alertOtherDevices(exceptDeviceId: string, kind: "device-paired" | "device-revoked"): Promise<void>;
  /** The `push-register` session op: store the device's push address and send key, and register them as log secrets. */
  registerPush(deviceId: string, pushRef: string, sendKey: Uint8Array): Promise<void>;
  /** For Settings and the CLI: why pushes would not go out right now. */
  status(): { configured: boolean };
}

export function createPhoneSink(deps: PushDeps): PhoneSink {
  const now = deps.now ?? Date.now;
  const gateway = deps.pushUrl ?? (() => defaultPushUrl());
  const away = deps.atTheMac ?? (() => atTheMac());
  const doFetch = deps.fetch ?? fetch;

  async function post(device: RemoteDeviceRow, kind: PushBody["kind"], sealed: Uint8Array, taskKey: string): Promise<void> {
    const base = gateway();
    if (!base || !device.pushRef || !device.pushSendKey || device.pushDead) return;
    const body: PushBody = {
      push_ref: device.pushRef,
      kind,
      collapse: toBase64Url(collapseId(device.linkSecret, taskKey)),
      sealed: toBase64(sealed),
      ts: now(),
      nonce: toHex(randomBytes(16)),
    };
    const mac = toHex(pushRequestMac(device.pushSendKey, canonicalBytes(body)));
    try {
      const res = await doFetch(`${base.replace(/\/+$/, "")}/v1/push`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-agetor-mac": mac },
        body: JSON.stringify(body),
      });
      if (res.status === 410) await deps.markDead?.(device.id);
    } catch {
      /* the gateway is unreachable: a push is best effort, the Mac's own notification already went */
    }
  }

  return {
    id: "phone",

    async deliver(d: NotificationDecision) {
      if (notificationUrgency(d.kind) !== "needs-you") return;
      if (!gateway()) return;
      if (away()) return; // someone is at the Mac: no push
      const taskId = d.notification.taskId;
      if (!taskId) return;
      const devices = await deps.devices();
      for (const device of devices) {
        const sealed = sealPush(
          { v: 1, taskId, kind: d.kind ?? "waiting", title: d.notification.title, subtitle: d.notification.body ?? null, ts: now() },
          device.pushPub,
          deps.ephemeral?.(),
        );
        await post(device, "needs-you", sealed, taskId);
      }
    },

    async alertOtherDevices(exceptDeviceId, kind) {
      if (!gateway()) return;
      for (const device of await deps.devices()) {
        if (device.id === exceptDeviceId) continue;
        const sealed = sealPush(
          { v: 1, taskId: "agetor", kind, title: kind === "device-paired" ? "A phone was paired" : "A phone was revoked", subtitle: null, ts: now() },
          device.pushPub,
          deps.ephemeral?.(),
        );
        await post(device, "alert", sealed, `alert:${kind}`);
      }
    },

    async registerPush(deviceId, pushRef, sendKey) {
      // Secrets: never in a log line, whatever prints one (invariant 11).
      registerLogSecret(pushRef);
      registerLogSecret(toHex(sendKey));
      await deps.setPushRef?.(deviceId, pushRef, sendKey);
    },

    status: () => ({ configured: gateway() !== null }),
  };
}

export { fromHex, utf8 };
