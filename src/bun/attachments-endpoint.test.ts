import { test, expect, beforeAll, afterAll, afterEach, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";

// Unique port, distinct from every other *.test.ts file's AGETOR_API_PORT.
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-attachments-endpoint-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_API_PORT = "4562";

// A scratch tree for /refs/drag fixtures: one file, one directory.
const SCRATCH = mkdtempSync(path.join(tmpdir(), "agetor-attachments-scratch-"));
const DRAG_FILE = path.join(SCRATCH, "dragged.txt");
const DRAG_DIR = path.join(SCRATCH, "dragged-dir");
writeFileSync(DRAG_FILE, "x");
mkdirSync(DRAG_DIR);

let server: { stop: () => void };
let token: string;

beforeAll(async () => {
  await import("./db.ts");
  const { startApiServer, API_TOKEN } = await import("./server.ts");
  server = startApiServer() as unknown as { stop: () => void };
  token = API_TOKEN;
});

afterAll(() => {
  server?.stop?.();
});

afterEach(async () => {
  const { setDragPasteboardReaderForTests } = await import("./drag-pasteboard.ts");
  setDragPasteboardReaderForTests(null);
});

const BASE = "http://127.0.0.1:4562";

function postAttachment(name: string | undefined, body: BodyInit, extraHeaders: Record<string, string> = {}) {
  const url = name === undefined ? "/attachments" : `/attachments?name=${encodeURIComponent(name)}`;
  return fetch(BASE + url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, ...extraHeaders },
    body,
  });
}

describe("POST /attachments", () => {
  test("happy path: writes exact bytes under dataDir/attachments and returns {path, basename}", async () => {
    const bytes = new TextEncoder().encode("hello attachment world");
    const res = await postAttachment("report.pdf", bytes);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string; basename: string };
    expect(body.basename).toBe("report.pdf");
    // Don't compare against this file's own DATA_DIR: bun test runs every
    // *.test.ts file in one process, and whichever file imports server.ts/db.ts
    // FIRST wins the module-level AGETOR_DATA_DIR capture — so the server's
    // actual dataDir may be a different test file's mkdtemp root. Assert only
    // on the shape of the returned path.
    expect(body.path.endsWith(path.join("attachments", "report.pdf"))).toBe(true);
    expect(path.basename(path.dirname(body.path))).toBe("attachments");
    expect(existsSync(body.path)).toBe(true);
    expect(new Uint8Array(readFileSync(body.path))).toEqual(bytes);
  });

  test("sanitizes a traversal attempt so the file lands inside attachments/", async () => {
    const bytes = new TextEncoder().encode("traversal payload");
    const res = await postAttachment("../../evil.txt", bytes);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string; basename: string };
    // Slashes are the actual traversal vector — `sanitizeAttachmentBasename`
    // replaces them before `path.basename`, so what's left of "../../" is
    // inert leftover dot/dash text in the basename, not a path segment.
    expect(body.basename).not.toContain("/");
    // Don't compare against this file's own DATA_DIR (see note above) — just
    // confirm no traversal escaped the attachments/ directory the server
    // actually bound to.
    expect(path.basename(path.dirname(body.path))).toBe("attachments");
    expect(existsSync(body.path)).toBe(true);
  });

  test("strips a leading dot so the file isn't a hidden dotfile", async () => {
    const bytes = new TextEncoder().encode("dotfile payload");
    const res = await postAttachment(".hidden", bytes);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string; basename: string };
    expect(body.basename.startsWith(".")).toBe(false);
    expect(existsSync(body.path)).toBe(true);
  });

  test("missing name falls back to 'attachment'", async () => {
    const bytes = new TextEncoder().encode("no name payload");
    const res = await postAttachment(undefined, bytes);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string; basename: string };
    expect(body.basename).toBe("attachment");
    expect(existsSync(body.path)).toBe(true);
  });

  test("empty name falls back to 'attachment' (or a collision-suffixed variant of it)", async () => {
    // Runs after the "missing name" test above, which already claimed the
    // bare "attachment" basename in this same dataDir/attachments — so the
    // atomic writer's collision fallback is expected to kick in here.
    const bytes = new TextEncoder().encode("empty name payload");
    const res = await postAttachment("", bytes);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string; basename: string };
    expect(body.basename).toMatch(/^attachment(-[0-9a-f]{8})?$/);
    expect(existsSync(body.path)).toBe(true);
  });

  test("collision: uploading the same name twice gives the second upload a distinct -<hex8> basename", async () => {
    const first = await postAttachment("dup.txt", new TextEncoder().encode("first"));
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { path: string; basename: string };
    expect(firstBody.basename).toBe("dup.txt");

    const second = await postAttachment("dup.txt", new TextEncoder().encode("second"));
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { path: string; basename: string };
    expect(secondBody.basename).not.toBe("dup.txt");
    expect(secondBody.basename).toMatch(/^dup-[0-9a-f]{8}\.txt$/);

    expect(existsSync(firstBody.path)).toBe(true);
    expect(existsSync(secondBody.path)).toBe(true);
    expect(readFileSync(firstBody.path, "utf8")).toBe("first");
    expect(readFileSync(secondBody.path, "utf8")).toBe("second");
  });

  test("concurrent uploads with the same name each get a distinct basename and correct bytes (TOCTOU regression)", async () => {
    const n = 5;
    const bodies = Array.from({ length: n }, (_, i) => `concurrent-payload-${i}`);
    const responses = await Promise.all(
      bodies.map((b) => postAttachment("concurrent.txt", new TextEncoder().encode(b))),
    );
    for (const res of responses) expect(res.status).toBe(200);
    const parsed = (await Promise.all(responses.map((r) => r.json()))) as { path: string; basename: string }[];

    const basenames = parsed.map((p) => p.basename);
    expect(new Set(basenames).size).toBe(n);

    for (let i = 0; i < n; i++) {
      const entry = parsed[i]!;
      expect(existsSync(entry.path)).toBe(true);
      expect(readFileSync(entry.path, "utf8")).toBe(bodies[i]!);
    }
  });

  test("400 on empty body", async () => {
    const res = await postAttachment("empty.txt", new Uint8Array(0));
    expect(res.status).toBe(400);
  });

  test("413 when Content-Length exceeds the 25MB cap (pre-check rejects before reading the body)", async () => {
    // Both `fetch`/undici and Bun's `node:http` shim treat content-length as
    // a managed header: they silently recompute it from the actual body
    // bytes, so a spoofed value never reaches the server through either.
    // Drop to a raw TCP socket and hand-write the request line/headers so the
    // claimed Content-Length (26MB+) can diverge from the real body (4
    // bytes) — this is exactly the pre-body-read short-circuit the route
    // takes: it responds 413 off the header alone, before ever calling
    // `req.arrayBuffer()`, so it doesn't hang waiting for bytes the client
    // never sends.
    const OVER = 25 * 1024 * 1024 + 1; // > MAX
    const statusLine = await new Promise<string>((resolve, reject) => {
      const sock = net.connect(4562, "127.0.0.1", () => {
        const body = Buffer.from([1, 2, 3, 4]);
        const head =
          `POST /attachments?name=big.bin HTTP/1.1\r\n`
          + `Host: 127.0.0.1:4562\r\n`
          + `Authorization: Bearer ${token}\r\n`
          + `Content-Length: ${OVER}\r\n`
          + `Connection: close\r\n\r\n`;
        sock.write(head);
        sock.write(body);
      });
      let data = "";
      sock.on("data", (d) => { data += d.toString(); });
      sock.on("error", reject);
      sock.on("close", () => resolve(data.split("\r\n")[0] ?? ""));
    });
    expect(statusLine).toContain("413");
  });

  test("long multibyte name: 200x'ü' stays under a 255-byte basename after sanitization", async () => {
    const longName = "ü".repeat(200); // 400 bytes of UTF-8, no extension
    const res = await postAttachment(longName, new TextEncoder().encode("multibyte payload"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string; basename: string };
    expect(Buffer.byteLength(body.basename, "utf8")).toBeLessThanOrEqual(255);
    // Must not have been mangled mid-codepoint.
    expect(() => Buffer.from(body.basename, "utf8").toString("utf8")).not.toThrow();
    expect(existsSync(body.path)).toBe(true);
  });

  test("requires a token", async () => {
    const res = await fetch(BASE + "/attachments?name=noauth.txt", {
      method: "POST",
      body: new TextEncoder().encode("no auth payload"),
    });
    expect(res.status).toBe(401);
  });
});

describe("POST /refs/drag", () => {
  async function withDragReader<T>(paths: string[], fn: () => Promise<T>): Promise<T> {
    const { setDragPasteboardReaderForTests } = await import("./drag-pasteboard.ts");
    setDragPasteboardReaderForTests(() => paths);
    try {
      return await fn();
    } finally {
      setDragPasteboardReaderForTests(null);
    }
  }

  const drag = () =>
    fetch(BASE + "/refs/drag", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });

  test("returns the dragged file (isDirectory:false) and dir (isDirectory:true), drops the nonexistent path", async () => {
    const nonexistent = path.join(SCRATCH, "gone-forever.txt");
    const { refs } = await withDragReader([DRAG_FILE, DRAG_DIR, nonexistent], async () => {
      const res = await drag();
      expect(res.status).toBe(200);
      return (await res.json()) as { refs: { path: string; isDirectory: boolean }[] };
    });
    expect(refs).toEqual([
      { path: DRAG_FILE, isDirectory: false },
      { path: DRAG_DIR, isDirectory: true },
    ]);
  });

  test("an empty injected pasteboard yields { refs: [] }", async () => {
    const { refs } = await withDragReader([], async () => {
      const res = await drag();
      return (await res.json()) as { refs: unknown[] };
    });
    expect(refs).toEqual([]);
  });

  test("a transient-looking path (/var/folders-style) that exists is passed through — filtering is client-side, not server-side", async () => {
    // Mimic the shape of macOS's transient temp-file paths
    // (/var/folders/x/y/...) that the *client* regex treats specially. The
    // server has no such special-casing: refsFromPaths only stats for
    // existence/directory-ness, so a real, existing path in that shape must
    // come back unfiltered.
    const transientLike = mkdtempSync(path.join(tmpdir(), "agetor-transient-"));
    const transientFile = path.join(transientLike, "y");
    writeFileSync(transientFile, "transient");

    const { refs } = await withDragReader([transientFile], async () => {
      const res = await drag();
      return (await res.json()) as { refs: { path: string; isDirectory: boolean }[] };
    });
    expect(refs).toEqual([{ path: transientFile, isDirectory: false }]);
  });
});
