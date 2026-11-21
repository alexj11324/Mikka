import type { Pool } from 'pg'

export class NativeCoordinatorError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

// Persisted native tool calls may still be retried by older workflows.
export class NativeCoordinatorStore {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  /** Check inside the executing business step, including every durable retry. */
  async assertToolActive(userId: string, holder: string, id: string, callId: string): Promise<void> {
    const { rows } = await this.pool.query(`SELECT 1 FROM native_coordinator_turns j
      JOIN coordinator_sessions s ON s."userId"=j."userId" AND s."leaseHolder"=j.holder AND s."leaseUntil">now()
      JOIN devices d ON d.id=j."deviceId" AND d."ownerId"=j."userId" AND d.enabled
      JOIN native_coordinator_tools t ON t."turnId"=j.id
      WHERE j."expiresAt">now() AND j.id=$1 AND j."userId"=$2 AND j.holder=$3 AND j.status='running'
      AND t."callId"=$4 AND t.status='pending'`, [id,userId,holder,callId])
    if (!rows.length) throw new NativeCoordinatorError(409,'coordinatorExpiredOrLeaseLost')
  }
}
