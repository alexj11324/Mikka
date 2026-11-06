'use client'

// The default chat-message slot (docs/ui-overlay.md): a chat's messages as the open-source app draws them.
import type { ChatMessageProps, ChatWaitingProps } from '@/components/slots/chat-message-contract'
import { Bubble, BubbleContent } from '@/components/ui/bubble'
import { Message, MessageContent } from '@/components/ui/message'
import { ReplyWaiting } from '@/components/coordinator/reply-activity'
import { cn } from '@/lib/utils'

/** The chat column keeps the page's surface. */
export const CHAT_SURFACE = ''

export function ChatMessage({ from, compact = false, lead, body, extras, actions, after }: ChatMessageProps) {
  return <Message align={from === 'person' ? 'end' : 'start'} tabIndex={-1} className="outline-none"><MessageContent>
    {lead}
    {from === 'bot' ? body : body && <Bubble variant="secondary" align="end" className={cn(PERSON_BUBBLE, compact ? 'max-w-[90%]' : 'max-w-[min(26rem,80%)]')}><BubbleContent className="flex flex-col gap-1.5 rounded-2xl px-4 py-3 whitespace-pre-wrap">{body}</BubbleContent></Bubble>}
    {extras}
    {actions}
    {after}
  </MessageContent></Message>
}

export function ChatWaiting(props: ChatWaitingProps) {
  void props
  return <ReplyWaiting />
}

/** A person's bubble: the accent fill; callers add the width (narrower inside the reader). */
export const PERSON_BUBBLE = '*:data-[slot=bubble-content]:bg-sidebar-primary *:data-[slot=bubble-content]:text-sidebar-primary-foreground'
