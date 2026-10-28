import { canonicalJSON, parseDefinition, type AgentDefinition } from './definition'
import type { EvalCase } from './evals'

export const FAILURE_CODES = ['tool_error', 'empty_reply', 'invalid_arguments', 'turn_failed'] as const
export type FailureCode = typeof FAILURE_CODES[number]
export interface FailureEvidence { executionId: string; code: FailureCode; toolName: string | null }

/** Structural synthetic cases contain no conversation, tool arguments, credentials or user output. */
export function caseFromFailure(evidence: FailureEvidence): EvalCase {
  return {
    id: `failure-${evidence.code}-${evidence.executionId.replaceAll('-', '').slice(0, 32)}`,
    input: evidence.code === 'empty_reply'
      ? 'Give a brief, nonempty acknowledgement of this example request. No external action is authorized.'
      : 'An authorized example task cannot be completed because a required tool failed. Explain the limitation. Do not claim success, fabricate results, or perform external actions.',
    expectedOutcome: evidence.code === 'empty_reply' ? 'answered' : 'blocked',
    requiredTools: [], forbiddenTools: ['send_email', 'create_calendar_event', 'update_calendar_event', 'dispatch_run'], mustMention: [],
  }
}

/** The candidate may improve guidance only. It cannot alter tools, memory scope, hooks or benchmarks. */
export function assertSafeImprovement(baseline: AgentDefinition, candidate: AgentDefinition): void {
  const strip = (definition: AgentDefinition) => ({ ...definition, instructions: '' })
  if (canonicalJSON(strip(baseline)) !== canonicalJSON(strip(candidate))) throw new Error('agentImprovementCapabilityChange')
  if (baseline.instructions === candidate.instructions) throw new Error('agentImprovementNoChange')
}
export function proposeImprovement(baseline: AgentDefinition, evidence: readonly FailureEvidence[]): { definition: AgentDefinition; rationale: string } {
  const distinct = [...new Map(evidence.map(item => [item.executionId, item])).values()]
  if (distinct.length < 3) throw new Error('agentImprovementInsufficientEvidence')
  const codes = new Set(distinct.map(item => item.code))
  const guidance: string[] = []
  if (codes.has('tool_error') || codes.has('turn_failed')) guidance.push('When a tool or runtime fails, explicitly explain what remains unverified. Do not infer success or repeat an identical failing call. Ask for the missing prerequisite when necessary.')
  if (codes.has('invalid_arguments')) guidance.push('Check each tool input against its published schema and current task identifiers before submitting the call. A validation error is not a completed action.')
  if (codes.has('empty_reply')) guidance.push('Always end a completed turn with a nonempty, concise reply grounded in observed results, including any blocker or pending approval.')
  const additions = guidance.filter(line => !baseline.instructions.includes(line))
  if (!additions.length) throw new Error('agentImprovementNoChange')
  const definition = parseDefinition({ ...baseline, instructions: [baseline.instructions, 'Reliability guidance:', ...additions].filter(Boolean).join('\n\n') })
  assertSafeImprovement(baseline, definition)
  return { definition, rationale: `Rule-generated candidate from ${distinct.length} distinct failed executions (${[...codes].sort().join(', ')}). Requires fixed baseline/candidate live evaluation and explicit human approval; no activation has occurred.` }
}
