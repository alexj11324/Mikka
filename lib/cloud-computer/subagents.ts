import 'server-only'
import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { subagentEventSchema, type SubagentEvent } from '@mikka/protocol/subagent'
import { ComputerError } from '@/lib/computer/store'
import { createComputer, connectComputer } from '@/lib/computer/e2b-provider'
import { installSubagentRuntime, runtimeRequest, grant, endpointPath, type BrowserBinding } from './runtime'
export type Actor = { userId: string; workspaceId: string }
export type Subagent = BrowserBinding & { task: string; status: SubagentEvent['data']['state']; step: string; needs: SubagentEvent['data']['needs']; targetId: string | null }
export class SubagentStore {
  constructor(private pool: Pool) {}
  async get(actor: Actor, botId: string, id: string, client: Pool | PoolClient = this.pool): Promise<Subagent> {
    const row = (await client.query<Subagent>('SELECT * FROM bot_subagents WHERE id=$1 AND "ownerId"=$2 AND "workspaceId"=$3 AND "botId"=$4', [id, actor.userId, actor.workspaceId, botId])).rows[0]
    if (!row) throw new ComputerError(404, 'Subagent unavailable')
    return row
  }
  async create(actor: Actor, botId: string, task: string, id: string = randomUUID()) {
    const bot = (await this.pool.query('SELECT id FROM bots WHERE id=$1 AND "ownerId"=$2 AND "workspaceId"=$3', [botId, actor.userId, actor.workspaceId])).rows[0]
    if (!bot) throw new ComputerError(404, 'Bot unavailable')
    await this.pool.query(`INSERT INTO bot_subagents (id,"ownerId","workspaceId","botId",task) VALUES ($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING`, [id, actor.userId, actor.workspaceId, botId, task])
    return this.get(actor, botId, id)
  }
  private async publish(client: Pool | PoolClient, row: Subagent) {
    const event = subagentEventSchema.parse({ type: 'data-subagent', data: { botId: row.botId, subagentId: row.id, task: row.task, state: row.status, step: row.step, needs: row.needs } })
    await client.query('INSERT INTO subagent_events ("ownerId","workspaceId","botId","subagentId",event) VALUES ($1,$2,$3,$4,$5)', [row.ownerId, row.workspaceId, row.botId, row.id, JSON.stringify(event)])
    return event
  }
  async start(actor: Actor, botId: string, id: string) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`subagents:${actor.workspaceId}`])
      const row = await this.get(actor, botId, id, client)
      if (row.status !== 'queued') { await client.query('COMMIT'); return row }
      const count = Number((await client.query(`SELECT count(*) AS n FROM bot_subagents WHERE "workspaceId"=$1 AND status IN ('running','needs_you')`, [actor.workspaceId])).rows[0].n)
      const older = await client.query(`SELECT 1 FROM bot_subagents WHERE "workspaceId"=$1 AND status='queued' AND "createdAt"<(SELECT "createdAt" FROM bot_subagents WHERE id=$2) LIMIT 1`, [actor.workspaceId, id])
      if (count >= 6 || older.rowCount) { await client.query('COMMIT'); return row }
      await client.query('INSERT INTO cloud_machines ("workspaceId","ownerId","operationId") VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [actor.workspaceId, actor.userId, randomUUID()])
      const machine = (await client.query('SELECT * FROM cloud_machines WHERE "workspaceId"=$1 FOR UPDATE', [actor.workspaceId])).rows[0]
      if (machine.ownerId !== actor.userId) throw new ComputerError(409, 'This Bot machine belongs to another account')
      const sandbox = machine.sandboxId ? await connectComputer(machine.sandboxId) : await createComputer(actor.workspaceId, machine.operationId)
      // Persist provisioned ID before runtime work so a retry cannot leak a machine.
      await client.query('UPDATE cloud_machines SET "sandboxId"=$2,state=$3,"lastActiveAt"=now() WHERE "workspaceId"=$1', [actor.workspaceId, sandbox.sandboxId, 'running'])
      await client.query('COMMIT')
      await installSubagentRuntime(sandbox, actor.userId)
      const result = await runtimeRequest(sandbox.sandboxId, row, '/start', {})
      await client.query('BEGIN')
      // A concurrent stop wins; it cannot be resurrected by provisioning.
      const changed = (await client.query<Subagent>(`UPDATE bot_subagents SET status='running',"targetId"=$2,step='running' WHERE id=$1 AND status='queued' RETURNING *`, [id, result.targetId])).rows[0]
      if (changed) await this.publish(client, changed)
      await client.query('COMMIT')
      if (!changed) await runtimeRequest(sandbox.sandboxId, row, '/stop', {})
      return changed ?? await this.get(actor, botId, id)
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }
  async update(actor: Actor, botId: string, id: string, status: Subagent['status'], step: string, needs: Subagent['needs'] = null) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const row = (await client.query<Subagent>(`UPDATE bot_subagents SET status=$5,step=$6,needs=$7,"endedAt"=CASE WHEN $5 IN ('done','failed','stopped') THEN now() ELSE NULL END
        WHERE id=$1 AND "ownerId"=$2 AND "workspaceId"=$3 AND "botId"=$4 AND status IN ('running','needs_you') RETURNING *`, [id, actor.userId, actor.workspaceId, botId, status, step.slice(0, 500), needs ? JSON.stringify(needs) : null])).rows[0]
      if (row) {
        await this.publish(client, row)
        if (['done', 'failed', 'stopped'].includes(status)) await client.query(`UPDATE suggestion_executions SET status=$2,"endedAt"=now() WHERE "subagentId"=$1`, [id, status])
      }
      await client.query('COMMIT')
      return row ?? await this.get(actor, botId, id)
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }
  async machine(actor: Actor, botId: string, id: string) {
    const row = await this.get(actor, botId, id)
    const machine = (await this.pool.query('SELECT "sandboxId" FROM cloud_machines WHERE "workspaceId"=$1 AND "ownerId"=$2', [actor.workspaceId, actor.userId])).rows[0]
    if (!machine?.sandboxId) throw new ComputerError(409, 'Browser unavailable')
    return { row, sandboxId: machine.sandboxId as string }
  }
  async viewer(actor: Actor, botId: string, id: string) {
    const { row, sandboxId } = await this.machine(actor, botId, id)
    if (!['running', 'needs_you'].includes(row.status)) throw new ComputerError(409, 'Browser unavailable')
    const capability = await grant(await connectComputer(sandboxId), row, 'view')
    return { url: endpointPath(capability.endpoint, '/viewer').replace('https:', 'wss:'), expiresAt: new Date(capability.expiresAt).toISOString() }
  }
  async stop(actor: Actor, botId: string, id: string) {
    const row = await this.get(actor, botId, id)
    if (['done', 'failed', 'stopped'].includes(row.status)) return row
    if (row.status === 'queued') {
      const stopped = (await this.pool.query<Subagent>(`UPDATE bot_subagents SET status='stopped',step='stopped',"endedAt"=now() WHERE id=$1 AND status='queued' RETURNING *`, [id])).rows[0]
      if (stopped) { await this.publish(this.pool, stopped); return stopped }
    }
    const machine = await this.machine(actor, botId, id)
    // Cleanup first; failures remain retryable and must not claim a stop succeeded.
    await runtimeRequest(machine.sandboxId, machine.row, '/stop', {})
    return this.update(actor, botId, id, 'stopped', 'stopped')
  }
  async action(actor: Actor, botId: string, id: string, action: Record<string, unknown>) {
    const { row, sandboxId } = await this.machine(actor, botId, id)
    if (row.status !== 'running') throw new ComputerError(409, 'Subagent is waiting or stopped')
    return runtimeRequest(sandboxId, row, '/action', action)
  }
}
