// Shared, value-free configuration for third-party secrets (ADR 2026-11-08-0240).
// This module is safe to import from settings UI; actual delivery remains server-only.
import { z } from 'zod'

const origin = z.string().max(2048).refine(value => {
  try {
    const url = new URL(value)
    return value === value.trim() && !value.includes('\\') && url.protocol === 'https:'
      && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/'
      && !!url.hostname && !url.hostname.endsWith('.')
  } catch { return false }
}, 'an HTTPS origin without credentials, path, query or fragment is required').transform(value => new URL(value).origin)

const path = z.string().min(1).max(2048).refine(value => {
  if (!value.startsWith('/') || value.startsWith('//') || /[\\%;?#\s]/u.test(value)
    || Array.from(value).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return false
  return !value.split('/').some(part => part === '.' || part === '..')
}, 'an absolute path without encoding, matrix parameters, dot segments, query or fragment is required')

export const secretHttpPolicy = z.object({
  origin,
  header: z.enum(['authorization', 'x-api-key', 'api-key', 'x-goog-api-key']),
  prefix: z.string().max(64).regex(/^[\x20-\x7e]*$/),
  rules: z.array(z.object({
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']),
    path,
    match: z.enum(['exact', 'prefix']),
  }).strict()).min(1).max(32),
}).strict()

const protectedDelivery = z.object({ mode: z.literal('protected'), http: secretHttpPolicy.optional() }).strict()
const directInput = z.object({ mode: z.literal('direct'), exposeToAgent: z.literal(true) }).strict()

/** Approval fields cannot be supplied by a client, including when editing an existing direct secret. */
export const secretDeliveryInput = z.discriminatedUnion('mode', [protectedDelivery, directInput])
export type SecretDeliveryInput = z.infer<typeof secretDeliveryInput>
export type SecretHttpPolicy = z.infer<typeof secretHttpPolicy>

const storedDelivery = z.discriminatedUnion('mode', [protectedDelivery, directInput.extend({
  approvedBy: z.string().min(1).max(256),
  approvedAt: z.iso.datetime(),
}).strict()])
export type SecretDelivery = z.infer<typeof storedDelivery>

/** Legacy and corrupt metadata never grant plaintext access. An unconfigured protected secret stays protected. */
export function effectiveSecretDelivery(value: unknown): SecretDelivery {
  const parsed = storedDelivery.safeParse(value)
  return parsed.success ? parsed.data : { mode: 'protected' }
}

/** Run only in authenticated writes, with the server's actor and clock. Omitting delivery preserves existing approval. */
export function approveSecretDelivery(input: SecretDeliveryInput | undefined, actorId: string, now = new Date(), current?: unknown): SecretDelivery {
  if (input === undefined) return effectiveSecretDelivery(current)
  const delivery = secretDeliveryInput.parse(input)
  if (delivery.mode === 'protected') return delivery
  return storedDelivery.parse({ ...delivery, approvedBy: actorId, approvedAt: now.toISOString() })
}
