import { z } from 'zod'

/** A third-party grant is opaque to every runner. Never a native model key. */
export const TASK_SECRETS_HEADER = 'x-mikka-task-secrets'
export const TASK_SECRETS_VERSION = '1'
export const TASK_SECRET_MAX_CAPABILITIES = 32
export const TASK_SECRET_MAX_TOKEN_BYTES = 65_536
export const TASK_SECRET_MAX_ASSIGNMENT_BYTES = 262_144
export const TASK_SECRET_CAPABILITY_PREFIX = 'mikka-egress-v1.'
// The complete first 15 bytes have a stable base64 prefix even when the token
// follows. Pattern masking avoids keeping every 90-second bearer forever.
const ENCODED_CAPABILITY_PREFIX = 'bWlra2EtZWdyZXNzLXYx'
const CAPABILITY_PATTERNS = [
  /mikka-egress-v1\.[A-Za-z0-9_-]+/g,
  /bWlra2EtZWdyZXNzLXYx[A-Za-z0-9+/]+={0,2}/g,
]
const MAX_MASK_HOLDBACK = 4 * Math.ceil(TASK_SECRET_MAX_TOKEN_BYTES / 3)

export function maskTaskSecretCapabilities(value: string, replacement = '[secret:TASK_SECRET_CAPABILITY]'): string {
  let output = value
  for (const pattern of CAPABILITY_PATTERNS) output = output.replace(pattern, replacement)
  return output
}

/** Keep at most one bounded token-shaped suffix while output is streaming. */
export function taskSecretCapabilityHoldback(value: string): number {
  let startOfTail = value.length
  while (startOfTail > 0 && /[A-Za-z0-9_.+/=-]/.test(value[startOfTail - 1])) startOfTail--
  const tail = value.slice(startOfTail)
  if (!tail) return 0
  let hold = 0
  for (const prefix of [TASK_SECRET_CAPABILITY_PREFIX, ENCODED_CAPABILITY_PREFIX]) {
    const start = tail.indexOf(prefix)
    if (start >= 0) hold = Math.max(hold, Math.min(tail.length - start, MAX_MASK_HOLDBACK))
    for (let length = Math.min(prefix.length - 1, tail.length); length > hold; length--) {
      if (prefix.startsWith(tail.slice(-length))) { hold = length; break }
    }
  }
  return hold
}

const secretName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/)
export const taskSecretGrantSchema = z.object({
  name: secretName,
  capability: z.string().min(1).max(TASK_SECRET_MAX_TOKEN_BYTES),
  expiresAt: z.iso.datetime(),
  origin: z.url().max(512),
}).strict()
export type TaskSecretGrant = z.infer<typeof taskSecretGrantSchema>

/** Metadata is safe to describe; the opaque bearer itself must not be logged. */
export const taskSecretAccessSchema = z.object({
  version: z.literal(1),
  endpoint: z.url().max(2_000),
  grants: z.array(taskSecretGrantSchema).max(TASK_SECRET_MAX_CAPABILITIES),
  unavailable: z.array(secretName).max(1500),
}).strict().refine(value => JSON.stringify(value).length <= TASK_SECRET_MAX_ASSIGNMENT_BYTES, 'task Secret assignment too large')
export type TaskSecretAccess = z.infer<typeof taskSecretAccessSchema>

/** Existing heartbeats carry the current opaque leases; no extra request loop. */
export const taskSecretRenewalSchema = z.array(z.string().min(1).max(TASK_SECRET_MAX_TOKEN_BYTES))
  .max(TASK_SECRET_MAX_CAPABILITIES)
  .refine(value => value.reduce((size, token) => size + token.length, 0) <= TASK_SECRET_MAX_ASSIGNMENT_BYTES, 'task Secret renewal too large')
