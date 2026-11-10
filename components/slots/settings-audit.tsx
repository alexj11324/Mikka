// The default settings-audit slot (docs/ui-overlay.md): none. 审计日志 draws
// its own list (AuditLogSettings); a layer that draws the page exports
// `AuditLogPage` here and gets the same reads and filters as props.
import type { ComponentType } from 'react'
import type { SettingsAuditProps } from './settings-audit-contract'

export const AuditLogPage: ComponentType<SettingsAuditProps> | null = null
