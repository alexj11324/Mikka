import { DESKTOP_RPC_VERSION } from '../../../lib/desktop-rpc/wire'
import type { DecisionReceipt } from '../../../hooks/decision-submission'

type Response = {
  version?: number
  ok?: boolean
  result?: { queued?: boolean; error?: string }
  error?: { code?: string }
}
type Request = (path: string, init: { method: 'POST'; body: { version: number; action: string; args: string[] } }) => Promise<Response>

function refusal(code: string, status?: number): DecisionReceipt {
  const unavailable = code === 'suggestionNotFound' || status === 401 || status === 403 || status === 404
  return { status: unavailable ? 'unavailable' : 'failed', error: code }
}

/** The suggestion ID is also the server's idempotency key for an acknowledged replay. */
export async function handoffSuggestion(id: string, request: Request): Promise<DecisionReceipt> {
  try {
    const response = await request('/api/rpc', {
      method: 'POST', body: { version: DESKTOP_RPC_VERSION, action: 'coordinator.sendSuggestion', args: [id] },
    })
    if (response?.version === DESKTOP_RPC_VERSION) {
      const error = response.ok ? response.result?.error : response.error?.code
      if (error) return refusal(error)
      if (response.ok && response.result?.queued === true) return { status: 'accepted' }
    }
  } catch (error) {
    const failure = error as { status?: number; code?: string | { code?: string } } | null
    if (failure?.status && failure.status < 500) {
      const code = typeof failure.code === 'string' ? failure.code : failure.code?.code
      return refusal(code || 'generic', failure.status)
    }
  }
  return { status: 'uncertain', error: 'decisionUnconfirmed' }
}
