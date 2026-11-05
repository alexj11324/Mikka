import type { BotPage, Thread, ThreadStatus } from '@/lib/types'

/** How many of the bot's threads the title menu lists before 「全部线程」. */
export const MENU_THREADS = 5

/** An SF Symbol for each thread state, as the title menu marks its rows. */
export const THREAD_SYMBOL: Record<ThreadStatus, 'circle.dotted' | 'questionmark.circle' | 'pause.circle' | 'exclamationmark.circle' | 'checkmark.circle' | 'stop.circle'> = {
  running: 'circle.dotted',
  waiting: 'questionmark.circle',
  paused: 'pause.circle',
  failed: 'exclamationmark.circle',
  done: 'checkmark.circle',
  stopped: 'stop.circle',
}

/**
 * The threads the chat title's menu lists: the bot's threads in the server's order (waiting and running first, R-52),
 * the first few that are not resolved; resolved ones only when nothing else is left.
 */
export function menuThreads(page: Pick<BotPage, 'threads'> | null | undefined, limit = MENU_THREADS): Thread[] {
  const threads = page?.threads ?? []
  const open = threads.filter(thread => thread.group !== 'resolved')
  return (open.length ? open : threads).slice(0, limit)
}
