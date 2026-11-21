import type { SettingsAuditProps } from './settings-audit-contract'

/** Type contract for public tooling. Official clients link the provider at build time. */
export function AuditLogPage(_props: SettingsAuditProps): never {
  throw new Error('UI_SLOT_REQUIRES_OFFICIAL_CLIENT: settings-audit')
}
