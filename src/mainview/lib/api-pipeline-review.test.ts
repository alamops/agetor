/**
 * `api.reviewPipeline` — the webview's only writer for a human gate. The
 * route contract is pinned in `docs/plans/pipeline-human-step.md` §2.2:
 * POST /tasks/:id/pipeline/review with `stepId` + `seq` (the idempotency key)
 * and `decision`, plus the Return-only `comment`/`mode` and the Accept-only
 * `nextStepIds`. A typo here would only surface when a user decides a gate,
 * so the body is asserted against a stubbed fetch (the boundary), not a
 * mocked client.
 */
import { afterEach, expect, test } from "bun:test";
import { ApiError, api } from "./api.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

/** Answer every request with `status`/`body`, recording the one request. */
function answer(status: number, body: string): CapturedRequest[] {
  const calls: CapturedRequest[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(body, { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return calls;
}

test("posts the documented Return body to the review route, task id encoded", async () => {
  const calls = answer(200, '{"id":"task-1","title":"parent"}');
  const body = {
    stepId: "human",
    seq: 4,
    decision: "return" as const,
    comment: "redo the header",
    mode: "resume" as const,
  };

  const task = await api.reviewPipeline("task 1", body);

  expect(task.id).toBe("task-1");
  expect(task.title).toBe("parent");
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toEndWith("/tasks/task%201/pipeline/review");
  expect(calls[0]!.init.method).toBe("POST");
  expect(JSON.parse(String(calls[0]!.init.body))).toEqual(body);
});

test("posts an Accept's optional target list and omits absent fields", async () => {
  const calls = answer(200, '{"id":"task-1"}');
  const body = {
    stepId: "human",
    seq: 7,
    decision: "accept" as const,
    comment: "looks good",
    nextStepIds: ["ship"],
  };

  await api.reviewPipeline("task-1", body);

  expect(JSON.parse(String(calls[0]!.init.body))).toEqual(body);
  expect(calls[0]!.init.body).not.toContain("mode");
});

test("surfaces the server's 409 message for the panel's inline error", async () => {
  answer(409, '{"error":"this review was already decided"}');

  const err = await api
    .reviewPipeline("task-1", { stepId: "human", seq: 1, decision: "accept" })
    .catch((e: unknown) => e);

  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).status).toBe(409);
  expect((err as ApiError).message).toBe("this review was already decided");
});
