import { describe, expect, test } from "bun:test";
import { IDEMPOTENCY_MAX_RESPONSE_BYTES, IDEMPOTENCY_WINDOW_MS, createIdempotency, isValidIdemKey, requestHash, type IdempotencyStore, type StoredResult } from "./idempotency.ts";

function memoryStore() {
  const rows = new Map<string, Parameters<IdempotencyStore["put"]>[0]>();
  const store: IdempotencyStore = {
    async get(d, k) {
      return rows.get(`${d}\0${k}`) ?? null;
    },
    async put(row) {
      const key = `${row.deviceId}\0${row.idemKey}`;
      if (rows.has(key)) return false;
      rows.set(key, row);
      return true;
    },
    async prune(before) {
      let n = 0;
      for (const [k, r] of rows) if (r.createdAt < before) (rows.delete(k), n++);
      return n;
    },
  };
  return { rows, store };
}

const KEY = "ab".repeat(16);
const H1 = requestHash("POST", "/runs/r1/input", null, { text: "go" });
const H2 = requestHash("POST", "/runs/r1/input", null, { text: "other" });
const ok = (body = "{}"): StoredResult => ({ status: 200, contentType: "application/json", body: new TextEncoder().encode(body) });

describe("idempotency keys", () => {
  test("a key is 128 bits of lowercase hex", () => {
    expect(isValidIdemKey(KEY)).toBe(true);
    for (const bad of ["", "AB".repeat(16), "ab".repeat(15), "ab".repeat(17), "zz".repeat(16), null, 5, undefined]) expect(isValidIdemKey(bad)).toBe(false);
  });

  test("the request hash covers method, path, query and body", () => {
    expect(requestHash("POST", "/a", null, { x: 1 })).toBe(requestHash("POST", "/a", null, { x: 1 }));
    for (const other of [requestHash("PUT", "/a", null, { x: 1 }), requestHash("POST", "/b", null, { x: 1 }), requestHash("POST", "/a", "q=1", { x: 1 }), requestHash("POST", "/a", null, { x: 2 })]) {
      expect(other).not.toBe(requestHash("POST", "/a", null, { x: 1 }));
    }
  });
});

describe("claim", () => {
  test("the first call runs, commits, and a repeat returns the stored result", async () => {
    const m = memoryStore();
    const idem = createIdempotency(m.store, () => 1000);
    const c = await idem.claim("d1", KEY, H1);
    expect(c.kind).toBe("run");
    if (c.kind !== "run") return;
    await c.commit(ok('{"delivered":true}'));
    const again = await idem.claim("d1", KEY, H1);
    expect(again.kind).toBe("hit");
    if (again.kind === "hit") {
      expect(again.result.status).toBe(200);
      expect(new TextDecoder().decode(again.result.body!)).toBe('{"delivered":true}');
    }
  });

  test("the same key with a different body is a mismatch (409), and never runs", async () => {
    const m = memoryStore();
    const idem = createIdempotency(m.store);
    const c = await idem.claim("d1", KEY, H1);
    if (c.kind === "run") await c.commit(ok());
    expect((await idem.claim("d1", KEY, H2)).kind).toBe("mismatch");
  });

  test("keys are per device", async () => {
    const m = memoryStore();
    const idem = createIdempotency(m.store);
    const c = await idem.claim("d1", KEY, H1);
    if (c.kind === "run") await c.commit(ok());
    expect((await idem.claim("d2", KEY, H1)).kind).toBe("run");
  });

  test("two concurrent calls with one key: the second waits and answers from the first's result (the mutation runs once)", async () => {
    const m = memoryStore();
    const idem = createIdempotency(m.store);
    const first = await idem.claim("d1", KEY, H1);
    expect(first.kind).toBe("run");
    const secondP = idem.claim("d1", KEY, H1);
    let settled = false;
    void secondP.then(() => (settled = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
    if (first.kind === "run") await first.commit(ok('{"n":1}'));
    const second = await secondP;
    expect(second.kind).toBe("hit");
  });

  test("a call that aborted releases the key: the waiting duplicate runs", async () => {
    const m = memoryStore();
    const idem = createIdempotency(m.store);
    const first = await idem.claim("d1", KEY, H1);
    const secondP = idem.claim("d1", KEY, H1);
    if (first.kind === "run") first.abort();
    expect((await secondP).kind).toBe("run");
  });

  test("a concurrent duplicate with a different body is a mismatch at once", async () => {
    const m = memoryStore();
    const idem = createIdempotency(m.store);
    await idem.claim("d1", KEY, H1);
    expect((await idem.claim("d1", KEY, H2)).kind).toBe("mismatch");
  });

  test("a result older than ten minutes is gone: the call runs again", async () => {
    const m = memoryStore();
    let t = 1_000_000;
    const idem = createIdempotency(m.store, () => t);
    const c = await idem.claim("d1", KEY, H1);
    if (c.kind === "run") await c.commit(ok());
    t += IDEMPOTENCY_WINDOW_MS - 1;
    expect((await idem.claim("d1", KEY, H1)).kind).toBe("hit");
    t += 2;
    expect((await idem.claim("d1", KEY, H1)).kind).toBe("run");
  });

  test("a response over 64 KB stores its status only; a repeat answers the status with no body", async () => {
    const m = memoryStore();
    const idem = createIdempotency(m.store);
    const c = await idem.claim("d1", KEY, H1);
    if (c.kind === "run") await c.commit({ status: 201, contentType: "application/json", body: new Uint8Array(IDEMPOTENCY_MAX_RESPONSE_BYTES + 1) });
    const again = await idem.claim("d1", KEY, H1);
    expect(again.kind).toBe("hit");
    if (again.kind === "hit") {
      expect(again.result.status).toBe(201);
      expect(again.result.body).toBeNull();
    }
  });

  test("a malformed key is refused before anything is stored", async () => {
    const idem = createIdempotency(memoryStore().store);
    await expect(idem.claim("d1", "not-a-key", H1)).rejects.toThrow("bad idempotency key");
  });

  test("prune drops rows past the window", async () => {
    const m = memoryStore();
    let t = 1_000_000;
    const idem = createIdempotency(m.store, () => t);
    const c = await idem.claim("d1", KEY, H1);
    if (c.kind === "run") await c.commit(ok());
    t += IDEMPOTENCY_WINDOW_MS + 1;
    expect(await idem.prune()).toBe(1);
  });
});
