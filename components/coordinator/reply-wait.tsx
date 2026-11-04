'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { ThinkingLoader } from '@/components/ui/thinking-loader-clean'
import type { CoordinatorLiveReply } from '@/lib/coordinator-stream-client'
import { cn } from '@/lib/utils'

/** Where a turn is before its words: thinking, using a tool (by name), reading what tools returned; `answering` once words arrive. */
export type ReplyWait = { phase: 'thinking' } | { phase: 'tool'; tool: string } | { phase: 'reading' } | { phase: 'answering' } | null

/**
 * The wait as the stream reports it, from real events only: a sent message is `thinking`, a running tool is `tool`,
 * a tool that returned with no words yet is `reading`, the first word is `answering`. Nothing while the chat is not
 * working, or once the turn's reply is stored (`replied`) and no new step has started.
 */
export function replyWait(working: boolean, replies: readonly CoordinatorLiveReply[], replied = false): ReplyWait {
  if (!working) return null
  const last = replies.at(-1)
  if (!last) return replied ? { phase: 'answering' } : { phase: 'thinking' }
  const running = last.tools?.findLast(tool => tool.state === 'running')
  if (running) return { phase: 'tool', tool: running.name }
  if (last.text) return { phase: 'answering' }
  if (last.tools?.length) return { phase: 'reading' }
  return { phase: 'thinking' }
}

/** How long the check stays after the first word, before the reply alone remains. */
export const DONE_HOLD_MS = 700
const PHASES = { thinking: 0, tool: 1, reading: 2 } as const
/** A short fade in (R-37: opacity on a duration), as a new message enters. */
const ENTER = 'animate-in fade-in-0 duration-200 motion-reduce:animate-none'

/**
 * affectUI's Thinking Loader under the chat while a reply has no words yet, unchanged in look. Its label follows `wait`;
 * on the first word it turns into a check with the seconds since it appeared, then leaves. A wait that starts again
 * (a later step calls a tool) brings a new one. `enter` fades it in, for a turn that started after the chat opened.
 */
export function ReplyWaitLine({ wait, enter = false }: { wait: ReplyWait; enter?: boolean }) {
  const t = useTranslations('Coordinator.activity')
  const waiting = wait !== null && wait.phase !== 'answering'
  const [shown, setShown] = useState(waiting)
  const [round, setRound] = useState(0)
  if (waiting && !shown) { setShown(true); setRound(round + 1) }
  if (wait === null && shown) setShown(false)
  const done = shown && wait?.phase === 'answering'
  useEffect(() => {
    if (!done) return
    const timer = window.setTimeout(() => setShown(false), DONE_HOLD_MS)
    return () => window.clearTimeout(timer)
  }, [done])
  if (!shown) return null
  const tool = wait?.phase === 'tool' ? wait.tool : null
  const toolLabel = tool && t.has(`tools.${tool}` as never) ? t(`tools.${tool}` as never) : t('tool')
  return <div data-reply-wait={done ? 'done' : wait?.phase} className={cn('flex min-w-0', enter && ENTER)}>
    <ThinkingLoader key={round} phases={[t('thinking'), toolLabel, t('reading')]} phase={wait && wait.phase !== 'answering' ? PHASES[wait.phase] : undefined}
      done={done} doneLabel={seconds => t('thought', { seconds })} />
  </div>
}
