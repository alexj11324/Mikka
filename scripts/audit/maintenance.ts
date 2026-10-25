// Operator-only maintenance entrypoint; never scheduled or invoked by this change.
// Environment delivery stays with the existing approved deployment configuration.
import { Pool } from "pg";
import { z } from "zod";
import { pruneAudit, transaction, verifyAudit } from "../../lib/audit/store";
async function main() {
  const tenant = z
    .string()
    .regex(/^[a-zA-Z0-9_:.@-]{1,240}$/)
    .parse(process.argv[2]);
  const operation = z.enum(["verify", "prune"]).parse(process.argv[3]);
  const target = z
    .enum(["MIKKA_DATABASE_URL", "DATABASE_URL"])
    .parse(process.argv[4]);
  if (!process.env[target])
    throw new Error("explicit database target required");
  const pool = new Pool({ connectionString: process.env[target], max: 1 });
  try {
    const result = await transaction(pool, (tx) =>
      operation === "prune"
        ? pruneAudit(tx, tenant, "system")
        : verifyAudit(tx, tenant),
    );
    console.log(
      JSON.stringify({
        tenant,
        operation,
        target,
        result,
        utc: new Date().toISOString(),
      }),
    );
  } finally {
    await pool.end();
  }
}
void main().catch(() => {
  console.error("auditMaintenanceFailed");
  process.exitCode = 1;
});
