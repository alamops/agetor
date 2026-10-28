// `openFileBytes` / `readFileBytes` (D26(j)): every case runs in-process (switch
// off) and through a recording `AGETOR_DISCLAIM_BIN` passthrough stub (switch
// on), and must answer the same — except that the disclaimed path is the one
// that actually spawns, which the stub's log proves.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getDisclaimSwitch, setDisclaimSwitch } from "./disclaim.ts";
import { openFileBytes, readFileBytes } from "./core-file-read.ts";

let root: string;
let stubBin: string;
let stubLog: string;
const savedBin = process.env.AGETOR_DISCLAIM_BIN;
const savedSwitch = getDisclaimSwitch();

function restore(): void {
  if (savedBin === undefined) delete process.env.AGETOR_DISCLAIM_BIN;
  else process.env.AGETOR_DISCLAIM_BIN = savedBin;
  setDisclaimSwitch(savedSwitch);
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "core-file-read-")));
  stubBin = path.join(root, "disclaim-stub.sh");
  stubLog = path.join(root, "disclaim-stub.log");
  writeFileSync(stubBin, `#!/bin/sh\nprintf '%s\\n' "$1" >> '${stubLog}'\nexec "$@"\n`, { mode: 0o755 });
  chmodSync(stubBin, 0o755);

  writeFileSync(path.join(root, "a.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(path.join(root, "empty.png"), "");
  // Bigger than one pipe buffer, so the disclaimed path streams several chunks.
  const big = Buffer.alloc(1_000_003);
  for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 0xff;
  writeFileSync(path.join(root, "big.png"), big);
  mkdirSync(path.join(root, "dir.png"));
  Bun.spawnSync(["/usr/bin/mkfifo", path.join(root, "fifo.png")]);
  symlinkSync(path.join(root, "a.png"), path.join(root, "link.png"));
  symlinkSync(path.join(root, "nowhere.png"), path.join(root, "dangling.png"));
  writeFileSync(path.join(root, "locked.png"), "secret");
  chmodSync(path.join(root, "locked.png"), 0o000);
  writeFileSync(path.join(root, "my file\nname.png"), "spaced");
});

afterAll(() => {
  restore();
  chmodSync(path.join(root, "locked.png"), 0o600);
  Bun.spawnSync(["/bin/rm", "-rf", root]);
});

afterEach(restore);

const modes = [
  { name: "in-process", on: false },
  { name: "disclaimed", on: true },
] as const;

for (const mode of modes) {
  describe(`openFileBytes (${mode.name})`, () => {
    const setup = () => {
      if (mode.on) {
        process.env.AGETOR_DISCLAIM_BIN = stubBin;
        setDisclaimSwitch(true);
      } else {
        setDisclaimSwitch(false);
      }
      writeFileSync(stubLog, "");
    };
    const spawned = () => readFileSync(stubLog, "utf8").trim().length > 0;
    const p = (name: string) => path.join(root, name);

    test("reads a regular file's exact bytes, with a size+mtime etag", async () => {
      setup();
      const r = await readFileBytes(p("a.png"), { followSymlinks: true, maxBytes: 1024 });
      expect(r.kind).toBe("ok");
      if (r.kind !== "ok") return;
      expect([...r.bytes]).toEqual([0x89, 0x50, 0x4e, 0x47]);
      expect(r.etag).toMatch(/^"4-[0-9.]+"$/);
      expect(spawned()).toBe(mode.on);
    });

    test("streams a large file byte for byte", async () => {
      setup();
      const r = await openFileBytes(p("big.png"), { followSymlinks: true });
      expect(r.kind).toBe("ok");
      if (r.kind !== "ok") return;
      expect(r.size).toBe(1_000_003);
      const bytes = new Uint8Array(await new Response(r.body).arrayBuffer());
      expect(bytes.length).toBe(1_000_003);
      expect(Buffer.from(bytes).equals(readFileSync(p("big.png")))).toBe(true);
    });

    test("answers not-modified for its own etag, without a body", async () => {
      setup();
      const first = await openFileBytes(p("a.png"), { followSymlinks: true });
      expect(first.kind).toBe("ok");
      if (first.kind !== "ok") return;
      const again = await openFileBytes(p("a.png"), { followSymlinks: true, ifNoneMatch: first.etag });
      expect(again).toEqual({ kind: "not-modified", etag: first.etag });
      const other = await openFileBytes(p("a.png"), { followSymlinks: true, ifNoneMatch: '"1-2"' });
      expect(other.kind).toBe("ok");
    });

    test("an empty file is ok with an empty body", async () => {
      setup();
      const r = await readFileBytes(p("empty.png"), { followSymlinks: true, maxBytes: 10 });
      expect(r.kind).toBe("ok");
      if (r.kind === "ok") expect(r.bytes.length).toBe(0);
    });

    test("a name with a space and a newline round-trips", async () => {
      setup();
      const r = await readFileBytes(p("my file\nname.png"), { followSymlinks: true, maxBytes: 100 });
      expect(r.kind).toBe("ok");
      if (r.kind === "ok") expect(new TextDecoder().decode(r.bytes)).toBe("spaced");
    });

    test("missing, a directory, a FIFO and a dangling symlink are all missing (no hang)", async () => {
      setup();
      for (const name of ["gone.png", "dir.png", "fifo.png", "dangling.png", "gone/x.png"]) {
        expect((await openFileBytes(p(name), { followSymlinks: true })).kind).toBe("missing");
      }
    });

    test("a symlink is followed only with followSymlinks", async () => {
      setup();
      expect((await openFileBytes(p("link.png"), { followSymlinks: true })).kind).toBe("ok");
      expect((await openFileBytes(p("link.png"), { followSymlinks: false })).kind).toBe("missing");
      expect((await openFileBytes(p("fifo.png"), { followSymlinks: false })).kind).toBe("missing");
    });

    test("a file over maxBytes is refused before it is read", async () => {
      setup();
      const r = await openFileBytes(p("big.png"), { followSymlinks: false, maxBytes: 1000 });
      expect(r).toEqual({ kind: "too-large", size: 1_000_003 });
    });

    test("an unreadable file is denied, not a 200 that dies mid-body", async () => {
      setup();
      if (process.getuid?.() === 0) return; // root reads mode-000 files
      const r = await openFileBytes(p("locked.png"), { followSymlinks: true });
      expect(r.kind).toBe("denied");
    });
  });
}

test("the disclaimed path goes through the helper with the path only as argv", async () => {
  process.env.AGETOR_DISCLAIM_BIN = stubBin;
  setDisclaimSwitch(true);
  writeFileSync(stubLog, "");
  await readFileBytes(path.join(root, "a.png"), { followSymlinks: true, maxBytes: 100 });
  expect(readFileSync(stubLog, "utf8").trim()).toBe("/bin/sh");
});
