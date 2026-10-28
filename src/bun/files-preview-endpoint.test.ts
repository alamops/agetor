import { test, expect, beforeAll, afterAll, afterEach, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-files-preview-endpoint-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
// Unique port, distinct from every other *.test.ts file's AGETOR_API_PORT.
process.env.AGETOR_API_PORT = "4441";

// A scratch tree with fixtures: a real (tiny) PNG, a directory whose name
// happens to end in ".png" (must still 404, not be treated as a file), and a
// non-image file.
const SCRATCH = mkdtempSync(path.join(tmpdir(), "agetor-files-preview-scratch-"));
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_FILE = path.join(SCRATCH, "shot.png");
writeFileSync(PNG_FILE, PNG_MAGIC);
const DIR_PNG = path.join(SCRATCH, "dir.png");
mkdirSync(DIR_PNG);
const TXT_FILE = path.join(SCRATCH, "note.txt");
writeFileSync(TXT_FILE, "hello");
const UPPER_PNG_FILE = path.join(SCRATCH, "shout.PNG");
writeFileSync(UPPER_PNG_FILE, PNG_MAGIC);

let server: { stop: () => void };
let token: string;

beforeAll(async () => {
  await import("./db.ts");
  const { startApiServer } = await import("./server.ts");
  const { API_TOKEN } = await import("./api-config.ts");
  server = startApiServer() as unknown as { stop: () => void };
  token = API_TOKEN;
});

afterAll(() => {
  server?.stop?.();
});

const previewUrl = (p: string) =>
  `http://127.0.0.1:4441/files/preview?path=${encodeURIComponent(p)}`;

const previewWithHeader = (p: string) =>
  fetch(previewUrl(p), { headers: { authorization: `Bearer ${token}` } });

const previewWithQueryToken = (p: string) =>
  fetch(`${previewUrl(p)}&token=${token}`);

test("/files/preview requires a token", async () => {
  const res = await fetch(previewUrl(PNG_FILE));
  expect(res.status).toBe(401);
});

test("/files/preview accepts an Authorization: Bearer header", async () => {
  const res = await previewWithHeader(PNG_FILE);
  expect(res.status).toBe(200);
});

test("/files/preview refuses a ?token= query param (D13: the webview fetches a blob with a header)", async () => {
  const res = await previewWithQueryToken(PNG_FILE);
  expect(res.status).toBe(401);
});

test("/files/preview 400s when path is missing", async () => {
  const res = await fetch(`http://127.0.0.1:4441/files/preview?path=`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(400);
});

test("/files/preview 400s on a relative path", async () => {
  const res = await previewWithHeader("shot.png");
  expect(res.status).toBe(400);
});

test("/files/preview 400s on a non-image extension", async () => {
  const res = await previewWithHeader(TXT_FILE);
  expect(res.status).toBe(400);
});

test("/files/preview 404s for a nonexistent .png path", async () => {
  const res = await previewWithHeader(path.join(SCRATCH, "gone.png"));
  expect(res.status).toBe(404);
});

test("/files/preview 404s for a directory named like an image (dir.png)", async () => {
  const res = await previewWithHeader(DIR_PNG);
  expect(res.status).toBe(404);
});

test("/files/preview 200s with matching bytes, content-type, and cache headers", async () => {
  const res = await previewWithHeader(PNG_FILE);
  expect(res.status).toBe(200);
  const bytes = new Uint8Array(await res.arrayBuffer());
  expect(bytes).toEqual(new Uint8Array(PNG_MAGIC));
  expect(res.headers.get("content-type")).toBe("image/png");
  expect(res.headers.get("cache-control") ?? "").toContain("must-revalidate");
  expect(res.headers.get("etag")).toBeTruthy();
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
});

test("/files/preview sends the sandbox CSP header on the byte response", async () => {
  const res = await previewWithHeader(PNG_FILE);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
});

test("/files/preview 404 does not carry the sandbox CSP header (only the byte response does)", async () => {
  const res = await previewWithHeader(path.join(SCRATCH, "gone.png"));
  expect(res.status).toBe(404);
  expect(res.headers.get("content-security-policy")).toBeNull();
});

test("/files/preview 304s on a matching If-None-Match with an empty body", async () => {
  const first = await previewWithHeader(PNG_FILE);
  const etag = first.headers.get("etag");
  expect(etag).toBeTruthy();

  const second = await fetch(previewUrl(PNG_FILE), {
    headers: {
      authorization: `Bearer ${token}`,
      "if-none-match": etag as string,
    },
  });
  expect(second.status).toBe(304);
  const body = await second.arrayBuffer();
  expect(body.byteLength).toBe(0);
});

test("/files/preview is case-insensitive on the extension (.PNG)", async () => {
  const res = await previewWithHeader(UPPER_PNG_FILE);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("image/png");
});

// D26(j): while disclaiming, the bytes come from a disclaimed child (a
// recording passthrough stub stands in for the helper), never the core's own
// process — same answers as in-process.
test("/files/preview reads through the disclaim helper while the switch is on", async () => {
  const { chmodSync, readFileSync } = await import("node:fs");
  const { getDisclaimSwitch, setDisclaimSwitch } = await import("./disclaim.ts");
  const stub = path.join(SCRATCH, "disclaim-stub.sh");
  const log = path.join(SCRATCH, "disclaim-stub.log");
  writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$1" >> '${log}'\nexec "$@"\n`, { mode: 0o755 });
  chmodSync(stub, 0o755);
  writeFileSync(log, "");
  const savedBin = process.env.AGETOR_DISCLAIM_BIN;
  const savedSwitch = getDisclaimSwitch();
  process.env.AGETOR_DISCLAIM_BIN = stub;
  setDisclaimSwitch(true);
  try {
    const res = await previewWithHeader(PNG_FILE);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array(PNG_MAGIC));
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
    expect(readFileSync(log, "utf8")).toContain("/bin/sh");

    const etag = res.headers.get("etag") as string;
    expect(etag).toBeTruthy();
    const again = await fetch(previewUrl(PNG_FILE), {
      headers: { authorization: `Bearer ${token}`, "if-none-match": etag },
    });
    expect(again.status).toBe(304);

    expect((await previewWithHeader(path.join(SCRATCH, "gone.png"))).status).toBe(404);
    expect((await previewWithHeader(DIR_PNG)).status).toBe(404);
  } finally {
    if (savedBin === undefined) delete process.env.AGETOR_DISCLAIM_BIN;
    else process.env.AGETOR_DISCLAIM_BIN = savedBin;
    setDisclaimSwitch(savedSwitch);
  }
});

// D26(j), both disclaim modes: a file the core can't read answers 403 before
// any 200 (never a 200 whose body dies), and a FIFO named like an image is a
// 404 at once (never a response that hangs on a pipe nobody writes).
describe("/files/preview answers the same in both disclaim modes", () => {
  const LOCKED_PNG = path.join(SCRATCH, "locked.png");
  const FIFO_PNG = path.join(SCRATCH, "fifo.png");
  const LINK_PNG = path.join(SCRATCH, "link.png");
  let stub: string;
  let savedBin: string | undefined;
  let savedSwitch = true;

  beforeAll(async () => {
    const { chmodSync, symlinkSync } = await import("node:fs");
    const { getDisclaimSwitch } = await import("./disclaim.ts");
    writeFileSync(LOCKED_PNG, PNG_MAGIC);
    chmodSync(LOCKED_PNG, 0o000);
    expect(Bun.spawnSync(["/usr/bin/mkfifo", FIFO_PNG]).exitCode).toBe(0);
    symlinkSync(PNG_FILE, LINK_PNG);
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

  afterAll(async () => {
    const { chmodSync } = await import("node:fs");
    chmodSync(LOCKED_PNG, 0o600);
  });

  for (const on of [false, true]) {
    const mode = on ? "disclaimed" : "in-process";
    const enter = async () => {
      const { setDisclaimSwitch } = await import("./disclaim.ts");
      if (on) process.env.AGETOR_DISCLAIM_BIN = stub;
      setDisclaimSwitch(on);
    };

    test(`${mode}: an unreadable image is 403 with no image body`, async () => {
      if (process.getuid?.() === 0) return; // root reads mode-000 files
      await enter();
      const res = await previewWithHeader(LOCKED_PNG);
      expect(res.status).toBe(403);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(((await res.json()) as { error: string }).error).toContain("not readable");
    });

    test(`${mode}: a FIFO named like an image is 404 at once`, async () => {
      await enter();
      const started = Date.now();
      const res = await previewWithHeader(FIFO_PNG);
      expect(res.status).toBe(404);
      expect(Date.now() - started).toBeLessThan(5_000);
    });

    test(`${mode}: a symlinked image is followed (markdown refs may go through links)`, async () => {
      await enter();
      const res = await previewWithHeader(LINK_PNG);
      expect(res.status).toBe(200);
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array(PNG_MAGIC));
    });
  }

  // D26(j) says "a short read errors the stream" so a truncated image never
  // reads as whole. That has to hold where the webview sees it — the HTTP
  // response — not just inside the core: either no 200 at all, or a 200 whose
  // body fails. (Bun ends a chunked response cleanly when its stream errors,
  // and ignores an explicit content-length on a stream body.)
  test("disclaimed: a body that ends before its size never reaches the client as a whole 200", async () => {
    const { chmodSync } = await import("node:fs");
    const short = path.join(SCRATCH, "short-stub.sh");
    writeFileSync(short, "#!/bin/sh\nprintf 'O 100 1\\n0123456789'\nexit 0\n", { mode: 0o755 });
    chmodSync(short, 0o755);
    const { setDisclaimSwitch } = await import("./disclaim.ts");
    process.env.AGETOR_DISCLAIM_BIN = short;
    setDisclaimSwitch(true);
    const res = await previewWithHeader(PNG_FILE);
    let outcome: string;
    if (res.status !== 200) {
      outcome = "refused";
    } else {
      try {
        outcome = `whole 200 with ${(await res.arrayBuffer()).byteLength} of 100 bytes`;
      } catch {
        outcome = "failed";
      }
    }
    expect(outcome).toMatch(/^(refused|failed)$/);
  });

  test("disclaimed: an image over the preview cap is 413 before any byte is read", async () => {
    const { chmodSync } = await import("node:fs");
    const { MAX_FILE_PREVIEW_BYTES } = await import("../shared/attachments.ts");
    const big = path.join(SCRATCH, "big-stub.sh");
    // The real script answers `L <size>` only when $4 (the limit) is set and
    // exceeded; this stub records $8 — the limit as the helper received it —
    // and answers as an over-limit stat would.
    const seen = path.join(SCRATCH, "big-stub.limit");
    writeFileSync(big, `#!/bin/sh\nprintf '%s' "$8" > '${seen}'\nprintf 'L ${MAX_FILE_PREVIEW_BYTES + 1}\\n'\n`, {
      mode: 0o755,
    });
    chmodSync(big, 0o755);
    const { setDisclaimSwitch } = await import("./disclaim.ts");
    process.env.AGETOR_DISCLAIM_BIN = big;
    setDisclaimSwitch(true);
    const res = await previewWithHeader(PNG_FILE);
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toContain(`exceeds ${MAX_FILE_PREVIEW_BYTES} bytes`);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(seen, "utf8")).toBe(String(MAX_FILE_PREVIEW_BYTES));
  });
});
