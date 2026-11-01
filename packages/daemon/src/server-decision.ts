/**
 * The daemon cannot call the Decisions API itself (it needs the server's
 * gateway credential and billing scope), so a run asks the server:
 * POST /v1/runs/:runId/decision with its run credential. The server runs
 * `invokeDecision` (lib/coordinator/decide.ts) and returns the validated
 * answers, or null when there is no usable answer.
 *
 * Callers treat null as "no decision": the person's explicit allow/ask/deny
 * still wins first, and a judgment the API could not make falls back to the
 * agent's own call (allowed and logged), never to a hardcoded rule (Alex,
 * 2026-11-01). Hard boundaries (read-only runs, worktree containment, the
 * network ceiling, the git push deny) stay in code and are not asked.
 */
export type ServerDecisionPurpose =
  | 'command-action'
  | 'network-destination'
  | 'computer-action'
  | 'tool-access'
  | 'setup-recipe'
  | 'permission-default'

export type ServerDecisionQuestion =
  | { type: 'predicate'; name: string; instructions: string }
  | { type: 'choice'; name: string; instructions: string; choices: { value: string; description?: string }[] }

export interface ServerDecisionRequest {
  purpose: ServerDecisionPurpose
  /** Evidence for the model; untrusted content is labelled as such inside it. Bounded to 16k characters. */
  input: string
  questions: ServerDecisionQuestion[]
}

export type ServerDecisionAnswer =
  | { type: 'predicate'; name: string; probability: number }
  | { type: 'choice'; name: string; choice: string }

export type ServerDecisionAnswers = ReadonlyMap<string, ServerDecisionAnswer>

/** Ask the server's Decisions API on behalf of one run. Never throws; null means no usable answer. */
export type ServerDecide = (runId: string, request: ServerDecisionRequest, signal?: AbortSignal) => Promise<ServerDecisionAnswers | null>

/** A predicate answer at or above 0.5 is yes; null when the answer is missing or malformed. */
export function predicateAnswer(answers: ServerDecisionAnswers | null, name: string): boolean | null {
  const answer = answers?.get(name)
  return answer?.type === 'predicate' && Number.isFinite(answer.probability) ? answer.probability >= 0.5 : null
}

/** A choice answer within `values`; null when missing, malformed or outside them. */
export function choiceAnswer<T extends string>(answers: ServerDecisionAnswers | null, name: string, values: readonly T[]): T | null {
  const answer = answers?.get(name)
  return answer?.type === 'choice' && (values as readonly string[]).includes(answer.choice) ? answer.choice as T : null
}
