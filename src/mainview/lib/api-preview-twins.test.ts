/**
 * The webview half of the preview-twin contract (docs/plans/picked-image-preview-tcc.md,
 * T5/T7), asserted on the wire against a stubbed fetch (the boundary):
 *
 *   - `resolveCapturedRefs` (the user's own drop/paste) is the ONLY call that
 *     asks `/refs/resolve` for twins, and it carries the dropped Files' names;
 *   - `resolveRefs` (SentFilesCard, handoff chips, `@`-scope: agent-chosen
 *     paths) never sends `previewTwins` or `names`;
 *   - `dragRefs` posts the carried Files' names to `/refs/drag`;
 *   - `fetchBlobBytes` reports a 403 as "denied", so the diff panes can say
 *     the preview is blocked instead of "couldn't load".
 */
import { afterEach, expect, test } from "bun:test";
import { api } from "./api.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface Call {
  method: string;
  url: string;
  body: unknown;
}

function stub(respond: (call: Call) => Response): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/health")) return new Response("{}", { status: 200 });
    const raw = init?.body;
    const call: Call = {
      method: init?.method ?? "GET",
      url: u,
      body: typeof raw === "string" ? JSON.parse(raw) : raw ?? null,
    };
    calls.push(call);
    return respond(call);
  }) as unknown as typeof fetch;
  return calls;
}

const refsResponse = (refs: unknown[]) => new Response(JSON.stringify({ refs }), { status: 200 });

test("resolveCapturedRefs posts paths, names and previewTwins: true to /refs/resolve", async () => {
  const calls = stub(() => refsResponse([{ path: "/Users/x/a.heic", isDirectory: false }]));
  const refs = await api.resolveCapturedRefs(["/Users/x/a.heic"], ["a.heic"]);
  expect(refs).toEqual([{ path: "/Users/x/a.heic", isDirectory: false }]);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.method).toBe("POST");
  expect(new URL(calls[0]!.url).pathname).toBe("/refs/resolve");
  expect(calls[0]!.body).toEqual({ paths: ["/Users/x/a.heic"], names: ["a.heic"], previewTwins: true });
});

test("resolveCapturedRefs with no carried Files still sends an empty names list (the core twins nothing)", async () => {
  const calls = stub(() => refsResponse([]));
  await api.resolveCapturedRefs(["/Users/x/Desktop/secret.png"], []);
  expect(calls[0]!.body).toEqual({ paths: ["/Users/x/Desktop/secret.png"], names: [], previewTwins: true });
});

test("resolveRefs (agent-chosen paths) never asks for twins", async () => {
  const calls = stub(() => refsResponse([]));
  await api.resolveRefs(["/Users/x/Desktop/agent-said.png"]);
  expect(new URL(calls[0]!.url).pathname).toBe("/refs/resolve");
  expect(calls[0]!.body).toEqual({ paths: ["/Users/x/Desktop/agent-said.png"] });
});

test("dragRefs posts the carried Files' names to /refs/drag", async () => {
  const calls = stub(() => refsResponse([{ path: "/Users/x/a.heic", isDirectory: false }]));
  const refs = await api.dragRefs(["a.heic", "notes.txt"]);
  expect(refs).toEqual([{ path: "/Users/x/a.heic", isDirectory: false }]);
  expect(calls[0]!.method).toBe("POST");
  expect(new URL(calls[0]!.url).pathname).toBe("/refs/drag");
  expect(calls[0]!.body).toEqual({ names: ["a.heic", "notes.txt"] });
});

test.each([
  [403, "denied"],
  [404, "missing"],
  [413, "too-large"],
  [500, "500 "],
  [401, "401 "],
] as const)("fetchBlobBytes turns a %d into the %p failure", async (status, message) => {
  stub(() => new Response("{}", { status }));
  const err = await api.fetchBlobBytes("http://127.0.0.1:1/tasks/t/diff/blob?side=new").catch((e: unknown) => e);
  expect(err).toBeInstanceOf(Error);
  if (message.endsWith(" ")) expect((err as Error).message.startsWith(message)).toBe(true);
  else expect((err as Error).message).toBe(message);
});

test("fetchBlobBytes returns the bytes of a 200", async () => {
  stub(() => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
  const buf = await api.fetchBlobBytes("http://127.0.0.1:1/tasks/t/diff/blob?side=old");
  expect([...new Uint8Array(buf)]).toEqual([1, 2, 3]);
});
