// What the thread-header slot receives (docs/ui-overlay.md): a thread panel's
// header row and the status line above its transcript
// (components/workspace/issue-thread-panel.tsx). The panel keeps the state,
// the actions and the widgets; the slot only lays them out.
import type { ReactNode, RefObject } from 'react'
import type { ThreadOutcome } from '@/lib/thread-groups'

export type ThreadHeaderProps = {
  /** The task it works on; null for a thread with no task. */
  issueId: string | null
  runId: string
  /** The name the thread's row shows (its task, else what it was asked). */
  title: string
  /** The heading Esc and focus return to. */
  headingRef: RefObject<HTMLHeadingElement | null>
  /** ← and Esc: back to where it was opened from. */
  onBack?: () => void
  /** ✕, only where it closes more than ← does. */
  onClose?: () => void
  /** Stop, for a live run its owner may stop; null otherwise. */
  onStop: (() => void) | null
  /** Open its task, beside a chat; undefined elsewhere. */
  onOpenTask?: () => void
  /** Where it runs and its Agent (ThreadRunPlace); null before the thread is read. */
  place: ReactNode
  /** The acceptance state badge, for a Factory candidate; null otherwise. */
  acceptanceBadge: ReactNode
  /** The execution identity (ThreadExecutionIdentity), for its owner; null otherwise. */
  identity: ReactNode
  /** The Artifact button (ThreadArtifactButton); null when the read was rejected. */
  artifact: ReactNode
  /** 对话 / 验收 tabs when they share the header row; null otherwise. */
  tabs: ReactNode
  /** The header wraps on a phone (a Factory candidate's tabs). */
  wraps: boolean
  /**
   * ⤢: widen the right column the thread sits in, or put back the width it had (useRightColumnWiden);
   * absent outside the right column. Optional: the default header has no widen button.
   */
  widen?: { wide: boolean; onToggle: () => void }
  /** The run its live work goes to (a continuation's), for a layer that opens the execution identity itself. */
  liveRunId?: string
  /** The thread's status, for a layer that lists its Artifacts itself (useArtifactReview). */
  status?: string
  /** The acceptance task this thread produced, when the panel knows it. */
  acceptanceTaskId?: string | null
}

export type ThreadStatusLineProps = {
  pauseReason?: import('@/lib/task-state').TaskStateRun['pauseReason']
  status: string
  outcome: ThreadOutcome | string | null | undefined
  /** A stop was asked for and has not landed. */
  stopping: boolean
  /** The chain ended on a Factory question. */
  waiting: boolean
  /** When the thread started (ISO). */
  startedAt: string
  /** The Bot that dispatched it; null when unknown. */
  dispatchedBy: string | null
  /** For a layer that names where it runs in the status line (the thread-machine read ThreadRunPlace shares). */
  issueId?: string | null
  runId?: string
  /** Its Agent (harnessLabel); null before the thread is read. */
  harness?: string | null
  /**
   * Its place in its task's one conversation (task-conversation slot): the attempt's number and Agent, whether it is
   * the first (which carries the dispatch: the Bot's instruction, its prompt), and the task's title. Absent alone.
   */
  attempt?: { n: number; first: boolean; harness: string | null; prompt: string | null; taskTitle?: string }
}
