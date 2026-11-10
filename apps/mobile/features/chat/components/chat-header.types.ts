import type { Task } from '@/lib/types'

export type ChatHeaderProps = {
  /** The bot's name; empty until the home list has loaded (a spinner stands in). */
  name: string
  /** The bot's look, for the avatar in the title pill. */
  color?: string
  shape?: string
  botId?: string
  coordinator?: boolean
  /** The bot's own tasks for the menu, waiting ones first; null while they load. */
  tasks: Task[] | null
  onTask: (id: string) => void
  onAllTasks: () => void
  onInfo: () => void
  /** Content is under the bar: its backdrop shows (BarBackdrop). */
  scrolled?: boolean
}
