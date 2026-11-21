'use client'

import { AuditLogPage } from '@ui-slot/settings-audit'
import { useAuditLog } from '@/hooks/settings/use-audit-log'

export function AuditLogSettings({ workspaceId }: { workspaceId: string }) {
  const log = useAuditLog(workspaceId)
  return <AuditLogPage workspaceId={workspaceId} {...log} />
}
