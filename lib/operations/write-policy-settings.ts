import type { Pool } from 'pg'
import { z } from 'zod'
import type { AgentScope } from '@/lib/agent-kit/store'
import { AgentKitError } from '@/lib/agent-kit/store'
import type { MailboxTransactionGuard } from '@/lib/mailbox-transaction-guard'
import { writeTransaction } from './write-transaction'

export const writePolicySettingsSchema = z.record(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), z.enum(['allow', 'ask', 'deny'])).refine(value => Object.keys(value).length <= 100)
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
  return {
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
