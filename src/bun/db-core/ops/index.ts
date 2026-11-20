import { defineOp, type OpCtx, type OpDef } from "./define.ts";
import { testOps } from "./test-ops.ts";

export { defineOp };
export type { OpCtx, OpDef };

// Named atomic ops: a multi-statement unit of work that must commit or roll back
// as one and must not hold a transaction across a thread hop. Each op runs
// entirely inside the database worker (or, in in-process mode, on the main
// connection) via `db-rpc.ts`'s `op(name, args)`.
//
// To add an op:
//   1. Create `src/bun/db-core/ops/<area>-ops.ts` exporting a record of
//      `defineOp({ tx, run })` entries, named `<area>.<verb>`.
//   2. Spread that record into `ops` below. The registry's type is the contract
//      callers see: `op("<area>.<verb>", [...args])` is checked against it.
//   3. Args and the result must be structured-clone safe (plain data, Set, Map).
// `tx: true` wraps `run` in `conn.transaction(...)`, so a throw rolls back every
// write the op made. An op never imports `db.ts` or any main-thread registry.

export const ops = {
  ...testOps,
};

export type OpRegistry = typeof ops;
export type OpName = keyof OpRegistry;
export type OpArgs<K extends OpName> = OpRegistry[K] extends OpDef<infer A, unknown> ? A : never;
export type OpResult<K extends OpName> = OpRegistry[K] extends OpDef<never[], infer R> ? Awaited<R> : never;

/** Test-only ops are refused outside NODE_ENV=test. */
const TEST_OP_PREFIX = "__test.";

/** Look an op up by name. Only own keys of the registry resolve, so a name like
 *  `constructor` or `__proto__` never reaches a prototype member. */
export function findOp(name: string): OpDef<unknown[], unknown> | null {
  if (name.startsWith(TEST_OP_PREFIX) && process.env.NODE_ENV !== "test") return null;
  if (!Object.prototype.hasOwnProperty.call(ops, name)) return null;
  return (ops as Record<string, OpDef<unknown[], unknown>>)[name]!;
}

/** Run an op against a context, in a transaction when it declares one. */
export function runOp(def: OpDef<unknown[], unknown>, ctx: OpCtx, args: unknown[]): unknown {
  if (!def.tx) return def.run(ctx, ...args);
  return ctx.conn.transaction(() => def.run(ctx, ...args))();
}
