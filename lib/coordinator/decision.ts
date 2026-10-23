// The decision model: one call answers typed questions (yes/no probability,
// pick one of several, or a score) about some input, instead of writing text.
// It goes through Vercel AI Gateway's OpenAI-compatible Decisions API, and its
// spend is capped per calendar month so it stays inside the Gateway's free
// quota. Callers fall back to fixed rules whenever it does not answer.

/** The decision model on AI Gateway. */
export const DECISION_MODEL = 'openai/gpt-6-luna-decisions'
/** AI Gateway's Decisions endpoint. */
export const DECISIONS_URL = 'https://ai-gateway.vercel.sh/v1/decisions'
/** The Gateway's free quota is $5 a month per Vercel team. */
export const DEFAULT_MONTHLY_BUDGET_USD = 5
/** Input price, used when the Gateway does not report a call's cost. Output is free. */
const INPUT_USD_PER_TOKEN = 0.1 / 1_000_000

export type DecisionQuestion =
  | { type: 'predicate'; name: string; instructions: string }
  | { type: 'choice'; name: string; instructions: string; choices: { value: string; description?: string }[] }

export type DecisionAnswer =
  | { type: 'predicate'; name: string; probability: number }
  | { type: 'choice'; name: string; choice: string; confidence?: number; probabilities?: { value: string; probability: number }[] }
  | { type: 'refusal'; name: string }

export interface DecisionResponse {
  answers?: DecisionAnswer[]
  usage?: { input_tokens?: number }
  provider_metadata?: { gateway?: { cost?: string | number } }
}

/** The monthly cap: DECISION_MONTHLY_BUDGET_USD when set to a number, otherwise the free quota. */
export function monthlyBudgetUsd(env: Record<string, string | undefined> = process.env): number {
  const value = Number(env.DECISION_MONTHLY_BUDGET_USD)
  return env.DECISION_MONTHLY_BUDGET_USD?.trim() && Number.isFinite(value) && value >= 0 ? value : DEFAULT_MONTHLY_BUDGET_USD
}

/** Midnight UTC on the first of this month; spend since then counts against the cap. */
export function monthStart(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
}

/** What a call cost in USD: the Gateway's figure, or input tokens at list price. */
export function callCostUsd(body: DecisionResponse): number {
  const reported = Number(body.provider_metadata?.gateway?.cost)
  if (Number.isFinite(reported) && reported >= 0) return reported
  return (body.usage?.input_tokens ?? 0) * INPUT_USD_PER_TOKEN
}

/** The answers by question name, leaving out refusals. */
export function answersByName(body: DecisionResponse): Map<string, Exclude<DecisionAnswer, { type: 'refusal' }>> {
  const answers = new Map<string, Exclude<DecisionAnswer, { type: 'refusal' }>>()
  for (const answer of body.answers ?? []) if (answer.type !== 'refusal' && answer.name) answers.set(answer.name, answer)
  return answers
}

/** Renders a record as `key: value` lines for the model to read. */
export function decisionInput(state: Record<string, string>): string {
  return Object.entries(state).map(([key, value]) => `${key}: ${value}`).join('\n')
}
