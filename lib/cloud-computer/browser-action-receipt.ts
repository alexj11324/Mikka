import { createHash } from 'node:crypto'

// Canonical object-key ordering survives a jsonb round trip and avoids relying
// on the order supplied by a model or by PostgreSQL.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
  return JSON.stringify(value)
}
export const browserActionDigest = (userId: string, receipt: unknown) => createHash('sha256').update(canonical([userId, receipt])).digest('hex')
