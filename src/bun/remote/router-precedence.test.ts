// Closes plan assumption 5: for every route pattern of the served table and a corpus of at least 200 paths (and every method), the
// router's match is the route a real `Bun.serve` picks. The echo server registers one handler per method per pattern, answering the pattern
// and the params; the router's own matcher is then asked the same question.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { everyRoute } from "../route-policy.ts";
import { compileRoutes, matchPath, splitPath } from "./router.ts";

const table = everyRoute();
const compiled = compileRoutes(table);
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

let server: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  const routes: Record<string, Record<string, (req: Request & { params: Record<string, string> }) => Response>> = {};
  for (const t of table) {
    if (t.method === "HEAD" || t.method === "OPTIONS") continue;
    (routes[t.route] ??= {})[t.method] = (req) => Response.json({ route: t.route, params: req.params });
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", routes: routes as any, fetch: () => new Response("none", { status: 404 }) });
});
afterAll(() => void server.stop(true));

/** Concrete paths for each pattern (fill params with a few values), plus near-misses and shadowing probes. */
function corpus(): string[] {
  const out = new Set<string>();
  const fills = ["t1", "page", "events", "42", "a-b", "x.y", "cancel", "seen", "pending", "preview", "history", "input"];
  for (const t of table) {
    const segs = t.route.split("/").slice(1);
    for (const f of fills) out.add("/" + segs.map((s) => (s.startsWith(":") ? f : s)).join("/"));
    out.add("/" + segs.map((s, i) => (s.startsWith(":") ? `id${i}` : s)).join("/"));
    // one segment more and one less
    out.add("/" + segs.map((s) => (s.startsWith(":") ? "t1" : s)).join("/") + "/extra");
    out.add("/" + segs.slice(0, -1).map((s) => (s.startsWith(":") ? "t1" : s)).join("/"));
  }
  for (const p of [
    "/tasks/t1/events/page", "/tasks/t1/events/page/x", "/tasks/t1/events/12", "/tasks/page/events/page", "/tasks/events/events/events", "/tasks/t1/events",
    "/interactions/pending", "/tasks/t1/interactions/pending", "/tasks/interactions/pending", "/runs/r1/cancel", "/runs/cancel/cancel", "/runs/r1", "/tasks/t1/seen",
    "/tasks/seen/seen", "/tasks/t1/backlog/i1", "/tasks/t1/backlog", "/tasks/t1/plans/p1", "/tasks/t1/plans/p1/approve", "/tasks/t1/plans/approve/approve",
    "/tasks/t1/pipeline", "/tasks/t1/pipeline/review", "/tasks/t1/pipeline/cancel", "/tasks/pipeline/pipeline", "/tasks/t1/files/preview", "/health", "/info", "/events", "/tasks",
    "/tasks/t1", "/ask-questions/q1/answer", "/tmux-prompts/p1/answer", "/fx-permissions/x1/answer",
  ]) out.add(p);
  return [...out].filter((p) => splitPath(p) !== null);
}

describe("the router picks what Bun.serve picks", () => {
  test("the corpus is at least 200 paths", () => {
    expect(corpus().length).toBeGreaterThanOrEqual(200);
  });

  test("for every path and method: same pattern, same params, same 'no such route'", async () => {
    const paths = corpus();
    const mismatches: string[] = [];
    let checked = 0;
    for (const path of paths) {
      for (const method of METHODS) {
        const mine = matchPath(compiled, method, path);
        const res = await fetch(`http://127.0.0.1:${server.port}${path}`, { method });
        const theirs = res.status === 404 && (await res.text()) === "none" ? null : ((await res.json().catch(() => null)) as { route: string; params: Record<string, string> } | null);
        const myEntry = mine;
        checked++;
        const a = myEntry ? JSON.stringify([myEntry.route.route, myEntry.params]) : "none";
        const b = theirs ? JSON.stringify([theirs.route, theirs.params]) : "none";
        if (a !== b) mismatches.push(`${method} ${path}: router=${a} bun=${b}`);
      }
    }
    expect(checked).toBeGreaterThanOrEqual(1000);
    expect(mismatches).toEqual([]);
  }, 120_000);
});
