// 审计日志's categories. Plain data with no imports, so the settings page can list them as filters.
export const AUDIT_CATEGORIES = ['security', 'secret', 'permission', 'member', 'billing'] as const
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number]
