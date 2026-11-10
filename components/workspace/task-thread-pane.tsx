'use client'

import type { ComponentType } from 'react'
import * as taskConversationSlot from '@ui-slot/task-conversation'
import type { TaskConversationProps } from '@/components/slots/task-conversation-contract'
import { IssueThreadPanel } from './issue-thread-panel'

type Props = {
  issueId: string
  /** The run opened: an 活动 row passes its Agent stretch's first run. */
  runId: string
  tab: 'chat' | 'acceptance'
  onOpenThread: (runId: string) => void
  onBack: () => void
  /** The task-conversation slot's component; null in the build without a layer. */
  conversation?: ComponentType<TaskConversationProps> | null
}

/**
 * The thread beside a task page. A task is one conversation (decision 2026-11-04-2200, #1681): where a layer provides
 * the task-conversation slot, 对话 opens the task's joined conversation scrolled to `runId`. An 活动 row passes its
 * stretch's first run, so a failed run and the run that fixed it read inline. 验收 stays the run's own panel, as does
 * every thread in the build without a layer.
 */
export function TaskThreadPane({ issueId, runId, tab, onOpenThread, onBack, conversation = taskConversationSlot.TaskConversation }: Props) {
  const Conversation = conversation
  if (Conversation && tab === 'chat') return <Conversation key={issueId} issueId={issueId} runId={runId} onBack={onBack} onOpenThread={onOpenThread} />
  return <IssueThreadPanel key={`${runId}:${tab}`} issueId={issueId} runId={runId} initialTab={tab} onOpenThread={onOpenThread} onBack={onBack} />
}
