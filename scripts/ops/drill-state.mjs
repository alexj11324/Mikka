/** Repair only the drill's known, never-invoked effects and owned fault rows.
 * This fixture helper is not authority to clear a real unknown provider outcome. */
export async function repairDrillFaults(main, { ownerId, runId, effectIds }) {
  await main.query('UPDATE coordinator_events SET "deliveredAt"=now() WHERE "userId"=$1 AND "deliveredAt" IS NULL', [ownerId])
  // A real stop repairs a stale lease; it does not fabricate an earlier start.
  await main.query(`UPDATE agent_runs SET status='stopped',"finishedAt"=COALESCE("finishedAt",now()),"leaseExpiresAt"=NULL
    WHERE id=$1 AND "userId"=$2 AND status IN ('preparing','running','finishing')`, [runId, ownerId])
  await main.query(`UPDATE operation_ledger SET status='failed',"updatedAt"=now()
    WHERE "operationId"=ANY($1::uuid[]) AND "ownerId"=$2 AND status IN ('executing','uncertain')`, [effectIds, ownerId])
}
