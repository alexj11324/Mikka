import { authorizeModel } from '@/lib/policy/runtime'
import 'server-only'
import { answersByName, DECISION_MODEL, DECISIONS_URL, type DecisionQuestion, type DecisionResponse } from '@/lib/coordinator/decision'

/** Longest a decision call may take before the caller falls back to its rules. */
const DECISION_TIMEOUT_MS = 5000

/**
 * Asks the decision model `questions` about `input`; `purpose` names the call
 * in logs. It signs in with its own AI Gateway key, DECISION_GATEWAY_API_KEY,
 * whose budget on Vercel caps what decisions can spend. Returns the answers by
 * question name, or null when the key is missing, the budget is spent (the
 * Gateway refuses) or the call fails, so the caller falls back to its fixed
 * rules. Never throws.
 */
export async function decide(purpose: string, input: string, questions: DecisionQuestion[], userId?: string) {
  const key = process.env.DECISION_GATEWAY_API_KEY
  if (!key || !userId) return null
  try {
    await authorizeModel(userId, { provider: 'vercel_gateway', model: DECISION_MODEL, endpoint: DECISIONS_URL, region: 'unknown' })
    const response = await fetch(DECISIONS_URL, {
      method: 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: DECISION_MODEL, input, questions }),
      signal: AbortSignal.timeout(DECISION_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`AI Gateway answered ${response.status}`)
    return answersByName(await response.json() as DecisionResponse)
  } catch (error) {
    console.error(`Decision call (${purpose}) failed`, error instanceof Error ? error.message : error)
    return null
  }
}
