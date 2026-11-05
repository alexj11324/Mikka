import type { Thread } from '@/lib/types'

export type ChatHeaderProps = {
  /** The bot's name; empty until the home list has loaded (a spinner stands in). */
  name: string
  /** The bot's own threads for the menu, newest work first; null while they load. */
  threads: Thread[] | null
  onThread: (id: string) => void
  onAllThreads: () => void
  onInfo: () => void
}
