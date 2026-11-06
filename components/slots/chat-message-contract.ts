// What the chat-message slot receives (docs/ui-overlay.md). Every behaviour
// stays in the chat (components/coordinator/coordinator-chat.tsx); a slot only
// lays out the nodes it is handed.
import type { ReactNode } from 'react'

/** Who said a message: a bot, or the Coordinator (`coordinator`). */
export type ChatSpeaker = { id?: string | null; name: string; color?: string | null; shape?: string | null; coordinator?: boolean }

export type ChatMessageProps = {
  from: 'person' | 'bot'
  /** The bot or Coordinator of this chat; for a person's message, who it was sent to. */
  speaker: ChatSpeaker
  /** The chat inside the Artifact reader: narrower bubbles. */
  compact?: boolean
  /** The reply is still streaming: no actions yet. */
  streaming?: boolean
  /** Above the message: the 建议 card it was sent from. */
  lead?: ReactNode
  /** The words: a person's text with its quote and notes, or a reply's rows (thinking, words, tool groups). */
  body?: ReactNode
  /** Cards the message carries: artifacts, then thread cards. */
  extras?: ReactNode
  /** The actions row as the open-source chat draws it (copy, cited pages). */
  actions?: ReactNode
  /** For a layer that draws its own actions: the text 复制 copies, and the cited pages. */
  copyText?: string
  sources?: ReactNode
  /** Under the message: reactions, 已停止, a failure with its way on. */
  after?: ReactNode
}

/** Before a reply has anything to show. */
export type ChatWaitingProps = { speaker: ChatSpeaker }

/** The slot module also exports `CHAT_SURFACE`: classes for the chat's own surface (its background), '' for none. */
