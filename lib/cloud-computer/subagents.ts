import 'server-only'
import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { ensureCloudMachine } from '@/lib/computer/provision'
import { subagentEventSchema, type SubagentEvent } from '@mikka/protocol/subagent'
import { ComputerError } from '@/lib/computer/store'
import { connectComputer } from '@/lib/computer/e2b-provider'
import { installSubagentRuntime, runtimeRequest, grant, endpointPath, type BrowserBinding } from './runtime'
export type Actor = { userId: string; workspaceId: string }
export type Subagent = BrowserBinding & { task: string; status: SubagentEvent['data']['state']; step: string; needs: SubagentEvent['data']['needs']; targetId: string | null; activeActionId?: string | null; nextAttemptAt?: Date | null; activeSteps?: number; consecutiveFailures?: number }
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
    const row = await this.get(actor, botId, id)
    if (row.task !== task) throw new ComputerError(409, 'Web task request changed')
    return row
  }
  private async publish(client: Pool | PoolClient, row: Subagent) {
    const event = subagentEventSchema.parse({ type: 'data-subagent', data: { botId: row.botId, subagentId: row.id, task: row.task, state: row.status, step: row.step, needs: row.needs } })
    await client.query('INSERT INTO subagent_events ("ownerId","workspaceId","botId","subagentId",event) VALUES ($1,$2,$3,$4,$5)', [row.ownerId, row.workspaceId, row.botId, row.id, JSON.stringify(event)])
    return event
  }
  async start(actor: Actor, botId: string, id: string) {
    const client = await this.pool.connect(), leaseId = randomUUID()
    let row: Subagent
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`subagents:${actor.workspaceId}:${actor.userId}`])
      row = await this.get(actor, botId, id, client)
      if (row.status !== 'queued') { await client.query('COMMIT'); return row }
      const permission=(await client.query('SELECT permission FROM workspace_computer_policies WHERE "workspaceId"=$1',[actor.workspaceId])).rows[0]?.permission
      if(permission && !['allow','ask','deny'].includes(permission)) throw new ComputerError(503,'Computer policy unavailable')
      if(permission==='deny') {
        const denied=(await client.query<Subagent>(`UPDATE bot_subagents SET status='failed',step='Computer use is denied',"endedAt"=now(),"startLeaseId"=NULL,"startLeaseUntil"=NULL WHERE id=$1 AND status='queued' RETURNING *`,[id])).rows[0]
        if(denied) await this.publish(client,denied)
        await client.query('COMMIT')
        return denied ?? await this.get(actor,botId,id,client)
      }
      const count = Number((await client.query(`SELECT count(*) AS n FROM bot_subagents WHERE "workspaceId"=$1 AND "ownerId"=$2 AND (status IN ('running','needs_you') OR (status='queued' AND "startLeaseUntil">now()))`, [actor.workspaceId,actor.userId])).rows[0].n)
      const older = await client.query(`SELECT 1 FROM bot_subagents WHERE "workspaceId"=$1 AND "ownerId"=$2 AND status='queued' AND ("startLeaseUntil" IS NULL OR "startLeaseUntil"<=now()) AND "createdAt"<(SELECT "createdAt" FROM bot_subagents WHERE id=$3) LIMIT 1`, [actor.workspaceId,actor.userId,id])
      if (count >= 6 || older.rowCount) { await client.query('COMMIT'); return row }
      const claimed = await client.query(`UPDATE bot_subagents SET "startLeaseId"=$2,"startLeaseUntil"=now()+interval '3 minutes' WHERE id=$1 AND status='queued' AND ("startLeaseUntil" IS NULL OR "startLeaseUntil"<=now()) RETURNING id`, [id,leaseId])
      await client.query('COMMIT')
      if (!claimed.rowCount) return row
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
    try {
      const sandbox = await ensureCloudMachine(this.pool,actor)
      if (!sandbox) {
        await this.pool.query('UPDATE bot_subagents SET "startLeaseId"=NULL,"startLeaseUntil"=NULL WHERE id=$1 AND "startLeaseId"=$2',[id,leaseId])
        return this.get(actor,botId,id)
      }
      await installSubagentRuntime(sandbox, actor.userId)
      const result = await runtimeRequest(sandbox.sandboxId, row, '/start', {})
      const tx = await this.pool.connect()
      let changed: Subagent | undefined
      try {
        await tx.query('BEGIN')
        changed = (await tx.query<Subagent>(`UPDATE bot_subagents SET status='running',"targetId"=$2,step='running',"startLeaseId"=NULL,"startLeaseUntil"=NULL WHERE id=$1 AND status='queued' AND "startLeaseId"=$3 RETURNING *`, [id, result.targetId,leaseId])).rows[0]
        if (changed) await this.publish(tx, changed)
        await tx.query('COMMIT')
      } catch(error) {await tx.query('ROLLBACK');throw error} finally {tx.release()}
      if (!changed) {
        const current=await this.get(actor,botId,id)
        // A successor's lease may have published the same browser already.
        // Only a terminal task justifies tearing down the shared task target.
        if(['stopped','failed','done'].includes(current.status)) await runtimeRequest(sandbox.sandboxId,row,'/stop',{})
      }
      return changed ?? await this.get(actor, botId, id)
    } catch(error) {
      await this.pool.query('UPDATE bot_subagents SET "startLeaseId"=NULL,"startLeaseUntil"=NULL WHERE id=$1 AND "startLeaseId"=$2',[id,leaseId])
      throw error
    }
  }
  async update(actor: Actor, botId: string, id: string, status: Subagent['status'], step: string, needs: Subagent['needs'] = null) {
    const client = await this.pool.connect()
    let changed: Subagent | undefined
    try {
      await client.query('BEGIN')
      const row = (await client.query<Subagent>(`UPDATE bot_subagents SET status=$5,step=$6,needs=$7,"activeActionId"=CASE WHEN $5 IN ('running','done','failed','stopped') THEN NULL ELSE "activeActionId" END,"endedAt"=CASE WHEN $5 IN ('done','failed','stopped') THEN now() ELSE NULL END
        WHERE id=$1 AND "ownerId"=$2 AND "workspaceId"=$3 AND "botId"=$4 AND (status IN ('running','needs_you') OR (status='queued' AND $5 IN ('failed','stopped'))) RETURNING *`, [id, actor.userId, actor.workspaceId, botId, status, step.slice(0, 500), needs ? JSON.stringify(needs) : null])).rows[0]
      if (row) {
        await this.publish(client, row)
        if (['done', 'failed', 'stopped'].includes(status)) await client.query(`UPDATE suggestion_executions SET status=$2,"endedAt"=now() WHERE "subagentId"=$1`, [id, status])
      }
      await client.query('COMMIT')
      changed = row
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
    if (['done', 'failed', 'stopped'].includes(status)) await this.cleanup(actor, botId, id)
    return changed ?? await this.get(actor, botId, id)
  }
  async cleanup(actor: Actor, botId: string, id: string) {
    const row = await this.get(actor, botId, id)
    const machine = (await this.pool.query('SELECT "sandboxId" FROM cloud_machines WHERE "workspaceId"=$1 AND "ownerId"=$2', [actor.workspaceId, actor.userId])).rows[0]
    if (machine?.sandboxId) await runtimeRequest(machine.sandboxId, row, '/stop', {})
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
    const capability = await grant(await connectComputer(actor.workspaceId, sandboxId), row, 'view')
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
