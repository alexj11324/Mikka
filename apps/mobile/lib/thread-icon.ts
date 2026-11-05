/** Which icon a thread shows on the phone: its server-decided group (R-52), never its run's raw status. */
import type { ThreadGroup, ThreadStatus } from './types'

/** Each thread group's status (R-52), drawn as the dot on the thread's bubble (threadDot). */
export const GROUP_ICON: Record<ThreadGroup, ThreadStatus> = { running: 'running', blocked: 'failed', waiting: 'waiting', idle: 'stopped', resolved: 'done' }

/** A cited run's icon, from the group the server decided, never its raw status; a server older than the group sends none, and it reads as 等待你. */
export function runIcon(source: { group?: ThreadGroup }): ThreadStatus {
  return GROUP_ICON[source.group ?? 'waiting']
}

/** A thread's state as the dot on its bubble (R-52): a circle is always a task, a bubble with a dot is a thread. */
export type ThreadDot = 'running' | 'waiting' | 'blocked' | 'idle' | 'resolved'

const DOTS: Record<ThreadStatus, ThreadDot> = { running: 'running', waiting: 'waiting', paused: 'blocked', failed: 'blocked', stopped: 'idle', done: 'resolved' }
const DOT_LABELS: Record<ThreadDot, string> = { running: '进行中', waiting: '等待你', blocked: '受阻', idle: '空闲', resolved: '已解决' }

/** The dot a thread's icon carries, and its word for the screen reader: the colour is never the only sign (R-87). A run paused on its quota is 受阻. */
export function threadDot(status: ThreadStatus): { dot: ThreadDot; label: string } {
  const dot = DOTS[status]
  return { dot, label: DOT_LABELS[dot] }
}
