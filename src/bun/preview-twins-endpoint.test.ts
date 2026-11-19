// Endpoint tests for the preview twins (docs/plans/picked-image-preview-tcc.md,
// U3): twins are written by exactly the three user gestures and nothing else,
// and `/files/preview` falls back to one only when the original is denied.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MAX_FILE_PREVIEW_BYTES } from "../shared/attachments.ts";
import { rmTestDataDir } from "./test-data-dir.ts";
import { makeTestNative } from "./test-native.ts";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-preview-twins-endpoint-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_API_PORT = "4469";
const PORT = 4469;
delete process.env.AGETOR_FAKE_PICK_REFS_DIR;

const SCRATCH = mkdtempSync(path.join(tmpdir(), "agetor-preview-twins-scratch-"));
const PNG_A = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xa1]);
const PNG_B = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xb2]);
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

let n = 0;
/** A unique file under SCRATCH (twins are keyed by path). */
function file(name: string, content: Buffer | string = PNG_A): string {
  const p = path.join(SCRATCH, `${++n}-${name}`);
  writeFileSync(p, content);
  return p;
}

let answer: string[] = [];
let server: { stop: () => void };
let token: string;
let cliToken: string;
let dataDir: string;
let twinPath: (p: string) => string | null;
let writePreviewTwin: (dataDir: string, p: string) => Promise<unknown>;
let setDragReader: (fn: (() => string[]) | null) => void;
let sweepIdle: (() => Promise<void>) | undefined;

beforeAll(async () => {
  ({ dataDir } = await import("./db.ts"));
  const { startApiServer, API_TOKEN } = await import("./server.ts");
  const { CLI_TOKEN } = await import("./api-config.ts");
  const twins = await import("./preview-twins.ts");
  twinPath = (p) => twins.previewTwinPath(dataDir, p);
  writePreviewTwin = twins.writePreviewTwin;
  sweepIdle = () => twins.__forTest.idle();
  ({ setDragPasteboardReaderForTests: setDragReader } = await import("./drag-pasteboard.ts"));
  const native = makeTestNative({ openFileDialog: async () => answer });
  server = startApiServer({ native }) as unknown as { stop: () => void };
  token = API_TOKEN;
  cliToken = CLI_TOKEN;
});

afterAll(async () => {
  server?.stop?.();
  await sweepIdle?.();
  rmSync(SCRATCH, { recursive: true, force: true });
  rmTestDataDir(DATA_DIR);
});

afterEach(() => {
  setDragReader(null);
  answer = [];
});

const post = (route: string, body: unknown, bearer?: string) =>
  fetch(`http://127.0.0.1:${PORT}${route}`, {
    method: "POST",
    headers: { authorization: `Bearer ${bearer ?? token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const preview = (p: string, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${PORT}/files/preview?path=${encodeURIComponent(p)}`, {
    headers: { authorization: `Bearer ${token}`, ...headers },
  });

const hasTwin = (p: string) => {
  const t = twinPath(p);
  return t !== null && existsSync(t);
};

describe("/refs/pick writes a twin of each picked image", () => {
  test("native panel: an image gets a twin; a .txt does not", async () => {
    const png = file("pick.png");
    const txt = file("pick.txt", "hi");
    answer = [png, txt];
    const res = await post("/refs/pick", { mode: "files" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { refs: unknown[] }).refs).toHaveLength(2);
    expect(hasTwin(png)).toBe(true);
    expect(readFileSync(twinPath(png)!).equals(PNG_A)).toBe(true);
    expect(twinPath(txt)).toBeNull();
  });

  test("native panel, folder mode: no twins", async () => {
    const dir = path.join(SCRATCH, `folder-${++n}`);
    mkdirSync(dir);
    const inside = path.join(dir, "inside.png");
    writeFileSync(inside, PNG_A);
    answer = [dir];
    const res = await post("/refs/pick", { mode: "folder" });
    expect(res.status).toBe(200);
    expect(hasTwin(inside)).toBe(false);
  });

  test("native panel, folder mode: even a file the panel hands back is not twinned", async () => {
    // Only a files-mode pick twins (the guard in the native branch); a folder
    // pick never reads file bytes, whatever the panel answers.
    const png = file("folder-mode-file.png");
    answer = [png];
    const res = await post("/refs/pick", { mode: "folder" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { refs: unknown[] }).refs).toHaveLength(1);
    expect(hasTwin(png)).toBe(false);
  });

  test("native panel: every image of a multi-file pick gets its own twin", async () => {
    const a = file("multi-a.png", PNG_A);
    const b = file("multi-b.webp", PNG_B);
    const c = file("multi-c.heic", PNG_A);
    answer = [a, b, c];
    const res = await post("/refs/pick", { mode: "files" });
    expect(((await res.json()) as { refs: unknown[] }).refs).toHaveLength(3);
    expect(readFileSync(twinPath(a)!).equals(PNG_A)).toBe(true);
    expect(readFileSync(twinPath(b)!).equals(PNG_B)).toBe(true);
    expect(readFileSync(twinPath(c)!).equals(PNG_A)).toBe(true);
  });

  test("native panel cancelled: an empty answer, no error", async () => {
    answer = [];
    const res = await post("/refs/pick", { mode: "files" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { refs: unknown[] }).refs).toEqual([]);
  });

  test("the CLI token cannot pick (desktop-only), so it never writes a twin", async () => {
    const png = file("pick-cli.png");
    answer = [png];
    const res = await post("/refs/pick", { mode: "files" }, cliToken);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code?: string }).code).toBe("desktop-only");
    expect(hasTwin(png)).toBe(false);
  });

  test.skipIf(isRoot)("a picked image is served from its twin once the original becomes unreadable (pick → block → preview)", async () => {
    const png = file("assembled.png", PNG_B);
    answer = [png];
    expect((await post("/refs/pick", { mode: "files" })).status).toBe(200);
    chmodSync(png, 0o000);
    try {
      const res = await preview(png);
      expect(res.status).toBe(200);
      expect(Buffer.from(await res.arrayBuffer()).equals(PNG_B)).toBe(true);
    } finally {
      chmodSync(png, 0o600);
    }
  });

  test("native panel: a symlinked png gets no twin", async () => {
    const real = file("real-target.png");
    const link = path.join(SCRATCH, `${++n}-link.png`);
    symlinkSync(real, link);
    answer = [link];
    const res = await post("/refs/pick", { mode: "files" });
    expect(((await res.json()) as { refs: unknown[] }).refs).toHaveLength(1);
    expect(hasTwin(link)).toBe(false);
  });

  test("fake-dir seam branch writes twins too", async () => {
    const fakeDir = path.join(SCRATCH, `fake-${++n}`);
    mkdirSync(fakeDir);
    const png = path.join(fakeDir, "seam.png");
    writeFileSync(png, PNG_B);
    writeFileSync(path.join(fakeDir, "seam.txt"), "x");
    const saved = process.env.AGETOR_FAKE_PICK_REFS_DIR;
    process.env.AGETOR_FAKE_PICK_REFS_DIR = fakeDir;
    try {
      const res = await post("/refs/pick", { mode: "files" });
      expect(((await res.json()) as { refs: unknown[] }).refs).toHaveLength(2);
    } finally {
      if (saved === undefined) delete process.env.AGETOR_FAKE_PICK_REFS_DIR;
      else process.env.AGETOR_FAKE_PICK_REFS_DIR = saved;
    }
    expect(readFileSync(twinPath(png)!).equals(PNG_B)).toBe(true);
  });
});

describe("/refs/drag twins only non-uploadable images the drop vouches for", () => {
  test("a named .heic gets a twin; an unnamed one does not; a .png never does", async () => {
    const named = file("drag-named.heic");
    const unnamed = file("drag-unnamed.heic");
    const png = file("drag-upload.png");
    setDragReader(() => [named, unnamed, png]);
    const res = await post("/refs/drag", { names: [path.basename(named), path.basename(png)] });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { refs: unknown[] }).refs).toHaveLength(3);
    expect(hasTwin(named)).toBe(true);
    expect(hasTwin(unnamed)).toBe(false);
    expect(hasTwin(png)).toBe(false);
  });

  test("a body without names (an older webview) twins nothing", async () => {
    const heic = file("drag-nonames.heic");
    setDragReader(() => [heic]);
    const res = await post("/refs/drag", {});
    expect(res.status).toBe(200);
    expect(hasTwin(heic)).toBe(false);
  });

  test("a request with no body at all (the pre-twin webview) still answers the refs", async () => {
    const heic = file("drag-nobody.heic");
    setDragReader(() => [heic]);
    const res = await fetch(`http://127.0.0.1:${PORT}/refs/drag`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { refs: Array<{ path: string }> }).refs.map((r) => r.path)).toEqual([heic]);
    expect(hasTwin(heic)).toBe(false);
  });

  test("every non-uploadable image type is twinned when named; every uploadable one never is", async () => {
    const twinned = ["heic", "svg", "bmp", "ico", "avif", "HEIC"].map((ext) => file(`drag-kind.${ext}`));
    const uploaded = ["png", "jpg", "jpeg", "gif", "webp", "PNG"].map((ext) => file(`drag-kind.${ext}`));
    const all = [...twinned, ...uploaded];
    setDragReader(() => all);
    const res = await post("/refs/drag", { names: all.map((p) => path.basename(p)) });
    expect(((await res.json()) as { refs: unknown[] }).refs).toHaveLength(all.length);
    for (const p of twinned) expect({ p, twin: hasTwin(p) }).toEqual({ p, twin: true });
    for (const p of uploaded) expect({ p, twin: hasTwin(p) }).toEqual({ p, twin: false });
  });

  test("a directory or a symlink on the pasteboard is never twinned, even when named", async () => {
    const dir = path.join(SCRATCH, `${++n}-drag-dir.heic`);
    mkdirSync(dir);
    const target = file("drag-link-target.heic");
    const link = path.join(SCRATCH, `${++n}-drag-link.heic`);
    symlinkSync(target, link);
    setDragReader(() => [dir, link]);
    const res = await post("/refs/drag", { names: [path.basename(dir), path.basename(link)] });
    expect(((await res.json()) as { refs: unknown[] }).refs).toHaveLength(2);
    expect(hasTwin(dir)).toBe(false);
    expect(hasTwin(link)).toBe(false);
  });

  test("at most 256 names are honored: a name past the cap vouches for nothing", async () => {
    const within = file("drag-cap-within.heic");
    const beyond = file("drag-cap-beyond.heic");
    const fillers = Array.from({ length: 255 }, (_, i) => `filler-${i}.txt`);
    setDragReader(() => [within, beyond]);
    // Index 255 is the 256th name (honored); index 256 is the 257th (dropped).
    await post("/refs/drag", { names: [...fillers, path.basename(within), path.basename(beyond)] });
    expect(hasTwin(within)).toBe(true);
    expect(hasTwin(beyond)).toBe(false);
  });

  test("non-string names are ignored, not coerced", async () => {
    const heic = file("drag-nested.heic");
    setDragReader(() => [heic]);
    // `String(["x.heic"])` is "x.heic": a coercing reader would let a nested
    // array vouch for the file.
    await post("/refs/drag", { names: [[path.basename(heic)], 123, null] });
    expect(hasTwin(heic)).toBe(false);
  });

  test("the CLI token cannot drag (desktop-only), so it never writes a twin", async () => {
    const heic = file("drag-cli.heic");
    setDragReader(() => [heic]);
    const res = await post("/refs/drag", { names: [path.basename(heic)] }, cliToken);
    expect(res.status).toBe(403);
    expect(hasTwin(heic)).toBe(false);
  });
});

describe("/refs/resolve twins only for the app caller that asks for it", () => {
  test("the app token without the flag: no twin (SentFilesCard / handoff / @-scope callers)", async () => {
    const png = file("resolve-noflag.png");
    const res = await post("/refs/resolve", { paths: [png] });
    expect(((await res.json()) as { refs: unknown[] }).refs).toHaveLength(1);
    expect(hasTwin(png)).toBe(false);
  });

  test("the app token with previewTwins: true: a twin", async () => {
    const png = file("resolve-flag.png");
    const res = await post("/refs/resolve", { paths: [png], names: [path.basename(png)], previewTwins: true });
    expect(((await res.json()) as { refs: unknown[] }).refs).toHaveLength(1);
    expect(hasTwin(png)).toBe(true);
  });

  test("previewTwins without a vouching name: the stat answers, no twin (text drop of a file:// line)", async () => {
    const png = file("resolve-noname.png");
    const other = file("resolve-othername.png");
    for (const names of [undefined, [], ["unrelated.png"], [42, null], path.basename(png)]) {
      const res = await post("/refs/resolve", { paths: [png, other], names, previewTwins: true });
      expect(((await res.json()) as { refs: unknown[] }).refs).toHaveLength(2);
    }
    expect(hasTwin(png)).toBe(false);
    expect(hasTwin(other)).toBe(false);
  });

  test("only the path a name vouches for is twinned", async () => {
    const vouched = file("resolve-vouched.png");
    const stranger = file("resolve-stranger.png");
    await post("/refs/resolve", { paths: [vouched, stranger], names: [path.basename(vouched)], previewTwins: true });
    expect(hasTwin(vouched)).toBe(true);
    expect(hasTwin(stranger)).toBe(false);
  });

  test("only a literal true counts", async () => {
    const png = file("resolve-truthy.png");
    await post("/refs/resolve", { paths: [png], names: [path.basename(png)], previewTwins: "true" });
    await post("/refs/resolve", { paths: [png], names: [path.basename(png)], previewTwins: 1 });
    expect(hasTwin(png)).toBe(false);
  });

  test("a missing file and a directory resolve as before and get no twin", async () => {
    const gone = path.join(SCRATCH, `${++n}-resolve-gone.png`);
    const dir = path.join(SCRATCH, `${++n}-resolve-dir.png`);
    mkdirSync(dir);
    const res = await post("/refs/resolve", {
      paths: [gone, dir],
      names: [path.basename(gone), path.basename(dir)],
      previewTwins: true,
    });
    const { refs } = (await res.json()) as { refs: Array<{ path: string; isDirectory: boolean }> };
    expect(refs.map((r) => r.isDirectory)).toEqual([true]); // the missing path is dropped, as always
    expect(hasTwin(gone)).toBe(false);
    expect(hasTwin(dir)).toBe(false);
  });

  test("the response shape is unchanged by the flag (same refs with and without it)", async () => {
    const png = file("resolve-shape.png");
    const txt = file("resolve-shape.txt", "x");
    const plain = await (await post("/refs/resolve", { paths: [png, txt] })).json();
    const twinned = await (
      await post("/refs/resolve", { paths: [png, txt], names: [path.basename(png)], previewTwins: true })
    ).json();
    expect(twinned).toEqual(plain);
    expect(hasTwin(png)).toBe(true);
  });

  test("the CLI token with the flag still gets no twin (D17)", async () => {
    const png = file("resolve-cli.png");
    const res = await post("/refs/resolve", { paths: [png], names: [path.basename(png)], previewTwins: true }, cliToken);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { refs: unknown[] }).refs).toHaveLength(1);
    expect(hasTwin(png)).toBe(false);
  });
});

// The same answers with the original read in-process and through the disclaim
// helper (a passthrough stub stands in for it).
describe("/files/preview falls back to the twin only when the original is denied", () => {
  let stub: string;
  let savedBin: string | undefined;
  let savedSwitch = true;
  const locked: string[] = [];

  beforeAll(async () => {
    const { getDisclaimSwitch } = await import("./disclaim.ts");
    stub = path.join(SCRATCH, "passthrough-stub.sh");
    writeFileSync(stub, '#!/bin/sh\nexec "$@"\n', { mode: 0o755 });
    chmodSync(stub, 0o755);
    savedBin = process.env.AGETOR_DISCLAIM_BIN;
    savedSwitch = getDisclaimSwitch();
  });

  afterEach(async () => {
    const { setDisclaimSwitch } = await import("./disclaim.ts");
    if (savedBin === undefined) delete process.env.AGETOR_DISCLAIM_BIN;
    else process.env.AGETOR_DISCLAIM_BIN = savedBin;
    setDisclaimSwitch(savedSwitch);
  });

  afterAll(() => {
    for (const p of locked) {
      try {
        chmodSync(p, 0o600);
      } catch {
        /* already gone */
      }
    }
  });

  /** An image at a unique path, made unreadable (restored in afterAll). */
  function lockedImage(name: string, content: Buffer = PNG_A): string {
    const p = file(name, content);
    locked.push(p);
    chmodSync(p, 0o000);
    return p;
  }

  for (const on of [false, true]) {
    const mode = on ? "disclaimed" : "in-process";
    const enter = async () => {
      const { setDisclaimSwitch } = await import("./disclaim.ts");
      if (on) process.env.AGETOR_DISCLAIM_BIN = stub;
      setDisclaimSwitch(on);
    };

    test(`${mode}: a readable original wins over a different twin`, async () => {
      await enter();
      const orig = file("wins.png", PNG_A);
      const twin = twinPath(orig)!;
      mkdirSync(path.dirname(twin), { recursive: true });
      writeFileSync(twin, PNG_B);
      const res = await preview(orig);
      expect(res.status).toBe(200);
      expect(Buffer.from(await res.arrayBuffer()).equals(PNG_A)).toBe(true);
    });

    test.skipIf(isRoot)(`${mode}: a denied original with a twin answers 200 with the twin's bytes`, async () => {
      await enter();
      const orig = file("denied-twin.png", PNG_A);
      await writePreviewTwin(dataDir, orig); // the pick-time copy
      chmodSync(orig, 0o000);
      locked.push(orig);
      const res = await preview(orig);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
      expect(res.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
      expect(Buffer.from(await res.arrayBuffer()).equals(PNG_A)).toBe(true);
    });

    test.skipIf(isRoot)(`${mode}: a denied original without a twin is still 403`, async () => {
      await enter();
      const res = await preview(lockedImage("denied-notwin.png"));
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toContain("not readable");
    });

    test(`${mode}: a missing original with a twin is 404 (no fallback)`, async () => {
      await enter();
      const orig = file("gone-twin.png");
      await writePreviewTwin(dataDir, orig);
      rmSync(orig);
      expect((await preview(orig)).status).toBe(404);
    });

    test.skipIf(isRoot)(`${mode}: a twin that is a symlink is not followed (403)`, async () => {
      await enter();
      const readable = file("symlink-target.png", PNG_B);
      const orig = lockedImage("denied-linktwin.png", PNG_A);
      const twin = twinPath(orig)!;
      mkdirSync(path.dirname(twin), { recursive: true });
      symlinkSync(readable, twin);
      const res = await preview(orig);
      expect(res.status).toBe(403);
    });

    // Only an `ok` or `not-modified` twin replaces the denial. A twin that is
    // missing, not a regular file or too large keeps the ORIGINAL's 403: the
    // chip must not turn amber (404) or claim the file is too big (413)
    // because of the cache.
    test.skipIf(isRoot)(`${mode}: a twin that is a directory keeps the 403 (not a 404)`, async () => {
      await enter();
      const orig = lockedImage("denied-dirtwin.png");
      mkdirSync(twinPath(orig)!, { recursive: true });
      try {
        expect((await preview(orig)).status).toBe(403);
      } finally {
        rmSync(twinPath(orig)!, { recursive: true, force: true });
      }
    });

    test.skipIf(isRoot)(`${mode}: a twin over the preview cap keeps the 403 (not a 413)`, async () => {
      await enter();
      const orig = lockedImage("denied-bigtwin.png");
      const twin = twinPath(orig)!;
      mkdirSync(path.dirname(twin), { recursive: true });
      writeFileSync(twin, "");
      truncateSync(twin, MAX_FILE_PREVIEW_BYTES + 1);
      try {
        expect((await preview(orig)).status).toBe(403);
      } finally {
        rmSync(twin, { force: true });
      }
    });

    test.skipIf(isRoot)(`${mode}: the twin is keyed by the exact path (a U+202F/space twin is not used)`, async () => {
      await enter();
      // The denied original has a narrow no-break space; the only twin on disk
      // belongs to the same name with a plain space.
      const spaced = file("Screenshot 2.40.41 PM.png", PNG_B);
      const narrow = path.join(path.dirname(spaced), path.basename(spaced).replace(" PM", " PM"));
      writeFileSync(narrow, PNG_A);
      locked.push(narrow);
      await writePreviewTwin(dataDir, spaced);
      chmodSync(narrow, 0o000);
      expect(hasTwin(spaced)).toBe(true);
      expect(hasTwin(narrow)).toBe(false);
      expect((await preview(narrow)).status).toBe(403);
    });

    test.skipIf(isRoot)(`${mode}: the twin is served with the requested path's content type, not one sniffed from its bytes`, async () => {
      await enter();
      // PNG bytes under an uppercase `.WEBP` name: the type comes from the
      // path the chip asked for, as it does for a readable original.
      const orig = file("upper.WEBP", PNG_A);
      await writePreviewTwin(dataDir, orig);
      chmodSync(orig, 0o000);
      locked.push(orig);
      const res = await preview(orig);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/webp");
    });

    test.skipIf(isRoot)(`${mode}: If-None-Match with the twin's ETag is 304`, async () => {
      await enter();
      const orig = file("etag-twin.png", PNG_A);
      await writePreviewTwin(dataDir, orig);
      chmodSync(orig, 0o000);
      locked.push(orig);
      const first = await preview(orig);
      expect(first.status).toBe(200);
      const etag = first.headers.get("etag");
      expect(etag).toBeTruthy();
      const again = await preview(orig, { "if-none-match": etag as string });
      expect(again.status).toBe(304);
      expect((await again.arrayBuffer()).byteLength).toBe(0);
    });
  }
});
