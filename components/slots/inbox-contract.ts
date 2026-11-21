// What the inbox slot receives (docs/ui-overlay.md): the 收件箱 page's body
// (the rail's 建议). The suggestions come from useSuggestions
// (components/suggestions/suggestion-feed.tsx); the threads and tasks are the
// workspace's live lists, for a layer that also lists what waits for the person.
import type { listIssues } from '@/app/actions/issues'
import type { Thread } from '@/app/actions/task-runs'

type Issue = Awaited<ReturnType<typeof listIssues>>[number]

/** `INBOX_TITLE`, a message key the slot exports: the page's title, e.g. in the phone header. */
export type InboxTitle = string
/** `INBOX_PHONE_HEADER`, a boolean the slot exports: false when its body brings its own list and back button on phones. */
export type InboxPhoneHeader = boolean

export type InboxPageProps = {
  threads: Thread[]
  issues: Issue[]
  /** Task and run projections are read by the workspace shell. */
  taskRead?: { loading: boolean; retry?: () => Promise<unknown> }
  workspaceId?: string
  ownerId?: string
  /** All pending actions and suggestions in the authorized workspace, across pages. */
  pendingCount?: number
  /** Opens a task, where its review or acceptance is handled. */
  onOpenIssue: (id: string) => void
  /** 连接应用, for someone with no app connected. */
  onConnect: () => void
  /** After a suggestion went to the Coordinator. */
  onSent?: () => void
}
