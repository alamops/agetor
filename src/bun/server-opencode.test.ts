import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentProfile, AppEvent, Task } from "../shared/types.ts";
import { OPENCODE_SERVER_INPUT_ERROR } from "../shared/opencode.ts";
import { rmTestDataDir } from "./test-data-dir.ts";

// HTTP surface of the OpenCode harness (docs/plans/add-opencode-harness.md
// W2-T2): the `opencode` kind on `POST /harnesses`, `opencodeServer`
// validation on every launch route, the bound-profile 409, the D-14
// auto-enable hook in `GET /harnesses`, and the `/opencode-sessions*` routes
// against a stubbed `opencode` CLI. Port 4671 is used by no other test file.
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-server-opencode-"));
process.env.AGETOR_DATA_DIR ??= DATA_DIR;
process.env.AGETOR_CLAUDE_DRIVER ??= "fake";
process.env.AGETOR_CLAUDE_BIN ??= "/bin/echo";
process.env.AGETOR_TMUX_BIN ??= "/bin/echo";

const PORT = "4671";
const BASE = `http://127.0.0.1:${PORT}`;
const FIXTURES = path.join(import.meta.dir, "fixtures", "opencode");

/** The parent session of `v2-session-export.json`: the stub exports it. */
const SESSION_OK = "ses_e8261398affehUf22D8iOXNtgS";
/** Listed under a directory that doesn't exist. */
const SESSION_GONE = "ses_e8261a325ffe6fHIVNDgP5Dw0o";

const scratch = mkdtempSync(path.join(tmpdir(), "agetor-server-opencode-scratch-"));
const projectDir = path.join(scratch, "project");
mkdirSync(projectDir, { recursive: true });
const listFile = path.join(scratch, "session-list.json");
// Old `updated` stamps keep both rows out of the scanner's busy window, so
// listing never runs an export.
writeFileSync(listFile, JSON.stringify([
  { id: SESSION_OK, title: "imported over http", updated: 1_700_000_100_000, created: 1_700_000_000_000, projectId: "global", directory: projectDir },
  { id: SESSION_GONE, updated: 1_700_000_050_000, created: 1_700_000_000_000, projectId: "global", directory: path.join(scratch, "gone") },
]));

const opencodeBin = path.join(scratch, "opencode");
writeFileSync(
  opencodeBin,
  [
    "#!/bin/sh",
    'if [ "$1" = "--version" ]; then cat "' + path.join(FIXTURES, "v2-version.txt") + '"; exit 0; fi',
    'if [ "$1" = "auth" ]; then echo "[]"; exit 0; fi',
    'if [ "$1" = "session" ] && [ "$2" = "list" ]; then cat "' + listFile + '"; exit 0; fi',
    'if [ "$1" = "session" ] && [ "$2" = "export" ]; then',
    '  for a in "$@"; do id="$a"; done',
    '  if [ "$id" = "' + SESSION_OK + '" ]; then cat "' + path.join(FIXTURES, "v2-session-export.json") + '"; exit 0; fi',
    "  exit 1",
    "fi",
    "exit 1",
    "",
  ].join("\n"),
  { mode: 0o755 },
);
const codexBin = path.join(scratch, "codex");
writeFileSync(codexBin, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex-cli 0.159.2"; exit 0; fi\nexit 1\n', { mode: 0o755 });

const ENV_KEYS = [
  "AGETOR_OPENCODE_BIN",
  "AGETOR_CODEX_BIN",
  "AGETOR_CURSOR_BIN",
  "AGETOR_GEMINI_BIN",
  "AGETOR_FX_BIN",
  "AGETOR_HARNESS_AUTO_ENABLE",
] as const;
const savedEnv = new Map<string, string | undefined>();

let token = "";
let stop: (() => void) | null = null;
let db: typeof import("./db.ts");
let restoreHarnesses: (() => void) | undefined;
let unsubscribe: (() => void) | null = null;
const appEvents: AppEvent[] = [];

beforeAll(async () => {
  for (const k of ENV_KEYS) savedEnv.set(k, process.env[k]);
  process.env.AGETOR_OPENCODE_BIN = opencodeBin;
  process.env.AGETOR_CODEX_BIN = codexBin;
  // Kept unavailable so a CLI installed on this machine can't join the
  // auto-enable assertions below.
  process.env.AGETOR_CURSOR_BIN = path.join(scratch, "missing-cursor-agent");
  process.env.AGETOR_GEMINI_BIN = path.join(scratch, "missing-gemini");
  process.env.AGETOR_FX_BIN = path.join(scratch, "missing-fx");
  delete process.env.AGETOR_HARNESS_AUTO_ENABLE;

  db = await import("./db.ts");
  restoreHarnesses = (await import("./test-harness-state.ts")).snapshotHarnessState();
  const server = await import("./server.ts");
  const { subscribeAppEvents } = await import("./quit-guard.ts");
  token = server.API_TOKEN;
  process.env.AGETOR_API_PORT = PORT;
  const started = server.startApiServer() as unknown as { stop: () => void };
  stop = () => started.stop();
  unsubscribe = subscribeAppEvents((e) => appEvents.push(e));
});

afterAll(() => {
  restoreHarnesses?.();
  unsubscribe?.();
  stop?.();
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(scratch, { recursive: true, force: true });
  rmTestDataDir(DATA_DIR);
});

function call(method: string, p: string, body?: unknown): Promise<Response> {
  return fetch(`${BASE}${p}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function createTask(extra: Record<string, unknown> = {}): Promise<Response> {
  return call("POST", "/tasks", {
    title: "opencode server option",
    prompt: "hello",
    agent: "claude-code",
    workdir: projectDir,
    isolation: "none",
    ...extra,
  });
}

let profileSeq = 0;
async function createProfile(extra: Record<string, unknown> = {}): Promise<Response> {
  profileSeq++;
  return call("POST", "/agent-profiles", {
    name: `OpenCode profile ${profileSeq}`,
    harness: "opencode",
    model: "opencode/big-pickle",
    ...extra,
  });
}

describe("POST /harnesses", () => {
  test("accepts kind opencode", async () => {
    const res = await call("POST", "/harnesses", { id: "opencode-2", kind: "opencode", label: "OpenCode (work)" });
    expect(res.status).toBeLessThan(300);
    expect(db.harnesses.get("opencode-2")?.kind).toBe("opencode");
    db.harnesses.delete("opencode-2");
  });

  test("an unknown kind names opencode in the error", async () => {
    const res = await call("POST", "/harnesses", { id: "nope", kind: "nope", label: "Nope" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("'opencode'");
  });
});

describe("opencodeServer validation", () => {
  test("POST /tasks: junk is a 400, a valid value is stored, omitted is shared", async () => {
    for (const junk of ["bogus", 1, null, true]) {
      const res = await createTask({ opencodeServer: junk });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe(OPENCODE_SERVER_INPUT_ERROR);
    }
    const standalone = (await (await createTask({ opencodeServer: "standalone" })).json()) as Task;
    expect(standalone.opencodeServer).toBe("standalone");
    const omitted = (await (await createTask()).json()) as Task;
    expect(omitted.opencodeServer).toBe("shared");
  });

  test("PATCH /tasks/:id: junk is a 400 and leaves the row alone; a valid value applies", async () => {
    const task = (await (await createTask()).json()) as Task;
    const bad = await call("PATCH", `/tasks/${task.id}`, { opencodeServer: "remote" });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe(OPENCODE_SERVER_INPUT_ERROR);
    expect(db.tasks.get(task.id)?.opencodeServer).toBe("shared");
    const ok = await call("PATCH", `/tasks/${task.id}`, { opencodeServer: "standalone" });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as Task).opencodeServer).toBe("standalone");
  });

  test("POST and PATCH /agent-profiles", async () => {
    const bad = await createProfile({ opencodeServer: "both" });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe(OPENCODE_SERVER_INPUT_ERROR);

    const shared = (await (await createProfile()).json()) as AgentProfile;
    expect(shared.opencodeServer).toBe("shared");
    const standalone = (await (await createProfile({ opencodeServer: "standalone" })).json()) as AgentProfile;
    expect(standalone.opencodeServer).toBe("standalone");

    const badPatch = await call("PATCH", `/agent-profiles/${shared.id}`, { opencodeServer: 7 });
    expect(badPatch.status).toBe(400);
    expect(db.agentProfiles.get(shared.id)?.opencodeServer).toBe("shared");
    const patched = await call("PATCH", `/agent-profiles/${shared.id}`, { opencodeServer: "standalone" });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as AgentProfile).opencodeServer).toBe("standalone");
    // A PATCH that omits it leaves it alone.
    const renamed = await call("PATCH", `/agent-profiles/${shared.id}`, { name: `Renamed ${shared.id}` });
    expect(((await renamed.json()) as AgentProfile).opencodeServer).toBe("standalone");
  });

  test("POST /agent-profiles/:id/duplicate copies it unless the body overrides it", async () => {
    const source = (await (await createProfile({ opencodeServer: "standalone" })).json()) as AgentProfile;
    const bad = await call("POST", `/agent-profiles/${source.id}/duplicate`, { opencodeServer: "nope" });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe(OPENCODE_SERVER_INPUT_ERROR);

    const copied = await call("POST", `/agent-profiles/${source.id}/duplicate`, {});
    expect(copied.status).toBe(201);
    expect(((await copied.json()) as { profile: AgentProfile }).profile.opencodeServer).toBe("standalone");

    const overridden = await call("POST", `/agent-profiles/${source.id}/duplicate`, { opencodeServer: "shared" });
    expect(((await overridden.json()) as { profile: AgentProfile }).profile.opencodeServer).toBe("shared");
  });

  test("POST /projects/clone refuses a bad launch value before cloning anything", async () => {
    const dest = path.join(scratch, "clone-dest");
    const res = await call("POST", "/projects/clone", { url: "owner/repo", dest, opencodeServer: "everywhere" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(OPENCODE_SERVER_INPUT_ERROR);
    expect(existsSync(dest)).toBe(false);
  });
});

describe("bound-profile lock", () => {
  test("a profile's value overrides the body, and a differing PATCH 409s", async () => {
    const profile = (await (await createProfile({ harness: "claude-code", model: "claude-opus-5-5" })).json()) as AgentProfile;
    expect(profile.opencodeServer).toBe("shared");
    const created = await createTask({ agentProfileId: profile.id, opencodeServer: "standalone" });
    expect(created.status).toBe(200);
    const task = (await created.json()) as Task;
    expect(task.agentProfileId).toBe(profile.id);
    expect(task.opencodeServer).toBe("shared");

    const refused = await call("PATCH", `/tasks/${task.id}`, { opencodeServer: "standalone" });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toContain("detach it first");
    // A same-value resend is a no-op and passes.
    const same = await call("PATCH", `/tasks/${task.id}`, { opencodeServer: "shared" });
    expect(same.status).toBe(200);
  });
});

describe("GET /harnesses auto-enable (D-14)", () => {
  function setDisabled(): void {
    db.harnesses.setEnabled("codex", false);
    db.harnesses.setEnabled("opencode", false);
  }

  test("off under bun test without the seam: nothing flips, nothing is recorded", async () => {
    setDisabled();
    const res = await call("GET", "/harnesses");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { harnesses: { id: string; enabled: boolean }[]; statuses: { harnessId: string; available: boolean }[] };
    expect(body.statuses.find((s) => s.harnessId === "opencode")?.available).toBe(true);
    expect(body.statuses.find((s) => s.harnessId === "codex")?.available).toBe(true);
    expect(body.harnesses.find((h) => h.id === "opencode")?.enabled).toBe(false);
    expect(body.harnesses.find((h) => h.id === "codex")?.enabled).toBe(false);
    expect(db.harnessAutoEnabled.has("opencode")).toBe(false);
    expect(db.harnessAutoEnabled.has("codex")).toBe(false);
  });

  test("with the seam on: the response already shows the flipped rows and a live notice goes out", async () => {
    setDisabled();
    process.env.AGETOR_HARNESS_AUTO_ENABLE = "1";
    try {
      const before = appEvents.length;
      const res = await call("GET", "/harnesses");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { harnesses: { id: string; enabled: boolean }[] };
      expect(body.harnesses.find((h) => h.id === "opencode")?.enabled).toBe(true);
      expect(body.harnesses.find((h) => h.id === "codex")?.enabled).toBe(true);
      expect(db.harnessAutoEnabled.has("opencode")).toBe(true);

      const notice = appEvents.slice(before).find(
        (e): e is Extract<AppEvent, { type: "harnesses_auto_enabled" }> => e.type === "harnesses_auto_enabled",
      );
      expect(notice?.harnessIds).toEqual(expect.arrayContaining(["codex", "opencode"]));
      // Delivered live, so nothing is left for the next /app/events client.
      expect(db.harnessAutoEnabled.pending()).not.toContain("opencode");

      // A later manual Off sticks: the recorded row is never acted on again.
      db.harnesses.setEnabled("opencode", false);
      const again = (await (await call("GET", "/harnesses")).json()) as { harnesses: { id: string; enabled: boolean }[] };
      expect(again.harnesses.find((h) => h.id === "opencode")?.enabled).toBe(false);
    } finally {
      delete process.env.AGETOR_HARNESS_AUTO_ENABLE;
    }
  });
});

describe("/opencode-sessions", () => {
  beforeAll(() => {
    db.harnesses.setEnabled("opencode", true);
    db.projects.upsert(projectDir, "project");
  });

  test("GET lists the stubbed CLI's sessions with their refusal reason", async () => {
    const res = await call("GET", "/opencode-sessions");
    expect(res.status).toBe(200);
    const { sessions } = (await res.json()) as { sessions: { sessionId: string; harnessId: string; importable: boolean; blockedReason: string | null; title: string | null }[] };
    const ok = sessions.find((s) => s.sessionId === SESSION_OK);
    expect(ok).toMatchObject({ harnessId: "opencode", importable: true, blockedReason: null, title: "imported over http" });
    const gone = sessions.find((s) => s.sessionId === SESSION_GONE);
    expect(gone).toMatchObject({ importable: false, blockedReason: "missing-folder", title: null });
  });

  test("POST /recheck answers the same shape", async () => {
    const res = await call("POST", "/opencode-sessions/recheck");
    expect(res.status).toBe(200);
    const { sessions } = (await res.json()) as { sessions: { sessionId: string }[] };
    expect(sessions.map((s) => s.sessionId)).toEqual(expect.arrayContaining([SESSION_OK, SESSION_GONE]));
  });

  test("POST /import refuses a bad body", async () => {
    for (const body of [null, {}, { ids: "ses_x" }, { ids: [1] }, { ids: [SESSION_OK], harnessId: 3 }, { ids: [SESSION_OK], harnessId: "" }]) {
      const res = await call("POST", "/opencode-sessions/import", body);
      expect(res.status).toBe(400);
    }
  });

  test("POST /import reports a per-id refusal for a missing folder and an unknown harness", async () => {
    const gone = await call("POST", "/opencode-sessions/import", { ids: [SESSION_GONE] });
    expect(gone.status).toBe(200);
    const goneBody = (await gone.json()) as { results: { id: string; taskId?: string; error?: string }[] };
    expect(goneBody.results[0]?.taskId).toBeUndefined();
    expect(goneBody.results[0]?.error).toBeTruthy();

    const wrong = await call("POST", "/opencode-sessions/import", { ids: [SESSION_OK], harnessId: "claude-code" });
    const wrongBody = (await wrong.json()) as { results: { id: string; error?: string }[] };
    expect(wrongBody.results[0]?.error).toContain("unknown OpenCode harness");
  });

  test("POST /import imports, then the retry route refuses a ready import and a plain task", async () => {
    const res = await call("POST", "/opencode-sessions/import", { ids: [SESSION_OK] });
    expect(res.status).toBe(200);
    const { results } = (await res.json()) as { results: { id: string; taskId?: string; error?: string }[] };
    expect(results[0]?.error).toBeUndefined();
    const taskId = results[0]!.taskId!;
    expect(taskId).toBeTruthy();

    const { pendingOpencodeImportBackfill } = await import("./opencode-session-import.ts");
    await pendingOpencodeImportBackfill(taskId);
    const task = db.tasks.get(taskId)!;
    expect(task.importedOpencode?.sessionId).toBe(SESSION_OK);
    expect(task.importedOpencode?.status).toBe("ready");
    expect(task.column).toBe("review");

    // A second import of the same id is refused per id.
    const twice = (await (await call("POST", "/opencode-sessions/import", { ids: [SESSION_OK] })).json()) as { results: { error?: string }[] };
    expect(twice.results[0]?.error).toBeTruthy();
    // The imported session is owned now, so the list hides it.
    const listed = (await (await call("POST", "/opencode-sessions/recheck")).json()) as { sessions: { sessionId: string }[] };
    expect(listed.sessions.map((s) => s.sessionId)).not.toContain(SESSION_OK);

    const notFailed = await call("POST", `/tasks/${taskId}/opencode-session/retry`);
    expect(notFailed.status).toBe(400);
    expect(((await notFailed.json()) as { error: string }).error).toBe("import is not failed");

    const plain = (await (await createTask()).json()) as Task;
    const notImported = await call("POST", `/tasks/${plain.id}/opencode-session/retry`);
    expect(notImported.status).toBe(400);
    expect(((await notImported.json()) as { error: string }).error).toBe("task is not an imported session");

    const missing = await call("POST", "/tasks/does-not-exist/opencode-session/retry");
    expect(missing.status).toBe(404);
  });

  test("POST retry re-runs a failed import", async () => {
    // Fail a fresh import by flipping its provenance, then retry it through
    // the route: the stub still exports the session, so it comes back ready.
    const imported = db.tasks.list().find((t) => t.importedOpencode?.sessionId === SESSION_OK)!;
    db.tasks.setImportedOpencode(imported.id, { ...imported.importedOpencode!, status: "failed", error: "boom" });
    const res = await call("POST", `/tasks/${imported.id}/opencode-session/retry`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(db.tasks.get(imported.id)?.importedOpencode?.status).toBe("ready");
  });
});
