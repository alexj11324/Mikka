'use client'

import { SquareUserRound } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import type { TaskWorkspaceProps } from '@/components/slots/task-workspace-contract'

/**
 * Where a task lives (#1608). The open-source UI keeps its existing breadcrumb
 * in the new-task dialog and adds nothing to a task's properties; the hosted
 * layer names the workspace in both (docs/ui-overlay.md).
 */
export function TaskWorkspace({ variant }: TaskWorkspaceProps) {
  if (variant !== 'create') return null
  return <Badge variant="outline" className="gap-1.5 rounded-full"><SquareUserRound />ORV</Badge>
}
