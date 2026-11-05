import type { Pool, PoolClient } from 'pg'
import { afterCommit, hasCommitEffect } from '../db/commit-effects'
import { liveGatewayConfig, type LiveScope } from './scope'
import type { LiveInvalidation } from './events'

type Database = Pick<Pool, 'query'>
type Target = { botId?: string; ownerId?: string; workspaceId?: string }

/** Computer reads are owner-only, including in a shared workspace. Resolve
 * the persisted Bot again after COMMIT; a stale caller cannot choose a channel. */
export async function computerLiveTargets(database: Database, workspaceDatabase: Database, target: Target) {
  const { rows } = await database.query<{ id: string; ownerId: string; workspaceId: string }>(
    `SELECT id,"ownerId","workspaceId" FROM bots WHERE ($1::uuid IS NULL OR id=$1)
      AND ($2::text IS NULL OR "ownerId"=$2) AND ($3::uuid IS NULL OR "workspaceId"=$3)`,
    [target.botId ?? null, target.ownerId ?? null, target.workspaceId ?? null],
  )
  const groups = new Map<string, { scope: LiveScope; events: LiveInvalidation[] }>()
  for (const row of rows) {
    const key = `${row.ownerId}:${row.workspaceId}`
    let group = groups.get(key)
    if (!group) {
      const member = await workspaceDatabase.query(
        'SELECT 1 FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2 AND status=\'active\'',
        [row.workspaceId, row.ownerId],
      )
      if (!member.rowCount) continue
      group = { scope: { ownerId: row.ownerId, workspaceId: row.workspaceId }, events: [] }
      groups.set(key, group)
    }
    group.events.push({ kind: 'computer_state', id: row.id })
  }
  return [...groups.values()]
}

async function sender(database: Database, target: Target) {
  const { scheduleLive, sendLiveInvalidations } = await import('./notify')
  return () => scheduleLive(async () => {
    const { withoutDatabaseClient } = await import('../db/request-scope')
    const { workspacePool } = await import('../workspace-db')
    await withoutDatabaseClient(async () => {
      const groups = await computerLiveTargets(database, workspacePool, target)
      for (const { scope, events } of groups) {
        for (let offset = 0; offset < events.length; offset += 16) await sendLiveInvalidations(scope, events.slice(offset, offset + 16))
      }
    })
  })
}

async function changed(tx: PoolClient, database: Database, target: Target, key: string) {
  if (!liveGatewayConfig(process.env) || hasCommitEffect(tx, key)) return
  afterCommit(tx, key, await sender(database, target))
}

export const computerChanged = (tx: PoolClient, database: Database, botId: string) =>
  changed(tx, database, { botId }, `computer_state:${botId}`)

export const machineChanged = (tx: PoolClient, database: Database, ownerId: string, workspaceId: string) =>
  changed(tx, database, { ownerId, workspaceId }, `computer_machine:${ownerId}:${workspaceId}`)

export const computerWorkspaceChanged = (tx: PoolClient, database: Database, workspaceId: string) =>
  changed(tx, database, { workspaceId }, `computer_workspace:${workspaceId}`)

/** Only for a provider reconciliation whose guarded UPDATE already committed. */
export async function machineCommitted(database: Database, ownerId: string, workspaceId: string) {
  if (!liveGatewayConfig(process.env)) return
  ;(await sender(database, { ownerId, workspaceId }))()
}
