'use client'

import type { TaskWorkspaceProps } from '@/components/slots/task-workspace-contract'

/**
 * Where a task lives (#1608). The open-source UI adds nothing here (#1646:
 * the community UI is frozen); the hosted layer names the workspace in the
 * new-task dialog and in a task's properties (docs/ui-overlay.md).
 */
export function TaskWorkspace(_props: TaskWorkspaceProps) {
  return null
}
