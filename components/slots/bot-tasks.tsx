'use client'

// The default bot-tasks slot (docs/ui-overlay.md): the threads this bot dispatched, in R-52's groups.
import { ThreadResults } from '@/components/nav/context-panel'
import type { BotTasksProps } from '@/components/slots/bot-tasks-contract'

/** Optional export: true when the slot lists tasks, so the panel's tab reads 任务 rather than 线程. */
export const LISTS_TASKS = false

export function BotTasks({ stateKey, threads, shown, issues, loading, onOpenThread }: BotTasksProps) {
  return <ThreadResults stateKey={stateKey} threads={threads} shown={shown} issues={issues} loading={loading} onOpenThread={onOpenThread} />
}
