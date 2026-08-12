import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-font-size-preference-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
// Unique port, distinct from every other *.test.ts file's AGETOR_API_PORT.
process.env.AGETOR_API_PORT = "4531";

let server: { stop: () => void; port: number };
let token: string;
let preferences: typeof import("./db.ts").preferences;
let resolveFontSizePreference: typeof import("./window-url.ts").resolveFontSizePreference;
let buildWindowHash: typeof import("./window-url.ts").buildWindowHash;

beforeAll(async () => {
  ({ preferences } = await import("./db.ts"));
  ({ resolveFontSizePreference, buildWindowHash } = await import("./window-url.ts"));
  const { startApiServer, API_TOKEN } = await import("./server.ts");
  server = startApiServer() as unknown as { stop: () => void; port: number };
  token = API_TOKEN;
});

afterAll(() => {
  server?.stop?.();
});

const url = (p: string) => `http://127.0.0.1:4531${p}`;
// Built lazily — `token` is only assigned in beforeAll, after module load.
const auth = () => ({ authorization: `Bearer ${token}` });

// --- /preferences + /preferences/:key over HTTP ---------------------------

test("GET /preferences omits the fontSize key entirely when nothing has been set", async () => {
  const res = await fetch(url("/preferences"), { headers: auth() });
  expect(res.status).toBe(200);
  const body = (await res.json()) as Record<string, string>;
  expect(Object.prototype.hasOwnProperty.call(body, "fontSize")).toBe(false);
});

test("PUT /preferences/fontSize persists '130' and GET reflects it", async () => {
  const put = await fetch(url("/preferences/fontSize"), {
    method: "PUT",
    headers: { ...auth(), "content-type": "application/json" },
    body: JSON.stringify({ value: "130" }),
  });
  expect(put.status).toBe(204);

  const get = await fetch(url("/preferences"), { headers: auth() });
  const body = (await get.json()) as Record<string, string>;
  expect(body.fontSize).toBe("130");
});

test("overwriting fontSize replaces the value rather than duplicating it (ON CONFLICT DO UPDATE)", async () => {
  await fetch(url("/preferences/fontSize"), {
    method: "PUT",
    headers: { ...auth(), "content-type": "application/json" },
    body: JSON.stringify({ value: "110" }),
  });
  await fetch(url("/preferences/fontSize"), {
    method: "PUT",
    headers: { ...auth(), "content-type": "application/json" },
    body: JSON.stringify({ value: "150" }),
  });

  const get = await fetch(url("/preferences"), { headers: auth() });
  const body = (await get.json()) as Record<string, string>;
  expect(body.fontSize).toBe("150");
  expect(preferences.get("fontSize")).toBe("150");
});

test("PUT /preferences/fontSize with a non-string value ({ value: 130 }) is rejected with 400 and leaves the stored value unchanged", async () => {
  await fetch(url("/preferences/fontSize"), {
    method: "PUT",
    headers: { ...auth(), "content-type": "application/json" },
    body: JSON.stringify({ value: "140" }),
  });

  const res = await fetch(url("/preferences/fontSize"), {
    method: "PUT",
    headers: { ...auth(), "content-type": "application/json" },
    body: JSON.stringify({ value: 130 }),
  });
  expect(res.status).toBe(400);
  expect(preferences.get("fontSize")).toBe("140");
});

test("PUT /preferences/fontSize with an empty body ({}) is rejected with 400 and leaves the stored value unchanged", async () => {
  await fetch(url("/preferences/fontSize"), {
    method: "PUT",
    headers: { ...auth(), "content-type": "application/json" },
    body: JSON.stringify({ value: "140" }),
  });

  const res = await fetch(url("/preferences/fontSize"), {
    method: "PUT",
    headers: { ...auth(), "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  expect(res.status).toBe(400);
  expect(preferences.get("fontSize")).toBe("140");
});

test("requests without a bearer token are rejected with 401", async () => {
  const getRes = await fetch(url("/preferences"));
  expect(getRes.status).toBe(401);

  const putRes = await fetch(url("/preferences/fontSize"), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value: "140" }),
  });
  expect(putRes.status).toBe(401);
});

test("writing fontSize does not disturb other preference keys, and vice versa", async () => {
  await fetch(url("/preferences/defaultHarness"), {
    method: "PUT",
    headers: { ...auth(), "content-type": "application/json" },
    body: JSON.stringify({ value: "claude-code" }),
  });
  await fetch(url("/preferences/fontSize"), {
    method: "PUT",
    headers: { ...auth(), "content-type": "application/json" },
    body: JSON.stringify({ value: "120" }),
  });

  const get = await fetch(url("/preferences"), { headers: auth() });
  const body = (await get.json()) as Record<string, string>;
  expect(body.fontSize).toBe("120");
  expect(body.defaultHarness).toBe("claude-code");
});

test("the server stores fontSize as an opaque string — no server-side clamping of the 100-170 bounds", async () => {
  // Contrast with src/shared/types.ts's clampFontSizePercent, which is the
  // actual defense against an out-of-range or garbage value — the server
  // itself performs no such check and will happily round-trip anything
  // that's a string, exactly like theme.
  const put = await fetch(url("/preferences/fontSize"), {
    method: "PUT",
    headers: { ...auth(), "content-type": "application/json" },
    body: JSON.stringify({ value: "not-a-number" }),
  });
  expect(put.status).toBe(204);

  const get = await fetch(url("/preferences"), { headers: auth() });
  const body = (await get.json()) as Record<string, string>;
  expect(body.fontSize).toBe("not-a-number");
});

test("the server round-trips an out-of-range numeric string ('300') verbatim — clamping happens client/boot-side, not server-side", async () => {
  const put = await fetch(url("/preferences/fontSize"), {
    method: "PUT",
    headers: { ...auth(), "content-type": "application/json" },
    body: JSON.stringify({ value: "300" }),
  });
  expect(put.status).toBe(204);

  const get = await fetch(url("/preferences"), { headers: auth() });
  const body = (await get.json()) as Record<string, string>;
  expect(body.fontSize).toBe("300");
});

// --- window-url.ts: resolveFontSizePreference + buildWindowHash -----------

test("resolveFontSizePreference falls back to 100 when nothing is stored", async () => {
  // Reach for the store directly and confirm the current state, since
  // resolveFontSizePreference reads through the same `preferences` module
  // the HTTP tests above mutate. There's no delete on the store, so instead
  // verify the fallback contract precisely: anything that isn't a valid
  // in-range value resolves to FONT_SIZE_DEFAULT (100).
  preferences.set("fontSize", "not-a-real-size");
  expect(resolveFontSizePreference()).toBe(100);
});

test("resolveFontSizePreference clamps an out-of-range stored value to the nearer bound", () => {
  preferences.set("fontSize", "300");
  expect(resolveFontSizePreference()).toBe(170);

  preferences.set("fontSize", "1");
  expect(resolveFontSizePreference()).toBe(100);
});

test("resolveFontSizePreference falls back to 100 for a non-numeric stored value", () => {
  preferences.set("fontSize", "abc");
  expect(resolveFontSizePreference()).toBe(100);
});

test("resolveFontSizePreference passes an in-range stored value through unchanged", () => {
  preferences.set("fontSize", "140");
  expect(resolveFontSizePreference()).toBe(140);

  preferences.set("fontSize", "100");
  expect(resolveFontSizePreference()).toBe(100);

  preferences.set("fontSize", "170");
  expect(resolveFontSizePreference()).toBe(170);
});

test("resolveFontSizePreference rounds a fractional stored value", () => {
  preferences.set("fontSize", "133.6");
  expect(resolveFontSizePreference()).toBe(134);
});

test("resolveFontSizePreference falls back to 100 (instead of throwing) when the DB read itself throws", () => {
  // Regression coverage for the window-build path: buildWindow in
  // src/bun/index.ts awaits resolveFontSizePreference() before constructing
  // the BrowserWindow — an uncaught throw here (e.g. a locked/corrupt
  // SQLite file) must not reject that promise and block the main window
  // from ever opening. Simulate the throw at the `preferences.get` boundary
  // rather than actually corrupting the on-disk DB (which would poison
  // every other test in this file that shares AGETOR_DATA_DIR).
  const realGet = preferences.get;
  preferences.get = () => {
    throw new Error("simulated: database disk image is malformed");
  };
  try {
    expect(resolveFontSizePreference()).toBe(100);
  } finally {
    preferences.get = realGet;
  }
  // The store itself is unaffected — restoring the stub didn't lose data.
  preferences.set("fontSize", "140");
  expect(resolveFontSizePreference()).toBe(140);
});

test("buildWindowHash omits &fontSize= entirely when fontSize is exactly the 100 default", () => {
  const hash = buildWindowHash({ port: "4317", token: "sekrit-token", theme: "dark", fontSize: 100 });
  expect(hash).toBe("#api=4317&token=sekrit-token&theme=dark");
  expect(hash.includes("fontSize")).toBe(false);
});

test("buildWindowHash appends &fontSize=<n> as the trailing param when fontSize is not the default", () => {
  const hash = buildWindowHash({ port: "4317", token: "sekrit-token", theme: "dark", fontSize: 140 });
  expect(hash).toBe("#api=4317&token=sekrit-token&theme=dark&fontSize=140");
});

test("buildWindowHash reflects the maximum (170) verbatim, unclamped — clamping is resolveFontSizePreference's job, not buildWindowHash's", () => {
  const hash = buildWindowHash({ port: "4317", token: "tok", theme: "auto", fontSize: 170 });
  expect(hash).toBe("#api=4317&token=tok&theme=auto&fontSize=170");
});

test("buildWindowHash passes an out-of-range fontSize value through verbatim — it does not clamp", () => {
  // buildWindowHash is a pure string template; normalization is
  // resolveFontSizePreference's job. A caller that hands it an
  // already-resolved-but-out-of-range value (shouldn't happen in practice,
  // but the function itself performs no defense) sees it echoed as-is.
  const hash = buildWindowHash({ port: "4317", token: "tok", theme: "auto", fontSize: 9999 });
  expect(hash).toBe("#api=4317&token=tok&theme=auto&fontSize=9999");
});

test("buildWindowHash keeps fontSize as the last param regardless of theme value", () => {
  const hash = buildWindowHash({ port: "1", token: "t", theme: "light", fontSize: 120 });
  expect(hash).toBe("#api=1&token=t&theme=light&fontSize=120");
});
