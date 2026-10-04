import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IssueTaskTemplate, Project } from "../shared/types.ts";

// Set AGETOR_DATA_DIR BEFORE importing db.ts (it opens + migrates on load).
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-issue-template-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_API_PORT = "4403";

let server: { stop: () => void; port: number };
let token: string;
let db: typeof import("./db.ts");

beforeAll(async () => {
  db = await import("./db.ts");
  const { startApiServer, API_TOKEN } = await import("./server.ts");
  server = startApiServer() as unknown as { stop: () => void; port: number };
  token = API_TOKEN;
});

afterAll(() => {
  server?.stop?.();
});

const url = (p: string) => `http://127.0.0.1:4403${p}`;
// Built lazily — `token` is only assigned in beforeAll, after module load.
const auth = () => ({ authorization: `Bearer ${token}` });

const put = (body: unknown) =>
  fetch(url("/projects/issue-template"), {
    method: "PUT",
    headers: { ...auth(), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const get = (p: string) =>
  fetch(url(`/projects/issue-template?path=${encodeURIComponent(p)}`), { headers: auth() });

// ---- db layer ---------------------------------------------------------------

test("db: a new project has no issue task template", () => {
  const p = db.projects.upsert("/tmp/agetor-itt-fresh", "fresh");
  expect(p.issueTaskTemplate).toBeNull();
});

test("db: setIssueTaskTemplate round-trips, survives upsert, and clears with null", () => {
  const p = "/tmp/agetor-itt-roundtrip";
  db.projects.upsert(p, "rt");
  const template: IssueTaskTemplate = { prompt: "/acme:cards {number}", agentProfileId: "prof-1" };
  expect(db.projects.setIssueTaskTemplate(p, template)?.issueTaskTemplate).toEqual(template);
  expect(db.projects.get(p)?.issueTaskTemplate).toEqual(template);
  // Re-picking the project (every task creation upserts) must not wipe it.
  expect(db.projects.upsert(p, "rt").issueTaskTemplate).toEqual(template);
  expect(db.projects.list().find((x) => x.path === p)?.issueTaskTemplate).toEqual(template);
  expect(db.projects.setIssueTaskTemplate(p, null)?.issueTaskTemplate).toBeNull();
});

test("db: setIssueTaskTemplate returns null for an unregistered project", () => {
  expect(db.projects.setIssueTaskTemplate("/definitely/not/registered", { prompt: "x", agentProfileId: null })).toBeNull();
});

test("db: parseIssueTaskTemplate tolerates corrupt and invalid stored values", () => {
  const { parseIssueTaskTemplate } = db;
  expect(parseIssueTaskTemplate(null)).toBeNull();
  expect(parseIssueTaskTemplate("")).toBeNull();
  expect(parseIssueTaskTemplate("{not json")).toBeNull();
  expect(parseIssueTaskTemplate("[]")).toBeNull();
  expect(parseIssueTaskTemplate("42")).toBeNull();
  expect(parseIssueTaskTemplate(JSON.stringify({ agentProfileId: "p" }))).toBeNull();
  expect(parseIssueTaskTemplate(JSON.stringify({ prompt: "   " }))).toBeNull();
  // A non-string profile id degrades to "no profile" rather than dropping the prompt.
  expect(parseIssueTaskTemplate(JSON.stringify({ prompt: "go", agentProfileId: 7 }))).toEqual({ prompt: "go", agentProfileId: null });
  // Unknown keys never leak through.
  expect(parseIssueTaskTemplate(JSON.stringify({ prompt: "go", agentProfileId: null, extra: 1 }))).toEqual({ prompt: "go", agentProfileId: null });
});

test("db: a corrupt stored column reads back as no template", () => {
  const p = "/tmp/agetor-itt-corrupt";
  db.projects.upsert(p, "corrupt");
  db.db.run(`UPDATE projects SET issue_task_template = ? WHERE path = ?`, ["{oops", p]);
  expect(db.projects.get(p)?.issueTaskTemplate).toBeNull();
});

// ---- HTTP routes ------------------------------------------------------------

test("GET /projects/issue-template: 400 without path, 404 for an unregistered project", async () => {
  expect((await fetch(url("/projects/issue-template"), { headers: auth() })).status).toBe(400);
  expect((await get("/definitely/not/registered")).status).toBe(404);
});

test("GET /projects/issue-template requires the bearer token", async () => {
  const res = await fetch(url(`/projects/issue-template?path=${encodeURIComponent("/x")}`));
  expect(res.status).toBe(401);
});

test("PUT then GET /projects/issue-template round-trips a trimmed template", async () => {
  const p = "/tmp/agetor-itt-route";
  db.projects.upsert(p, "route");
  expect(await (await get(p)).json()).toEqual({ template: null });

  const profile = db.agentProfiles.insert({ name: "Card Writer", harness: "claude-code", model: "claude-opus-5-5" });
  const res = await put({ path: p, template: { prompt: "  /acme:cards {number}\n", agentProfileId: profile.id, junk: true } });
  expect(res.status).toBe(200);
  const updated = (await res.json()) as Project;
  expect(updated.issueTaskTemplate).toEqual({ prompt: "/acme:cards {number}", agentProfileId: profile.id });
  expect(await (await get(p)).json()).toEqual({ template: { prompt: "/acme:cards {number}", agentProfileId: profile.id } });
});

test("PUT /projects/issue-template: an empty profile id means no profile", async () => {
  const p = "/tmp/agetor-itt-noprofile";
  db.projects.upsert(p, "np");
  const res = await put({ path: p, template: { prompt: "work on {url}", agentProfileId: "" } });
  expect(res.status).toBe(200);
  expect(((await res.json()) as Project).issueTaskTemplate).toEqual({ prompt: "work on {url}", agentProfileId: null });
});

test("PUT /projects/issue-template: template null clears it", async () => {
  const p = "/tmp/agetor-itt-clear";
  db.projects.upsert(p, "clear");
  db.projects.setIssueTaskTemplate(p, { prompt: "x", agentProfileId: null });
  const res = await put({ path: p, template: null });
  expect(res.status).toBe(200);
  expect(((await res.json()) as Project).issueTaskTemplate).toBeNull();
});

test("PUT /projects/issue-template: 400s for bad bodies", async () => {
  const p = "/tmp/agetor-itt-bad";
  db.projects.upsert(p, "bad");
  expect((await put({ template: { prompt: "x" } })).status).toBe(400); // no path
  expect((await put({ path: p })).status).toBe(400); // no template key
  expect((await put({ path: p, template: "x" })).status).toBe(400);
  expect((await put({ path: p, template: { prompt: "   " } })).status).toBe(400);
  expect((await put({ path: p, template: { prompt: 5 } })).status).toBe(400);
  expect((await put({ path: p, template: { prompt: "x", agentProfileId: 5 } })).status).toBe(400);
  expect((await put({ path: p, template: { prompt: "x".repeat(20_001) } })).status).toBe(400);
  expect((await put({ path: p, template: { prompt: "x", agentProfileId: "no-such-profile" } })).status).toBe(400);
  expect(db.projects.get(p)?.issueTaskTemplate).toBeNull();
});

test("PUT /projects/issue-template 404s for an unregistered project", async () => {
  const res = await put({ path: "/definitely/not/registered", template: { prompt: "x", agentProfileId: null } });
  expect(res.status).toBe(404);
});
