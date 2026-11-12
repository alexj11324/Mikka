import { createContext, type ReactNode } from 'react'
import type { DecisionReceipt } from '@/hooks/use-decision-submission'
import type { RunSource } from '@/lib/coordinator/citations'
import type { ChatComposerProps } from './chat-composer-contract'

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
  /** Its output or the thought, in full, for a tooltip. */
  detail?: string
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
  /** Something failed: the words, with what can be done about it (retry, change model, sign in again). */
  | { kind: 'error'; text: string; actions?: ReactNode }

export type ThreadEntry =
  | {
    id: string
    role: 'person'
    /** When it was written, ms. */
    at: number
    text: string
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
    author?: { id: string; name: string; mark: ReactNode }
    /** A line about the chat (an event, a quota switch), not the Bot's words: it has no author line, and the reply after it shows its own. */
    event?: true
    /** Copy, the pages it cites, reactions. */
    actions?: ReactNode
  }

/** A question waiting on the person (a Factory question): answered in the dock above the composer. */
export type ThreadQuestion = {
  revision?: number
  unavailable?: string
  id: string
  question: string
  /** The task it belongs to, in words. */
  task: string
  taskId?: string
  kind: 'decision' | 'question' | 'approval'
  options?: { id: string; title: string }[]
  facts?: { label: string; value: string }[]
}

export type ThreadScreenProps = {
  /** Who the person talks to: the Bot's id (null: the Coordinator) and its name. */
  botId: string | null
  name: string
  /** Its mark, for the author line (an entry's own author wins). */
  mark: ReactNode
  /** null while the first read is on its way. */
  entries: ThreadEntry[] | null
  /** Shown in place of an empty conversation: the welcome being written, or starters. */
  empty?: ReactNode
  older?: { loading: boolean; onLoad: () => void }
  /** The Bot is answering: Stop ends it. */
  working: boolean
  onStop?: () => void
  /** Where the person stopped reading (ms), for 「有新消息」. */
  lastSeen?: number
  onMarkRead?: () => void
  /** The composer, as the chat-composer slot gets it: `useChatComposer` (hooks/use-chat-composer.ts) does what it does. */
  composer: Omit<ChatComposerProps, 'model' | 'quote'>
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

/** The hosted shell waits for a task tab's existing save before removing it. */
export const WorkTabCloseContext = createContext<((tabId: string) => Promise<boolean>) | null>(null)

export type ThreadPanelTab = { id: 'overview' | 'browser' | `task:${string}` | `thread:${string}`; title: string; content: ReactNode }
