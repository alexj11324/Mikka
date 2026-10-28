import { createHash } from 'node:crypto'
import { z } from 'zod'
import { bindingSchema } from '../factory/contract'

export const commandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('feedback'), eventId: z.uuid(), runId: z.uuid(),
    verdict: z.enum(['positive', 'negative', 'unknown']), note: z.string().max(2000).default('') }).strict(),
  z.object({ action: z.literal('propose'), runId: z.uuid() }).strict(),
  z.object({ action: z.literal('select_baseline'), runId: z.uuid() }).strict(),
  z.object({ action: z.literal('handoff'), proposalId: z.uuid(), binding: bindingSchema,
    agentId: z.uuid(), deviceRepoId: z.uuid() }).strict(),
  z.object({ action: z.literal('rehearse'), binding: bindingSchema,
    agentId: z.uuid(), deviceRepoId: z.uuid() }).strict(),
])
export type Feedback = Extract<z.infer<typeof commandSchema>, { action: 'feedback' }>
export type ImprovementHandoff = Extract<z.infer<typeof commandSchema>, { action: 'handoff' }>
export type ImprovementRehearsal = Extract<z.infer<typeof commandSchema>, { action: 'rehearse' }>
export class ImprovementError extends Error {
  constructor(public code: 'notFound' | 'invalid' | 'conflict' | 'runUnavailable' | 'configurationDrift' | 'workerCapabilityRequired' | 'sourceMismatch' | 'sourceRequired' | 'evaluationPending' | 'evaluationNotImproved') { super(code) }
}
// Canonical content hashing avoids object-key order affecting replay identities.
export function digest(value: unknown): string {
  function canonical(item: unknown): string {
    if (Array.isArray(item)) return `[${item.map(canonical).join(',')}]`
    if (item && typeof item === 'object') return `{${Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`
    return JSON.stringify(item) ?? 'null'
  }
  return createHash('sha256').update(canonical(value)).digest('hex')
}
