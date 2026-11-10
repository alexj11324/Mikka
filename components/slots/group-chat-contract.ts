// What the group-chat slot receives (docs/ui-overlay.md). The data and every action come from
// components/workspace/group-chat-view.tsx (useGroupChat); a layer only draws them.
import type { ReactNode, RefObject } from 'react'
import type { ChatComposerProps } from './chat-composer-contract'
import type { MessageReaction } from '@/lib/message-reactions'
import type { TaskReason, TaskState } from '@/hooks/use-bot-tasks'

/** Someone in the group: a person (letter), a bot or an agent (its avatar from id, colour and shape). */
export type GroupChatMember = {
  key: string
  id: string
  kind: 'user' | 'agent' | 'bot'
  name: string
  color?: string | null
  shape?: string | null
  coordinator?: boolean
  /** The person looking at the chat. */
  you?: boolean
  /** Opens this bot's own chat; only bots have one. */
  onOpen?: () => void
}

/** A task a bot's message links to (a group task report): its state as the task rows name it (localTaskState). */
export type GroupChatTask = {
  id: string
  identifier: string | null
  title: string
  state: TaskState
  reason: TaskReason | null
  onOpen: () => void
}

export type GroupChatEntry =
  /** The person's own message; `status` is `sending` or `failed` until the server has it. */
  | { key: string; mine: true; text: string; body: ReactNode; at: string | null; reactions: readonly MessageReaction[]; status: 'sent' | 'sending' | 'failed'; onRetry?: () => void }
  /** Anyone else's: another person, a bot or an agent. `tasks`: the tasks it links to. */
  | { key: string; mine: false; text: string; body: ReactNode; at: string; reactions: readonly MessageReaction[]; author: GroupChatMember; tasks: GroupChatTask[] }

export type GroupChatProps = {
  group: { id: string; title: string }
  /** Undefined while the member list loads. */
  members: GroupChatMember[] | undefined
  membersError: boolean
  onRetryMembers: () => void
  /** Why nothing can be shown or sent: the group is gone, the sign-in expired, or the read failed (with 重试). */
  blocked: 'not_found' | 'unauthorized' | 'unavailable' | null
  onRetry: () => void
  loading: boolean
  entries: GroupChatEntry[]
  /** Someone is answering: the member, or null when the server does not say who. */
  answering: { member: GroupChatMember | null } | null
  /** The last message found no taker, or the last reply was stopped. */
  notice: 'noTaker' | 'stopped' | null
  /** Older messages to load. */
  older: { loading: boolean; onLoad: () => void } | null
  /** The message list's scroll element; the view keeps it at the end while the person is there. */
  scrollRef: RefObject<HTMLDivElement | null>
  composer: Omit<ChatComposerProps, 'ref'>
  /** 新建群聊. */
  onNewGroup?: () => void
}
