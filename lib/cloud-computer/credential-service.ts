import 'server-only'
import { ComputerError } from '@/lib/computer/store'
import { parseCredentialAction, type CredentialAction } from './credential-action-ledger'

export type CredentialServiceResult = { status: 'needs_login' | 'session_applied' | 'submitted' | 'guarded' }
export function credentialServiceOutcome(raw: unknown): CredentialServiceResult {
  if (!raw || typeof raw !== 'object' || !('status' in raw) || typeof raw.status !== 'string' || !['needs_login', 'session_applied', 'submitted', 'guarded'].includes(raw.status)) throw new ComputerError(503, 'Credential service outcome unavailable')
  return { status: raw.status as CredentialServiceResult['status'] }
}

/** #345 owns the I/O implementation. It must load and atomically consume
 * actionId from pending_actions and validate exact input/current run policy
 * under its own policy -> credentials lock order. No approved flag or
 * client-held policy lock is an authorization substitute. */
export async function executeRecordedCredentialAction(action: CredentialAction): Promise<CredentialServiceResult> {
  if (process.env.CREDENTIAL_VAULT_ENABLED !== '1') throw new ComputerError(503, 'Credential vault unavailable')
  parseCredentialAction(action)
  const { pool } = await import('@/lib/db')
  const { credentialStore, executeCredentialLease } = await import('@/lib/credentials/runtime')
  const { resolveRecordedCredentialTarget } = await import('./subagent-browser')
  const caller = { userId: action.userId, workspaceId: action.workspaceId, botId: action.botId, subagentId: action.subagentId }
  await credentialStore.authorize(caller)
  const target = await resolveRecordedCredentialTarget(action)
  const lease = await credentialStore.lease(caller, action.origin, target, undefined, action.forcePassword === true)
  if (lease.status === 'needs_login') {
    const consumed = await pool.query(`UPDATE pending_actions SET context='{"credentialExecuting":true}'::jsonb WHERE id=$1 AND "userId"=$2 AND action='browser_operation' AND status='running' AND context IS NULL AND input=$3::jsonb RETURNING id`, [action.actionId, action.userId, JSON.stringify(action)])
    if (!consumed.rowCount) throw new ComputerError(409, 'Credential action already consumed')
    return { status: 'needs_login' }
  }
  return credentialServiceOutcome(await executeCredentialLease(lease.lease, action.origin))
}
