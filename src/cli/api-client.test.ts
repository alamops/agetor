import { test, expect } from "bun:test";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureCore, stopDaemon } from "./daemon/supervisor.ts";
import { AgetorClient, ApiError, discoverCore } from "./api-client.ts";
import { coreCredsPath } from "../bun/core-creds.ts";

test("discoverCore returns null when no core is running", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-disc-"));
  expect(await discoverCore(dir)).toBeNull();
});

test("api-client task round-trip + ApiError on 404", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-apic-"));
  const core = await ensureCore({ dataDir: dir, port: 4494 });
  const client = new AgetorClient(core);
  try {
    // createTask returns the BARE Task (regression guard for the {task} bug).
    const task = await client.createTask({
      title: "Round-trip",
      prompt: "p",
      agent: "claude-code",
      isolation: "none",
      workdir: dir,
    });
    expect(typeof task.id).toBe("string");
    expect(task.title).toBe("Round-trip");
    expect(task.column).toBe("backlog");

    expect((await client.getTask(task.id)).id).toBe(task.id);
    expect(await client.listTasks()).toHaveLength(1);

    let err: unknown;
    try {
      await client.getTask("does-not-exist");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);

    await client.deleteTask(task.id);
    expect(await client.listTasks()).toHaveLength(0);
  } finally {
    await stopDaemon(dir);
    for (let i = 0; i < 30 && existsSync(coreCredsPath(dir)); i++) {
      await Bun.sleep(100);
    }
  }
}, 30_000);

// `resumeFxRecovery` (docs/plans/fix-fx-harness-rate-limit.md §3.5) — request
// shape (method/path/no-body) against a bare `Bun.serve` stub standing in for
// the core, since the real `/tasks/:id/fx-resume` route needs a genuinely
// paused fx recovery to answer `{ok:true}` (that end-to-end path belongs to
// `fx-resume-endpoint.test.ts`); this suite only pins what the CLIENT sends
// and how it parses what comes back.
test("resumeFxRecovery: issues POST /tasks/<url-encoded id>/fx-resume with no body, and parses {ok:true, runId}", async () => {
  let captured: { method: string; pathname: string; contentType: string | null; body: string } | null = null;
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      captured = {
        method: req.method,
        pathname: url.pathname,
        contentType: req.headers.get("content-type"),
        body: await req.text(),
      };
      return new Response(JSON.stringify({ ok: true, runId: "run123456" }), {
        headers: { "content-type": "application/json" },
      });
    },
  });
  try {
    const client = new AgetorClient({ port: server.port!, token: "tok" });
    const res = await client.resumeFxRecovery("t 1");
    expect(res).toEqual({ ok: true, runId: "run123456" });
    expect(captured).not.toBeNull();
    expect(captured!.method).toBe("POST");
    // The space in the task id must be percent-encoded into the path — a raw
    // space would produce an invalid request line.
    expect(captured!.pathname).toBe("/tasks/t%201/fx-resume");
    // No body/content-type: `resumeFxRecovery` calls `req()` with no third
    // argument, so `AgetorClient`'s body-presence check (`body !== undefined`)
    // must not synthesize an empty JSON body.
    expect(captured!.contentType).toBeNull();
    expect(captured!.body).toBe("");
  } finally {
    server.stop(true);
  }
});

// A 400 `{error}` response — the shape every gating failure in
// `resumeFxRecovery` (orchestrator.ts) returns — rejects as an `ApiError`
// carrying that exact message, mirroring the file's existing 404 assertion
// above. Driven against a real daemon + a genuine (non-fx) task so this is
// the server's real error text, not a stub's guess.
test("resumeFxRecovery: a 400 {error} response rejects with that message", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-fxresume-"));
  const core = await ensureCore({ dataDir: dir, port: 4496 });
  const client = new AgetorClient(core);
  try {
    const t = await client.createTask({
      title: "Not fx",
      prompt: "p",
      agent: "claude-code",
      isolation: "none",
      workdir: dir,
    });

    let err: unknown;
    try {
      await client.resumeFxRecovery(t.id);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(400);
    expect((err as ApiError).message).toBe("only fx tasks can resume a paused response");
  } finally {
    await stopDaemon(dir);
    for (let i = 0; i < 30 && existsSync(coreCredsPath(dir)); i++) {
      await Bun.sleep(100);
    }
  }
}, 30_000);

// `cancelFxAutoResume` (docs/plans/fx-recovery-follow-ups.md §3.4/T6) —
// mirrors `resumeFxRecovery`'s two-test shape immediately above: a stub
// `Bun.serve` pins the request METHOD/PATH/parse contract, a real daemon +
// a genuine (non-paused) task pins the server's actual 400 error text.
test("cancelFxAutoResume: issues DELETE /tasks/<url-encoded id>/fx-auto-resume with no body, and parses {ok:true}", async () => {
  let captured: { method: string; pathname: string; contentType: string | null; body: string } | null = null;
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      captured = {
        method: req.method,
        pathname: url.pathname,
        contentType: req.headers.get("content-type"),
        body: await req.text(),
      };
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      });
    },
  });
  try {
    const client = new AgetorClient({ port: server.port!, token: "tok" });
    const res = await client.cancelFxAutoResume("t 1");
    expect(res).toEqual({ ok: true });
    expect(captured).not.toBeNull();
    expect(captured!.method).toBe("DELETE");
    // The space in the task id must be percent-encoded into the path — a raw
    // space would produce an invalid request line.
    expect(captured!.pathname).toBe("/tasks/t%201/fx-auto-resume");
    // No body/content-type: `cancelFxAutoResume` calls `req()` with no third
    // argument, so `AgetorClient`'s body-presence check (`body !== undefined`)
    // must not synthesize an empty JSON body.
    expect(captured!.contentType).toBeNull();
    expect(captured!.body).toBe("");
  } finally {
    server.stop(true);
  }
});

// A 400 `{error}` response — the shape the route (`server.ts`'s
// `/tasks/:id/fx-auto-resume` DELETE handler) returns when
// `cancelFxAutoResume(taskId, "cancelled")` finds no pending timer — rejects
// as an `ApiError` carrying that exact message. Driven against a real daemon
// + a genuine (non-fx, never-paused) task, so this is the server's real
// error text, not a stub's guess — mirrors the `resumeFxRecovery` 400 test.
test("cancelFxAutoResume: a 400 {error} response (no auto-resume pending) rejects with that message", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-fxcancel-"));
  const core = await ensureCore({ dataDir: dir, port: 4497 });
  const client = new AgetorClient(core);
  try {
    const t = await client.createTask({
      title: "Not paused",
      prompt: "p",
      agent: "claude-code",
      isolation: "none",
      workdir: dir,
    });

    let err: unknown;
    try {
      await client.cancelFxAutoResume(t.id);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(400);
    expect((err as ApiError).message).toBe("no auto-resume pending");
  } finally {
    await stopDaemon(dir);
    for (let i = 0; i < 30 && existsSync(coreCredsPath(dir)); i++) {
      await Bun.sleep(100);
    }
  }
}, 30_000);

// A 404 for an unknown task id — the route's other error branch (`!tasks.get(taskId)`).
test("cancelFxAutoResume: a 404 response (unknown task id) rejects as ApiError with status 404", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-fxcancel404-"));
  const core = await ensureCore({ dataDir: dir, port: 4498 });
  const client = new AgetorClient(core);
  try {
    let err: unknown;
    try {
      await client.cancelFxAutoResume("does-not-exist");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);
  } finally {
    await stopDaemon(dir);
    for (let i = 0; i < 30 && existsSync(coreCredsPath(dir)); i++) {
      await Bun.sleep(100);
    }
  }
}, 30_000);

test("edit/move/archive/unarchive round-trip returns the bare Task", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-mng-"));
  const core = await ensureCore({ dataDir: dir, port: 4495 });
  const client = new AgetorClient(core);
  try {
    const t = await client.createTask({
      title: "Orig",
      prompt: "p",
      agent: "claude-code",
      isolation: "none",
      workdir: dir,
    });
    // PATCH returns the bare updated Task (same contract as createTask).
    const renamed = await client.patchTask(t.id, { title: "Renamed" });
    expect(renamed.id).toBe(t.id);
    expect(renamed.title).toBe("Renamed");
    expect((await client.patchTask(t.id, { column: "done" })).column).toBe("done");
    expect((await client.archiveTask(t.id)).archivedAt).not.toBeNull();
    expect((await client.unarchiveTask(t.id)).archivedAt).toBeNull();
    await client.deleteTask(t.id);
  } finally {
    await stopDaemon(dir);
    for (let i = 0; i < 30 && existsSync(coreCredsPath(dir)); i++) {
      await Bun.sleep(100);
    }
  }
}, 30_000);

// A `/bundle/*` 2xx that isn't a JSON object (a body cut off or garbled
// after the core committed) must not reach the printers as a raw string.
test("bundle calls: an unreadable 2xx rejects with the lost-answer message", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response("{\"agents\": [", { status: 201, headers: { "content-type": "application/json" } }),
  });
  try {
    const client = new AgetorClient({ port: server.port!, token: "tok" });
    const err = await client.importBundle("{}").then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toContain("the import may have run");
    expect((err as ApiError).message).toContain("agetor profile ls");
    const preview = await client.previewBundleImport("{}").then(
      () => null,
      (e: unknown) => e,
    );
    expect((preview as ApiError).message).toBe("the core's answer to the preview was lost — try again");
    const exported = await client.exportBundle({ all: true }).then(
      () => null,
      (e: unknown) => e,
    );
    expect((exported as ApiError).message).toBe("the core's answer to the export was lost — try again");
  } finally {
    server.stop(true);
  }
});

// An import that got no answer at all (a dropped socket, a timeout) may still
// have committed, so it reads as lost — never as a plain "cannot reach core"
// that invites a rerun. Preview/export keep `req`'s own text.
test("bundle calls: an import with no answer rejects with the lost-answer message", async () => {
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket) {
        socket.end();
      },
    },
  });
  try {
    const client = new AgetorClient({ port: listener.port, token: "tok" });
    const err = await client.importBundle("{}").then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(0);
    expect((err as ApiError).message).toContain("the import may have run");
    expect((err as ApiError).message).toContain("cannot reach core (POST /bundle/import)");
    const preview = await client.previewBundleImport("{}").then(
      () => null,
      (e: unknown) => e,
    );
    expect((preview as ApiError).status).toBe(0);
    expect((preview as ApiError).message).toContain("cannot reach core (POST /bundle/import/preview)");
  } finally {
    listener.stop(true);
  }
});

test("bundle calls: an HTTP error answer keeps the core's own message", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () => Response.json({ error: "import failed — nothing was imported: boom" }, { status: 500 }),
  });
  try {
    const client = new AgetorClient({ port: server.port!, token: "tok" });
    const err = await client.importBundle("{}").then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as ApiError).status).toBe(500);
    expect((err as ApiError).message).toBe("import failed — nothing was imported: boom");
  } finally {
    server.stop(true);
  }
});

// The core's 403 refusals (`desktop-only`, `path-not-accessible`) carry a
// machine-readable `code` next to the plain sentence. `ApiError` exposes the
// code and keeps `message` as just the sentence, so the CLI's central printer
// shows it with no "HTTP 403" noise. A stub server on an ephemeral port keeps
// this off the fixed-port daemon tests.
test("ApiError exposes the 403 body's code and a plain message", async () => {
  const bodies: Record<string, unknown> = {
    "/a": { error: "only available in the Agetor app", code: "desktop-only" },
    "/b": { error: "This path isn't accessible to Agetor's CLI token.", code: "path-not-accessible" },
    "/c": { error: "plain refusal" },
  };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const b = bodies[new URL(req.url).pathname];
      return b ? Response.json(b, { status: 403 }) : new Response("nope", { status: 404 });
    },
  });
  try {
    const client = new AgetorClient({ port: server.port as number, token: "t" });
    const call = async (path: string) => {
      try {
        // Reach the private `req` the same way every public method does.
        await (client as unknown as { req(m: string, p: string): Promise<unknown> }).req("GET", path);
      } catch (e) {
        return e as ApiError;
      }
      throw new Error("expected a rejection");
    };

    const a = await call("/a");
    expect(a).toBeInstanceOf(ApiError);
    expect(a.status).toBe(403);
    expect(a.code).toBe("desktop-only");
    expect(a.message).toBe("only available in the Agetor app");

    const b = await call("/b");
    expect(b.code).toBe("path-not-accessible");
    expect(b.message).toBe("This path isn't accessible to Agetor's CLI token.");

    // No code in the body (or no JSON body at all) → undefined, message unchanged.
    expect((await call("/c")).code).toBeUndefined();
    const d = await call("/missing");
    expect(d.code).toBeUndefined();
    expect(d.status).toBe(404);
  } finally {
    server.stop(true);
  }
});

// Review S21: the stack create/edit routes mirror the primary's config inline
// with the server's idle timeout off. The default 15 s budget aborted the CLI
// after the stack was saved, so the client must use the long budget, and a
// no-answer failure must say the stack may already exist.
test("createHarnessStack / patchHarnessStack use the long mirror budget, and a transport failure says the stack may be saved", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: async () =>
      new Response(JSON.stringify({ stack: { id: "s1" }, warnings: [], mirror: { copied: [], warnings: [] } }), {
        headers: { "content-type": "application/json" },
      }),
  });
  const realTimeout = AbortSignal.timeout;
  const budgets: number[] = [];
  AbortSignal.timeout = ((ms: number) => {
    budgets.push(ms);
    return realTimeout.call(AbortSignal, ms);
  }) as typeof AbortSignal.timeout;
  try {
    const client = new AgetorClient({ port: server.port!, token: "tok" });
    await client.createHarnessStack({ label: "T", kind: "claude-code", members: ["a", "b"] });
    await client.patchHarnessStack("s1", { members: ["b", "a"] });
    await client.listHarnessStacks().catch(() => null);
    expect(budgets).toHaveLength(3);
    expect(budgets[0]).toBe(15 * 60_000);
    expect(budgets[1]).toBe(15 * 60_000);
    // Plain reads keep the default budget.
    expect(budgets[2]).toBe(15_000);
  } finally {
    AbortSignal.timeout = realTimeout;
    server.stop(true);
  }

  // A core that is gone: no answer at all → status 0 with the save hint.
  const dead = Bun.serve({ port: 0, fetch: () => new Response("") });
  const deadPort = dead.port!;
  dead.stop(true);
  const client = new AgetorClient({ port: deadPort, token: "tok" });
  let err: unknown;
  try {
    await client.createHarnessStack({ label: "T", kind: "claude-code", members: ["a"] });
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).status).toBe(0);
  expect((err as ApiError).message).toContain("may have been saved");
  err = undefined;
  try {
    await client.patchHarnessStack("s1", { label: "U" });
  } catch (e) {
    err = e;
  }
  expect((err as ApiError).message).toContain("may have been saved");
});

test("ids are URL-encoded; switch/preview/restore/agent-patch use the long budget; a lost switch says it may have gone through", async () => {
  const seen: { method: string; url: string }[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const u = new URL(req.url);
      seen.push({ method: req.method, url: u.pathname + u.search });
      return new Response(JSON.stringify({}), { headers: { "content-type": "application/json" } });
    },
  });
  const realTimeout = AbortSignal.timeout;
  const budgets: number[] = [];
  AbortSignal.timeout = ((ms: number) => {
    budgets.push(ms);
    return realTimeout.call(AbortSignal, ms);
  }) as typeof AbortSignal.timeout;
  try {
    const client = new AgetorClient({ port: server.port!, token: "tok" });
    const odd = "a/b c?#";
    const enc = encodeURIComponent(odd);
    await client.getHarnessStack(odd);
    await client.deleteHarnessStack(odd);
    await client.patchHarnessStack(odd, { label: "x", expectedUpdatedAt: 5 });
    await client.getTask(odd);
    await client.harnessUsage(odd);
    await client.getHarnessStackHistory(odd, { limit: 10, before: "cur sor" });
    await client.clearHarnessCooldown(odd, { model: "m/1" });
    await client.switchTaskAccount(odd);
    await client.cancelScheduledAccountSwitch(odd);
    await client.restoreHarnessMirror(odd);
    await client.previewHarnessMirror({ kind: "claude-code", members: ["a", "b"] });
    await client.patchTask(odd, { agent: "b" });
    await client.patchTask(odd, { title: "t" });
    await client.getUsage();
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      `GET /harness-stacks/${enc}`,
      `DELETE /harness-stacks/${enc}`,
      `PATCH /harness-stacks/${enc}`,
      `GET /tasks/${enc}`,
      `GET /harnesses/${enc}/usage`,
      `GET /harness-stacks/${enc}/history?limit=10&before=cur+sor`,
      `DELETE /harnesses/${enc}/limit-state?model=${encodeURIComponent("m/1")}`,
      `POST /tasks/${enc}/switch-account`,
      `DELETE /tasks/${enc}/switch-account`,
      `POST /harnesses/${enc}/mirror-restore`,
      `POST /harness-stacks/mirror-preview`,
      `PATCH /tasks/${enc}`,
      `PATCH /tasks/${enc}`,
      `GET /usage`,
    ]);
    const long = 15 * 60_000;
    expect(budgets[2]).toBe(long); // patchHarnessStack
    expect(budgets[7]).toBe(long); // switchTaskAccount
    expect(budgets[9]).toBe(long); // restore
    expect(budgets[10]).toBe(long); // preview
    expect(budgets[11]).toBe(long); // agent patch
    expect(budgets[12]).toBe(15_000); // plain patch keeps the default
  } finally {
    AbortSignal.timeout = realTimeout;
    server.stop(true);
  }

  const dead = Bun.serve({ port: 0, fetch: () => new Response("") });
  const deadPort = dead.port!;
  dead.stop(true);
  const client = new AgetorClient({ port: deadPort, token: "tok" });
  for (const call of [() => client.switchTaskAccount("t1"), () => client.patchTask("t1", { agent: "b" })]) {
    let err: unknown;
    try {
      await call();
    } catch (e) {
      err = e;
    }
    expect((err as ApiError).status).toBe(0);
    expect((err as ApiError).message).toContain("the switch may have gone through; check 'agetor show t1' before retrying");
  }
});

// ── TT-E: finding 20 (encoding) and the stack/switch budgets ─────────────────

/** A stub core that records the raw request line and answers `{}` (or `reply`). */
function stubCore(reply: () => Response = () => new Response("{}", { headers: { "content-type": "application/json" } })) {
  const seen: { method: string; pathname: string; search: string }[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const u = new URL(req.url);
      seen.push({ method: req.method, pathname: u.pathname, search: u.search });
      return reply();
    },
  });
  return { seen, server, client: new AgetorClient({ port: server.port!, token: "tok" }) };
}

test("finding 20: every id-taking stack / harness / switch / task method percent-encodes `../x`, `100%`, `a/b` and `%2e%2e` into ONE path segment", async () => {
  const { seen, server, client } = stubCore();
  try {
    const ids = ["../x", "100%", "a/b", "%2e%2e", "a b", "x?y#z"];
    const calls: [string, (id: string) => Promise<unknown>, (e: string) => string][] = [
      ["GET", (id) => client.getHarnessStack(id), (e) => `/harness-stacks/${e}`],
      ["PATCH", (id) => client.patchHarnessStack(id, { label: "x" }), (e) => `/harness-stacks/${e}`],
      ["DELETE", (id) => client.deleteHarnessStack(id), (e) => `/harness-stacks/${e}`],
      ["GET", (id) => client.getHarnessStackHistory(id), (e) => `/harness-stacks/${e}/history`],
      ["DELETE", (id) => client.clearHarnessCooldown(id), (e) => `/harnesses/${e}/limit-state`],
      ["POST", (id) => client.restoreHarnessMirror(id), (e) => `/harnesses/${e}/mirror-restore`],
      ["PATCH", (id) => client.patchHarness(id, { label: "x" }), (e) => `/harnesses/${e}`],
      ["DELETE", (id) => client.deleteHarness(id), (e) => `/harnesses/${e}`],
      ["GET", (id) => client.harnessUsage(id), (e) => `/harnesses/${e}/usage`],
      ["POST", (id) => client.switchTaskAccount(id), (e) => `/tasks/${e}/switch-account`],
      ["DELETE", (id) => client.cancelScheduledAccountSwitch(id), (e) => `/tasks/${e}/switch-account`],
      ["PATCH", (id) => client.patchTask(id, { agent: "b" }), (e) => `/tasks/${e}`],
      ["PATCH", (id) => client.patchTask(id, { title: "t" }), (e) => `/tasks/${e}`],
    ];
    for (const id of ids) {
      for (const [method, run, expected] of calls) {
        seen.length = 0;
        await run(id);
        expect(seen, `${method} ${expected(id)}`).toHaveLength(1);
        expect(seen[0]!.method).toBe(method);
        expect(seen[0]!.pathname).toBe(expected(encodeURIComponent(id)));
        // The id never leaks into the query string or splits the path.
        expect(seen[0]!.search).toBe("");
        expect(seen[0]!.pathname.split("/").length).toBe(expected("x").split("/").length);
      }
    }
  } finally {
    server.stop(true);
  }
});

test("budgets: create/patch stack, preview, restore, switch and an agent patch get the 15-minute budget; history, cooldown clear, cancel and a plain patch keep the default", async () => {
  const { server, client } = stubCore();
  const realTimeout = AbortSignal.timeout;
  const budgets: Record<string, number> = {};
  let label = "";
  AbortSignal.timeout = ((ms: number) => {
    budgets[label] = ms;
    return realTimeout.call(AbortSignal, ms);
  }) as typeof AbortSignal.timeout;
  try {
    const run = async (name: string, fn: () => Promise<unknown>) => {
      label = name;
      await fn();
    };
    await run("create", () => client.createHarnessStack({ label: "T", kind: "claude-code", members: ["a"] }));
    await run("patchStack", () => client.patchHarnessStack("s", { label: "x" }));
    await run("preview", () => client.previewHarnessMirror({ kind: "claude-code", members: ["a", "b"] }));
    await run("restore", () => client.restoreHarnessMirror("a"));
    await run("switch", () => client.switchTaskAccount("t"));
    await run("agentPatch", () => client.patchTask("t", { agent: "b" }));
    await run("history", () => client.getHarnessStackHistory("s"));
    await run("cooldown", () => client.clearHarnessCooldown("a", { accountWideOnly: true }));
    await run("cancel", () => client.cancelScheduledAccountSwitch("t"));
    await run("plainPatch", () => client.patchTask("t", { title: "x" }));
    const long = 15 * 60_000;
    for (const k of ["create", "patchStack", "preview", "restore", "switch", "agentPatch"]) expect(budgets[k], k).toBe(long);
    for (const k of ["history", "cooldown", "cancel", "plainPatch"]) expect(budgets[k], k).toBe(15_000);
  } finally {
    AbortSignal.timeout = realTimeout;
    server.stop(true);
  }
});

test("a switch 409 refusal reaches the caller untouched (status, body, message); only a lost answer gets the 'may have gone through' note", async () => {
  const refusal = { error: "no other account in the stack can take this task right now (B: cooling)", code: "no-usable-member", reasons: [{ harnessId: "b", label: "B", reason: "cooling" }] };
  const { server, client } = stubCore(() => new Response(JSON.stringify(refusal), { status: 409, headers: { "content-type": "application/json" } }));
  try {
    for (const call of [() => client.switchTaskAccount("t1"), () => client.patchTask("t1", { agent: "b" })]) {
      let err: unknown;
      try {
        await call();
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(409);
      expect((err as ApiError).body).toEqual(refusal);
      expect((err as ApiError).message).toBe(refusal.error);
      expect((err as ApiError).message).not.toContain("may have gone through");
    }
  } finally {
    server.stop(true);
  }
  // The stack writes keep their own wording and a lost patch of a non-agent field has none.
  const dead = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = dead.port!;
  dead.stop(true);
  const lost = new AgetorClient({ port, token: "tok" });
  let plain: unknown;
  try {
    await lost.patchTask("t1", { title: "x" });
  } catch (e) {
    plain = e;
  }
  expect((plain as ApiError).status).toBe(0);
  expect((plain as ApiError).message).not.toContain("may have gone through");
});
