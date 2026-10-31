import { createHash } from 'node:crypto'
import { z } from 'zod'
import { agentModelSourceSchema } from '../agent-model'
import type { HostedRuntimeSnapshot } from '../subscription-model-snapshot'
import { AGENT_HOOK_IDS, AGENT_TOOL_IDS } from './registry'
import type { PersonalPluginSnapshot } from '@/lib/plugins/contracts'

export const MAX_DEFINITION_BYTES = 256_000
const identifier = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/)
export const skillDefinitionSchema = z.strictObject({
  id: identifier,
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(500),
  body: z.string().min(1).max(20_000),
})
export const agentDefinitionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: identifier,
  /** Additive, user-owned guidance. Never replaces the platform's system/permission policy. */
  instructions: z.string().max(24_000),
  tools: z.array(z.enum(AGENT_TOOL_IDS)).max(AGENT_TOOL_IDS.length),
  skills: z.array(skillDefinitionSchema).max(20),
  hooks: z.array(z.enum(AGENT_HOOK_IDS)).max(2),
  memory: z.strictObject({ scope: z.literal('owner-bot') }),
  evalSuite: z.literal('mikka.core.v1'),
  modelSelection: agentModelSourceSchema.optional(),
}).superRefine((value, ctx) => {
  for (const key of ['tools', 'hooks'] as const) {
    if (new Set(value[key]).size !== value[key].length) ctx.addIssue({ code: 'custom', path: [key], message: 'Duplicate capability' })
  }
  if (new Set(value.skills.map(skill => skill.id)).size !== value.skills.length) ctx.addIssue({ code: 'custom', path: ['skills'], message: 'Duplicate skill id' })
  if (value.skills.length && !value.tools.includes('load_skill')) ctx.addIssue({ code: 'custom', path: ['tools'], message: 'Skills require load_skill' })
  if (!value.hooks.includes('audit')) ctx.addIssue({ code: 'custom', path: ['hooks'], message: 'Audit cannot be disabled' })
})
export type AgentDefinition = z.infer<typeof agentDefinitionSchema>
export type SkillDefinition = z.infer<typeof skillDefinitionSchema>

/** Canonical JSON is for hashes, not deterministic replay of a model. */
export function canonicalJSON(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const result = JSON.stringify(value)
    if (result === undefined) throw new Error('agentDefinitionNotJSON')
    return result
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJSON((value as Record<string, unknown>)[key])}`).join(',')}}`
}
export function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJSON(value)).digest('hex')
}
export function parseDefinition(input: unknown): AgentDefinition {
  const value = typeof input === 'string' ? JSON.parse(input) : input
  if (Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8') > MAX_DEFINITION_BYTES) throw new Error('agentDefinitionTooLarge')
  return agentDefinitionSchema.parse(value)
}
export function exportDefinition(input: unknown): string {
  const definition = parseDefinition(input)
  return canonicalJSON({ format: 'mikka.agent', formatVersion: 1, definition, checksum: digest(definition) })
}
export function importDefinition(input: unknown): AgentDefinition {
  const raw = typeof input === 'string' ? input : JSON.stringify(input)
  if (Buffer.byteLength(raw, 'utf8') > MAX_DEFINITION_BYTES + 1024) throw new Error('agentDefinitionTooLarge')
  const envelope = z.strictObject({ format: z.literal('mikka.agent'), formatVersion: z.literal(1), definition: agentDefinitionSchema, checksum: z.string().regex(/^[a-f0-9]{64}$/) }).parse(JSON.parse(raw))
  const definition = parseDefinition(envelope.definition)
  if (digest(definition) !== envelope.checksum) throw new Error('agentDefinitionChecksumMismatch')
  return definition
}

export function skillCatalog(definition: AgentDefinition): string {
  if (!definition.skills.length) return ''
  return '\n\nAvailable skills (load the body with load_skill only when relevant):\n' + definition.skills.map(skill => `${JSON.stringify(skill.id)}: ${JSON.stringify(skill.description)}`).join('\n')
}
export function definitionInstructions(base: string, definition: AgentDefinition): string {
  return base + (definition.instructions.trim() ? `\n\nUser-owned guidance (subordinate to platform permissions and approval policy):\n${definition.instructions}` : '') + skillCatalog(definition)
}
export interface DefinitionSnapshot {
  formatVersion: 1
  revisionId: string
  revision: number
  definitionDigest: string
  definition: AgentDefinition
  hostInstructions: string
  hostInstructionsDigest: string
  effectiveTools: string[]
  runtime: HostedRuntimeSnapshot
  /** Explicit personal installations frozen when this execution starts. No credentials. */
  personalPlugins?: PersonalPluginSnapshot
}
export function makeSnapshot(revisionId: string, revision: number, input: unknown, hostInstructions: string, runtime: DefinitionSnapshot['runtime']): DefinitionSnapshot {
  const definition = parseDefinition(input)
  return { formatVersion: 1, revisionId, revision, definitionDigest: digest(definition), definition, hostInstructions, hostInstructionsDigest: digest(hostInstructions), effectiveTools: [...definition.tools], runtime }
}
