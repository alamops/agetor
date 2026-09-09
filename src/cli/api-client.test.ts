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
