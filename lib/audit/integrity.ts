import { createHash } from 'node:crypto'

/** Stable JSON for an exported audit payload; it is not a signature or an encryption scheme. */
export function canonicalAuditJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalAuditJSON).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalAuditJSON(item)}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

export const auditDigest = (value: unknown) => createHash('sha256').update(canonicalAuditJSON(value)).digest('hex')
export type AuditExportRecord = { id: string; digest: string }
export type AuditExportManifest = {
  format: 'mikka-audit-export'; version: 1; id: string; workspaceId: string
  createdAt: string; expiresAt: string; from: string; until: string
  filter: 'all' | 'security'; count: number; digest: string
}

export function auditExportRecords(events: readonly { id: string }[]): AuditExportRecord[] {
  return events.map(event => ({ id: event.id, digest: auditDigest(event) }))
}

/** Detects alteration, missing entries and reordering relative to an independently retained manifest. */
export function verifyAuditExport(manifest: Pick<AuditExportManifest, 'count' | 'digest'>, events: readonly { id: string }[]): boolean {
  return events.length === manifest.count && auditDigest(auditExportRecords(events)) === manifest.digest
}
