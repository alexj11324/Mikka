'use client'

// The default chat-message slot (docs/ui-overlay.md): a chat's messages as the open-source app draws them.
import type { ChatMessageProps, ChatWaitingProps } from '@/components/slots/chat-message-contract'
import { Bubble, BubbleContent } from '@/components/ui/bubble'
import { Message, MessageContent } from '@/components/ui/message'
import { ReplyWaiting } from '@/components/coordinator/reply-activity'
import { CircleAlert } from '@/components/icons'
import { cn } from '@/lib/utils'

/** The chat column keeps the page's surface. */
export const CHAT_SURFACE = ''

export function ChatMessage({ from, compact = false, presentation = 'default', delivery, lead, body, extras, actions, after }: ChatMessageProps) {
  if (presentation === 'group-received') return <>
    <Bubble variant="muted" align="start" className="max-w-full">
      <BubbleContent size="roomy" className="whitespace-pre-wrap">{body}</BubbleContent>
    </Bubble>
    {after}
  </>
  if (presentation === 'suggestion') return <>
    {lead}
    {body && <Bubble variant="secondary" align="end" className={cn(PERSON_BUBBLE, compact ? 'max-w-[90%]' : 'max-w-[min(26rem,80%)]')}>
      <BubbleContent size="roomy" className="flex flex-col gap-1.5 break-words">{body}</BubbleContent>
    </Bubble>}
  </>
  if (delivery) return <Message align="end"><MessageContent>
    <span className="flex w-full min-w-0 items-center justify-end gap-2">
      {delivery.phase === 'failed' && <CircleAlert aria-hidden="true" className="size-4 shrink-0 text-destructive-foreground" />}
      <Bubble variant="secondary" align="end" className={cn(PERSON_BUBBLE, compact ? 'max-w-[90%]' : 'max-w-[min(26rem,80%)]')}><BubbleContent size="roomy" className="flex flex-col gap-1.5 whitespace-pre-wrap">{body}</BubbleContent></Bubble>
    </span>
    <span role={delivery.phase === 'failed' ? 'alert' : 'status'} className="flex items-center justify-end gap-1 self-end text-xs text-muted-foreground">
      {delivery.label}
      {delivery.retry}
    </span>
  </MessageContent></Message>
  return <Message align={from === 'person' ? 'end' : 'start'} tabIndex={-1} className="outline-none"><MessageContent>
    {lead}
    {from === 'bot' ? body : body && <Bubble variant="secondary" align="end" className={cn(PERSON_BUBBLE, compact ? 'max-w-[90%]' : 'max-w-[min(26rem,80%)]')}><BubbleContent size="roomy" className="flex flex-col gap-1.5 whitespace-pre-wrap">{body}</BubbleContent></Bubble>}
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
