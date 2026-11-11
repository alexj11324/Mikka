import { Client, ClientError } from 'eve/client'
import { withBasePath } from '@/lib/base-path'
import { ACTION_ERROR_CODES, type ActionErrorCode } from '@/lib/action-result'
import type { DispatchedTaskReceipt } from '@/lib/task-create-command'
export type SubmitOutcome =
  // Stored. Not an approval of anything the message asks for.
  | { kind: 'accepted'; enabled: boolean; sourceEventId: string | null; replayed: boolean; task?: DispatchedTaskReceipt }
  // The result is unknown (timeout, network error, 5xx). Sending again reuses the id.
  | { kind: 'uncertain' }
  // Signed out. Sending again as the same account reuses the id; another account starts anew.
  | { kind: 'authRequired' }
  // The server holds a different body under this id. Terminal: never resent, never given a new id.
  | { kind: 'conflict' }
  | { kind: 'rejected'; error: ActionErrorCode | 'originRejected' | 'failed' }
  // Another submission of this composer is still in flight.
  | { kind: 'busy' }

/** Bot identity is product metadata; the server resolves its Workspace and eve session. */
export function coordinatorAgentUrl(botId: string | null) {
  const query = botId ? `?botId=${encodeURIComponent(botId)}` : ''
  return withBasePath(`/api/agents${query}`)
}

export function coordinatorAgentClient(botId: string | null) {
  return new Client({ baseUrl: coordinatorAgentUrl(botId) })
}

/** Only closed public error codes become application copy. Provider bodies stay private. */
export function coordinatorSendFailure(error: unknown): SubmitOutcome {
  if (!ClientError.is(error)) return { kind: 'uncertain' }
  if (error.status === 401) return { kind: 'authRequired' }
  if (error.code === 'submissionConflict') return { kind: 'conflict' }
  if (error.status >= 500) return { kind: 'uncertain' }
  return { kind: 'rejected', error: ACTION_ERROR_CODES.find(code => code === error.code) ?? 'generic' }
}
