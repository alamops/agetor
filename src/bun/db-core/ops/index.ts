import { defineOp, type OpCtx, type OpDef } from "./define.ts";
import { testOps } from "./test-ops.ts";
import { usageOps } from "./usage-ops.ts";
import { harnessMirrorOps } from "./harness-mirror-ops.ts";
import { bundleOps } from "./bundle-ops.ts";
import { harnessStacksOps } from "./harness-stacks-ops.ts";
import { pipelineOps } from "./pipeline-ops.ts";
import { backlogOps } from "./backlog-ops.ts";
import { orchestratorOps } from "./orchestrator-ops.ts";
import { retentionOps } from "./retention-ops.ts";
import { serverOps } from "./server-ops.ts";
import { deltaOps } from "./delta-ops.ts";

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
// `tx: true` wraps `run` in `conn.transaction(...).immediate()` (BEGIN IMMEDIATE), so a throw rolls back every
// write the op made. An op never imports `db.ts` or any main-thread registry.

export const ops = {
  ...testOps,
  ...usageOps,
  ...harnessMirrorOps,
  ...bundleOps,
  ...harnessStacksOps,
  ...pipelineOps,
  ...backlogOps,
  ...orchestratorOps,
  ...retentionOps,
  ...serverOps,
  ...deltaOps,
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
  // BEGIN IMMEDIATE: an op reads then writes, and a deferred transaction that
  // upgrades on a stale snapshot fails with SQLITE_BUSY_SNAPSHOT at once
  // instead of waiting on busy_timeout.
  return ctx.conn.transaction(() => def.run(ctx, ...args)).immediate();
}
