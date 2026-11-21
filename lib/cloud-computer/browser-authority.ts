import 'server-only'
import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import { browserPermission, type BrowserEffect } from './visual-contract'
import type { Actor, Subagent } from './subagents'
import { ComputerError } from '@/lib/computer/store'
import { computerPermission } from '@/lib/computer/permission'

export async function lockBrowserAuthority(tx: PoolClient, actor: Actor, botId: string, id: string, effect: BrowserEffect) {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`computer-policy:${actor.workspaceId}`])
  // Match policy writers' locks: one decision, no new permission source.
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`workspace-external-write:${actor.workspaceId}`])
  const row=(await tx.query<Subagent>(`SELECT s.* FROM bot_subagents s JOIN bots b ON b.id=s."botId" AND b."ownerId"=s."ownerId" AND b."workspaceId"=s."workspaceId" WHERE s.id=$1 AND s."ownerId"=$2 AND s."workspaceId"=$3 AND s."botId"=$4 FOR UPDATE OF s`,[id,actor.userId,actor.workspaceId,botId])).rows[0]
  if (!row || !['running','needs_you'].includes(row.status)) throw new ComputerError(409,'Browser task unavailable')
  const policy=(await tx.query(`SELECT permission,version,external_write_permissions,external_write_policy_version FROM workspace_computer_policies WHERE "workspaceId"=$1 FOR SHARE`,[actor.workspaceId])).rows[0]
  const computer=computerPermission(policy?.permission)
  if (!computer) throw new ComputerError(503,'Computer policy unavailable')
  const workspace=policy?.external_write_permissions ?? {}
  const permission=browserPermission(effect,computer,workspace)
  const revision=createHash('sha256').update(JSON.stringify([computer,policy?.version ?? 0,policy?.external_write_policy_version ?? 0,workspace,effect])).digest('hex')
  return {row,permission,revision}
}
