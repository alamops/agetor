import { afterEach, describe, expect, test } from "bun:test";
import { api } from "./api.ts";
import { ApiTransitError } from "./net-retry.ts";

const ALL = { agentIds: [], pipelineIds: [], all: true };
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Answer every request with `status` and the raw `body` text. */
function answer(status: number, body: string): void {
  globalThis.fetch = (async () =>
    new Response(body, { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}

describe("bundle wrappers", () => {
  test("a 2xx whose body doesn't parse is a lost answer, not a null result", async () => {
    answer(201, "{not json");
    const err = await api.importBundle("{}", {}, "fp").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiTransitError);
  });

  test("a 2xx whose body isn't a JSON object is a lost answer too", async () => {
    for (const body of ["null", "[]", '"text"', "42"]) {
      answer(200, body);
      expect(await api.saveBundle(ALL, "downloads").catch((e: unknown) => e)).toBeInstanceOf(
        ApiTransitError,
      );
      expect(await api.pickBundleFile().catch((e: unknown) => e)).toBeInstanceOf(ApiTransitError);
      expect(await api.exportBundle(ALL).catch((e: unknown) => e)).toBeInstanceOf(ApiTransitError);
      expect(await api.previewBundleImport("{}", {}).catch((e: unknown) => e)).toBeInstanceOf(ApiTransitError);
    }
  });

  test("an object body passes through", async () => {
    answer(200, '{"cancelled":true}');
    expect(await api.pickBundleFile()).toEqual({ cancelled: true });
  });
});
