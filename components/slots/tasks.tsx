'use client'

/**
 * The 任务 page (`?section=tasks`). The open-source UI has no page of its own
 * there and goes on to the board; a UI layer may draw one from the same data
 * (docs/ui-overlay.md).
 */
import { useEffect } from 'react'
import { navigate } from '@/components/workspace/workspace-navigation'
import type { TasksPageProps } from './tasks-contract'

export function TasksPage(_props: TasksPageProps) {
  useEffect(() => { navigate({ section: 'all-issues' }, 'replace') }, [])
  return null
}
