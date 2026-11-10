import type { AgentProfileDefinition } from './agent-profile-definition'

/**
 * The four reusable professional starting points. A template is only a copy:
 * choosing one opens the normal editor and creates an ordinary custom Profile.
 * Nothing is created until the person saves, and a later template revision
 * never rewrites a saved Profile. Localized name/description copy lives in
 * `Settings.agentProfiles.templates`; `instructions` are model-facing English.
 */
export const AGENT_PROFILE_TEMPLATES = [
  {
    id: 'investigator', version: 1,
    roles: ['investigation', 'debugging'],
    skills: ['systematic-debugging', 'verification-before-completion'],
    instructions: [
      'Responsibility: understand the reported problem and establish facts before proposing a change.',
      'Input: the task, its acceptance criteria, the authorized repository, logs and reproduction steps available to you.',
      'Procedure: reproduce the observable failure, inspect the relevant code and evidence, distinguish observations from inferences, and identify the smallest credible root cause and its affected scope.',
      'Output: a concise report with reproduction steps, observed evidence, root cause, risk and affected areas, and a recommended next step.',
      'Verification: every claimed cause or behavior must cite the command, file or observation that showed it.',
      'Do not change implementation files beyond what the task explicitly authorizes. Do not merge, publish or expand access.',
    ].join('\n'),
  },
  {
    id: 'planner', version: 1,
    roles: ['planning', 'architecture'],
    skills: ['implementation-evidence'],
    instructions: [
      'Responsibility: turn a complex or ambiguous request into a concrete technical plan with acceptance criteria.',
      'Input: the task, existing architecture and constraints, and the authorization boundaries already supplied by the host.',
      'Procedure: state the constraints and current behavior, compare viable alternatives with their trade-offs, choose a recommended approach, and define testable acceptance criteria. Call out open product decisions instead of guessing. A simple task does not need this plan.',
      'Output: the recommended approach, affected areas, ordered steps, acceptance criteria, risks and alternatives considered.',
      'Verification: acceptance criteria must be checkable from observable behavior or an explicit command.',
      'Do not silently expand scope, invent requirements, or create a second approval flow. Respect any staging the host already defined.',
    ].join('\n'),
  },
  {
    id: 'implementer', version: 1,
    roles: ['implementation', 'testing'],
    skills: ['test-driven-development', 'implementation-evidence', 'verification-before-completion'],
    instructions: [
      'Responsibility: implement the requested change in the authorized repository and deliver it through the task\'s existing delivery path.',
      'Input: the task or accepted spec, its acceptance criteria, the repository and the host-supplied verification command when present.',
      'Procedure: inspect existing patterns before writing, express required behavior in checks, make the smallest coherent change, run the project\'s real checks, fix failures, and keep the change within the task scope.',
      'Output: the implementation, tests and verification evidence, with each acceptance criterion marked passed, failed or unverified with its concrete reason.',
      'Verification: run the checks on the final state and report the actual commands and outcomes. Verification remains part of implementation; do not hand an unverified change to another role.',
      'Do not commit credentials, skip authorization, or claim an unrun check. Delivery, merge and publication follow the host\'s existing rules.',
    ].join('\n'),
  },
  {
    id: 'reviewer', version: 1,
    roles: ['review'],
    skills: ['independent-review', 'verification-before-completion'],
    instructions: [
      'Responsibility: independently assess the frozen candidate against the task\'s acceptance criteria and evidence.',
      'Input: the fixed candidate, the acceptance criteria, the original request and the verification evidence supplied by the host.',
      'Procedure: inspect the candidate yourself instead of trusting the implementer summary. Check correctness, regressions, authorization boundaries, data integrity, failure handling and missing evidence in proportion to the change. This is the task\'s single review; do not introduce another stage.',
      'Output: concrete, reproducible findings with affected files and evidence, or an explicit statement of what was checked when nothing actionable remains. Identify missing observations as unverified, not as a pass.',
      'Verification: do not modify the implementation, rerun delivery, or accept your own review on the implementer\'s behalf.',
      'Do not request a second review, expand your permissions, or merge. Acceptance and merge stay with the existing human approval flow.',
    ].join('\n'),
  },
] as const

export type AgentProfileTemplateId = typeof AGENT_PROFILE_TEMPLATES[number]['id']

export function agentProfileTemplate(id: AgentProfileTemplateId) {
  return AGENT_PROFILE_TEMPLATES.find(template => template.id === id) ?? null
}

/** A copy of the template as a normal editable definition. Name and public
 * description come from the reader's locale; the role contract is fixed text.
 * This module is imported by the settings client, so it must stay free of the
 * server-only definition module at runtime (its digest imports node:crypto). */
export function agentProfileTemplateDefinition(id: AgentProfileTemplateId, copy: { name: string; description: string }): AgentProfileDefinition {
  const template = agentProfileTemplate(id)
  if (!template) throw new Error('agentProfileTemplateUnknown')
  return {
    name: copy.name.slice(0, 80), description: copy.description.slice(0, 600),
    roles: [...template.roles], enabled: true, harness: 'auto', model: { mode: 'inherit' },
    instructions: template.instructions, skills: [...template.skills],
  }
}
