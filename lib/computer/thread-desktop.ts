import 'server-only'
import type { Pool } from 'pg'
import type { ComputerState } from '@mikka/protocol/computer'
import * as provider from './e2b-provider'
import { ThreadMachines } from './thread-machine'
import { ComputerError } from './store'

type Actor = { userId: string; workspaceId: string }
type Desktop = { botId: string; ownerId: string; control: 'agent' | 'user' | 'idle'; controlledBy: string | null; controlUntil: Date | null; epoch: number; lastAction: ComputerState['lastAction'] | null }

/** The desktop lives on the thread machine and is allocated only on first
 * viewer or computer-tool use. All control transitions share the policy lock. */
export class ThreadDesktopStore {
  constructor(private readonly pool: Pool, private readonly runtime = provider) {}

  async state(actor: Actor, runId: string): Promise<ComputerState> {
    const row = (await this.pool.query(`SELECT t.state,t."sandboxId",d.control,d."controlledBy",d."controlUntil",d."lastAction"
      FROM thread_machines t LEFT JOIN thread_desktops d ON d."runId"=t."runId"
      WHERE t."runId"=$1 AND t."workspaceId"=$2 AND t."ownerId"=$3`, [runId, actor.workspaceId, actor.userId])).rows[0]
    if (!row) throw new ComputerError(404, 'Thread computer not found')
    const machine = row.state === 'paused' || row.state === 'ended' ? 'sleeping' : row.state === 'starting' ? 'waking' : row.state === 'error' ? 'error' : row.sandboxId ? await this.runtime.computerState(row.sandboxId) : 'sleeping'
    const held = row.control === 'user' && row.controlUntil && new Date(row.controlUntil).getTime() > Date.now()
    const review = (await this.pool.query(`SELECT v.id,v.digest,v."runId",v.call,v."expiresAt",b."botId"
      FROM local_computer_reviews v JOIN agent_runs r ON r.id=v."runId" AND r."userId"=v."userId" AND r."deviceId"=v."deviceId"
      JOIN computer_run_bindings b ON b."runId"=r.id AND b."ownerId"=r."userId"
      WHERE r.id=$1 AND b."workspaceId"=$2 AND b."ownerId"=$3 AND v.decision IS NULL AND v."expiresAt">now()
        AND v."seenAt">now()-interval '10 seconds' AND r."stopRequestedAt" IS NULL AND r."leaseExpiresAt">now()
        AND r.status IN ('running','preparing','waiting_input','finishing')
        AND NOT EXISTS (SELECT 1 FROM workspace_computer_policies p WHERE p."workspaceId"=b."workspaceId" AND p.permission='deny')
      ORDER BY v."seenAt",v.id LIMIT 1`, [runId, actor.workspaceId, actor.userId])).rows[0]
    const call = review?.call
    const pendingApproval: ComputerState['pendingApproval'] = call && (call.name === 'click' || call.name === 'type_text' || call.name === 'get_desktop_state' || call.name === 'press_key' || call.name === 'scroll')
      ? { id: review.id, digest: review.digest, runId, botId: review.botId,
          action: call.name === 'click' ? { tool: 'click', x: call.arguments.x, y: call.arguments.y }
            : call.name === 'type_text' ? { tool: 'type', text: call.arguments.text }
              : call.name === 'press_key' ? { tool: 'key', text: [...(call.arguments.modifiers ?? []), call.arguments.key].join('+') }
                : call.name === 'scroll' ? { tool: 'scroll', text: `${call.arguments.direction} × ${call.arguments.amount}`, x: call.arguments.x, y: call.arguments.y } : { tool: 'screenshot' },
          summary: call.name, expiresAt: new Date(review.expiresAt).toISOString() } : undefined
    return { machine, control: held ? 'user' : row.control === 'user' ? 'agent' : row.control ?? 'idle',
      ...(held ? { controlledBy: { userId: row.controlledBy } } : {}), ...(row.lastAction ? { lastAction: row.lastAction } : {}), ...(pendingApproval ? { pendingApproval } : {}) }
  }

  async operate(actor: Actor, runId: string, action: 'wake' | 'viewer' | 'takeover' | 'handback', mode: 'view' | 'control' = 'view') {
    const available = await this.pool.query(`SELECT 1 FROM thread_machines t JOIN agent_runs r ON r.id=t."runId" AND r."userId"=t."ownerId"
      WHERE t."runId"=$1 AND t."workspaceId"=$2 AND t."ownerId"=$3 AND t.state<>'ended' AND r."stopRequestedAt" IS NULL
        AND r.status IN ('queued','preparing','running','waiting_input','finishing')
        AND NOT EXISTS (SELECT 1 FROM workspace_computer_policies p WHERE p."workspaceId"=t."workspaceId" AND p.permission='deny')`, [runId, actor.workspaceId, actor.userId])
    if (!available.rowCount) throw new ComputerError(404, 'Thread computer not found')
    const sandboxId = await new ThreadMachines(this.pool, this.runtime.threadMachineProvider).wake(actor, runId)
    const client = await this.pool.connect()
    let persistProgress = false
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`computer-policy:${actor.workspaceId}`])
      const machine = (await client.query(`SELECT t.*,b."botId",r.status,r."stopRequestedAt" FROM thread_machines t
        JOIN computer_run_bindings b ON b."runId"=t."runId" AND b."workspaceId"=t."workspaceId" AND b."ownerId"=t."ownerId"
        JOIN agent_runs r ON r.id=t."runId" AND r."userId"=t."ownerId"
        WHERE t."runId"=$1 AND t."workspaceId"=$2 AND t."ownerId"=$3 AND t."sandboxId"=$4 FOR UPDATE OF t,r`, [runId, actor.workspaceId, actor.userId, sandboxId])).rows[0]
      const policy = (await client.query('SELECT permission,version FROM workspace_computer_policies WHERE "workspaceId"=$1', [actor.workspaceId])).rows[0]
      if (!machine || machine.stopRequestedAt || !['queued','preparing','running','waiting_input','finishing'].includes(machine.status) || policy?.permission === 'deny') throw new ComputerError(409, 'Thread computer unavailable')
      const sandbox = await this.runtime.connectComputer(sandboxId)
      if (!machine.runtimeReady) {
        await this.runtime.installComputerRuntime(sandbox)
        await client.query('UPDATE thread_machines SET "runtimeReady"=true WHERE "runId"=$1', [runId]); persistProgress = true
      }
      let desktop = (await client.query<Desktop>('SELECT * FROM thread_desktops WHERE "runId"=$1 FOR UPDATE', [runId])).rows[0]
      if (!desktop) desktop = (await client.query<Desktop>(`INSERT INTO thread_desktops ("runId","workspaceId","ownerId","botId") VALUES ($1,$2,$3,$4) RETURNING *`, [runId, actor.workspaceId, actor.userId, machine.botId])).rows[0]
      if (!machine.desktop) {
        await this.runtime.startDesktop(sandbox, 1)
        await client.query('UPDATE thread_machines SET desktop=true WHERE "runId"=$1', [runId]); persistProgress = true
      }
      const held = desktop.control === 'user' && desktop.controlUntil && new Date(desktop.controlUntil).getTime() > Date.now()
      if (desktop.control === 'user' && !held) { desktop.control = 'agent'; desktop.controlledBy = null; desktop.controlUntil = null; desktop.epoch++ }
      if (action === 'takeover') {
        if (held && desktop.controlledBy !== actor.userId) throw new ComputerError(409, 'Computer is already controlled')
        desktop.control = 'user'; desktop.controlledBy = actor.userId; desktop.controlUntil = new Date(Date.now() + 5 * 60_000); desktop.epoch++
      } else if (action === 'handback') {
        if (held && desktop.controlledBy !== actor.userId) throw new ComputerError(409, 'Control is held by another user')
        desktop.control = 'agent'; desktop.controlledBy = null; desktop.controlUntil = null; desktop.epoch++
      } else if (mode === 'control') {
        if (!held || desktop.controlledBy !== actor.userId) throw new ComputerError(403, 'Take control first')
        desktop.controlUntil = new Date(Date.now() + 5 * 60_000)
      }
      const lease: provider.DesktopLease = { botId: desktop.botId, ownerId: desktop.ownerId, display: 1, epoch: desktop.epoch,
        controlledBy: desktop.controlledBy, controlUntil: desktop.controlUntil ? new Date(desktop.controlUntil).getTime() / 1000 : 0,
        computerAllowed: true, policyVersion: policy?.version ?? 0 }
      await client.query('UPDATE thread_desktops SET control=$2,"controlledBy"=$3,"controlUntil"=$4,epoch=$5 WHERE "runId"=$1', [runId, desktop.control, desktop.controlledBy, desktop.controlUntil, desktop.epoch])
      persistProgress = true
      await this.runtime.syncDesktopLease(sandbox, lease)
      const result = action === 'viewer' || action === 'takeover' ? await this.runtime.viewerGrant(sandbox, lease, actor.userId, action === 'takeover' ? 'control' : mode) : null
      await client.query('COMMIT')
      return result
    } catch (error) {
      if (persistProgress) await client.query('COMMIT'); else await client.query('ROLLBACK')
      throw error
    } finally { client.release() }
  }
}
