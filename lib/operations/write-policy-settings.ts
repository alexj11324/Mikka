import type { Pool } from 'pg'
import { z } from 'zod'
import type { AgentScope } from '@/lib/agent-kit/store'
import { AgentKitError } from '@/lib/agent-kit/store'
import type { MailboxTransactionGuard } from '@/lib/mailbox-transaction-guard'
import type { PoolClient } from 'pg'
import { writeTransaction } from './write-transaction'

export const writePolicySettingsSchema = z.record(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), z.enum(['allow', 'ask', 'deny']))
  .refine(value => Object.keys(value).length <= 100)
  // Browser actions have no "ask": bots operate their browsers without asking (Alex, 2026-10-30 and 2026-11-01).
  .refine(value => Object.entries(value).every(([key, decision]) => !key.startsWith('browser_') || decision !== 'ask'), { message: 'browserAskUnavailable' })
const versionSchema = z.string().regex(/^(0|[1-9]\d*)$/)

/** Host supplies workspace membership lease; model input cannot select identity. */
export function createWritePolicySettings(pool: Pool, membershipGuard: (scope: AgentScope) => MailboxTransactionGuard | undefined) {
  async function work<T>(scope: AgentScope, callback: (row: { permissions: unknown; version: string }, tx: Parameters<Parameters<typeof writeTransaction>[1]>[0]) => Promise<T>) {
    const guard = membershipGuard(scope)
    if (scope.botId && (!scope.workspaceId || !guard)) throw new AgentKitError('agentScopeNotFound', 404)
    return writeTransaction(pool, async tx => {
      const rows = await tx.query<{ permissions: unknown; version: string }>('select external_write_permissions as permissions,external_write_policy_version as version from agent_kit_heads where owner_id=$1 and bot_key=$2 and workspace_id is not distinct from $3 for update', [scope.ownerId, scope.botId ?? 'coordinator', scope.workspaceId])
      if (!rows.rows[0]) throw new AgentKitError('agentScopeNotFound', 404)
      return callback(rows.rows[0], tx)
    }, { guard })
  }
  async function workspace<T>(scope: AgentScope, work: (tx: PoolClient) => Promise<T>, admin = false, after?: (tx: PoolClient, value: T) => Promise<T>) {
    const guard = membershipGuard(scope)
    if (!scope.botId || !scope.workspaceId || !guard) throw new AgentKitError('agentScopeNotFound',404)
    return writeTransaction(pool, async tx => {
      await tx.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [`workspace-external-write:${scope.workspaceId}`])
      return work(tx)
    }, { guard, guardedWork: async (tx,value,lease) => {
      if (!lease?.workspaceClient) throw new AgentKitError('agentScopeNotFound',404)
      if (admin) {
        const result = await lease.workspaceClient.query(`select role from mikka_workspace_members where "workspaceId"=$1 and "userId"=$2 and status='active' for share`, [scope.workspaceId, scope.ownerId])
        if (result.rows[0]?.role !== 'admin') throw new AgentKitError('workspaceAccessDenied',403)
      }
      return after ? after(tx,value) : value
    } })
  }
  async function workspaceRow(tx: PoolClient, workspaceId:string) {
    const result=await tx.query<{ permissions:unknown; version:string }>('select external_write_permissions as permissions,external_write_policy_version as version from workspace_computer_policies where "workspaceId"=$1 for update',[workspaceId])
    return result.rows[0] ?? { permissions:{},version:'0' }
  }
  return {
    readWorkspace: (scope:AgentScope) => workspace(scope, async tx => {
      const row=await workspaceRow(tx,scope.workspaceId!)
      return { permissions:writePolicySettingsSchema.parse(row.permissions),version:versionSchema.parse(String(row.version)) }
    }),
    setWorkspace: (scope:AgentScope,raw:unknown,expected:string) => {
      const permissions=writePolicySettingsSchema.parse(raw), version=versionSchema.parse(expected)
      return workspace(scope, async tx => {
        const row=await workspaceRow(tx,scope.workspaceId!)
        if (String(row.version)!==version) throw new AgentKitError('writePolicyChanged')
        return { permissions,version }
      }, true, async (tx,value) => {
        const result=await tx.query<{permissions:unknown;version:string}>(`insert into workspace_computer_policies ("workspaceId",permission,external_write_permissions,external_write_policy_version)
          values ($1,'allow',$2,case when $2::jsonb='{}'::jsonb then 0 else 1 end)
          on conflict ("workspaceId") do update set external_write_permissions=$2
          returning external_write_permissions as permissions,external_write_policy_version as version`,[scope.workspaceId,value.permissions])
        return {permissions:writePolicySettingsSchema.parse(result.rows[0].permissions),version:versionSchema.parse(String(result.rows[0].version))}
      })
    },
    read: (scope: AgentScope) => work(scope, async row => ({ permissions: writePolicySettingsSchema.parse(row.permissions), version: versionSchema.parse(String(row.version)) })),
    set: (scope: AgentScope, raw: unknown, expected: string) => {
      const permissions = writePolicySettingsSchema.parse(raw), version = versionSchema.parse(expected)
      return work(scope, async (row, tx) => {
        if (String(row.version) !== version) throw new AgentKitError('writePolicyChanged')
        const result = await tx.query<{ permissions: unknown; version: string }>('update agent_kit_heads set external_write_permissions=$3 where owner_id=$1 and bot_key=$2 returning external_write_permissions as permissions,external_write_policy_version as version', [scope.ownerId, scope.botId ?? 'coordinator', permissions])
        return { permissions: writePolicySettingsSchema.parse(result.rows[0].permissions), version: versionSchema.parse(String(result.rows[0].version)) }
      })
    },
  }
}
