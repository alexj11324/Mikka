import { createContext, type ReactNode, type RefObject, type UIEventHandler } from 'react'
import type { DecisionReceipt } from '@/hooks/use-decision-submission'
import type { RunSource } from '@/lib/coordinator/citations'
import type { ChatComposerProps } from './chat-composer-contract'
import type { ChatMessageProps } from './chat-message-contract'

/**
 * A conversation as one screen (docs/ui-overlay.md, slot `thread`): a Bot's chat, built by `CoordinatorChat` from the
 * same reads, stream and actions it draws itself. A layer that exports `ThreadScreen` draws the whole conversation from
 * these props instead; every action stays in this repository and reaches the screen as a callback or a node.
 */

/** A tool the reply used, or the thinking before it, as one row. */
export type ThreadToolRow = {
  id: string
  /** What it did, in the person's words. */
  label: string
  status: 'running' | 'done' | 'failed' | 'stopped'
  /** How long it took, once done; a running tool counts up from `startedAt`. */
  ms?: number
  startedAt?: number
  /** Why it failed, in a few words. */
  error?: string
  /** A short note after the label (its target, a count). */
  note?: string
  /** Recorded input, output or reasoning for the expanded row. */
  input?: string
  detail?: string
  command?: string
  exitCode?: number
}

/** One part of a Bot's message, top to bottom as it happened. */
export type ThreadEntryPart =
  /** Its words as Markdown text, and the same words as Mikka renders them (links, citations, cards it names). */
  | { kind: 'text'; text: string; node: ReactNode }
  | { kind: 'tools'; id: string; tools: ThreadToolRow[] }
  /** A thread it dispatched, as its task: the layer names its state; Open shows the task (or the thread without one). */
  | { kind: 'task'; run: RunSource; onOpen: () => void }
  /** Artifacts it handed over: a chip opens the artifact. */
  | { kind: 'artifacts'; items: { id: string; name: string }[]; onOpen: (id: string) => void }
  /** Something failed: the words, with what can be done about it (retry, change model, sign in again).
   * Current failures keep their semantic marker on the existing error line; historical actions own their past marker. */
  | { kind: 'error'; text: string; actions?: ReactNode; failure?: 'live' | 'welcome' }

export type ThreadEntry =
  | {
    id: string
    role: 'person'
    /** When it was written, ms. */
    at: number
    text: string
    /** The same words with explicit task, thread and PR references linked. */
    body?: ReactNode
    /** What went with it: a quote from an artifact or a reply, browser notes, a 建议 card. */
    attachments?: { id: string; name: string; meta?: string }[]
    /** queued: written offline · sending · failed: shows 重试 (onRetry). */
    status?: 'sent' | 'sending' | 'failed'
    deliveryMessage?: string
    onRetry?: () => void
    /** Copy and reactions. */
    actions?: ReactNode
  }
  | {
    id: string
    role: 'bot'
    at: number
    parts: ThreadEntryPart[]
    streaming?: boolean
    stopped?: boolean
    /** Who wrote it, where the conversation has more than one Agent (a task's attempts): shown where it changes. */
    author?: { id: string; name: string; mark: ReactNode; /** An Agent's reply, as Capy's: its words with no author line (Alex, 2026-11-15). */ quiet?: boolean; /** Its name opens where the message came from: a child thread's first message, its parent thread. */ onOpen?: () => void }
    /** A line about the chat (an event, a quota switch), not the Bot's words: it has no author line, and the reply after it shows its own. */
    event?: true
    /** Copy, the pages it cites, reactions. */
    actions?: ReactNode
  }

/** A question waiting on the person (a Factory question): answered in the dock above the composer. */
export type ThreadQuestion = {
  revision?: number
  unavailable?: string
  recordedAnswer?: string
  id: string
  question: string
  /** The task it belongs to, in words. */
  task: string
  taskId?: string
  kind: 'decision' | 'question' | 'approval'
  options?: { id: string; title: string }[]
  facts?: { label: string; value: string }[]
}

/** The surface containing a conversation; choosing a host does not change its appearance. */
export type ThreadHost = 'page' | 'embedded' | 'column'

export type ThreadScreenProps = {
  host: ThreadHost
  /** Who the person talks to: the Bot's id (null: the Coordinator) and its name. */
  botId: string | null
  name: string
  /** The accessible name of the existing transcript viewport. */
  transcriptLabel?: string
  /** The accessible waiting state for an initial read; omitted once it resolves or fails. */
  loadingLabel?: string
  /** Its mark, for the author line (an entry's own author wins). */
  mark: ReactNode
  /** null until the first read supplies entries; loadingLabel distinguishes a pending read from an error. */
  entries: ThreadEntry[] | null
  /** Shown in place of an empty conversation: the welcome being written. No starter cards (R-12). */
  empty?: ReactNode
  /** Older rows were added above the visible transcript. */
  historyPrepend?: number
  older?: { loading: boolean; auto?: boolean; onLoad: () => void }
  /** The Bot is answering: Stop ends it. */
  working: boolean
  onStop?: () => void
  /** Where the person stopped reading (ms), for 「有新消息」. */
  lastSeen?: number
  onMarkRead?: () => void
  /** The composer, as the chat-composer slot gets it: `useChatComposer` (hooks/use-chat-composer.ts) does what it does. */
  composer: Omit<ChatComposerProps, 'quote'>
  /** A reader without a reply target does not get a composer. */
  readOnly?: boolean
  scrollRef?: RefObject<HTMLDivElement | null>
  /** Chips that go out with the next message (a quote, a browser note), each with Remove. */
  pending: { id: string; name: string; meta?: string; onRemove: () => void }[]
  /** Notices that wait above the composer (quota, sign in again, actions to approve). */
  notices?: ReactNode
  /** Questions waiting on the person; `onAnswer` sends the option's title or the person's own words. */
  questions: ThreadQuestion[]
  onAnswer: (id: string, text: string) => Promise<DecisionReceipt>
  /** How many tasks run, for the head. */
  running: number
  /** Opens a task and the Inbox. */
  onOpenTask: (taskId: string) => void
  onOpenInbox: () => void
  /**
   * Tabs the page adds to the conversation's right-hand work area when the frame owns that panel
   * (FRAME_OWNS_PANEL): the chat's Overview and the browser. `reveal` counts up each time the page asks for one
   * (`revealId`) to be shown; the work area stays folded until then.
   */
  panels?: {
    tabs: ThreadPanelTab[]; reveal: number; revealId: string | null
    /** The real active work tab's task, or null for another tab. */
    onActiveTask?: (taskId: string | null) => void
  }
  /**
   * Tabs the chat opens itself in the same work area (FRAME_OWNS_PANEL, decision 2026-11-10): a task's view
   * (`task:<issueId>`) from a task card or chip, a thread's conversation (`thread:<runId>`) from a thread chip, an
   * Agent's stretch or a subagent. `reveal` counts up each time one is asked for (`revealId`). With `work`, a task card
   * opens through its part's `onOpen` only, never the template's own task tab.
   */
  work?: {
    tabs: ThreadPanelTab[]; reveal: number; revealId: string | null; beforeClose?: (tabId: string) => Promise<boolean>
    /** Reports the work area's actual active page; null for New or an artifact. */
    onActiveTab?: (tabId: string | null) => void
  }
}

/** Message contents remain with their readers; the screen owns every list item and its key. */
export type ThreadTranscriptMessage = { id: string } & (
  | { message: ChatMessageProps; content?: never }
  | { content: ReactNode; message?: never }
)

export type ThreadGroupRow =
  | { kind: 'author'; id: string; mine: boolean; name: string; mark?: ReactNode; messages: ThreadTranscriptMessage[] }
  | { kind: 'pending'; id: string; phase: 'sending' | 'accepted' | 'failed'; message: ChatMessageProps; after?: ReactNode }
  | { kind: 'notice'; id: string; label: string; content: ReactNode }

export type ThreadScrolledRow = ThreadTranscriptMessage & {
  messageId: string
  before?: ReactNode
  arriving?: boolean
  attributes?: {
    'data-coordinator-stream-id'?: string
    'data-streaming'?: boolean
    'data-message-position'?: number
    'data-testid'?: string
  }
}

type TranscriptScroll = {
  label: string
  ref: RefObject<HTMLDivElement | null>
  onScroll: UIEventHandler<HTMLDivElement>
}

/** Existing transcript presentations share one screen without changing their DOM or their readers' state. */
export type ThreadTranscriptScreenProps = {
  host: ThreadHost
  /** The same composer slot node; the screen owns its placement, the reader owns its actions. */
  composer: ReactNode
  beforeComposer?: ReactNode
  transcript:
    | {
      kind: 'group'
      scroll: TranscriptScroll
      rows: ThreadGroupRow[]
      /** A loading, refusal or empty state replaces the list. */
      placeholder?: ReactNode
      before?: ReactNode
      after?: ReactNode
      end?: ReactNode
    }
    | {
      kind: 'embedded'
      scroll: TranscriptScroll
      stateKey: string
      startAtEnd: boolean
      sentCount: number | null
      compact: boolean
      rows: ThreadScrolledRow[]
      before?: ReactNode
      after?: ReactNode
      overlay?: ReactNode
      jumpToEnd: boolean
    }
}

/** The hosted shell waits for a task tab's existing save before removing it. */
export const WorkTabCloseContext = createContext<((tabId: string) => Promise<boolean>) | null>(null)

export type ThreadPanelTab = { id: 'overview' | 'browser' | `task:${string}` | `thread:${string}`; title: string; label?: string; content: ReactNode }
