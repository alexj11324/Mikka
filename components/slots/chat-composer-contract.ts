// What the chat-composer slot receives (docs/ui-overlay.md). What it does comes
// from hooks/use-chat-composer.ts, which every implementation calls.
import type { ReactNode, Ref } from 'react'
import type { SendKey } from '@/lib/send-key'
import type { ChatFileScope } from '@mikka/protocol/chat-attachments'

export type ChatComposerProps = {
  ref: Ref<HTMLTextAreaElement | null>
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  label: string
  placeholder?: string
  /** Waiting for a reply. With `onStop`, the send button turns into stop. */
  sending?: boolean
  /** The other side keeps working and still takes messages. With `onStop`, the button is stop until something is typed. */
  running?: boolean
  /** Keep the draft editable while a thread waits for its stop acknowledgement. */
  editableWhileSending?: boolean
  /** The draft remains editable, but the run no longer accepts new messages. */
  submitDisabled?: boolean
  /** The conversation takes no messages at all (a group chat that failed to load): nothing can be typed, attached or sent. */
  disabled?: boolean
  onStop?: () => void
  /** Something quoted into the message (an artifact quote chip): it sits on top, the buttons move to a row below. */
  quote?: ReactNode
  /** A bot chat's model chip (the model-picker slot), beside attach. */
  model?: ReactNode
  /** The person's send key (偏好设置); the caller reads it from their preferences. */
  sendKey?: SendKey
  /** A thread's composer, not a bot chat's: choosing a chat focuses only the latter, and Esc never stops the run (decision 2026-11-02-0301). */
  thread?: boolean
  attachmentScope?: ChatFileScope
}
