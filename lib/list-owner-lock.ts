import "server-only";
import type { Pool, PoolClient } from "pg";

/**
 * Runs `work` in one transaction that holds a per-person, per-workspace lock, so a limit counted
 * inside it (pins, saved views) cannot be passed by two concurrent writes. Read committed: each
 * statement after the lock sees every write committed before it was granted.
 */
export async function withListOwnerLock<T>(
  pool: Pick<Pool, "connect">,
  key: [list: string, ownerId: string, workspaceId: string],
  work: (tx: PoolClient) => Promise<T>,
): Promise<T> {
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN");
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [JSON.stringify(key)]);
    const value = await work(tx);
    await tx.query("COMMIT");
    return value;
  } catch (error) {
    await tx.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    tx.release();
  }
}
