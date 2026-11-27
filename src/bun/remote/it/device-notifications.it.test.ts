// TS3 / M1: device notifications from a HEADLESS core (docs/architecture/notifications.md). A CLI revoke, or Revoke all, on a core with no app
// window posts its notice through the notifier helper under the device's own id (`agetor.device.<id>`, or `agetor.device.all`), with no deep
// link. The core is a real child process (`bun src/bun/headless.ts`); the helper is a stub that records each post's argv and acks it.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NOTIFIER_LIST_HEADER } from "../../notifier.ts";
import { coreOnRelay, startCore, until, type CoreHandle } from "./harness.ts";

const cores: CoreHandle[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const c of cores.splice(0)) {
    for (const d of c.devices) d.phone.close();
    await c.stop();
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A notifier helper stand-in: `--list` answers the header; every other call appends its argv as one line and acks a post. */
function stubNotifier(): { bin: string; posts: () => string[] } {
  const dir = mkdtempSync(path.join(tmpdir(), "agt-it-notifier-"));
  dirs.push(dir);
  const log = path.join(dir, "argv.log");
  const bin = path.join(dir, "notifier");
  writeFileSync(
    bin,
    `#!/bin/sh
if [ "$1" = "--list" ]; then echo "${NOTIFIER_LIST_HEADER}"; exit 0; fi
echo "$@" >> "${log}"
while [ $# -gt 0 ]; do if [ "$1" = "--id" ]; then echo "posted $2"; fi; shift; done
exit 0
`,
  );
  chmodSync(bin, 0o755);
  return { bin, posts: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []) };
}

describe.skipIf(process.platform !== "darwin")("device notifications from a headless core", () => {
  test("M1: a CLI revoke posts 'Phone revoked' under the device's own id, and Revoke all posts under agetor.device.all; neither carries a link", async () => {
    const notifier = stubNotifier();
    const core = await startCore({
      devices: [{ name: "Ana's iPhone", level: "respond" }, { name: "Ben's Pixel", level: "respond" }],
      env: { AGETOR_HEADLESS_NOTIFICATIONS: "1", AGETOR_NOTIFIER_BIN: notifier.bin },
    });
    cores.push(core);
    await until(() => coreOnRelay(core.relay), 15_000, "the core on the relay");
    const ana = core.devices[0]!.id;

    expect((await core.api("DELETE", `/remote-access/devices/${ana}`)).status).toBe(200);
    const mine = (id: string) => notifier.posts().filter((l) => l.includes(`--id agetor.device.${id}`));
    await until(() => mine(ana).length > 0, 10_000, "the revoke notice to reach the helper");
    expect(mine(ana)).toHaveLength(1);
    expect(mine(ana)[0]).toContain("--title Phone revoked");
    expect(mine(ana)[0]).toContain("Ana's iPhone can no longer reach this Mac.");
    expect(mine(ana)[0]).not.toContain("--url");
    // a device notice is never posted under a task's id
    expect(notifier.posts().some((l) => l.includes("--id agetor.task."))).toBe(false);

    expect((await core.api("DELETE", "/remote-access/devices")).status).toBe(200);
    await until(() => mine("all").length > 0, 10_000, "the Revoke all notice to reach the helper");
    expect(mine("all")[0]).toContain("--title All phones revoked");
    expect(mine("all")[0]).not.toContain("--url");
  }, 90_000);
});
