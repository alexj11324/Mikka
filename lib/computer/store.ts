import 'server-only'
import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import type { ComputerState } from '@mikka/protocol/computer'
import * as provider from './e2b-provider'

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
    return (await this.pool.query<Bot>('SELECT id,name,"workspaceId","ownerId" FROM bots WHERE "workspaceId"=$1 AND "ownerId"=$2 AND NOT EXISTS (SELECT 1 FROM coordinator_web_bots c WHERE c."botId"=bots.id) ORDER BY "createdAt"', [actor.workspaceId, actor.userId])).rows
  }
  async policy(workspaceId: string): Promise<'ask' | 'deny'> {
    const row = (await this.pool.query('SELECT permission FROM workspace_computer_policies WHERE "workspaceId"=$1', [workspaceId])).rows[0]
    return row?.permission === 'deny' ? 'deny' : 'ask'
  }
  /** Caller must authorize an active workspace admin. Serializes policy
   * transitions with display wake/control and each actual driver call. */
  async setPolicy(workspaceId: string, permission: 'ask' | 'deny') {
    const client = await this.pool.connect()
    const key = `computer-policy:${workspaceId}`
    let stoppedQueued: { id: string; botId: string; ownerId: string }[] = []
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [key])
      const machine = (await client.query<Machine>('SELECT * FROM cloud_machines WHERE "workspaceId"=$1 FOR UPDATE', [workspaceId])).rows[0]
      const desktops = (await client.query<Desktop>('SELECT * FROM bot_desktops WHERE "workspaceId"=$1 ORDER BY display FOR UPDATE', [workspaceId])).rows
      const subagents = (await client.query<{ id: string; botId: string; ownerId: string; epoch: number; controlledBy: string | null; controlUntil: Date | null; stopRequestedAt: Date | null }>(`SELECT * FROM bot_subagents WHERE "workspaceId"=$1
        AND state IN ('running','needs_you') AND "browserContextId" IS NOT NULL ORDER BY id FOR UPDATE`, [workspaceId])).rows
      const threadDesktops = (await client.query<Desktop & { sandboxId: string; machineState: string }>(`SELECT d.*,1 AS display,t."sandboxId",t.state AS "machineState" FROM thread_desktops d
        JOIN thread_machines t ON t."runId"=d."runId" AND t."ownerId"=d."ownerId" AND t."workspaceId"=d."workspaceId"
        WHERE d."workspaceId"=$1 AND t."runtimeReady"=true AND t."sandboxId" IS NOT NULL AND t.state IN ('running','paused')
        ORDER BY d."runId" FOR UPDATE OF d`, [workspaceId])).rows
      const policy = (await client.query(`INSERT INTO workspace_computer_policies ("workspaceId",permission,version)
        VALUES ($1,$2,CASE WHEN $2='deny' THEN 1 ELSE 0 END)
        ON CONFLICT ("workspaceId") DO UPDATE SET permission=$2,"updatedAt"=now(),
          version=CASE WHEN workspace_computer_policies.permission=$2 THEN workspace_computer_policies.version ELSE workspace_computer_policies.version+1 END
        RETURNING version`, [workspaceId, permission])).rows[0]
      if (permission === 'deny') {
        await client.query('UPDATE computer_run_bindings SET "approvedForRun"=false WHERE "workspaceId"=$1', [workspaceId])
        await client.query(`UPDATE local_computer_reviews v SET decision=false FROM computer_run_bindings b
          WHERE v."runId"=b."runId" AND b."workspaceId"=$1 AND v.decision IS NULL`, [workspaceId])
        // Previously delivered approvals cannot be rebound to a later policy
        // generation. Stop these threads so they cannot appear to resume with
        // stale authority after an administrator re-enables computer use.
        await client.query(`UPDATE agent_runs r SET "stopRequestedAt"=coalesce(r."stopRequestedAt",now()),"updatedAt"=now(),
          "finishedAt"=CASE WHEN r.status='queued' THEN now() ELSE r."finishedAt" END,
          status=CASE WHEN r.status='queued' THEN 'stopped' ELSE r.status END
          FROM computer_run_bindings b WHERE b."runId"=r.id AND b."workspaceId"=$1
            AND r.status=ANY($2::text[])`, [workspaceId, ['queued', 'preparing', 'running', 'waiting_input', 'finishing']])
        const stopped = await client.query<{ id: string; botId: string; ownerId: string; state: string }>(`UPDATE bot_subagents SET "stopRequestedAt"=coalesce("stopRequestedAt",now()),
          state=CASE WHEN state='queued' THEN 'stopped' ELSE state END,
          "endedAt"=CASE WHEN state='queued' THEN now() ELSE "endedAt" END
          WHERE "workspaceId"=$1 AND state IN ('queued','running','needs_you') RETURNING id,"botId","ownerId",state`, [workspaceId])
        stoppedQueued = stopped.rows.filter(row => row.state === 'stopped')
        await client.query(`UPDATE bot_subagent_approvals SET state='denied',"decidedAt"=now()
          WHERE "workspaceId"=$1 AND state IN ('pending','approved')`, [workspaceId])
      }
      const sync = async () => {
        if (machine?.sandboxId && machine.runtimeReady && desktops.length) {
          const sandbox = await this.runtime.connectComputer(machine.sandboxId)
          for (const desktop of desktops) await this.runtime.syncDesktopLease(sandbox, this.lease(desktop, permission !== 'deny', policy.version))
        }
        if (machine?.sandboxId && machine.runtimeReady && subagents.length) {
          const sandbox = await this.runtime.connectComputer(machine.sandboxId)
          for (const subagent of subagents) await this.runtime.syncSubagentLease(sandbox, {
            subagentId: subagent.id, botId: subagent.botId, ownerId: subagent.ownerId, workspaceId,
            epoch: subagent.epoch, controlledBy: subagent.controlledBy,
            controlUntil: subagent.controlUntil ? new Date(subagent.controlUntil).getTime() / 1000 : 0,
            computerAllowed: permission !== 'deny', policyVersion: policy.version,
            stopRequested: permission === 'deny' || !!subagent.stopRequestedAt,
          })
        }
        for (const desktop of threadDesktops) {
          const sandbox = await this.runtime.connectComputer(desktop.sandboxId)
          await this.runtime.syncDesktopLease(sandbox, this.lease(desktop, permission !== 'deny', policy.version))
          if (desktop.machineState === 'paused') await this.runtime.threadMachineProvider.pause(desktop.sandboxId)
        }
      }
      // Every transition increments the policy version. The display lock
      // fences old approvals even if the subsequent database commit fails.
      await sync()
      await client.query('COMMIT')
      for (const task of stoppedQueued) {
        try {
          await (await import('@/lib/suggestions/execution')).finishSuggestionSubagent(this.pool, task.ownerId, task.id, 'stopped')
          await (await import('./subagent-notice')).subagentNotice(this.pool, { userId: task.ownerId, workspaceId }, task.botId, task.id, 'finished', { state: 'stopped' })
        } catch { console.error('Could not report stopped web task') }
      }
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
    const { rows } = await this.pool.query('SELECT m.state AS machine,m."sandboxId",d.control,d."controlledBy",d."controlUntil",d."lastAction" FROM bot_desktops d JOIN cloud_machines m USING ("workspaceId") WHERE d."botId"=$1 AND d."ownerId"=$2', [botId, actor.userId])
    const row = rows[0]
    if (!row) return { machine: 'sleeping', control: 'idle' }
    if (row.sandboxId && row.machine !== 'error') row.machine = await this.runtime.computerState(row.sandboxId)
    const held = row.control === 'user' && new Date(row.controlUntil).getTime() > Date.now()
    const review = (await this.pool.query(`SELECT v.id,v.digest,v."runId",v.call,v."expiresAt"
      FROM local_computer_reviews v JOIN agent_runs r ON r.id=v."runId" AND r."userId"=v."userId" AND r."deviceId"=v."deviceId"
      JOIN computer_run_bindings b ON b."runId"=r.id AND b."ownerId"=r."userId"
      WHERE b."botId"=$1 AND b."workspaceId"=$2 AND b."ownerId"=$3 AND v.decision IS NULL
        AND NOT EXISTS (SELECT 1 FROM thread_machines t WHERE t."runId"=r.id)
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
    // Persist the idempotency key before provisioning: a crashed request cannot
    // provision an unbounded number of instances on retry.
    await this.pool.query('INSERT INTO cloud_machines ("workspaceId","ownerId","operationId") VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [actor.workspaceId, actor.userId, randomUUID()])
    const client = await this.pool.connect()
    let persistProgress = false
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`computer-policy:${actor.workspaceId}`])
      const machine = (await client.query<Machine>('SELECT * FROM cloud_machines WHERE "workspaceId"=$1 FOR UPDATE', [actor.workspaceId])).rows[0]
      // A shared Unix account is not a multi-owner isolation boundary. Until
      // separate OS/sandbox isolation ships, one workspace machine has one owner.
      if (machine.ownerId !== actor.userId) throw new ComputerError(409, 'This workspace computer belongs to another account owner')
      await this.bot(actor, botId, client)
      let sandbox
      if (machine.sandboxId) sandbox = await this.runtime.connectComputer(machine.sandboxId)
      else {
        sandbox = await this.runtime.createComputer(actor.workspaceId, machine.operationId)
        await client.query('UPDATE cloud_machines SET "sandboxId"=$2,state=$3 WHERE "workspaceId"=$1', [actor.workspaceId, sandbox.sandboxId, 'waking'])
        persistProgress = true
      }
      if (!machine.runtimeReady) {
        await this.runtime.installComputerRuntime(sandbox)
        await client.query('UPDATE cloud_machines SET "runtimeReady"=true WHERE "workspaceId"=$1', [actor.workspaceId])
      }
      await client.query('UPDATE cloud_machines SET "sandboxId"=$2,state=$3,"lastActiveAt"=now() WHERE "workspaceId"=$1', [actor.workspaceId, sandbox.sandboxId, 'running'])
      let desktop = (await client.query<Desktop>('SELECT * FROM bot_desktops WHERE "botId"=$1 FOR UPDATE', [botId])).rows[0]
      if (!desktop) {
        const next = Number((await client.query('SELECT coalesce(max(display),0)+1 AS n FROM bot_desktops WHERE "workspaceId"=$1', [actor.workspaceId])).rows[0].n)
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
        if (!(error instanceof ComputerError)) await client.query('UPDATE cloud_machines SET state=$2 WHERE "workspaceId"=$1', [actor.workspaceId, 'error'])
        await client.query('COMMIT')
      } else await client.query('ROLLBACK')
      throw error
    } finally { client.release() }
  }
}
