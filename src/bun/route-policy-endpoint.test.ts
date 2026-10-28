// The route policy end to end, against two real in-process servers
// (docs/plans/master-token-agent-read.md, TT15a): one headless core and one
// with a fake native host ("app mode"). `route-policy.test.ts` pins the table
// and the walker with fake handlers; this file proves the real `server.ts`
// routes behave the way the table says, for both tokens:
//
//   • every desktop-only route + method refuses the CLI token (403
//     desktop-only on the app, 501-or-403 per `headless501` on headless) and
//     never refuses the master (the `headless501` flag is truthful: the master
//     on a headless core gets that same 501);
//   • no token → 401; `/health` is public; `/info` is CLI-scoped;
//   • `?token=` is dead for the master everywhere and for the CLI token
//     everywhere except the three legacy SSE GETs;
//   • the terminal WebSocket takes only a single-use, per-terminal, unexpired
//     ticket and refuses `?token=`;
//   • the `disclaimSpawnedAgents` value rule (D4–D6);
//   • the CLI path gate (D24) refuses an unreadable directory with
//     403 `path-not-accessible` and never touches the master or a missing path.
//
// `bun test` runs every file in one process, so every env var, preference and
// the disclaim switch this file changes is restored in afterAll.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeTestNative } from "./test-native.ts";
import { rmTestDataDir } from "./test-data-dir.ts";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-route-policy-ep-"));
const SCRATCH = mkdtempSync(path.join(tmpdir(), "agetor-route-policy-ep-scratch-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;

// Unique across src/ and e2e/ — grep before reusing.
const HEADLESS_PORT = 4750;
const APP_PORT = 4751;
const HEADLESS = `http://127.0.0.1:${HEADLESS_PORT}`;
const APP = `http://127.0.0.1:${APP_PORT}`;

const ENV_KEYS = [
  "AGETOR_API_PORT",
  "AGETOR_TEST_BLOCK_ROUTE",
  "AGETOR_DOWNLOADS_DIR",
  "SHELL",
] as const;
const SAVED_ENV: Record<string, string | undefined> = {};

type Stoppable = { stop: () => void; port: number };
let headless: Stoppable;
let appServer: Stoppable;
let master: string;
let cli: string;
let taskId: string;
let savedDisclaim: string | null = null;
let savedSwitch = true;

type Mods = {
  db: typeof import("./db.ts");
  disclaim: typeof import("./disclaim.ts");
  policy: typeof import("./route-policy.ts");
};
let mods: Mods;

beforeAll(async () => {
  for (const k of ENV_KEYS) SAVED_ENV[k] = process.env[k];
  // The conditional /test/block-event-loop route must be registered to be
  // classified; a deterministic shell for the terminal tests; a throwaway
  // Downloads dir so no export can reach the real one.
  process.env.AGETOR_TEST_BLOCK_ROUTE = "1";
  process.env.SHELL = "/bin/sh";
  process.env.AGETOR_DOWNLOADS_DIR = path.join(SCRATCH, "downloads");

  const db = await import("./db.ts");
  const disclaim = await import("./disclaim.ts");
  const policy = await import("./route-policy.ts");
  const { startApiServer } = await import("./server.ts");
  const { API_TOKEN, CLI_TOKEN } = await import("./api-config.ts");
  mods = { db, disclaim, policy };
  master = API_TOKEN;
  cli = CLI_TOKEN;
  savedDisclaim = db.preferences.get(disclaim.DISCLAIM_PREF_KEY);
  savedSwitch = disclaim.getDisclaimSwitch();

  process.env.AGETOR_API_PORT = String(HEADLESS_PORT);
  headless = startApiServer() as unknown as Stoppable;
  process.env.AGETOR_API_PORT = String(APP_PORT);
  appServer = startApiServer({
    // Every native call is a no-op that reports success, so a master request to
    // /app/force-quit, /updates/apply, /window/* … can't touch this process.
    native: makeTestNative({ quit: () => {} }),
  }) as unknown as Stoppable;

  taskId = "route-policy-ep-task";
  db.tasks.insert({
    id: taskId,
    title: "route policy host",
    prompt: "n/a",
    column: "backlog",
    agent: "codex",
    workdir: tmpdir(),
    isolation: "none",
    taskType: "task",
    branch: null,
    branchSource: "created",
    worktreePath: null,
    baseRef: null,
    prUrl: null,
    mode: null,
    model: null,
    effort: null,
    speed: "off",
    maxMode: false,
    opencodeServer: "shared",
    references: [],
    backlog: [],
    plans: [],
    draft: null,
    runId: null,
    hasOpenableRun: false,
    pendingInteractionCount: 0,
    openTerminalCount: 0,
    archivedAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
});

afterAll(async () => {
  const { killTerminalsForTask } = await import("./terminals.ts");
  killTerminalsForTask(taskId);
  headless?.stop?.();
  appServer?.stop?.();
  // The disclaim preference and the in-memory switch both go back to how this
  // file found them.
  if (savedDisclaim === null) mods.db.db.run(`DELETE FROM preferences WHERE key = ?`, [mods.disclaim.DISCLAIM_PREF_KEY]);
  else mods.db.preferences.set(mods.disclaim.DISCLAIM_PREF_KEY, savedDisclaim);
  mods.disclaim.setDisclaimSwitch(savedSwitch);
  for (const k of ENV_KEYS) {
    if (SAVED_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED_ENV[k];
  }
  // Restore every mode-000 fixture a test left behind (a test that timed out
  // never reached its own `finally`), or the rm below fails with EACCES.
  for (const name of ["locked", "locked-padded"]) {
    try {
      chmodSync(path.join(SCRATCH, name), 0o700);
    } catch {
      // never created
    }
  }
  rmSync(SCRATCH, { recursive: true, force: true });
  rmTestDataDir(DATA_DIR);
});

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

/** Every (route, method) the table marks desktop-only, in table order. */
function desktopOnlyRoutes(): Array<{ route: string; method: string; headless501: boolean }> {
  const out: Array<{ route: string; method: string; headless501: boolean }> = [];
  for (const [route, entry] of Object.entries(mods.policy.ROUTE_POLICY)) {
    const isFlat = typeof (entry as { callers?: unknown }).callers === "string";
    const perMethod: Array<[string, import("./route-policy.ts").RoutePolicy]> = isFlat
      ? [["GET", entry as import("./route-policy.ts").RoutePolicy]]
      : (Object.entries(entry) as Array<[string, import("./route-policy.ts").RoutePolicy]>);
    for (const [method, p] of perMethod) {
      if (p.callers === "app") out.push({ route, method, headless501: p.headless501 === true });
    }
  }
  return out;
}

/** `/tasks/:id/terminals` → `/tasks/no-such-id/terminals`. */
const fill = (route: string) => route.replace(/:[A-Za-z]+/g, "no-such-id");

/**
 * Routes that validate their body BEFORE they notice there is no native host:
 * with `{}` they answer 400, never reaching the 501 the `headless501` flag
 * promises. A minimal well-formed body gets them to the native check. (The
 * native calls themselves are the fake host's no-ops in app mode.)
 */
const VALID_BODY: Record<string, unknown> = {
  "/open-path": { path: SCRATCH },
  "/reveal-path": { path: SCRATCH },
  "/open-external": { url: "https://example.com/" },
};

function send(base: string, token: string | null, route: string, method: string): Promise<Response> {
  const hasBody = method !== "GET" && method !== "HEAD" && method !== "DELETE";
  return fetch(`${base}${fill(route)}`, {
    method,
    headers: {
      ...(token ? bearer(token) : {}),
      ...(hasBody ? { "content-type": "application/json" } : {}),
    },
    body: hasBody ? JSON.stringify(VALID_BODY[route] ?? {}) : undefined,
  });
}

// ── desktop-only routes, both tokens, both modes ────────────────────────────

test("the desktop-only set is non-trivial (the iteration below can't silently go empty)", () => {
  const routes = desktopOnlyRoutes();
  expect(routes.length).toBeGreaterThanOrEqual(25);
  expect(routes.some((r) => r.route === "/terminals/:id/ws-ticket")).toBe(true);
  expect(routes.some((r) => r.route === "/test/block-event-loop")).toBe(true);
  expect(routes.some((r) => r.headless501)).toBe(true);
});

test("app mode: the CLI token gets 403 desktop-only on every desktop-only route + method; the master gets neither 401 nor 403", async () => {
  for (const { route, method } of desktopOnlyRoutes()) {
    const viaCli = await send(APP, cli, route, method);
    expect(viaCli.status, `CLI ${method} ${route}`).toBe(403);
    expect(await viaCli.json(), `CLI ${method} ${route}`).toEqual({
      error: "only available in the Agetor app",
      code: "desktop-only",
    });

    const viaMaster = await send(APP, master, route, method);
    expect([401, 403], `master ${method} ${route} -> ${viaMaster.status}`).not.toContain(viaMaster.status);
    await viaMaster.text();
  }
});

test("headless: the CLI token gets 501 on headless501 routes and 403 desktop-only on the rest; the master is never 401/403", async () => {
  for (const { route, method, headless501 } of desktopOnlyRoutes()) {
    const viaCli = await send(HEADLESS, cli, route, method);
    if (headless501) {
      expect(viaCli.status, `CLI ${method} ${route}`).toBe(501);
    } else {
      expect(viaCli.status, `CLI ${method} ${route}`).toBe(403);
      expect(((await viaCli.json()) as { code: string }).code).toBe("desktop-only");
    }
    await viaCli.text().catch(() => "");

    const viaMaster = await send(HEADLESS, master, route, method);
    expect([401, 403], `master ${method} ${route} -> ${viaMaster.status}`).not.toContain(viaMaster.status);
    await viaMaster.text();
  }
});

test("headless: the headless501 flag is truthful — the master gets the same 501 on every flagged route", async () => {
  const seam = process.env.AGETOR_FAKE_PICK_REFS_DIR?.trim();
  for (const { route, method, headless501 } of desktopOnlyRoutes()) {
    if (!headless501) continue;
    // With the fake-pick seam set /refs/pick answers from the seam, not 501.
    if (route === "/refs/pick" && seam) continue;
    const res = await send(HEADLESS, master, route, method);
    expect(res.status, `master ${method} ${route}`).toBe(501);
    await res.text();
  }
});

test("no desktop-only route that the master reaches headless without a 501 claims headless501", async () => {
  // The converse of the test above: a route that does NOT 501 for the master
  // on a headless core must not be flagged, or the CLI would see a 501 where
  // the master sees a real answer.
  for (const { route, method, headless501 } of desktopOnlyRoutes()) {
    if (headless501) continue;
    const res = await send(HEADLESS, master, route, method);
    expect(res.status, `master ${method} ${route}`).not.toBe(501);
    await res.text();
  }
});

// ── public / unauthenticated / CLI-scoped ───────────────────────────────────

test("/health is public; /info answers the CLI token and the master", async () => {
  for (const base of [HEADLESS, APP]) {
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect((await fetch(`${base}/info`, { headers: bearer(cli) })).status).toBe(200);
    expect((await fetch(`${base}/info`, { headers: bearer(master) })).status).toBe(200);
  }
});

test("no token -> 401 on app, app+cli and desktop-only routes, in both modes", async () => {
  const samples: Array<[string, string]> = [
    ["GET", "/tasks"],
    ["GET", "/preferences"],
    ["GET", "/info"],
    ["GET", "/harnesses"],
    ["POST", "/tasks/no-such-id/start"],
    ["POST", "/projects"],
    ["GET", "/files/preview"],
    ["POST", "/terminals/no-such-id/ws-ticket"],
    ["POST", "/app/force-quit"],
    ["GET", "/events"],
  ];
  for (const base of [HEADLESS, APP]) {
    for (const [method, route] of samples) {
      const res = await fetch(`${base}${route}`, {
        method,
        headers: method === "POST" ? { "content-type": "application/json" } : {},
        body: method === "POST" ? "{}" : undefined,
      });
      expect(res.status, `${method} ${route} @ ${base}`).toBe(401);
      await res.text();
    }
  }
});

// ── ?token= ─────────────────────────────────────────────────────────────────

/** Open an SSE GET, return its status and (for a 200) the first frame, then abort. */
async function openStream(url: string): Promise<{ status: number; first: string }> {
  const ac = new AbortController();
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (res.status !== 200) {
      await res.text();
      return { status: res.status, first: "" };
    }
    const reader = res.body!.getReader();
    const timeout = new Promise<{ value: undefined }>((r) => setTimeout(() => r({ value: undefined }), 5000));
    const chunk = await Promise.race([reader.read(), timeout]);
    return { status: 200, first: chunk.value ? new TextDecoder().decode(chunk.value as Uint8Array) : "" };
  } finally {
    ac.abort();
  }
}

test("?token=<master> is 401 on ordinary routes and on all three legacy SSE GETs", async () => {
  const paths = [
    "/tasks",
    "/preferences",
    "/info",
    "/files/preview",
    "/events",
    "/app/events",
    `/tasks/${taskId}/events`,
  ];
  for (const base of [HEADLESS, APP]) {
    for (const p of paths) {
      const res = await fetch(`${base}${p}${p.includes("?") ? "&" : "?"}token=${encodeURIComponent(master)}`);
      expect(res.status, `${p} @ ${base}`).toBe(401);
      await res.text();
    }
  }
});

test("?token=<CLI token> opens the three legacy SSE GETs and nothing else", async () => {
  for (const base of [HEADLESS, APP]) {
    for (const p of ["/events", "/app/events", `/tasks/${taskId}/events`]) {
      const { status, first } = await openStream(`${base}${p}?token=${encodeURIComponent(cli)}`);
      expect(status, `${p} @ ${base}`).toBe(200);
      // The streams flush an initial frame (`: connected` / replay meta) on subscribe.
      expect(first.length, `${p} first frame`).toBeGreaterThan(0);
    }
    for (const p of ["/tasks", "/preferences", "/info", "/harnesses", `/tasks/${taskId}/runs`, `/tasks/${taskId}/events/page`]) {
      const res = await fetch(`${base}${p}?token=${encodeURIComponent(cli)}`);
      expect(res.status, `${p} @ ${base}`).toBe(401);
      await res.text();
    }
  }
});

test("the CLI token in a Bearer header opens the same SSE GETs", async () => {
  for (const p of ["/events", "/app/events", `/tasks/${taskId}/events`]) {
    const ac = new AbortController();
    const res = await fetch(`${APP}${p}`, { headers: bearer(cli), signal: ac.signal });
    expect(res.status, p).toBe(200);
    ac.abort();
  }
});

// ── terminal WebSocket ──────────────────────────────────────────────────────

async function newTerminal(): Promise<string> {
  const res = await fetch(`${APP}/tasks/${taskId}/terminals`, { method: "POST", headers: bearer(master) });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

async function mintTicket(terminalId: string): Promise<string> {
  const res = await fetch(`${APP}/terminals/${terminalId}/ws-ticket`, { method: "POST", headers: bearer(master) });
  expect(res.status).toBe(201);
  return ((await res.json()) as { ticket: string }).ticket;
}

function connect(pathAndQuery: string): Promise<"open" | "refused"> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${APP_PORT}${pathAndQuery}`);
    const timer = setTimeout(() => {
      ws.close();
      resolve("refused");
    }, 5000);
    ws.onopen = () => {
      clearTimeout(timer);
      ws.close();
      resolve("open");
    };
    ws.onerror = () => {
      clearTimeout(timer);
      resolve("refused");
    };
  });
}

test("terminal WS: a ticket opens the socket exactly once", async () => {
  const id = await newTerminal();
  const ticket = await mintTicket(id);
  expect(await connect(`/terminals/${id}/ws?ticket=${ticket}`)).toBe("open");
  expect(await connect(`/terminals/${id}/ws?ticket=${ticket}`)).toBe("refused");
});

test("terminal WS: a ticket for another terminal, an expired one, a missing or a made-up one are refused", async () => {
  const a = await newTerminal();
  const b = await newTerminal();

  // Wrong terminal — and the attempt burns the ticket.
  const wrong = await mintTicket(a);
  expect(await connect(`/terminals/${b}/ws?ticket=${wrong}`)).toBe("refused");
  expect(await connect(`/terminals/${a}/ws?ticket=${wrong}`)).toBe("refused");

  // Expired: the server checks `Date.now()` against a 30 s TTL, so advance the
  // clock past it for the one connect (timers use their own clock, unaffected).
  const stale = await mintTicket(a);
  const realNow = Date.now;
  Date.now = () => realNow() + 31_000;
  try {
    expect(await connect(`/terminals/${a}/ws?ticket=${stale}`)).toBe("refused");
  } finally {
    Date.now = realNow;
  }

  // Missing / empty / made up.
  expect(await connect(`/terminals/${a}/ws`)).toBe("refused");
  expect(await connect(`/terminals/${a}/ws?ticket=`)).toBe("refused");
  expect(await connect(`/terminals/${a}/ws?ticket=${"0".repeat(64)}`)).toBe("refused");
});

test("terminal WS: ?token= (either token) on the WS path is refused", async () => {
  const id = await newTerminal();
  expect(await connect(`/terminals/${id}/ws?token=${master}`)).toBe("refused");
  expect(await connect(`/terminals/${id}/ws?token=${cli}`)).toBe("refused");
  expect((await fetch(`${APP}/terminals/${id}/ws?token=${master}`)).status).toBe(401);
});

test("terminal WS: only the master can mint a ticket", async () => {
  const id = await newTerminal();
  const viaCli = await fetch(`${APP}/terminals/${id}/ws-ticket`, { method: "POST", headers: bearer(cli) });
  expect(viaCli.status).toBe(403);
  expect(((await viaCli.json()) as { code: string }).code).toBe("desktop-only");
});

// ── disclaimSpawnedAgents value rule ────────────────────────────────────────

const putPref = (base: string, token: string, value: string) =>
  fetch(`${base}/preferences/disclaimSpawnedAgents`, {
    method: "PUT",
    headers: { ...bearer(token), "content-type": "application/json" },
    body: JSON.stringify({ value }),
  });

async function storedDisclaim(): Promise<string | undefined> {
  const res = await fetch(`${APP}/preferences`, { headers: bearer(master) });
  return ((await res.json()) as Record<string, string>)["disclaimSpawnedAgents"];
}

test("disclaim: CLI token + \"false\" is 403 desktop-only and stores nothing (app and headless)", async () => {
  const { setDisclaimSwitch, getDisclaimSwitch } = mods.disclaim;
  for (const base of [APP, HEADLESS]) {
    setDisclaimSwitch(true);
    mods.db.preferences.set("disclaimSpawnedAgents", "true");
    const res = await putPref(base, cli, "false");
    expect(res.status, base).toBe(403);
    expect(await res.json()).toEqual({ error: "only available in the Agetor app", code: "desktop-only" });
    expect(await storedDisclaim()).toBe("true");
    expect(getDisclaimSwitch()).toBe(true);
  }
});

test("disclaim: the CLI token may turn it ON", async () => {
  mods.disclaim.setDisclaimSwitch(true);
  const res = await putPref(APP, cli, "true");
  expect(res.status).toBeLessThan(300);
  expect(res.status).not.toBe(403);
  expect(await storedDisclaim()).toBe("true");
  expect(mods.disclaim.getDisclaimSwitch()).toBe(true);
});

test("disclaim: master on the app stores \"false\" and turns the switch off at once", async () => {
  mods.disclaim.setDisclaimSwitch(true);
  try {
    const res = await putPref(APP, master, "false");
    expect(res.status).toBeLessThan(300);
    expect(await storedDisclaim()).toBe("false");
    expect(mods.disclaim.getDisclaimSwitch()).toBe(false);
  } finally {
    const back = await putPref(APP, master, "true");
    expect(back.status).toBeLessThan(300);
    expect(mods.disclaim.getDisclaimSwitch()).toBe(true);
  }
});

test("disclaim: master on a headless core stores \"false\" but the switch stays on", async () => {
  mods.disclaim.setDisclaimSwitch(true);
  try {
    const res = await putPref(HEADLESS, master, "false");
    expect(res.status).toBeLessThan(300);
    expect(await storedDisclaim()).toBe("false");
    expect(mods.disclaim.getDisclaimSwitch()).toBe(true);
  } finally {
    mods.db.preferences.set("disclaimSpawnedAgents", "true");
    mods.disclaim.setDisclaimSwitch(true);
  }
});

// ── CLI path gate (D24) ─────────────────────────────────────────────────────

const asRoot = typeof process.getuid === "function" && process.getuid() === 0;

test.skipIf(asRoot)("path gate: an unreadable directory is 403 path-not-accessible for the CLI token on POST /projects and GET /files/index; the master is not refused", async () => {
  const locked = path.join(SCRATCH, "locked");
  mkdirSync(locked);
  chmodSync(locked, 0o000);
  try {
    const post = (token: string) =>
      fetch(`${APP}/projects`, {
        method: "POST",
        headers: { ...bearer(token), "content-type": "application/json" },
        body: JSON.stringify({ path: locked }),
      });

    const viaCli = await post(cli);
    expect(viaCli.status).toBe(403);
    const body = (await viaCli.json()) as { code: string; error: string };
    expect(body.code).toBe("path-not-accessible");
    expect(body.error.length).toBeGreaterThan(0);

    const index = await fetch(`${APP}/files/index?dir=${encodeURIComponent(locked)}`, { headers: bearer(cli) });
    expect(index.status).toBe(403);
    expect(((await index.json()) as { code: string }).code).toBe("path-not-accessible");

    // The master keeps today's in-process behavior: the stat succeeds, so the
    // project is registered (not 401/403).
    const viaMaster = await post(master);
    expect([401, 403]).not.toContain(viaMaster.status);
    await viaMaster.text();
    // (No master GET /files/index here: `git` can't be spawned with an
    // unreadable cwd, so that handler throws EACCES for the master today. That
    // is the handler's own error path, not a policy answer.)
    await fetch(`${APP}/projects`, {
      method: "DELETE",
      headers: { ...bearer(master), "content-type": "application/json" },
      body: JSON.stringify({ path: locked }),
    });
  } finally {
    chmodSync(locked, 0o700);
  }
});

test("path gate: a missing path passes the gate — the handler answers with its own error, not 403", async () => {
  const missing = path.join(SCRATCH, "does-not-exist");
  const project = await fetch(`${APP}/projects`, {
    method: "POST",
    headers: { ...bearer(cli), "content-type": "application/json" },
    body: JSON.stringify({ path: missing }),
  });
  expect(project.status).toBe(404);
  expect(((await project.json()) as { error: string }).error).toContain("does not exist");

  const index = await fetch(`${APP}/files/index?dir=${encodeURIComponent(missing)}`, { headers: bearer(cli) });
  expect(index.status).not.toBe(403);
  expect(index.status).not.toBe(401);
  await index.text();
});

test("path gate: a readable directory is registered for the CLI token", async () => {
  const ok = path.join(SCRATCH, "readable");
  mkdirSync(ok);
  const res = await fetch(`${APP}/projects`, {
    method: "POST",
    headers: { ...bearer(cli), "content-type": "application/json" },
    body: JSON.stringify({ path: ok }),
  });
  expect(res.status).toBe(200);
  await res.text();
  await fetch(`${APP}/projects`, {
    method: "DELETE",
    headers: { ...bearer(cli), "content-type": "application/json" },
    body: JSON.stringify({ path: ok }),
  });
});

// Handlers trim some path fields (`createTask`'s workdir, `/projects/clone`'s
// dest), so the gate must refuse a padded spelling of a protected path too —
// otherwise `" /…/locked"` reads as a missing relative path to the probe while
// the handler acts on the absolute one. Driven from the table so a new gated
// route is covered automatically.
test.skipIf(asRoot)("path gate: a whitespace-padded spelling of an unreadable path is refused on every route that declares pathParams", async () => {
  const locked = path.join(SCRATCH, "locked-padded");
  mkdirSync(locked);
  chmodSync(locked, 0o000);
  try {
    type Entry = { callers: string; pathParams?: Array<{ in: "query" | "body"; name: string; mode: string }> };
    const routes: Array<{ method: string; key: string; policy: Entry }> = [];
    for (const [key, entry] of Object.entries(mods.policy.ROUTE_POLICY)) {
      if (typeof (entry as Entry).callers === "string") routes.push({ method: "POST", key, policy: entry as Entry });
      else for (const [method, policy] of Object.entries(entry)) routes.push({ method, key, policy: policy as Entry });
    }
    const gated = routes.filter((r) => r.policy.pathParams?.length);
    expect(gated.length).toBeGreaterThan(10);
    const spellings = [` ${locked}`, `${locked} `, `\t${locked}\n`];
    const problems: string[] = [];
    for (const { method, key, policy } of gated) {
      const url = key.replace(":id", taskId);
      for (const param of policy.pathParams!) {
        for (const raw of spellings) {
          // A nearest-ancestor field names a not-yet-existing child, so only
          // the locked ancestor decides.
          const value = param.mode === "nearest-ancestor" ? `${raw.trimEnd()}/child${raw.slice(raw.trimEnd().length)}` : raw;
          const fieldValue = param.name === "paths" ? [value] : value;
          const target = new URL(`${APP}${url}`);
          let body: string | undefined;
          if (param.in === "query") target.searchParams.set(param.name, value);
          else body = JSON.stringify({ [param.name]: fieldValue });
          const res = await fetch(target, {
            method,
            headers: { ...bearer(cli), ...(body ? { "content-type": "application/json" } : {}) },
            body,
          });
          const code = res.status === 403 ? ((await res.json()) as { code?: string }).code : (await res.text(), undefined);
          if (res.status !== 403 || code !== "path-not-accessible") {
            problems.push(`${method} ${key} ${param.in}.${param.name}=${JSON.stringify(value)} → ${res.status} ${code ?? ""}`);
          }
        }
      }
    }
    expect(problems).toEqual([]);
  } finally {
    chmodSync(locked, 0o700);
  }
  // Every gated route × field × spelling is a sequential request whose path
  // gate probes the raw AND trimmed value in disclaimed child processes —
  // ~2–3 s alone, well past the 5 s default under a full-suite load.
}, 60_000);

// `tmux_source` belongs to the desktop-only POST /tmux-source; the generic
// preference route must not let the CLI token set it either.
test("tmux_source: the CLI token can't set it through PUT /preferences/:key; the master is validated and updates the live source", async () => {
  const tmux = await import("./tmux-resolution.ts");
  const before = mods.db.preferences.get(tmux.TMUX_SOURCE_KEY);
  const put = (token: string, value: string) =>
    fetch(`${APP}/preferences/${tmux.TMUX_SOURCE_KEY}`, {
      method: "PUT",
      headers: { ...bearer(token), "content-type": "application/json" },
      body: JSON.stringify({ value }),
    });
  try {
    const viaCli = await put(cli, "system");
    expect(viaCli.status).toBe(403);
    expect(((await viaCli.json()) as { code: string }).code).toBe("desktop-only");
    expect(mods.db.preferences.get(tmux.TMUX_SOURCE_KEY)).toBe(before);

    const bad = await put(master, "/tmp/evil-tmux");
    expect(bad.status).toBe(400);
    await bad.text();
    expect(mods.db.preferences.get(tmux.TMUX_SOURCE_KEY)).toBe(before);

    const ok = await put(master, "system");
    expect(ok.status).toBe(204);
    expect(mods.db.preferences.get(tmux.TMUX_SOURCE_KEY)).toBe("system");
    expect(tmux.getTmuxSource()).toBe("system");
  } finally {
    // No preference delete exists; an unset key and "system" read the same.
    tmux.setTmuxSource(before === "bundled" ? "bundled" : "system");
  }
});
