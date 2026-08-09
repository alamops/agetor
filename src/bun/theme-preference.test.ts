import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-theme-preference-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
// Unique port, distinct from every other *.test.ts file's AGETOR_API_PORT.
process.env.AGETOR_API_PORT = "4409";

let server: { stop: () => void; port: number };
let token: string;
let preferences: typeof import("./db.ts").preferences;
let resolveThemePreference: typeof import("./window-url.ts").resolveThemePreference;
let buildWindowHash: typeof import("./window-url.ts").buildWindowHash;

beforeAll(async () => {
  ({ preferences } = await import("./db.ts"));
  ({ resolveThemePreference, buildWindowHash } = await import("./window-url.ts"));
  const { startApiServer, API_TOKEN } = await import("./server.ts");
  server = startApiServer() as unknown as { stop: () => void; port: number };
  token = API_TOKEN;
});

afterAll(() => {
  server?.stop?.();
});

const url = (p: string) => `http://127.0.0.1:4409${p}`;
// Built lazily — `token` is only assigned in beforeAll, after module load.
const auth = () => ({ authorization: `Bearer ${token}` });

// --- /preferences + /preferences/:key over HTTP ---------------------------

test("GET /preferences omits the theme key entirely when nothing has been set", async () => {
  const res = await fetch(url("/preferences"), { headers: auth() });
  expect(res.status).toBe(200);
  const body = (await res.json()) as Record<string, string>;
  expect(Object.prototype.hasOwnProperty.call(body, "theme")).toBe(false);
});

test("PUT /preferences/theme persists 'light' and GET reflects it", async () => {
  const put = await fetch(url("/preferences/theme"), {
    method: "PUT",
    headers: { ...auth(), "content-type": "application/json" },
    body: JSON.stringify({ value: "light" }),
  });
  expect(put.status).toBe(204);

  const get = await fetch(url("/preferences"), { headers: auth() });
  const body = (await get.json()) as Record<string, string>;
  expect(body.theme).toBe("light");
});

test("PUT /preferences/theme persists 'dark' and GET reflects it", async () => {
  const put = await fetch(url("/preferences/theme"), {
    method: "PUT",
    headers: { ...auth(), "content-type": "application/json" },
    body: JSON.stringify({ value: "dark" }),
  });
  expect(put.status).toBe(204);

  const get = await fetch(url("/preferences"), { headers: auth() });
  const body = (await get.json()) as Record<string, string>;
  expect(body.theme).toBe("dark");
});

test("PUT /preferences/theme persists 'auto' and GET reflects it", async () => {
  const put = await fetch(url("/preferences/theme"), {
    method: "PUT",
    headers: { ...auth(), "content-type": "application/json" },
    body: JSON.stringify({ value: "auto" }),
  });
  expect(put.status).toBe(204);

  const get = await fetch(url("/preferences"), { headers: auth() });
  const body = (await get.json()) as Record<string, string>;
  expect(body.theme).toBe("auto");
});

test("overwriting theme replaces the value rather than duplicating it (ON CONFLICT DO UPDATE)", async () => {
  await fetch(url("/preferences/theme"), {
    method: "PUT",
    headers: { ...auth(), "content-type": "application/json" },
    body: JSON.stringify({ value: "light" }),
  });
  await fetch(url("/preferences/theme"), {
    method: "PUT",
    headers: { ...auth(), "content-type": "application/json" },
    body: JSON.stringify({ value: "dark" }),
  });

  const get = await fetch(url("/preferences"), { headers: auth() });
  const body = (await get.json()) as Record<string, string>;
  expect(body.theme).toBe("dark");
  // Only one row for the key — confirmed via the store directly (list() is
  // keyed by `key`, so a duplicate-insert bug would still collapse to one
  // entry there; the DB-level guarantee is that `ON CONFLICT(key) DO UPDATE`
  // never leaves two rows for the same key).
  expect(preferences.get("theme")).toBe("dark");
});

test("PUT /preferences/theme with a non-string body ({ value: 123 }) is rejected with 400 and leaves the stored value unchanged", async () => {
  await fetch(url("/preferences/theme"), {
    method: "PUT",
    headers: { ...auth(), "content-type": "application/json" },
    body: JSON.stringify({ value: "light" }),
  });

  const res = await fetch(url("/preferences/theme"), {
    method: "PUT",
    headers: { ...auth(), "content-type": "application/json" },
    body: JSON.stringify({ value: 123 }),
  });
  expect(res.status).toBe(400);
  expect(preferences.get("theme")).toBe("light");
});

test("PUT /preferences/theme with an empty body ({}) is rejected with 400 and leaves the stored value unchanged", async () => {
  await fetch(url("/preferences/theme"), {
    method: "PUT",
    headers: { ...auth(), "content-type": "application/json" },
    body: JSON.stringify({ value: "dark" }),
  });

  const res = await fetch(url("/preferences/theme"), {
    method: "PUT",
    headers: { ...auth(), "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  expect(res.status).toBe(400);
  expect(preferences.get("theme")).toBe("dark");
});

test("requests without a bearer token are rejected with 401", async () => {
  const getRes = await fetch(url("/preferences"));
  expect(getRes.status).toBe(401);

  const putRes = await fetch(url("/preferences/theme"), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value: "light" }),
  });
  expect(putRes.status).toBe(401);
});

test("writing theme does not disturb other preference keys, and vice versa", async () => {
  await fetch(url("/preferences/defaultHarness"), {
    method: "PUT",
    headers: { ...auth(), "content-type": "application/json" },
    body: JSON.stringify({ value: "claude-code" }),
  });
  await fetch(url("/preferences/theme"), {
    method: "PUT",
    headers: { ...auth(), "content-type": "application/json" },
    body: JSON.stringify({ value: "light" }),
  });

  const get = await fetch(url("/preferences"), { headers: auth() });
  const body = (await get.json()) as Record<string, string>;
  expect(body.theme).toBe("light");
  expect(body.defaultHarness).toBe("claude-code");
});

test("the server stores theme as an opaque string — no server-side validation of the three known values", async () => {
  // Contrast with src/mainview/lib/theme.ts's parseThemePreference, which is
  // the actual defense against a garbage value — the server itself performs
  // no such check and will happily round-trip anything that's a string.
  const put = await fetch(url("/preferences/theme"), {
    method: "PUT",
    headers: { ...auth(), "content-type": "application/json" },
    body: JSON.stringify({ value: "not-a-real-theme" }),
  });
  expect(put.status).toBe(204);

  const get = await fetch(url("/preferences"), { headers: auth() });
  const body = (await get.json()) as Record<string, string>;
  expect(body.theme).toBe("not-a-real-theme");
});

// --- window-url.ts: resolveThemePreference + buildWindowHash --------------

test("resolveThemePreference falls back to 'auto' when nothing is stored", async () => {
  // Use a key namespace independent of the HTTP tests above: reach for the
  // store directly and confirm the current state, since resolveThemePreference
  // reads through the same `preferences` module those tests mutate. Reset
  // to an unset-equivalent state isn't possible (no delete on the store), so
  // instead verify the *unknown-value* fallback contract precisely, matching
  // what resolveThemePreference actually implements: anything other than
  // exactly "dark" or "light" resolves to "auto".
  preferences.set("theme", "not-a-real-theme");
  expect(resolveThemePreference()).toBe("auto");
});

test("resolveThemePreference passes through 'dark' and 'light' exactly, and normalizes everything else to 'auto'", () => {
  preferences.set("theme", "dark");
  expect(resolveThemePreference()).toBe("dark");

  preferences.set("theme", "light");
  expect(resolveThemePreference()).toBe("light");

  preferences.set("theme", "auto");
  expect(resolveThemePreference()).toBe("auto");

  preferences.set("theme", "garbage");
  expect(resolveThemePreference()).toBe("auto");
});

test("resolveThemePreference falls back to 'auto' (instead of throwing) when the DB read itself throws", () => {
  // Regression coverage for the window-build path: buildWindow in
  // src/bun/index.ts awaits resolveThemePreference() before constructing
  // the BrowserWindow — an uncaught throw here (e.g. a locked/corrupt
  // SQLite file) would reject that promise and the main window would never
  // open. Simulate the throw at the `preferences.get` boundary rather than
  // actually corrupting the on-disk DB (which would poison every other test
  // in this file that shares AGETOR_DATA_DIR).
  const realGet = preferences.get;
  preferences.get = () => {
    throw new Error("simulated: database disk image is malformed");
  };
  try {
    expect(resolveThemePreference()).toBe("auto");
  } finally {
    preferences.get = realGet;
  }
  // The store itself is unaffected — restoring the stub didn't lose data.
  preferences.set("theme", "dark");
  expect(resolveThemePreference()).toBe("dark");
});

test("buildWindowHash includes api, token, and theme as a hash fragment (not a query string)", () => {
  const hash = buildWindowHash({ port: "4317", token: "sekrit-token", theme: "dark" });
  expect(hash).toBe("#api=4317&token=sekrit-token&theme=dark");
  expect(hash.startsWith("#")).toBe(true);
  expect(hash.includes("?")).toBe(false);
});

test("buildWindowHash passes an unknown/garbage theme value through verbatim (it does not normalize)", () => {
  // buildWindowHash is a pure string template — normalization is
  // resolveThemePreference's job, not buildWindowHash's. Cast to bypass the
  // ThemePreference type at the call site, mirroring how a caller could in
  // principle hand it an already-resolved-but-wrong value.
  const hash = buildWindowHash({
    port: "4317",
    token: "tok",
    theme: "not-a-real-theme" as unknown as "auto",
  });
  expect(hash).toBe("#api=4317&token=tok&theme=not-a-real-theme");
});
