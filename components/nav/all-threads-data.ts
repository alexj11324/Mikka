import type { listIssues } from '@/app/actions/issues'
import type { Thread } from '@/app/actions/task-runs'
import { pendingTaskCount } from '@/hooks/use-bot-tasks'

type Issue = Awaited<ReturnType<typeof listIssues>>[number]

/** How many rows of 全部线程 sit in 等待你 (R-52), counted as the list groups them. */
export function waitingCount(threads: Thread[], issues: Issue[]) {
  return pendingTaskCount(threads, issues)
}

/** The bots that dispatched these threads, each once, by name: the choices of 按派出者筛选. */
export function threadBots(threads: Thread[]) {
  const bots = new Map<string, string>()
  for (const thread of threads) if (thread.botId && !bots.has(thread.botId)) bots.set(thread.botId, thread.agentName)
  return [...bots].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))
}
