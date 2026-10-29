/** Every action the workspace audit log records, with the filter it belongs to. */
export const AUDIT_ACTION_CATEGORIES = {
  'member.role_changed': 'members',
  'member.status_changed': 'members',
  'member.invited': 'members',
  'member.invitation_revoked': 'members',
  'member.removed': 'members',
  'secret.created': 'secrets',
  'secret.replaced': 'secrets',
  'secret.deleted': 'secrets',
  'egress.changed': 'secrets',
  'permission.workspace_changed': 'permissions',
  'permission.personal_changed': 'permissions',
  'token.created': 'security',
  'token.revoked': 'security',
  'two_factor.enabled': 'security',
  'two_factor.disabled': 'security',
  'two_factor.backup_codes_regenerated': 'security',
  'passkey.added': 'security',
  'passkey.renamed': 'security',
  'passkey.deleted': 'security',
  'device.deleted': 'security',
  'workspace.renamed': 'workspace',
  'workspace.deleted': 'workspace',
} as const

export type AuditAction = keyof typeof AUDIT_ACTION_CATEGORIES
export type AuditCategory = (typeof AUDIT_ACTION_CATEGORIES)[AuditAction]
export const AUDIT_FILTERS = ['all', 'security', 'members', 'secrets', 'permissions'] as const
export type AuditFilter = (typeof AUDIT_FILTERS)[number]
export const AUDIT_RETENTION_DAYS = 90

export function auditCategory(action: AuditAction): AuditCategory {
  return AUDIT_ACTION_CATEGORIES[action]
}

export function isAuditAction(value: string): value is AuditAction {
  return Object.hasOwn(AUDIT_ACTION_CATEGORIES, value)
}

export function auditRetentionStart(now = new Date()): Date {
  return new Date(now.getTime() - AUDIT_RETENTION_DAYS * 86_400_000)
}

/** Opaque keyset cursor: the last row's createdAt and id. */
export function encodeAuditCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`).toString('base64url')
}

export function decodeAuditCursor(cursor: string): { createdAt: Date; id: string } | null {
  const [at, id, ...rest] = Buffer.from(cursor, 'base64url').toString('utf8').split('|')
  const createdAt = new Date(at ?? '')
  if (rest.length || !id || !/^[0-9a-f-]{36}$/i.test(id) || Number.isNaN(createdAt.getTime())) return null
  return { createdAt, id }
}

export interface AuditEventView {
  id: string
  action: string
  category: AuditCategory
  actorId: string | null
  actorName: string | null
  actorEmail: string | null
  target: string | null
  metadata: Record<string, string | number | boolean | null>
  ip: string | null
  userAgent: string | null
  country: string | null
  createdAt: string
}

const CSV_COLUMNS = ['createdAt', 'action', 'category', 'actorName', 'actorEmail', 'target', 'ip', 'country', 'userAgent'] as const

function csvCell(value: string | null): string {
  let text = value ?? ''
  // Spreadsheet formula injection: a leading = + - @ tab or CR is neutralised.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

export function auditEventsToCsv(events: readonly AuditEventView[]): string {
  const lines = [CSV_COLUMNS.join(',')]
  for (const event of events) lines.push(CSV_COLUMNS.map(column => csvCell(event[column])).join(','))
  return `${lines.join('\r\n')}\r\n`
}
