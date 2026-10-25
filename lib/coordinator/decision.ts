// The decision model: one call answers typed questions (yes/no probability,
// pick one of several, or a score) about some input, instead of writing text.
// It goes through Vercel AI Gateway's OpenAI-compatible Decisions API with its
// own API key, whose Vercel budget caps the spend. Callers fall back to fixed
// rules whenever it does not answer.

/** The decision model on AI Gateway. */
export const DECISION_MODEL = 'openai/gpt-6-luna-decisions'
/** AI Gateway's Decisions endpoint. */
export const DECISIONS_URL = 'https://ai-gateway.vercel.sh/v1/decisions'

export type DecisionQuestion =
  | { type: 'predicate'; name: string; instructions: string }
  | { type: 'choice'; name: string; instructions: string; choices: { value: string; description?: string }[] }

export type DecisionAnswer =
  | { type: 'predicate'; name: string; probability: number }
  | { type: 'choice'; name: string; choice: string; confidence?: number; probabilities?: { value: string; probability: number }[] }
  | { type: 'refusal'; name: string }

export interface DecisionResponse { answers?: DecisionAnswer[] }

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
