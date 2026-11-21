import type { Thread } from '@/app/actions/task-runs'

/** The bots that dispatched these threads, each once, by name: the choices of 按派出者筛选. */
export function threadBots(threads: Thread[]) {
  const bots = new Map<string, string>()
  for (const thread of threads) if (thread.botId && !bots.has(thread.botId)) bots.set(thread.botId, thread.agentName)
  return [...bots].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))
}
