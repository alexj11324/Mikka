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
    return (await this.pool.query<Bot>('SELECT id,name,"workspaceId","ownerId" FROM bots WHERE "workspaceId"=$1 AND "ownerId"=$2 ORDER BY "createdAt"', [actor.workspaceId, actor.userId])).rows
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
        AND v."expiresAt">now() AND v."seenAt">now()-interval '10 seconds' AND r."stopRequestedAt" IS NULL
        AND r.status=ANY($4::text[]) ORDER BY v."seenAt",v.id LIMIT 1`, [botId, actor.workspaceId, actor.userId, ['running', 'preparing', 'waiting_input', 'finishing']])).rows[0]
    const call = review?.call
    const pendingApproval: ComputerState['pendingApproval'] = call && (call.name === 'click' || call.name === 'type_text' || call.name === 'get_desktop_state')
      ? { id: review.id, digest: review.digest, runId: review.runId, botId,
          action: call.name === 'click' ? { tool: 'click', x: call.arguments.x, y: call.arguments.y }
            : call.name === 'type_text' ? { tool: 'type', text: call.arguments.text } : { tool: 'screenshot' },
          summary: call.name,
          expiresAt: new Date(review.expiresAt).toISOString() } : undefined
    return { machine: row.machine, control: held ? 'user' : row.control === 'user' ? 'agent' : row.control,
      ...(held ? { controlledBy: { userId: row.controlledBy } } : {}), ...(row.lastAction ? { lastAction: row.lastAction } : {}), ...(pendingApproval ? { pendingApproval } : {}) }
  }
  private lease(d: Desktop): provider.DesktopLease {
    return { botId: d.botId, ownerId: d.ownerId, display: d.display, epoch: d.epoch, controlledBy: d.controlledBy, controlUntil: d.controlUntil ? new Date(d.controlUntil).getTime() / 1000 : 0 }
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
      const lease = this.lease(desktop)
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
