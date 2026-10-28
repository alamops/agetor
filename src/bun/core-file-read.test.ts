// `openFileBytes` / `readFileBytes` (D26(j)): every case runs in-process (switch
// off) and through a recording `AGETOR_DISCLAIM_BIN` passthrough stub (switch
// on), and must answer the same — except that the disclaimed path is the one
// that actually spawns, which the stub's log proves.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getDisclaimSwitch, setDisclaimSwitch } from "./disclaim.ts";
import { __forTest, openFileBytes, readFileBytes, settleFileBytes } from "./core-file-read.ts";

let root: string;
let stubBin: string;
let stubLog: string;
/** A stand-in helper that answers like a misbehaving or stalled child for the
 *  file names listed in its `case` (keyed on `$5`, the path argv element of
 *  core-file-read's `sh -c` script), and runs the real script otherwise. */
let scriptedBin: string;
/** `$$` of the last scripted run. Every stalled case `exec`s its delay, so this
 *  is also the pid of whatever the core has to kill. */
let scriptedPid: string;
const savedBin = process.env.AGETOR_DISCLAIM_BIN;
const savedSwitch = getDisclaimSwitch();

function restore(): void {
  if (savedBin === undefined) delete process.env.AGETOR_DISCLAIM_BIN;
  else process.env.AGETOR_DISCLAIM_BIN = savedBin;
  setDisclaimSwitch(savedSwitch);
  __forTest.setOpenTimeoutMs(null);
  __forTest.setBodyTimeoutMs(null);
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
  // A file whose folder can't be searched: `stat` itself fails (the helper's
  // `E` answer), unlike locked.png, where stat works and only `cat` fails.
  mkdirSync(path.join(root, "sealed"));
  writeFileSync(path.join(root, "sealed", "x.png"), "x");
  chmodSync(path.join(root, "sealed"), 0o000);

  scriptedBin = path.join(root, "scripted-stub.sh");
  scriptedPid = path.join(root, "scripted.pid");
  writeFileSync(
    scriptedBin,
    [
      "#!/bin/sh",
      `echo $$ > '${scriptedPid}'`,
      'case "$5" in',
      // The header promises 100 bytes; only 10 come before EOF.
      "  */short.png) printf 'O 100 1\\n0123456789'; exit 0 ;;",
      // More bytes than the header's size, then a child that never exits.
      "  */grew.png) printf 'O 4 1\\nabcdefgh'; exec /bin/sleep 30 ;;",
      // Part of the body, then nothing more and no EOF.
      "  */stall-body.png) printf 'O 100 1\\n0123456789'; exec /bin/sleep 30 ;;",
      // No header at all (a pending permission prompt looks like this).
      "  */silent.png) exec /bin/sleep 30 ;;",
      // A header, then no first byte.
      "  */header-only.png) printf 'O 10 1\\n'; exec /bin/sleep 30 ;;",
      "  */bad-token.png) printf 'X 1 2\\n'; exit 0 ;;",
      "  */bad-size.png) printf 'O abc 1\\n'; exit 0 ;;",
      "  */negative-size.png) printf 'O -5 1\\n'; exit 0 ;;",
      "  */short-header.png) printf 'O 5\\n'; exit 0 ;;",
      "  */long-header.png) printf '%5000s' x; exit 0 ;;",
      "  */no-answer.png) printf 'helper broke\\n' >&2; exit 3 ;;",
      "  */mute.png) exit 0 ;;",
      "  */stat-odd.png) printf 'E\\nstat: something odd happened\\n'; exit 0 ;;",
      "  */stat-blank.png) printf 'E\\n'; exit 0 ;;",
      "  */stat-denied.png) printf 'E\\nstat: x: Operation not permitted\\n'; exit 0 ;;",
      "  */cat-denied.png) printf 'O 10 1\\n'; printf 'cat: x: Operation not permitted\\n' >&2; exit 1 ;;",
      "  */cat-vanished.png) printf 'O 10 1\\n'; exit 0 ;;",
      "esac",
      'exec "$@"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  chmodSync(scriptedBin, 0o755);
});

afterAll(() => {
  restore();
  chmodSync(path.join(root, "locked.png"), 0o600);
  chmodSync(path.join(root, "sealed"), 0o755);
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

    test("a file in a folder that can't be searched is denied, with or without followSymlinks", async () => {
      setup();
      if (process.getuid?.() === 0) return;
      for (const followSymlinks of [true, false]) {
        const r = await openFileBytes(p("sealed/x.png"), { followSymlinks });
        expect(r.kind).toBe("denied");
        if (r.kind === "denied") expect(r.message).toMatch(/permission denied|operation not permitted/i);
      }
    });

    test("the unreadable file reads as denied through readFileBytes too (never ok)", async () => {
      setup();
      if (process.getuid?.() === 0) return;
      const r = await readFileBytes(p("locked.png"), { followSymlinks: false, maxBytes: 100 });
      expect(r.kind).toBe("denied");
    });

    test("an invalid maxBytes is an error before anything is opened", async () => {
      setup();
      for (const maxBytes of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
        const r = await openFileBytes(p("a.png"), { followSymlinks: true, maxBytes });
        expect(r.kind).toBe("error");
      }
      expect(spawned()).toBe(false);
    });

    test("an empty path or one with a NUL byte is missing, without spawning", async () => {
      setup();
      expect((await openFileBytes("", { followSymlinks: true })).kind).toBe("missing");
      expect((await openFileBytes(`${p("a.png")}\0.png`, { followSymlinks: true })).kind).toBe("missing");
      expect(spawned()).toBe(false);
    });

    test("maxBytes equal to the size reads the file; one byte less refuses it", async () => {
      setup();
      const r = await readFileBytes(p("a.png"), { followSymlinks: false, maxBytes: 4 });
      expect(r.kind).toBe("ok");
      expect(await openFileBytes(p("a.png"), { followSymlinks: false, maxBytes: 3 })).toEqual({
        kind: "too-large",
        size: 4,
      });
    });

    test("a size-matching etag from another file's stamp is not a match", async () => {
      setup();
      const first = await openFileBytes(p("a.png"), { followSymlinks: true });
      if (first.kind !== "ok") throw new Error(first.kind);
      // Same size, different mtime part.
      const r = await openFileBytes(p("a.png"), { followSymlinks: true, ifNoneMatch: '"4-0"' });
      expect(r.kind).toBe("ok");
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

// ---------------------------------------------------------------------------
// disclaimed child: short reads, stalls and kills (scripted helper)
// ---------------------------------------------------------------------------

/** Wait (bounded) until `pid` no longer exists. Bun reaps a killed child on its
 *  own, so a SIGKILLed one disappears within milliseconds. */
async function waitGone(pid: number, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ESRCH") return true;
    }
    if (Date.now() > end) return false;
    await Bun.sleep(20);
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const lastPid = (): number => Number(readFileSync(scriptedPid, "utf8").trim());

/** Drain a stream, returning what arrived and the error it ended with, if any. */
async function drain(body: ReadableStream<Uint8Array> | Blob | Uint8Array): Promise<{ bytes: Uint8Array; error: Error | null }> {
  if (!(body instanceof ReadableStream)) throw new Error("expected a streamed body");
  const reader = body.getReader();
  const parts: number[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(...value);
    }
  } catch (err) {
    return { bytes: Uint8Array.from(parts), error: err as Error };
  }
  return { bytes: Uint8Array.from(parts), error: null };
}

describe("openFileBytes (disclaimed, scripted helper)", () => {
  const p = (name: string) => path.join(root, name);
  const useScripted = () => {
    process.env.AGETOR_DISCLAIM_BIN = scriptedBin;
    setDisclaimSwitch(true);
    writeFileSync(scriptedPid, "");
  };
  // A test that fails before its kill path ran must not leave a `sleep 30`
  // helper behind for the rest of the run.
  afterEach(() => {
    try {
      const pid = lastPid();
      if (pid > 0 && alive(pid)) process.kill(pid, "SIGKILL");
    } catch {
      // no pid recorded yet, or already gone
    }
  });

  test("the scripted helper still runs the real script for any other file", async () => {
    useScripted();
    const r = await readFileBytes(p("a.png"), { followSymlinks: true, maxBytes: 100 });
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect([...r.bytes]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(lastPid()).toBeGreaterThan(0);
  });

  test("a body that ends before its size errors instead of closing", async () => {
    useScripted();
    const r = await openFileBytes(p("short.png"), { followSymlinks: true });
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.size).toBe(100);
    const { bytes, error } = await drain(r.body);
    expect(new TextDecoder().decode(bytes)).toBe("0123456789");
    expect(error?.message).toBe("file ended after 10 of 100 bytes");
  });

  test("settleFileBytes turns a short streamed body into an error before any response", async () => {
    useScripted();
    const r = await openFileBytes(p("short.png"), { followSymlinks: true });
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(await settleFileBytes(r)).toEqual({ kind: "error", message: "file ended after 10 of 100 bytes" });
  });

  test("settleFileBytes collects a whole streamed body into bytes", async () => {
    useScripted();
    const r = await openFileBytes(p("a.png"), { followSymlinks: true });
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.body).toBeInstanceOf(ReadableStream);
    const settled = await settleFileBytes(r);
    expect(settled.kind).toBe("ok");
    if (settled.kind !== "ok") return;
    expect(settled.body).toBeInstanceOf(Uint8Array);
    expect([...(settled.body as Uint8Array)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(settled.etag).toBe(r.etag);
  });

  test("readFileBytes turns a short body into an error, never a short ok", async () => {
    useScripted();
    const r = await readFileBytes(p("short.png"), { followSymlinks: true, maxBytes: 1000 });
    expect(r).toEqual({ kind: "error", message: "file ended after 10 of 100 bytes" });
  });

  test("a body is cut at the header's size, closes without waiting for EOF, and the child is killed", async () => {
    useScripted();
    const r = await openFileBytes(p("grew.png"), { followSymlinks: true });
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    const pid = lastPid();
    const started = Date.now();
    const { bytes, error } = await drain(r.body);
    expect(error).toBeNull();
    expect(new TextDecoder().decode(bytes)).toBe("abcd");
    // The child sleeps for 30 s; closing must not wait for it.
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(await waitGone(pid)).toBe(true);
  });

  test("cancelling the body kills the child", async () => {
    useScripted();
    const r = await openFileBytes(p("stall-body.png"), { followSymlinks: true });
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok" || !(r.body instanceof ReadableStream)) throw new Error("expected a stream");
    const pid = lastPid();
    expect(alive(pid)).toBe(true);
    await r.body.cancel();
    // The production body budget is 60 s, so only the cancel can have killed it.
    expect(await waitGone(pid)).toBe(true);
  });

  test("aborting settleFileBytes (a dropped request) kills the child and answers error", async () => {
    useScripted();
    const r = await openFileBytes(p("stall-body.png"), { followSymlinks: true });
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    const pid = lastPid();
    expect(alive(pid)).toBe(true);
    const ac = new AbortController();
    const settled = settleFileBytes(r, ac.signal);
    ac.abort();
    expect(await settled).toEqual({ kind: "error", message: "request aborted" });
    // The production body budget is 60 s, so only the abort can have killed it.
    expect(await waitGone(pid)).toBe(true);
  });

  test("settleFileBytes with an already-aborted signal never waits on the child", async () => {
    useScripted();
    const r = await openFileBytes(p("stall-body.png"), { followSymlinks: true });
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    const pid = lastPid();
    const ac = new AbortController();
    ac.abort();
    expect(await settleFileBytes(r, ac.signal)).toEqual({ kind: "error", message: "request aborted" });
    expect(await waitGone(pid)).toBe(true);
  });

  test("a body that stalls is killed at the body budget and errors short", async () => {
    useScripted();
    __forTest.setBodyTimeoutMs(300);
    const r = await openFileBytes(p("stall-body.png"), { followSymlinks: true });
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    const pid = lastPid();
    const { bytes, error } = await drain(r.body);
    expect(bytes.length).toBe(10);
    expect(error?.message).toBe("file ended after 10 of 100 bytes");
    expect(await waitGone(pid)).toBe(true);
  });

  test("no header within the open budget: a timeout error, and the child is killed", async () => {
    useScripted();
    __forTest.setOpenTimeoutMs(300);
    const started = Date.now();
    const r = await openFileBytes(p("silent.png"), { followSymlinks: true });
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.message).toMatch(/^timed out after 0\.3 s/);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await waitGone(lastPid())).toBe(true);
  });

  test("a header but no first byte within the open budget: a timeout error, not a 200 that hangs", async () => {
    useScripted();
    __forTest.setOpenTimeoutMs(300);
    const r = await openFileBytes(p("header-only.png"), { followSymlinks: true });
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.message).toMatch(/^timed out after 0\.3 s/);
    expect(await waitGone(lastPid())).toBe(true);
  });

  test("a fast child is answered without waiting for the open budget", async () => {
    useScripted();
    // A 10 s budget that must not be what ends these calls.
    const started = Date.now();
    expect((await openFileBytes(p("mute.png"), { followSymlinks: true })).kind).toBe("error");
    expect((await openFileBytes(p("short.png"), { followSymlinks: true })).kind).toBe("ok");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("helper output that isn't a valid header is an error", async () => {
    useScripted();
    for (const name of ["bad-token.png", "bad-size.png", "negative-size.png", "short-header.png", "long-header.png"]) {
      expect(await openFileBytes(p(name), { followSymlinks: true })).toEqual({
        kind: "error",
        message: "unexpected helper output",
      });
    }
  });

  test("a helper that exits without a header reports its stderr, or a fixed message", async () => {
    useScripted();
    expect(await openFileBytes(p("no-answer.png"), { followSymlinks: true })).toEqual({
      kind: "error",
      message: "helper broke",
    });
    expect(await openFileBytes(p("mute.png"), { followSymlinks: true })).toEqual({
      kind: "error",
      message: "helper produced no answer",
    });
  });

  test("a stat failure is denied only for a permission message", async () => {
    useScripted();
    expect(await openFileBytes(p("stat-denied.png"), { followSymlinks: true })).toEqual({
      kind: "denied",
      message: "stat: x: Operation not permitted",
    });
    expect(await openFileBytes(p("stat-odd.png"), { followSymlinks: true })).toEqual({
      kind: "error",
      message: "stat: something odd happened",
    });
    expect(await openFileBytes(p("stat-blank.png"), { followSymlinks: true })).toEqual({
      kind: "error",
      message: "stat failed",
    });
  });

  test("cat refusing after stat answered is denied before any byte; an empty pipe is an error", async () => {
    useScripted();
    expect(await openFileBytes(p("cat-denied.png"), { followSymlinks: true })).toEqual({
      kind: "denied",
      message: "cat: x: Operation not permitted",
    });
    expect(await openFileBytes(p("cat-vanished.png"), { followSymlinks: true })).toEqual({
      kind: "error",
      message: "file ended before its size",
    });
  });
});
