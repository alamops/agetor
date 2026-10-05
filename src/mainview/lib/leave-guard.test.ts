import { afterEach, expect, test } from "bun:test";
import { activeLeaveGuard, registerLeaveGuard, type LeaveGuard } from "./leave-guard.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

/** Register a check whose answer the test controls through `set`. */
function guardWith(initial: LeaveGuard | null): { set: (g: LeaveGuard | null) => void; unregister: () => void } {
  let current = initial;
  const unregister = registerLeaveGuard(() => current);
  cleanups.push(unregister);
  return { set: (g) => (current = g), unregister };
}

test("nothing registered — or nothing to lose — lets the navigation through", () => {
  expect(activeLeaveGuard()).toBeNull();
  guardWith(null);
  guardWith(null);
  expect(activeLeaveGuard()).toBeNull();
});

test("any check that reports a guard blocks; the latest registered one's wording wins", () => {
  const a = guardWith({ title: "A" });
  const b = guardWith(null);
  expect(activeLeaveGuard()?.title).toBe("A");
  b.set({ title: "B" });
  expect(activeLeaveGuard()?.title).toBe("B");
  // Clearing the newer one falls back to the older one, still dirty.
  b.set(null);
  expect(activeLeaveGuard()?.title).toBe("A");
  a.set(null);
  expect(activeLeaveGuard()).toBeNull();
});

test("unregistering or changing one check never drops another", () => {
  const a = guardWith({ title: "A" });
  const b = guardWith({ title: "B" });
  b.unregister();
  expect(activeLeaveGuard()?.title).toBe("A");
  // Unregistering twice is a no-op, not a removal of something else.
  b.unregister();
  expect(activeLeaveGuard()?.title).toBe("A");
  const c = guardWith(null);
  c.set({ title: "C" });
  c.set(null);
  expect(activeLeaveGuard()?.title).toBe("A");
  a.unregister();
  expect(activeLeaveGuard()).toBeNull();
});

test("checks are read at navigation time, so the answer is never stale", () => {
  let dirty = false;
  cleanups.push(registerLeaveGuard(() => (dirty ? { title: "Dirty" } : null)));
  expect(activeLeaveGuard()).toBeNull();
  dirty = true;
  expect(activeLeaveGuard()?.title).toBe("Dirty");
});

test("the guard's discard callback is handed back to the caller", () => {
  let discarded = 0;
  guardWith({ title: "A", discard: () => discarded++ });
  activeLeaveGuard()?.discard?.();
  expect(discarded).toBe(1);
});
