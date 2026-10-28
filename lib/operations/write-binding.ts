import { z } from 'zod'
import { snapshotDigest } from './write-target'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
export const sourceSlotSchema = z.object({
  version: z.literal(1), eventId: z.uuid(), botId: z.uuid().nullable(),
  sourceDigest: hash, planDigest: hash, batchDigest: hash, slotDigest: hash, hostContextDigest: hash.optional(),
  slotIndex: z.number().int().min(0).max(19), slotCount: z.number().int().min(1).max(20),
}).strict().refine(value => value.slotIndex < value.slotCount)
export const writeBindingSchema = z.object({
  accountId: z.string().min(1), version: z.string().min(1), provider: z.string().min(1),
  payloadDigest: hash, contextDigest: hash, source: sourceSlotSchema.optional(),
  run: z.object({ runId: z.uuid(), botId: z.uuid().nullable(), workspaceId: z.uuid().nullable(), policyVersion: z.string().regex(/^\d+(?::\d+)?$/), decision: z.enum(['allow', 'ask']) }).strict().optional(),
}).strict().refine(({ source, ...binding }) => !source || source.slotDigest === snapshotDigest(binding), 'host slot selection changed')

export function prepareWriteBinding(provider: string, selected: { accountId: string; version: string; context?: Record<string, unknown> | null }, input: Record<string, unknown>) {
  return writeBindingSchema.parse({ provider, accountId: selected.accountId, version: selected.version, payloadDigest: snapshotDigest(input), contextDigest: snapshotDigest(selected.context ?? null) })
}
