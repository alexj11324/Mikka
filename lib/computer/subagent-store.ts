import 'server-only'
import type { Pool } from 'pg'
import * as provider from './e2b-provider'
import { ComputerError } from './store'
import { SubagentQueue } from './subagent-queue'

type Actor = { userId: string; workspaceId: string }
type BrowserRow = { id: string; botId: string; workspaceId: string; ownerId: string; state: string; controlledBy: string | null; controlUntil: Date | null; epoch: number; stopRequestedAt: Date | null; sandboxId: string | null; permission: string | null; version: number | null }

/** Changes to a browser lease are serialized with workspace policy changes. */
export class SubagentStore {
  constructor(private readonly pool: Pool, private readonly runtime = provider) {}

  async operate(actor: Actor, botId: string, id: string, action: 'viewer' | 'takeover' | 'handback' | 'stop', mode: 'view' | 'control' = 'view') {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`computer-policy:${actor.workspaceId}`])
      const result = await client.query<BrowserRow>(`SELECT s.*, m."sandboxId", p.permission, p.version FROM bot_subagents s
        LEFT JOIN cloud_machines m ON m."workspaceId"=s."workspaceId" AND m."ownerId"=s."ownerId"
        LEFT JOIN workspace_computer_policies p ON p."workspaceId"=s."workspaceId"
        WHERE s.id=$1 AND s."botId"=$2 AND s."workspaceId"=$3 AND s."ownerId"=$4 FOR UPDATE OF s`, [id, botId, actor.workspaceId, actor.userId])
      const row = result.rows[0]
      if (!row) throw new ComputerError(404, 'Web task not found')
      if (action === 'stop' && row.state === 'queued') {
        await client.query(`UPDATE bot_subagents SET state='stopped',control='idle',"stopRequestedAt"=now(),"endedAt"=now() WHERE id=$1`, [id])
        await client.query('COMMIT')
        await (await import('@/lib/suggestions/execution')).finishSuggestionSubagent(this.pool, actor.userId, id, 'stopped')
        await (await import('./subagent-notice')).subagentNotice(this.pool, actor, botId, id, 'finished', { state: 'stopped' })
        return { stopped: true }
      }
      if (!['running', 'needs_you'].includes(row.state) || !row.sandboxId || row.permission === 'deny') throw new ComputerError(409, 'Web task is unavailable')
      const held = !!row.controlledBy && !!row.controlUntil && new Date(row.controlUntil).getTime() > Date.now()
      if (action === 'takeover') {
        if (held && row.controlledBy !== actor.userId) throw new ComputerError(409, 'Control is held by another user')
        row.controlledBy = actor.userId; row.controlUntil = new Date(Date.now() + 300_000); row.epoch++
      } else if (action === 'handback') {
        if (held && row.controlledBy !== actor.userId) throw new ComputerError(409, 'Control is held by another user')
        row.controlledBy = null; row.controlUntil = null; row.epoch++
      } else if (mode === 'control' && (!held || row.controlledBy !== actor.userId)) throw new ComputerError(403, 'Take control first')
      if (action === 'stop') { row.stopRequestedAt = new Date(); row.controlledBy = null; row.controlUntil = null; row.epoch++ }
      const lease: provider.SubagentLease = { subagentId: id, botId, workspaceId: actor.workspaceId, ownerId: actor.userId, epoch: row.epoch, controlledBy: row.controlledBy, controlUntil: row.controlUntil ? new Date(row.controlUntil).getTime() / 1000 : 0, computerAllowed: true, policyVersion: row.version ?? 0, stopRequested: !!row.stopRequestedAt }
      const sandbox = await this.runtime.connectComputer(row.sandboxId)
      await this.runtime.syncSubagentLease(sandbox, lease)
      await client.query(`UPDATE bot_subagents SET "controlledBy"=$2,"controlUntil"=$3,epoch=$4,control=$5,"stopRequestedAt"=$6 WHERE id=$1`, [id, row.controlledBy, row.controlUntil, row.epoch, row.controlledBy ? 'user' : 'agent', row.stopRequestedAt])
      if (action === 'stop') await client.query(`UPDATE bot_subagent_approvals SET state='denied',"decidedAt"=now() WHERE "subagentId"=$1 AND "ownerId"=$2 AND state IN ('pending','approved')`, [id, actor.userId])
      const grant = action === 'viewer' || action === 'takeover' ? await this.runtime.subagentViewerGrant(sandbox, lease, actor.userId, action === 'takeover' ? 'control' : mode) : null
      await client.query('COMMIT')
      if (action === 'stop') {
        await this.runtime.stopSubagentBrowser(sandbox, id)
        await new SubagentQueue(this.pool).finish(actor, botId, id, 'failed')
        await (await import('./subagent-notice')).subagentNotice(this.pool, actor, botId, id, 'finished', { state: 'stopped' })
        return { stopped: true }
      }
      return grant ?? { control: 'agent' }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally { client.release() }
  }
}
