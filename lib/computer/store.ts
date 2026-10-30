import 'server-only'
import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import type { ComputerState } from '@mikka/protocol/computer'
import * as provider from './e2b-provider'
import { ensureCloudMachine } from './provision'
import { computerPermission, type ComputerPermission } from './permission'

export class ComputerError extends Error {
  constructor(public status: number, message: string) { super(message) }
}
type Actor = { userId: string; workspaceId: string }
type Bot = { id: string; name: string; ownerId: string; workspaceId: string }
type Machine = { workspaceId: string; ownerId: string; sandboxId: string | null; operationId: string; state: string; runtimeReady: boolean }
type Desktop = { botId: string; ownerId: string; display: number; epoch: number; control: string; controlledBy: string | null; controlUntil: Date | null; lastAction: unknown }

/** Serialize machine allocation and control transitions across server instances. */
export class ComputerStore {
  constructor(private pool: Pool, private runtime = provider) {}

  async createBot(actor: Actor, name: string) {
    const { rows } = await this.pool.query<Bot>('INSERT INTO bots (id,"workspaceId","ownerId",name) VALUES ($1,$2,$3,$4) RETURNING id,name,"workspaceId","ownerId"', [randomUUID(), actor.workspaceId, actor.userId, name])
    return rows[0]
  }
  async listBots(actor: Actor) {
    return (await this.pool.query<Bot>('SELECT id,name,"workspaceId","ownerId" FROM bots WHERE "workspaceId"=$1 AND "ownerId"=$2 ORDER BY "createdAt"', [actor.workspaceId, actor.userId])).rows
  }
  async policy(workspaceId: string): Promise<ComputerPermission> {
    const row = (await this.pool.query('SELECT permission FROM workspace_computer_policies WHERE "workspaceId"=$1', [workspaceId])).rows[0]
    const permission = computerPermission(row?.permission)
    if (!permission) throw new Error('Computer policy unavailable')
    return permission
  }
  /** Caller must authorize an active workspace admin. Serializes policy
   * transitions with display wake/control and each actual driver call. */
  async setPolicy(workspaceId: string, permission: ComputerPermission) {
    const client = await this.pool.connect()
    const key = `computer-policy:${workspaceId}`
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [key])
      const previous = computerPermission((await client.query('SELECT permission FROM workspace_computer_policies WHERE "workspaceId"=$1', [workspaceId])).rows[0]?.permission)
      const machines = (await client.query<Machine>('SELECT * FROM cloud_machines WHERE "workspaceId"=$1 ORDER BY "ownerId" FOR UPDATE', [workspaceId])).rows
      const desktops = (await client.query<Desktop>('SELECT * FROM bot_desktops WHERE "workspaceId"=$1 ORDER BY display FOR UPDATE', [workspaceId])).rows
      const policy = (await client.query(`INSERT INTO workspace_computer_policies ("workspaceId",permission,version)
        VALUES ($1,$2,CASE WHEN $2='allow' THEN 0 ELSE 1 END)
        ON CONFLICT ("workspaceId") DO UPDATE SET permission=$2,"updatedAt"=now(),
          version=CASE WHEN workspace_computer_policies.permission=$2 THEN workspace_computer_policies.version ELSE workspace_computer_policies.version+1 END
        RETURNING version`, [workspaceId, permission])).rows[0]
      if (previous !== permission) {
        await client.query('UPDATE computer_run_bindings SET "approvedForRun"=false WHERE "workspaceId"=$1', [workspaceId])
        await client.query(`UPDATE local_computer_reviews v SET decision=false FROM computer_run_bindings b
          WHERE v."runId"=b."runId" AND b."workspaceId"=$1 AND v.decision IS NULL`, [workspaceId])
      }
      if (permission === 'deny') {
        // Previously delivered approvals cannot be rebound to a later policy
        // generation. Stop these threads so they cannot appear to resume with
        // stale authority after an administrator re-enables computer use.
        await client.query(`UPDATE agent_runs r SET "stopRequestedAt"=coalesce(r."stopRequestedAt",now()),"updatedAt"=now(),
          "finishedAt"=CASE WHEN r.status='queued' THEN now() ELSE r."finishedAt" END,
          status=CASE WHEN r.status='queued' THEN 'stopped' ELSE r.status END
          FROM computer_run_bindings b WHERE b."runId"=r.id AND b."workspaceId"=$1
            AND r.status=ANY($2::text[])`, [workspaceId, ['queued', 'preparing', 'running', 'waiting_input', 'finishing']])
      }
      const sync = async () => {
        for (const machine of machines) {
          if (!machine.sandboxId || !machine.runtimeReady) continue
          const sandbox = await this.runtime.connectComputer(machine.sandboxId)
          for (const desktop of desktops.filter(d => d.ownerId === machine.ownerId)) await this.runtime.syncDesktopLease(sandbox, this.lease(desktop, permission !== 'deny', policy.version))
        }
        // Dedicated threads have their own driver lease. Updating only the
        // Bot machine leaves an already issued thread grant on an old policy.
        const threads = (await client.query(`SELECT t."sandboxId",t."botId",t."ownerId",t.epoch FROM thread_machines t
          JOIN bots b ON b.id=t."botId" AND b."workspaceId"=t."workspaceId" AND b."ownerId"=t."ownerId"
          WHERE t."workspaceId"=$1 AND t."sandboxId" IS NOT NULL AND t.state IN ('starting','running') ORDER BY t."runId"`, [workspaceId])).rows
        for (const thread of threads) {
          const sandbox = await this.runtime.connectComputer(thread.sandboxId)
          await this.runtime.syncDesktopLease(sandbox, { botId: thread.botId, ownerId: thread.ownerId, display: 1, epoch: thread.epoch, controlledBy: null, controlUntil: 0, computerAllowed: permission !== 'deny', policyVersion: policy.version })
        }
      }
      // Every transition increments the policy version. The display lock
      // fences old approvals even if the subsequent database commit fails.
      await sync()
      await client.query('COMMIT')
      return { permission }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }
  private async bot(actor: Actor, botId: string, client: Pool | PoolClient = this.pool) {
    const { rows } = await client.query<Bot>('SELECT id,name,"workspaceId","ownerId" FROM bots WHERE id=$1 AND "workspaceId"=$2 AND "ownerId"=$3', [botId, actor.workspaceId, actor.userId])
    if (!rows[0]) throw new ComputerError(404, 'Computer not found')
    return rows[0]
  }
  async state(actor: Actor, botId: string): Promise<ComputerState> {
    await this.bot(actor, botId)
    const { rows } = await this.pool.query('SELECT m.state AS machine,m."sandboxId",d.control,d."controlledBy",d."controlUntil",d."lastAction" FROM bot_desktops d JOIN cloud_machines m ON m."workspaceId"=d."workspaceId" AND m."ownerId"=d."ownerId" WHERE d."botId"=$1 AND d."ownerId"=$2', [botId, actor.userId])
    const row = rows[0]
    if (!row) return { machine: 'sleeping', control: 'idle' }
    if (row.sandboxId && row.machine !== 'error') row.machine = await this.runtime.computerState(row.sandboxId)
    const held = row.control === 'user' && new Date(row.controlUntil).getTime() > Date.now()
    const review = (await this.pool.query(`SELECT v.id,v.digest,v."runId",v.call,v."expiresAt"
      FROM local_computer_reviews v JOIN agent_runs r ON r.id=v."runId" AND r."userId"=v."userId" AND r."deviceId"=v."deviceId"
      JOIN computer_run_bindings b ON b."runId"=r.id AND b."ownerId"=r."userId"
      WHERE b."botId"=$1 AND b."workspaceId"=$2 AND b."ownerId"=$3 AND v.decision IS NULL
        AND NOT EXISTS (SELECT 1 FROM workspace_computer_policies p WHERE p."workspaceId"=b."workspaceId" AND p.permission='deny')
        AND v."expiresAt">now() AND v."seenAt">now()-interval '10 seconds' AND r."stopRequestedAt" IS NULL AND r."leaseExpiresAt">now()
        AND r.status=ANY($4::text[]) ORDER BY v."seenAt",v.id LIMIT 1`, [botId, actor.workspaceId, actor.userId, ['running', 'preparing', 'waiting_input', 'finishing']])).rows[0]
    const call = review?.call
    const pendingApproval: ComputerState['pendingApproval'] = call && (call.name === 'click' || call.name === 'type_text' || call.name === 'get_desktop_state' || call.name === 'press_key' || call.name === 'scroll')
      ? { id: review.id, digest: review.digest, runId: review.runId, botId,
          action: call.name === 'click' ? { tool: 'click', x: call.arguments.x, y: call.arguments.y }
            : call.name === 'type_text' ? { tool: 'type', text: call.arguments.text }
              : call.name === 'press_key' ? { tool: 'key', text: [...(call.arguments.modifiers ?? []), call.arguments.key].join('+') }
                : call.name === 'scroll' ? { tool: 'scroll', text: `${call.arguments.direction} × ${call.arguments.amount}`, x: call.arguments.x, y: call.arguments.y } : { tool: 'screenshot' },
          summary: call.name,
          expiresAt: new Date(review.expiresAt).toISOString() } : undefined
    return { machine: row.machine, control: held ? 'user' : row.control === 'user' ? 'agent' : row.control,
      ...(held ? { controlledBy: { userId: row.controlledBy } } : {}), ...(row.lastAction ? { lastAction: row.lastAction } : {}), ...(pendingApproval ? { pendingApproval } : {}) }
  }
  private lease(d: Desktop, computerAllowed = true, policyVersion = 0): provider.DesktopLease {
    return { botId: d.botId, ownerId: d.ownerId, display: d.display, epoch: d.epoch, controlledBy: d.controlledBy, controlUntil: d.controlUntil ? new Date(d.controlUntil).getTime() / 1000 : 0, computerAllowed, policyVersion }
  }
  async operate(actor: Actor, botId: string, action: 'wake' | 'viewer' | 'takeover' | 'handback', mode: 'view' | 'control' = 'view') {
    await this.bot(actor, botId)
    const sandbox = await ensureCloudMachine(this.pool,actor,this.runtime)
    if (!sandbox) throw new ComputerError(409,'Computer provisioning in progress')
    const client = await this.pool.connect()
    let persistProgress = false
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`computer-policy:${actor.workspaceId}`])
      const machine = (await client.query<Machine>('SELECT * FROM cloud_machines WHERE "workspaceId"=$1 AND "ownerId"=$2 FOR UPDATE', [actor.workspaceId,actor.userId])).rows[0]
      if (!machine || machine.sandboxId !== sandbox.sandboxId) throw new ComputerError(409,'Computer allocation changed')
      await this.bot(actor,botId,client)
      let desktop = (await client.query<Desktop>('SELECT * FROM bot_desktops WHERE "botId"=$1 FOR UPDATE', [botId])).rows[0]
      if (!desktop) {
        const next = Number((await client.query('SELECT coalesce(max(display),0)+1 AS n FROM bot_desktops WHERE "workspaceId"=$1 AND "ownerId"=$2', [actor.workspaceId,actor.userId])).rows[0].n)
        if (next > 999) throw new ComputerError(409, 'Desktop limit reached')
        desktop = (await client.query<Desktop>('INSERT INTO bot_desktops ("botId","workspaceId","ownerId",display) VALUES ($1,$2,$3,$4) RETURNING *', [botId, actor.workspaceId, actor.userId, next])).rows[0]
      }
      // Starting a display can succeed even if the response is lost. Retain its
      // bot binding so a later bot cannot inherit an orphaned live desktop.
      persistProgress = true
      await this.runtime.startDesktop(sandbox, desktop.display)
      const held = desktop.control === 'user' && desktop.controlUntil && new Date(desktop.controlUntil).getTime() > Date.now()
      if (action === 'takeover') {
        if (held && desktop.controlledBy !== actor.userId) throw new ComputerError(409, 'Computer is already controlled')
        desktop.control = 'user'; desktop.controlledBy = actor.userId
        desktop.controlUntil = new Date(Date.now() + 5 * 60_000); desktop.epoch++
      } else if (action === 'handback') {
        if (held && desktop.controlledBy !== actor.userId) throw new ComputerError(409, 'Control is held by another user')
        desktop.control = 'agent'; desktop.controlledBy = null; desktop.controlUntil = null; desktop.epoch++
      } else if (mode === 'control') {
        if (!held || desktop.controlledBy !== actor.userId) throw new ComputerError(403, 'Take control first')
        desktop.controlUntil = new Date(Date.now() + 5 * 60_000)
      }
      const policy = (await client.query('SELECT permission,version FROM workspace_computer_policies WHERE "workspaceId"=$1', [actor.workspaceId])).rows[0]
      const lease = this.lease(desktop, policy?.permission !== 'deny', policy?.version ?? 0)
      await client.query('UPDATE bot_desktops SET control=$2,"controlledBy"=$3,"controlUntil"=$4,epoch=$5 WHERE "botId"=$1', [botId, desktop.control, desktop.controlledBy, desktop.controlUntil, desktop.epoch])
      persistProgress = true
      await this.runtime.syncDesktopLease(sandbox, lease)
      const result = action === 'viewer' || action === 'takeover'
        ? await this.runtime.viewerGrant(sandbox, lease, actor.userId, action === 'takeover' ? 'control' : mode) : null
      await client.query('COMMIT')
      return result
    } catch (error) {
      if (persistProgress) {
        // Never roll back a generation already sent to the gateway: doing so
        // could revive an old control token on the next synchronization.
        // An expected authorization/conflict response is not a provider failure.
        if (!(error instanceof ComputerError)) await client.query('UPDATE cloud_machines SET state=$2 WHERE "workspaceId"=$1 AND "ownerId"=$3', [actor.workspaceId, 'error',actor.userId])
        await client.query('COMMIT')
      } else await client.query('ROLLBACK')
      throw error
    } finally { client.release() }
  }
}
