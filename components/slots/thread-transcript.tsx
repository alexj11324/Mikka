'use client'

import { Fragment, useEffect, useRef } from 'react'
import { ChatMessage } from '@ui-slot/chat-message'
import { MessageScroller, MessageScrollerButton, MessageScrollerContent, MessageScrollerItem, MessageScrollerProvider, MessageScrollerViewport, useMessageScroller } from '@/components/ui/message-scroller'
import { cn } from '@/lib/utils'
import type { ThreadTranscriptMessage, ThreadTranscriptScreenProps } from './thread-contract'

const ENTER = 'animate-in fade-in-0 duration-(--motion-base) motion-reduce:animate-none'
const HEADER_FADE = 'md:[--scroll-fade-mask:linear-gradient(to_bottom,transparent_3.5rem,#000_6rem,#000_calc(100%_-_var(--scroll-fade-b,0px)),transparent)]'

function TranscriptMessage({ entry }: { entry: ThreadTranscriptMessage }) {
  return entry.message ? <ChatMessage {...entry.message} /> : entry.content
}

/** Only an accepted send follows the end; a background read preserves the person's place. */
function FollowSentMessages({ count }: { count: number | null }) {
  const { scrollToEnd } = useMessageScroller()
  const seen = useRef(count)
  useEffect(() => {
    if (count === null) return
    if (seen.current !== null && count > seen.current) scrollToEnd()
    seen.current = count
  }, [count, scrollToEnd])
  return null
}

/** Shared list and composer layout for the existing group and embedded presentations. */
export function ThreadTranscript({ host, transcript, composer, beforeComposer }: ThreadTranscriptScreenProps) {
  if (transcript.kind === 'group') return <>
    <div ref={transcript.scroll.ref} onScroll={transcript.scroll.onScroll} data-thread-host={host} className="min-h-0 flex-1 overflow-y-auto scroll-fade-y">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 pb-6">
        {transcript.placeholder != null ? transcript.placeholder : <>
          {transcript.before}
          <ol aria-label={transcript.scroll.label} className="flex flex-col gap-4">
            {transcript.rows.map(row => row.kind === 'author'
              ? <li key={row.id} className={cn('flex', row.mine ? 'flex-col items-end gap-1' : 'items-end gap-2')}>
                {!row.mine && row.mark}
                <div className={cn('flex min-w-0 flex-col gap-1', row.mine ? 'max-w-[min(26rem,80%)] items-end' : 'max-w-[min(35rem,85%)]')}>
                  {row.mine ? <span className="sr-only">{row.name}</span> : <span className="text-xs font-medium text-muted-foreground">{row.name}</span>}
                  {row.messages.map(entry => <TranscriptMessage key={entry.id} entry={entry} />)}
                </div>
              </li>
              : row.kind === 'pending'
                ? <li key={row.id} data-pending={row.phase} className={cn('flex flex-col items-end gap-1', row.phase === 'sending' && 'opacity-60')}>
                  <ChatMessage {...row.message} />{row.after}
                </li>
                : <li key={row.id} aria-label={row.label} className="flex">{row.content}</li>)}
          </ol>
          {transcript.after}
        </>}
        {transcript.end}
      </div>
    </div>
    <div className="mx-auto w-full max-w-3xl shrink-0 px-4 pb-4">
      {beforeComposer}
      {composer}
    </div>
  </>

  return <>
    <MessageScrollerProvider key={transcript.stateKey} defaultScrollPosition={transcript.startAtEnd ? 'end' : 'start'} autoScroll>
      <FollowSentMessages count={transcript.sentCount} />
      <MessageScroller data-thread-host={host} className="min-h-0 flex-1">
        <MessageScrollerViewport ref={transcript.scroll.ref} onScroll={transcript.scroll.onScroll} aria-label={transcript.scroll.label} className={cn(!transcript.compact && HEADER_FADE)}>
          <MessageScrollerContent className={cn('flex w-full min-w-0 max-w-full flex-col gap-5 pb-6', transcript.compact ? 'px-3 pt-4' : 'px-4 pt-24 sm:px-6')}>
            {transcript.before}
            {transcript.rows.map(row => <Fragment key={row.id}>
              {row.before}
              <MessageScrollerItem messageId={row.messageId} className={cn('[content-visibility:visible]', row.arriving && ENTER)} {...row.attributes}>
                <TranscriptMessage entry={row} />
              </MessageScrollerItem>
            </Fragment>)}
            {transcript.after}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        {transcript.overlay}
        {transcript.jumpToEnd && <MessageScrollerButton />}
      </MessageScroller>
    </MessageScrollerProvider>
    <div className={cn('flex w-full min-w-0 max-w-full flex-col gap-2', transcript.compact ? 'px-3 pb-3' : 'px-4 pb-4 sm:px-6')}>
      {beforeComposer}
      {composer}
    </div>
  </>
}
