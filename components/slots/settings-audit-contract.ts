// What 设置 › 审计日志's page receives (docs/ui-overlay.md). Reading, paging,
// the filters, the words for each event and the CSV export's address stay in
// useAuditLog (hooks/settings/use-audit-log.ts).
import type { AuditLogState } from '@/hooks/settings/use-audit-log'

export type SettingsAuditProps = AuditLogState & { workspaceId: string }
