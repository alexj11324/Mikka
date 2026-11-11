'use client'

import { TaskConversation } from '@ui-slot/task-conversation'
import { IssueThreadPanel } from './issue-thread-panel'

type Props = {
  issueId: string
  /** The run opened: an 活动 row passes its Agent stretch's first run. */
  runId: string
  tab: 'chat' | 'acceptance'
  onOpenThread: (runId: string) => void
  onBack: () => void
}

// Acceptance belongs to the selected run. Conversation keeps every readable Task attempt.
export function TaskThreadPane({ issueId, runId, tab, onOpenThread, onBack }: Props) {
  if (tab === 'chat') return <TaskConversation key={issueId} issueId={issueId} runId={runId} onBack={onBack} onOpenThread={onOpenThread} />
  return <IssueThreadPanel key={`${runId}:${tab}`} issueId={issueId} runId={runId} initialTab={tab} onOpenThread={onOpenThread} onBack={onBack} />
}
