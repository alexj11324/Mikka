import { createHash } from 'node:crypto'

export * from './schema'

export class ImprovementError extends Error {
  constructor(public code: 'notFound' | 'invalid' | 'conflict' | 'runUnavailable' | 'configurationDrift' | 'workerCapabilityRequired' | 'sourceMismatch' | 'sourceRequired') { super(code) }
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
