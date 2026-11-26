// TS2: file previews for a phone (grill D15) against a REAL core: inside the task's folders is an observe read, anywhere else needs operate, a
// symlink is never followed, and a big file arrives in chunks that stay inside the relay's own counters (no frame dropped for rate, no burst).
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { connectDevice, coreOnRelay, startCore, until, type CoreHandle } from "./harness.ts";

const cores: CoreHandle[] = [];
const scratch: string[] = [];
afterEach(async () => {
  for (const c of cores.splice(0)) {
    for (const d of c.devices) d.phone.close();
    await c.stop();
  }
  for (const s of scratch.splice(0)) rmSync(s, { recursive: true, force: true });
});

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function world() {
  const work = mkdtempSync(path.join(tmpdir(), "agt-it-prev-work-"));
  const outside = mkdtempSync(path.join(tmpdir(), "agt-it-prev-out-"));
  scratch.push(work, outside);
  mkdirSync(path.join(work, "shots"));
  const inside = path.join(work, "shots", "in.png");
  const outsideFile = path.join(outside, "secret.png");
  writeFileSync(inside, Buffer.concat([PNG_MAGIC, Buffer.from("inside")]));
  writeFileSync(outsideFile, Buffer.concat([PNG_MAGIC, Buffer.from("outside")]));
  symlinkSync(outsideFile, path.join(work, "shots", "link.png"));
  const core = await startCore({ devices: [{ name: "Viewer", level: "observe" }, { name: "Responder", level: "respond" }, { name: "Operator", level: "operate" }] });
  cores.push(core);
  const res = await core.api("POST", "/tasks", { title: "previews", prompt: "p", agent: "claude-code", workdir: work, isolation: "none" });
  const taskId = ((await res.json()) as { id: string }).id;
  await until(() => coreOnRelay(core.relay), 15_000, "the core on the relay");
  for (let i = 0; i < 3; i++) await connectDevice(core, i);
  const preview = (i: number, p: string) => core.devices[i]!.phone.request("GET", `/tasks/${taskId}/files/preview`, null, { query: `path=${encodeURIComponent(p)}` });
  return { core, work, inside, outsideFile, preview, taskId };
}

describe("D15: where a preview may read", () => {
  test("inside the task's folders: observe is enough", async () => {
    const w = await world();
    const res = await w.preview(0, w.inside);
    expect(res.status).toBe(200);
    expect(res.contentType).toBe("image/png");
    expect(Buffer.from(res.bytes()).subarray(8).toString()).toBe("inside");
  }, 120_000);

  test("outside the task's folders: observe and respond are refused at the level, operate is served", async () => {
    const w = await world();
    for (const i of [0, 1]) {
      const res = await w.preview(i, w.outsideFile);
      expect(res.status, `device ${i}`).toBe(403);
      expect(res.json<{ code: string; required: string }>()).toMatchObject({ code: "level", required: "operate" });
    }
    const ok = await w.preview(2, w.outsideFile);
    expect(ok.status).toBe(200);
    expect(Buffer.from(ok.bytes()).subarray(8).toString()).toBe("outside");
  }, 120_000);

  test("a symlink is never followed, even from inside the task's own folder (the planted link points at a file outside it)", async () => {
    const w = await world();
    const res = await w.preview(2, path.join(w.work, "shots", "link.png"));
    expect([403, 404]).toContain(res.status);
    expect(Buffer.from(res.bytes()).toString()).not.toContain("outside");
  }, 120_000);

  test("a path that is not an image, a relative path and an unknown task are refused", async () => {
    const w = await world();
    writeFileSync(path.join(w.work, "notes.txt"), "hello");
    // A heavy read: two a second per device, so the calls are spaced.
    expect((await w.preview(2, path.join(w.work, "notes.txt"))).status).toBe(400);
    await new Promise((r) => setTimeout(r, 600));
    expect((await w.preview(2, "shots/in.png")).status).toBe(400);
    await new Promise((r) => setTimeout(r, 600));
    const unknown = await w.core.devices[2]!.phone.request("GET", "/tasks/no-such-task/files/preview", null, { query: `path=${encodeURIComponent(w.inside)}` });
    expect(unknown.status).toBe(404);
  }, 120_000);
});

describe("a big preview", () => {
  test("arrives whole, in chunks, inside the relay's own counters: no frame dropped for rate, no second over 50 frames, never over 2 MB in ten seconds", async () => {
    const w = await world();
    const big = path.join(w.work, "shots", "big.png");
    const bytes = Buffer.concat([PNG_MAGIC, Buffer.alloc(1_100_000, 0x61)]);
    writeFileSync(big, bytes);
    const res = await w.core.devices[0]!.phone.request("GET", `/tasks/${w.taskId}/files/preview`, null, { query: `path=${encodeURIComponent(big)}`, timeoutMs: 60_000 });
    expect(res.status).toBe(200);
    expect(createHash("sha256").update(Buffer.from(res.bytes())).digest("hex")).toBe(createHash("sha256").update(bytes).digest("hex"));
    const s = w.core.relay.stats();
    expect(s.droppedRate).toBe(0);
    expect(s.maxFramesInOneSecond).toBeLessThanOrEqual(50);
    expect(s.maxBytesInTenSeconds).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(s.full).toBe(0);
  }, 180_000);
});
