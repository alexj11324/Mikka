import 'server-only'
import { auth } from '@/lib/auth'
import { pool } from '@/lib/db'
import { getComposio } from '@/lib/composio'
import { createApprovedWrites } from './approved-writes'
import { composioWriteProvider } from './write-provider'
import { composioConditionalCalendarDelete } from './calendar-conditional'
import type { WriteRequestContext } from './write-transaction'
import type { WriteActionName } from './write-contract'
import { createApprovedWriteDiscovery } from './write-discovery'
import { workspacePool } from '@/lib/workspace-db'
import { acquireWorkspaceMembership } from '@/lib/workspace-membership-guard'
import { personalWritesEnabled } from './write-feature'
import { agentScope } from '@/lib/agent-kit/service'
import { createHash } from 'node:crypto'
import { WRITE_ACTIONS } from './write-contract'
import type { ModelWriteCall } from './model-write-tools'
import { nativeMailboxFence, type PersonalNativeScope } from '@/lib/personal-mailbox-fence'
import { WORKSPACE_ID } from '@/lib/device-link'
import type { MailboxTransactionGuard } from '@/lib/mailbox-transaction-guard'

function guardForRun(run: { ownerId:string; workspaceId:string | null }) {
  return run.workspaceId ? (_tx: unknown, signal: AbortSignal) => acquireWorkspaceMembership(workspacePool, { workspaceId:run.workspaceId!, userId:run.ownerId }, signal) : undefined
}
function callIntent(runId:string, callId:string) {
  const bytes = createHash('sha256').update(JSON.stringify(['model-write-v1',runId,callId])).digest().subarray(0,16)
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128
  const hex = bytes.toString('hex'); return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`
}
/** Trusted host entry: no owner, run, permission or account comes from tool input. */
export async function personalWriteFromRun(ownerId:string, botId:string | null, runId:string, call:ModelWriteCall, nativeScope?:PersonalNativeScope) {
  if (!personalWritesEnabled() || !(WRITE_ACTIONS as readonly string[]).includes(call.action)) throw new Error('approvedWritesDisabled')
  const scope = await agentScope(ownerId,botId)
  const run = { ...scope, runId }
  const memberGuard = guardForRun(run)
  const fence = nativeScope ? nativeMailboxFence({ userId:ownerId, botId, workspaceId:run.workspaceId ?? WORKSPACE_ID, scope:nativeScope, action:call.action, toolName:call.action }, personalWritesEnabled) : undefined
  const guard: MailboxTransactionGuard | undefined = fence ? async (tx, signal) => {
    await fence(tx)
    const member = await memberGuard?.(tx,signal)
    return { signal:member?.signal ?? signal, async check() { await fence(tx); await member?.check() }, async close() { await member?.close() } }
  } : memberGuard
  const service = personalWriteRuntime().operations(call.action as WriteActionName,{ modelRun:run, guard, guardForRun })
  return service.proposeFromRun(call.input,callIntent(runId,call.toolCallId))
}

/** Reuses the application's personal-account auth and shared pool. No new
 * approval table, connection selector, user-supplied owner or worker authority.
 * No verified Slack contract or atomic Calendar transport is configured here. */
export function personalWriteRuntime() {
  return {
    auth,
    discovery: createApprovedWriteDiscovery(pool),
    operations: (action: WriteActionName, context?: WriteRequestContext) => {
      const client = getComposio()
      return createApprovedWrites(pool, composioWriteProvider(client, action, composioConditionalCalendarDelete(client)), action, { ...context, guardForRun })
    },
  }
}
