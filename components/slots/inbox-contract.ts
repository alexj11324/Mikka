// What the inbox slot receives (docs/ui-overlay.md): the 收件箱 page's body
// (the rail's 建议). The suggestions come from useSuggestions
// (components/suggestions/suggestion-feed.tsx); the threads and tasks are the
// workspace's live lists, for a layer that also lists what waits for the person.
import type { listIssues } from '@/app/actions/issues'
import type { Thread } from '@/app/actions/task-runs'

type Issue = Awaited<ReturnType<typeof listIssues>>[number]

export type InboxPageProps = {
  threads: Thread[]
  issues: Issue[]
  /** Opens a task, where its review or acceptance is handled. */
  onOpenIssue: (id: string) => void
  /** 连接应用, for someone with no app connected. */
  onConnect: () => void
  /** After a suggestion went to the Coordinator. */
  onSent?: () => void
}
