/**
 * Arrange-only helpers for the Companion's e2e specs (docs/plans/remote-readiness.md E2E): a local relay, a fake key helper whose state
 * directory the backend shares, and signed device rows written into the backend's SQLite file. A device row is only TRUSTED when the fake
 * helper's registry key signed it, so the rows are signed exactly the way a pairing signs them: nothing here weakens the core's trust check.
 * No real credentials, no Secure Enclave: the seams are honored because the e2e backend sets `AGETOR_E2E_HARNESS_SEAMS=1`.
 */
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes, toHex } from "@agetor/remote-protocol/bytes";
import type { RemoteLevel } from "@agetor/remote-protocol/levels";
import { TestPhone } from "@agetor/remote-protocol/test-client";
import { startTestRelay, type TestRelay } from "@agetor/remote-protocol/test-relay";
import { FakeKeyHelper } from "../src/bun/remote/key-helper-fake.ts";
import { registryEntryJson } from "../src/bun/remote/registry.ts";
import type { E2EBackend } from "./fixtures";

export interface RemoteWorld {
  relay: TestRelay;
  helper: FakeKeyHelper;
  helperDir: string;
  /** Pass to `test.use({ backendEnv: world.env })`. */
  env: Record<string, string>;
  close(): void;
}

/** One relay and one fake helper state dir per spec file. Create it at module scope, close it in `afterAll`. */
export function startRemoteWorld(extraEnv: Record<string, string> = {}): RemoteWorld {
  const relay = startTestRelay({ limits: { framesPerSecond: 10_000 } });
  const helperDir = mkdtempSync(path.join(tmpdir(), "agt-e2e-helper-"));
  const helper = new FakeKeyHelper({ dir: helperDir });
  return {
    relay,
    helper,
    helperDir,
    env: {
      AGETOR_FAKE_KEY_HELPER: "1",
      AGETOR_FAKE_KEY_HELPER_DIR: helperDir,
      AGETOR_REMOTE_RELAY_URL: relay.url,
      AGETOR_FAKE_LOGIN_ITEM: "1",
      AGETOR_FAKE_REMOTE_ACCESS: "on",
      ...extraEnv,
    },
    close() {
      helper.close();
      relay.stop();
      rmSync(helperDir, { recursive: true, force: true });
    },
  };
}

export interface SeededDevice {
  id: string;
  name: string;
  level: RemoteLevel;
  linkSecret: Uint8Array;
  phone: TestPhone;
}

/**
 * Writes one device row into the backend's database. `badSignature` signs it with a key that is not the registry key, so the core lists it as
 * "Not trusted". The registry reads its rows on every request, so a row written after boot is seen at once.
 */
export function seedDevice(world: RemoteWorld, backend: E2EBackend, opts: { name: string; level?: RemoteLevel; badSignature?: boolean }): SeededDevice {
  const phone = new TestPhone({ relayUrl: world.relay.url, timeoutMs: 8000 });
  const level = opts.level ?? "respond";
  const id = toHex(randomBytes(16));
  const row = { id, name: opts.name, platform: "ios" as const, sessionPub: phone.sessionPub, approvePub: phone.approvePub, pushPub: phone.pushPub, level, enrolledAt: Date.now() };
  const sig = opts.badSignature ? new Uint8Array(64).fill(1) : world.helper.signRegistryEntry(id, registryEntryJson(row));
  const linkSecret = randomBytes(32);
  const db = new Database(path.join(backend.dataDir, "agetor.sqlite"));
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.run(
      `INSERT INTO remote_devices (id, name, platform, app_version, session_pub, approve_pub, push_pub, link_secret, level, status, enrolled_at, sig)
       VALUES (?, ?, 'ios', '1.0', ?, ?, ?, ?, ?, 'active', ?, ?)`,
      [id, opts.name, row.sessionPub, row.approvePub, row.pushPub, linkSecret, level, row.enrolledAt, sig],
    );
  } finally {
    db.close();
  }
  return { id, name: opts.name, level, linkSecret, phone };
}

export async function connectPhone(world: RemoteWorld, d: SeededDevice): Promise<void> {
  await d.phone.connect({ corePub: (await world.helper.status()).corePub, deviceId: d.id, linkSecret: d.linkSecret });
}
