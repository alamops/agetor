import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BranchNamingConfig } from "../shared/types.ts";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-project-settings-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_API_PORT = "4401";

let server: { stop: () => void; port: number };
let token: string;
let projects: typeof import("./db.ts").projects;

beforeAll(async () => {
  ({ projects } = await import("./db.ts"));
  const { startApiServer, API_TOKEN } = await import("./server.ts");
  server = startApiServer() as unknown as { stop: () => void; port: number };
  token = API_TOKEN;
});

afterAll(() => {
  server?.stop?.();
});

const url = (p: string) => `http://127.0.0.1:4401${p}`;
// Built lazily — `token` is only assigned in beforeAll, after module load.
const auth = () => ({ authorization: `Bearer ${token}` });

test("GET /projects/settings returns built-in defaults for an unknown project", async () => {
  const res = await fetch(url(`/projects/settings?path=${encodeURIComponent("/nope")}`), { headers: auth() });
  expect(res.status).toBe(200);
  const cfg = (await res.json()) as BranchNamingConfig;
  expect(cfg.rules.task.prefix).toBe("feature/");
  expect(cfg.rules.bug.prefix).toBe("fix/");
  expect(cfg.includeSlug).toBe(true);
});

test("PUT /projects/settings persists a validated config", async () => {
  const p = "/tmp/agetor-settings-project";
  projects.upsert(p, "proj");
  const config: BranchNamingConfig = {
    includeSlug: false,
    rules: { task: { prefix: "features/" }, bug: { prefix: "hotfix/" }, spike: { prefix: "poc/" } },
  };
  const res = await fetch(url("/projects/settings"), {
    method: "PUT",
    headers: { ...auth(), "content-type": "application/json" },
    body: JSON.stringify({ path: p, config }),
  });
  expect(res.status).toBe(200);

  // Round-trips back out of the DB.
  expect(projects.get(p)?.branchConfig?.rules.task.prefix).toBe("features/");
  const get = await fetch(url(`/projects/settings?path=${encodeURIComponent(p)}`), { headers: auth() });
  const back = (await get.json()) as BranchNamingConfig;
  expect(back.rules.bug.prefix).toBe("hotfix/");
  expect(back.includeSlug).toBe(false);
});

test("PUT /projects/settings rejects a prefix that yields an illegal branch", async () => {
  const p = "/tmp/agetor-settings-project";
  projects.upsert(p, "proj");
  const res = await fetch(url("/projects/settings"), {
    method: "PUT",
    headers: { ...auth(), "content-type": "application/json" },
    body: JSON.stringify({
      path: p,
      config: { includeSlug: true, rules: { task: { prefix: "bad prefix/" }, bug: { prefix: "fix/" }, spike: { prefix: "spike/" } } },
    }),
  });
  expect(res.status).toBe(400);
});

test("PUT /projects/settings 404s for an unregistered project", async () => {
  const res = await fetch(url("/projects/settings"), {
    method: "PUT",
    headers: { ...auth(), "content-type": "application/json" },
    body: JSON.stringify({
      path: "/definitely/not/registered",
      config: { includeSlug: true, rules: { task: { prefix: "feature/" }, bug: { prefix: "fix/" }, spike: { prefix: "spike/" } } },
    }),
  });
  expect(res.status).toBe(404);
});
