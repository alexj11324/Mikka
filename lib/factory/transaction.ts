import { drizzle } from "drizzle-orm/node-postgres";
import type { PoolClient } from "pg";
import type { db } from "../db";

type DispatchDatabase = Pick<typeof db, "select" | "transaction">;
type DispatchTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** #191's transaction callback joins a caller-owned BEGIN; it must not COMMIT it. */
export function factoryDispatchDatabase(tx: PoolClient): DispatchDatabase {
  const executor = drizzle(tx);
  return {
    select: executor.select.bind(executor),
    transaction: async (callback) =>
      callback(executor as unknown as DispatchTransaction),
  };
}
