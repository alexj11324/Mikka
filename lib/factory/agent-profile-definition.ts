import { z } from 'zod'
import { digest } from '@/lib/agent-kit/definition'
import type { OrderEntry } from '@/lib/model-order-plan'
import type { DecisionExecution } from '@/lib/coordinator/decide'

const harness = z.enum(['claude_code', 'codex'])
const source = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('subscription'), connectionId: z.uuid() }),
  z.strictObject({ kind: z.literal('api_key'), keyId: z.uuid() }),
])
export const agentProfileDefinitionSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(600).default(''),
  roles: z.array(z.string().trim().min(1).max(48)).max(12).default([]),
  enabled: z.boolean().default(true),
  harness: z.enum(['auto', 'claude_code', 'codex']).default('auto'),
  model: z.discriminatedUnion('mode', [
    z.strictObject({ mode: z.literal('inherit') }),
    z.strictObject({ mode: z.literal('fixed'), harness, model: z.string().trim().min(1).max(128), source }),
  ]).default({ mode: 'inherit' }),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  instructions: z.string().max(24_000).default(''),
  skills: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)).max(12).default([]),
}).superRefine((value, ctx) => {
  if (value.model.mode === 'fixed' && value.harness !== 'auto' && value.model.harness !== value.harness) ctx.addIssue({ code: 'custom', path: ['model', 'harness'], message: 'Profile harness and fixed model must agree' })
  for (const field of ['skills', 'roles'] as const) if (new Set(value[field]).size !== value[field].length) ctx.addIssue({ code: 'custom', path: [field], message: 'Duplicate reference' })
})
export type AgentProfileDefinition = z.infer<typeof agentProfileDefinitionSchema>
export interface AgentProfileSkill { id: string; name: string; description: string; version: number; digest: string; content: string }
export interface AgentProfileScope { ownerId: string; workspaceId: string }
export interface AgentProfile extends AgentProfileDefinition {
  id: string; version: number; digest: string; createdAt: string; updatedAt: string; archivedAt: string | null
}
export interface AgentProfileSelection {
  profileId: string; version: number; digest: string; name: string
  source: 'explicit' | 'decision' | 'default'; reason: string
  scope: AgentProfileScope
  definition: AgentProfileDefinition
  skills: AgentProfileSkill[]
  /** Complete additive instructions, including controlled, versioned Skill bodies. */
  instructions: string
  effort?: AgentProfileDefinition['effort']
  targetEntry: OrderEntry
  decision?: DecisionExecution
}
export class AgentProfileError extends Error {
  constructor(readonly code: string, readonly status = 409) { super(code); this.name = 'AgentProfileError' }
}
export function parseAgentProfile(input: unknown) {
  if (Buffer.byteLength(JSON.stringify(input) ?? '', 'utf8') > 32_000) throw new AgentProfileError('agentProfileTooLarge', 413)
  return agentProfileDefinitionSchema.parse(input)
}
export function agentProfileDigest(definition: AgentProfileDefinition, skills: readonly AgentProfileSkill[]) {
  return digest({ definition, skills })
}
export function agentProfileInstructions(definition: AgentProfileDefinition, skills: readonly AgentProfileSkill[]) {
  return [definition.instructions.trim(), ...skills.map(skill => `Skill: ${skill.name} (${skill.id}, version ${skill.version}, digest ${skill.digest})\n${skill.content}`)].filter(Boolean).join('\n\n')
}

/** This immutable receipt documents the zero-configuration route; it grants no
 * capabilities and does not create a mutable profile row. */
export const BUILTIN_AGENT_PROFILE_ID = 'default'
export const BUILTIN_AGENT_PROFILE_VERSION = 1
export function builtinAgentProfileDefinition(): AgentProfileDefinition {
  return parseAgentProfile({ name: 'Default Agent', description: '', roles: [], enabled: true, harness: 'auto', model: { mode: 'inherit' }, instructions: '', skills: [] })
}
export function builtinAgentProfileSelection(scope: AgentProfileScope, targetEntry: OrderEntry): AgentProfileSelection {
  const definition = builtinAgentProfileDefinition(), skills: AgentProfileSkill[] = []
  return { profileId: BUILTIN_AGENT_PROFILE_ID, version: BUILTIN_AGENT_PROFILE_VERSION, digest: agentProfileDigest(definition, skills), name: definition.name, source: 'default', reason: 'Existing model preference and explicit task constraints.', scope: { ownerId: scope.ownerId, workspaceId: scope.workspaceId }, definition, skills, instructions: '', targetEntry }
}

/** A native continuation may retain a user revision, but cannot redefine the
 * immutable zero-configuration receipt as a privileged custom profile. */
export function isBuiltinAgentProfileSelection(selection: AgentProfileSelection): boolean {
  const definition = builtinAgentProfileDefinition()
  return selection.profileId === BUILTIN_AGENT_PROFILE_ID && selection.source === 'default' && selection.version === BUILTIN_AGENT_PROFILE_VERSION && selection.digest === agentProfileDigest(definition, []) && selection.name === definition.name && selection.instructions === '' && selection.effort === undefined && selection.decision === undefined && digest(selection.definition) === digest(definition) && Array.isArray(selection.skills) && selection.skills.length === 0
}
