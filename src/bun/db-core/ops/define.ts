import type { Database } from "bun:sqlite";
import type { DbModules } from "../modules.ts";

/** What an op receives: the connection and every instantiated module. */
export interface OpCtx {
  readonly conn: Database;
  readonly modules: DbModules;
}

export interface OpDef<A extends unknown[], R> {
  /** Run inside `conn.transaction(...)`. */
  readonly tx: boolean;
  run(ctx: OpCtx, ...args: A): R;
}

export function defineOp<A extends unknown[], R>(def: OpDef<A, R>): OpDef<A, R> {
  return def;
}
