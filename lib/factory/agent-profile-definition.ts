import { z } from 'zod'
import { CodedError, type CodedErrorOptions } from '@mikka/protocol/coded-error'
import type { ProfileDecisionFailure } from './agent-profile-decision'
import { digest } from '@/lib/agent-kit/definition'
import type { OrderEntry } from '@/lib/model-order-plan'
import type { DecisionExecution } from '@/lib/coordinator/decide'
import { BUILTIN_AGENT_PROFILE_ID } from './agent-profile-reference'
import type { ProfileMarkValue } from './agent-profile-mark'

export { BUILTIN_AGENT_PROFILE_ID } from './agent-profile-reference'

const harness = z.enum(['claude_code', 'codex'])
const source = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('subscription'), connectionId: z.uuid() }),
  z.strictObject({ kind: z.literal('api_key'), keyId: z.uuid() }),
])
/** A selected capability: a reviewed official id, or a namespaced reference to
 * an installed, explicitly shared, or repository Skill. Older stored Profiles
 * hold bare official ids, which remain valid. */
export const AGENT_PROFILE_SKILL_ID = /^(?:[a-z][a-z0-9-]{0,63}|official:[a-z][a-z0-9-]{0,63}|personal:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|workspace:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|repository:[a-z0-9][a-z0-9-]{0,63})$/
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
  skills: z.array(z.string().max(160).regex(AGENT_PROFILE_SKILL_ID)).max(12).default([]),
}).superRefine((value, ctx) => {
  if (value.model.mode === 'fixed' && value.harness !== 'auto' && value.model.harness !== value.harness) ctx.addIssue({ code: 'custom', path: ['model', 'harness'], message: 'Profile harness and fixed model must agree' })
  for (const field of ['skills', 'roles'] as const) if (new Set(value[field]).size !== value[field].length) ctx.addIssue({ code: 'custom', path: [field], message: 'Duplicate reference' })
})
export type AgentProfileDefinition = z.infer<typeof agentProfileDefinitionSchema>
export type AgentProfileSkillSource = 'official' | 'personal' | 'workspace' | 'repository'
export interface AgentProfileSkill {
  id: string; name: string; description: string; version: number; digest: string; content: string
  /** Non-official sources carry provenance. Official entries keep the original
   * envelope bytes so every frozen pre-existing Profile digest stays valid. */
  source?: AgentProfileSkillSource
  sourceRevision?: string
}
export interface AgentProfileScope { ownerId: string; workspaceId: string }
export interface AgentProfile extends AgentProfileDefinition, ProfileMarkValue {
  id: string; version: number; digest: string; createdAt: string; updatedAt: string; archivedAt: string | null
}
export interface AgentProfileSelection {
  profileId: string; version: number; digest: string; name: string
  /** A code: `explicit`, `default`, or the Decision's reason (agent-profile-decision.ts). Runs before 2026-11-05 hold an English sentence. */
  source: 'explicit' | 'decision' | 'default'; reason: string
  scope: AgentProfileScope
  definition: AgentProfileDefinition
  skills: AgentProfileSkill[]
  /** Additive instructions plus the bounded Skill metadata/load instruction.
   * Skill bodies live in `skills` and are served on demand by `load_skill`. */
  instructions: string
  effort?: AgentProfileDefinition['effort']
  targetEntry: OrderEntry
  decision?: DecisionExecution
}
export type AgentProfileErrorDetail = ProfileDecisionFailure
  | 'checking' | 'quota' | 'expired' | 'paused' | 'missing' | 'removed' | 'model_gone' | 'key_refused' | 'balance' | 'provider_unavailable'
  | 'disabled' | 'forbidden' | 'invalid'
export class AgentProfileError extends CodedError<string, AgentProfileErrorDetail> {
  constructor(code: string, readonly status = 409, options?: CodedErrorOptions<AgentProfileErrorDetail>) {
    super(code, options); this.name = 'AgentProfileError'; this.message = code
  }
}
export function parseAgentProfile(input: unknown) {
  if (Buffer.byteLength(JSON.stringify(input) ?? '', 'utf8') > 32_000) throw new AgentProfileError('agentProfileTooLarge', 413)
  return agentProfileDefinitionSchema.parse(input)
}
export function agentProfileDigest(definition: AgentProfileDefinition, skills: readonly AgentProfileSkill[]) {
  return digest({ definition, skills })
}
/** The runtime id the `load_skill` tool and the brief use. Older Profiles
 * store bare official ids; the namespaced form is a presentation detail and
 * never rewrites the frozen definition. */
export function agentProfileSkillRuntimeId(id: string) {
  return (id.includes(':') ? id : `official:${id}`).toLowerCase()
}

/** Progressive disclosure: the brief names each assigned capability and how to
 * load it. The body is served by `load_skill` from the run's pinned copy, so a
 * started run never depends on the current catalogue. */
export function agentProfileInstructions(definition: AgentProfileDefinition, skills: readonly AgentProfileSkill[]) {
  const brief = definition.instructions.trim()
  if (skills.length === 0) return brief
  return [
    brief,
    'Assigned Skills are loaded on demand. Call the `load_skill` Mikka tool with the exact id only when the current task needs that capability. Do not assume a Skill body from its name.',
    ...skills.map(skill => `- ${agentProfileSkillRuntimeId(skill.id)} — ${skill.name}${skill.description ? `: ${skill.description}` : ''}`),
  ].filter(Boolean).join('\n\n')
}

/** The brief shape used before progressive disclosure. Only an already frozen
 * selection may still carry it; new selections never produce it. */
export function agentProfileLegacyInstructions(definition: AgentProfileDefinition, skills: readonly AgentProfileSkill[]) {
  return [definition.instructions.trim(), ...skills.map(skill => `Skill: ${skill.name} (${skill.id}, version ${skill.version}, digest ${skill.digest})\n${skill.content}`)].filter(Boolean).join('\n\n')
}

/** This immutable receipt documents the zero-configuration route; it grants no
 * capabilities and does not create a mutable profile row. */
export const BUILTIN_AGENT_PROFILE_VERSION = 1
export function builtinAgentProfileDefinition(): AgentProfileDefinition {
  return parseAgentProfile({ name: 'Default Agent', description: '', roles: [], enabled: true, harness: 'auto', model: { mode: 'inherit' }, instructions: '', skills: [] })
}
export function builtinAgentProfileSelection(scope: AgentProfileScope, targetEntry: OrderEntry): AgentProfileSelection {
  const definition = builtinAgentProfileDefinition(), skills: AgentProfileSkill[] = []
  return { profileId: BUILTIN_AGENT_PROFILE_ID, version: BUILTIN_AGENT_PROFILE_VERSION, digest: agentProfileDigest(definition, skills), name: definition.name, source: 'default', reason: 'default', scope: { ownerId: scope.ownerId, workspaceId: scope.workspaceId }, definition, skills, instructions: '', targetEntry }
}

/** A native continuation may retain a user revision, but cannot redefine the
 * immutable zero-configuration receipt as a privileged custom profile. */
export function isBuiltinAgentProfileSelection(selection: AgentProfileSelection): boolean {
  const definition = builtinAgentProfileDefinition()
  return selection.profileId === BUILTIN_AGENT_PROFILE_ID && selection.source === 'default' && selection.version === BUILTIN_AGENT_PROFILE_VERSION && selection.digest === agentProfileDigest(definition, []) && selection.name === definition.name && selection.instructions === '' && selection.effort === undefined && selection.decision === undefined && digest(selection.definition) === digest(definition) && Array.isArray(selection.skills) && selection.skills.length === 0
}
