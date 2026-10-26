import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import type { Pool } from "pg";

// Fault injection is retired without deleting the trigger or its function.
export async function retainFaultTrigger(pool: Pool, table: string, trigger: string) {
  if (![table, trigger].every((value) => /^[a-z_][a-z0-9_]*$/.test(value)))
    throw new Error("Invalid synthetic trigger identifier");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`ALTER TABLE "${table}" DISABLE TRIGGER "${trigger}"`);
    const retained = `retained_${randomUUID().replaceAll("-", "")}`;
    await client.query(`ALTER TRIGGER "${trigger}" ON "${table}" RENAME TO "${retained}"`);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// These four cases are covered by the separately pending physical-absence recipe.
// They are not registered as skipped/passed in the retained recipe.
export async function physicalAbsenceCase(t: TestContext, name: string, run: () => Promise<void>) {
  if (process.env.FACTORY_PHYSICAL_ABSENCE_AUTHORIZED === "1") await t.test(name, run);
}
