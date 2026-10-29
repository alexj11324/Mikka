import type { TaskRun } from '@/app/actions/task-runs'

export type DesktopRun = Pick<TaskRun, 'issueId' | 'issueTitle' | 'agentName' | 'status'>
export type DesktopNotification = {
  id: string
  kind: 'awaiting' | 'failed'
  title: string
  body: string
  href: string
}

export interface DesktopRunUpdate {
  badge: number
  notifications: DesktopNotification[]
  next: Map<string, DesktopRun['status']>
}

/**
 * Compares two polls of the task-run list. `previous === null` is the launch
 * baseline: it seeds the map and badge but never replays old work. Later
 * snapshots notify only on a transition into 等你 or failed.
 */
export function desktopRunUpdate(previous: Map<string, DesktopRun['status']> | null, runs: readonly DesktopRun[], stamp = Date.now()): DesktopRunUpdate {
  const badge = runs.filter(run => run.status === 'waiting_input').length
  const next = new Map(runs.map(run => [run.issueId, run.status]))
  if (previous === null) return { badge, notifications: [], next }

  const notifications: DesktopNotification[] = []
  for (const run of runs) {
    const before = previous.get(run.issueId)
    if (before === run.status) continue
    const kind = run.status === 'waiting_input' ? 'awaiting' : run.status === 'failed' ? 'failed' : null
    if (!kind) continue
    notifications.push({
      // The stamp keeps a second transition into the same state (agent asks
      // again after a reply) from being deduplicated by the main process.
      id: `run:${run.issueId}:${kind}:${stamp}`,
      kind,
      title: run.issueTitle,
      body: run.agentName,
      href: `/?issue=${encodeURIComponent(run.issueId)}`,
    })
  }
  return { badge, notifications, next }
}
