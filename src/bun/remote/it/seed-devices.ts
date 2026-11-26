#!/usr/bin/env bun
// Seeds trusted devices into a data dir BEFORE a core boots, the way a pairing would have: rows signed by the fake key helper's registry key
// (its state lives in the helper dir, which the core's fake helper reads too). Usage:
//   NODE_ENV=test bun seed-devices.ts <dataDir> <helperDir> '<json: [{name, level, sessionPub, approvePub, pushPub}]>'
// Prints one JSON line: { corePub, devices: [{ id, linkSecret }] }.
import { randomBytes, toHex } from "@agetor/remote-protocol/bytes";

const [dataDir, helperDir, specJson] = process.argv.slice(2);
if (!dataDir || !helperDir || !specJson) throw new Error("usage: seed-devices.ts <dataDir> <helperDir> <json>");
process.env.AGETOR_DATA_DIR = dataDir;

const spec = JSON.parse(specJson) as Array<{ name: string; level: "observe" | "respond" | "operate" | "configure"; sessionPub: string; approvePub: string; pushPub: string; id?: string }>;
const { FakeKeyHelper } = await import("../key-helper-fake.ts");
const { registryEntryJson } = await import("../registry.ts");
const db = await import("../../db-async.ts");
const { fromHex } = await import("@agetor/remote-protocol/bytes");

const helper = new FakeKeyHelper({ dir: helperDir });
const out: Array<{ id: string; linkSecret: string }> = [];
for (const d of spec) {
  const id = d.id ?? toHex(randomBytes(16));
  const base = { id, name: d.name, platform: "ios" as const, sessionPub: fromHex(d.sessionPub), approvePub: fromHex(d.approvePub), pushPub: fromHex(d.pushPub), level: d.level, enrolledAt: Date.now() };
  const sig = helper.signRegistryEntry(id, registryEntryJson(base));
  const linkSecret = randomBytes(32);
  await db.op("remote.addDevice", [{ ...base, appVersion: "1", linkSecret, sig }, { ts: Date.now(), action: "pair", deviceId: id }]);
  out.push({ id, linkSecret: toHex(linkSecret) });
}
console.log(JSON.stringify({ corePub: toHex((await helper.status()).corePub), devices: out }));
process.exit(0);
