/** Which icon a thread shows on the phone: its server-decided group (R-52), never its run's raw status. */
import type { ThreadGroup, ThreadStatus } from './types'

/** Each thread group's icon (R-52): 受阻 the alert, 空闲 the slashed circle, 已解决 the check. */
export const GROUP_ICON: Record<ThreadGroup, ThreadStatus> = { running: 'running', blocked: 'failed', waiting: 'waiting', idle: 'stopped', resolved: 'done' }

/** A cited run's icon, from the group the server decided, never its raw status; a server older than the group sends none, and it reads as 等待你. */
export function runIcon(source: { group?: ThreadGroup }): ThreadStatus {
  return GROUP_ICON[source.group ?? 'waiting']
}
