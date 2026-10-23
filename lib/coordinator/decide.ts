import 'server-only'
import { getVercelOidcToken } from '@vercel/oidc'
import { gte, sum } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { db } from '@/lib/db'
import { decisionCalls } from '@/lib/db/schema'
import { answersByName, callCostUsd, DECISION_MODEL, DECISIONS_URL, type DecisionQuestion, type DecisionResponse, monthlyBudgetUsd, monthStart } from '@/lib/coordinator/decision'

/** Longest a decision call may take before the caller falls back to its rules. */
const DECISION_TIMEOUT_MS = 5000

/** AI Gateway credentials: a gateway key when set, otherwise the deployment's OIDC token. */
async function gatewayToken(): Promise<string | null> {
  if (process.env.AI_GATEWAY_API_KEY) return process.env.AI_GATEWAY_API_KEY
  if (process.env.VERCEL !== '1') return null
  try {
    return await getVercelOidcToken()
  } catch {
    return null
  }
}

/** USD the decision model has cost this calendar month (UTC). */
export async function decisionSpendThisMonth(): Promise<number> {
  const [row] = await db.select({ total: sum(decisionCalls.costUsd) }).from(decisionCalls).where(gte(decisionCalls.createdAt, monthStart()))
  return Number(row?.total ?? 0)
}

/**
 * Asks the decision model `questions` about `input`; `purpose` labels the call
 * in the spend ledger. Returns the answers by question name, or null when
 * there are no credentials, this month's budget is spent, or the call fails,
 * so the caller falls back to its fixed rules. Never throws.
 */
export async function decide(purpose: string, input: string, questions: DecisionQuestion[]) {
  try {
    const token = await gatewayToken()
    if (!token) return null
    const budget = monthlyBudgetUsd()
    if (await decisionSpendThisMonth() >= budget) {
      console.warn(`Decision model skipped: this month's $${budget} budget is spent`)
      return null
    }
    const response = await fetch(DECISIONS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: DECISION_MODEL, input, questions }),
      signal: AbortSignal.timeout(DECISION_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`AI Gateway answered ${response.status}`)
    const body = await response.json() as DecisionResponse
    await db.insert(decisionCalls).values({ id: randomUUID(), purpose, model: DECISION_MODEL, inputTokens: body.usage?.input_tokens ?? 0, costUsd: String(callCostUsd(body)) })
    return answersByName(body)
  } catch (error) {
    console.error(`Decision call (${purpose}) failed`, error instanceof Error ? error.message : error)
    return null
  }
}
