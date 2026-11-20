// What the task-conversation slot receives (docs/ui-overlay.md). A task has one conversation (#1681): a thread on a
// task opens as the task's whole conversation, its attempts oldest first, scrolled to the attempt opened. A layer builds
// it from IssueThreadPanel's `before`, `focusRunId` and `transcriptOnly` (components/workspace/issue-thread-panel.tsx).

import type { ThreadHost } from '@/components/slots/thread-contract'

export type TaskConversationProps = {
  /** Where the conversation is rendered; does not change its route or commands. */
  host?: ThreadHost
  issueId: string
  /** The attempt opened; the conversation scrolls to it. */
  runId: string
  /** The name the thread's row shows. */
  name?: string
  onBack: () => void
  onClose?: () => void
  onOpenThread: (runId: string, issueId?: string, name?: string) => void
  onOpenTask?: () => void
}
