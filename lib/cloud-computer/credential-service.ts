import 'server-only'
import { ComputerError } from '@/lib/computer/store'
import type { CredentialAction } from './credential-action-ledger'

export type CredentialServiceResult = { status: 'needs_login' | 'session_applied' | 'submitted' | 'guarded' }
export function credentialServiceOutcome(raw: unknown): CredentialServiceResult {
  if (!raw || typeof raw !== 'object' || !('status' in raw) || typeof raw.status !== 'string' || !['needs_login', 'session_applied', 'submitted', 'guarded'].includes(raw.status)) throw new ComputerError(503, 'Credential service outcome unavailable')
  return { status: raw.status as CredentialServiceResult['status'] }
}

/** #345 owns the I/O implementation. It must load and atomically consume
 * actionId from pending_actions and validate exact input/current run policy
 * under its own policy -> credentials lock order. No approved flag or
 * client-held policy lock is an authorization substitute. */
export async function executeRecordedCredentialAction(_action: CredentialAction): Promise<CredentialServiceResult> {
  throw new ComputerError(503, 'Credential service action binding unavailable')
}
