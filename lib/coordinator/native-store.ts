import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { coordinatorRuntimeSchema, nativeCoordinatorJobSchema, type CoordinatorRuntime, type NativeCoordinatorCommand, type NativeCoordinatorJob } from '@mikka/protocol/coordinator'

export class NativeCoordinatorError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

// Every native read/write is fenced by the current Coordinator lease and the
// selected device's owner/enabled state, not merely possession of a turn id.
const ACTIVE = `j."userId" = s."userId" AND s."leaseHolder" = j.holder AND s."leaseUntil" > now()
  AND d.id = j."deviceId" AND d."ownerId" = j."userId" AND d.enabled = true AND j."expiresAt" > now()`

export class NativeCoordinatorStore {
  constructor(private readonly pool: Pool) {}

  async runtime(userId: string): Promise<CoordinatorRuntime> {
    const { rows } = await this.pool.query('SELECT runtime FROM coordinator_runtime_settings WHERE "userId"=$1', [userId])
    return rows[0] ? coordinatorRuntimeSchema.parse(rows[0].runtime) : { harness: 'ai_sdk' }
  }

  async setRuntime(userId: string, runtime: CoordinatorRuntime): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('INSERT INTO coordinator_sessions ("userId") VALUES ($1) ON CONFLICT DO NOTHING', [userId])
      const { rows } = await client.query('SELECT "leaseUntil" > now() AS busy FROM coordinator_sessions WHERE "userId"=$1 FOR UPDATE', [userId])
      if (rows[0]?.busy) throw new NativeCoordinatorError(409, 'coordinatorBusy')
      if (runtime.harness !== 'ai_sdk') {
        const found = await client.query(`SELECT id FROM devices WHERE id=$1 AND "ownerId"=$2 AND enabled=true
          AND "lastSeenAt" > now() - interval '2 minutes' AND harnesses @> $3::jsonb`, [runtime.deviceId, userId, JSON.stringify([{ harness: runtime.harness, installed: true, coordinator: true }])])
        if (!found.rows.length) throw new NativeCoordinatorError(409, 'coordinatorDeviceUnavailable')
      }
      await client.query(`INSERT INTO coordinator_runtime_settings ("userId",runtime) VALUES ($1,$2)
        ON CONFLICT ("userId") DO UPDATE SET runtime=excluded.runtime,"updatedAt"=now()`, [userId, JSON.stringify(runtime)])
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }

  async enqueue(userId: string, holder: string, round: number, runtime: Exclude<CoordinatorRuntime, { harness: 'ai_sdk' }>, input: Omit<NativeCoordinatorJob, 'id' | 'harness' | 'model' | 'expiresAt'>): Promise<string> {
    const id = randomUUID()
    const payload = nativeCoordinatorJobSchema.parse({ ...input, id, harness: runtime.harness, model: runtime.model, expiresAt: new Date(Date.now() + 180_000).toISOString() })
    const { rows } = await this.pool.query(`INSERT INTO native_coordinator_turns (id,"userId","deviceId",holder,round,payload,"expiresAt")
      SELECT $1,$2,$3,$4,$5,$6,$7 FROM coordinator_sessions s JOIN devices d ON d.id=$3
      WHERE s."userId"=$2 AND s."leaseHolder"=$4 AND s."leaseUntil">now() AND d."ownerId"=$2 AND d.enabled=true
      ON CONFLICT ("userId",holder,round) DO UPDATE SET holder=excluded.holder RETURNING id`, [id, userId, runtime.deviceId, holder, round, JSON.stringify(payload), payload.expiresAt])
    if (!rows.length) throw new NativeCoordinatorError(409, 'coordinatorLeaseLost')
    return rows[0].id
  }

  async claim(userId: string, deviceId: string): Promise<NativeCoordinatorJob | null> {
    const { rows } = await this.pool.query(`UPDATE native_coordinator_turns SET status='running' WHERE id=(
      SELECT j.id FROM native_coordinator_turns j,coordinator_sessions s,devices d
      WHERE ${ACTIVE} AND j."userId"=$1 AND j."deviceId"=$2 AND j.status='queued'
      ORDER BY j."createdAt" LIMIT 1 FOR UPDATE OF j SKIP LOCKED) RETURNING payload`, [userId, deviceId])
    return rows[0] ? nativeCoordinatorJobSchema.parse(rows[0].payload) : null
  }

  private async ownedJob(userId: string, deviceId: string, id: string, client?: PoolClient) {
    const { rows } = await (client ?? this.pool).query(`SELECT j.payload,j.status FROM native_coordinator_turns j,coordinator_sessions s,devices d
      WHERE ${ACTIVE} AND j.id=$1 AND j."userId"=$2 AND j."deviceId"=$3 AND j.status IN ('running','completed','failed')${client ? ' FOR UPDATE OF j' : ''}`, [id,userId,deviceId])
    if (!rows.length) throw new NativeCoordinatorError(409, 'coordinatorTurnUnavailable')
    return rows[0] as { payload: NativeCoordinatorJob; status: string }
  }

  async submit(userId: string, deviceId: string, id: string, command: NativeCoordinatorCommand): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      // Serialize admission on the turn: concurrent requests cannot exceed the
      // tool budget or race final completion with another external operation.
      const job = await this.ownedJob(userId,deviceId,id,client)
      if (command.type !== 'tool') {
        if (command.type === 'complete') {
          const pending = await client.query("SELECT 1 FROM native_coordinator_tools WHERE \"turnId\"=$1 AND status='pending' LIMIT 1",[id])
          if (pending.rows.length) throw new NativeCoordinatorError(409,'coordinatorToolsPending')
        }
        await client.query(`UPDATE native_coordinator_turns SET status=$2,reply=$3 WHERE id=$1 AND status='running'`, [id,command.type === 'complete' ? 'completed' : 'failed',command.type === 'complete' ? command.text : null])
      } else {
        if (job.status !== 'running' || !job.payload.tools.some(tool => tool.name === command.name)) throw new NativeCoordinatorError(403,'coordinatorToolUnavailable')
        const existing = await client.query('SELECT name,input FROM native_coordinator_tools WHERE "turnId"=$1 AND "callId"=$2',[id,command.callId])
        if (existing.rows.length) {
          const same = await client.query('SELECT 1 FROM native_coordinator_tools WHERE "turnId"=$1 AND "callId"=$2 AND name=$3 AND input=$4::jsonb',[id,command.callId,command.name,JSON.stringify(command.input)])
          if (!same.rows.length) throw new NativeCoordinatorError(409,'coordinatorToolCallConflict')
        } else {
          const count = await client.query('SELECT count(*)::int AS count FROM native_coordinator_tools WHERE "turnId"=$1',[id])
          if (count.rows[0].count >= 40) throw new NativeCoordinatorError(409,'coordinatorToolLimit')
          await client.query('INSERT INTO native_coordinator_tools ("turnId","callId",name,input) VALUES ($1,$2,$3,$4)',[id,command.callId,command.name,JSON.stringify(command.input)])
        }
      }
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }

  async result(userId: string, deviceId: string, id: string, callId: string) {
    await this.ownedJob(userId,deviceId,id)
    const { rows } = await this.pool.query('SELECT status,output FROM native_coordinator_tools WHERE "turnId"=$1 AND "callId"=$2',[id,callId])
    return rows[0]?.status === 'done' ? { status: 'done' as const, output: rows[0].output } : { status: 'pending' as const }
  }

  async poll(userId: string, holder: string, id: string): Promise<{ status: string; reply: string | null; calls: { callId: string; name: string; input: unknown }[] }> {
    const { rows } = await this.pool.query(`SELECT j.status,j.reply FROM native_coordinator_turns j,coordinator_sessions s,devices d
      WHERE ${ACTIVE} AND j.id=$1 AND j."userId"=$2 AND j.holder=$3`, [id,userId,holder])
    if (!rows.length) throw new NativeCoordinatorError(409,'coordinatorExpiredOrLeaseLost')
    const calls = await this.pool.query('SELECT "callId",name,input FROM native_coordinator_tools WHERE "turnId"=$1 AND status=\'pending\' ORDER BY "createdAt","callId"',[id])
    return { ...rows[0], calls: calls.rows }
  }

  /** Check inside the executing business step, including every durable retry. */
  async assertToolActive(userId: string, holder: string, id: string, callId: string): Promise<void> {
    const { rows } = await this.pool.query(`SELECT 1 FROM native_coordinator_turns j,coordinator_sessions s,devices d,native_coordinator_tools t
      WHERE ${ACTIVE} AND j.id=$1 AND j."userId"=$2 AND j.holder=$3 AND j.status='running'
      AND t."turnId"=j.id AND t."callId"=$4 AND t.status='pending'`, [id,userId,holder,callId])
    if (!rows.length) throw new NativeCoordinatorError(409,'coordinatorExpiredOrLeaseLost')
  }

  async finishTool(userId: string, holder: string, id: string, callId: string, output: unknown) {
    const result = JSON.stringify(output ?? null)
    if (result.length > 500_000) throw new NativeCoordinatorError(413,'coordinatorToolOutputTooLarge')
    const { rowCount } = await this.pool.query(`UPDATE native_coordinator_tools t SET status='done',output=$5 FROM native_coordinator_turns j,coordinator_sessions s,devices d
      WHERE ${ACTIVE} AND j.id=$1 AND j."userId"=$2 AND j.holder=$3
      AND (j.status='running' OR (j.status='completed' AND t.status='done' AND t.output=$5::jsonb))
      AND t."turnId"=j.id AND t."callId"=$4`,[id,userId,holder,callId,result])
    if (!rowCount) throw new NativeCoordinatorError(409,'coordinatorExpiredOrLeaseLost')
  }

  async close(userId: string, holder: string, id: string) {
    await this.pool.query(`UPDATE native_coordinator_turns SET status='closed',payload='{}'::jsonb WHERE id=$1 AND "userId"=$2 AND holder=$3`,[id,userId,holder])
  }
}
