/** A bot row's face in the bot list, from the groups its threads are in (R-52). Pure, so it can be tested without a database. */
import { groupThreads, type GroupIssue, type ThreadGroup, type ThreadOutcome } from './thread-groups'

export type BotAttention = 'thinking' | 'exclaim' | 'idle'

type BotThread = { id: string; botId: string | null; status: string; issueId: string | null; createdAt: string; outcome?: ThreadOutcome | null }

/**
 * Each thread's place is the right column's group, never its raw run status:
 * a task's threads fold into its newest one, as in the thread list. Working
 * (进行中, or the bot's chat is replying) first, then a blocked newest row
 * (受阻: threads arrive latest activity first), else idle. A thread waiting on
 * you puts nothing on the face: bloub's notify pose draws a badge, and nothing
 * is drawn on an avatar (decision 2026-11-01-2230).
 */
export function botAttention(threads: readonly BotThread[], botId: string, chatting: boolean, issueOf: (issueId: string) => GroupIssue | undefined = () => undefined): BotAttention {
  const own = threads.filter(thread => thread.botId === botId)
  const groups = groupThreads(own, issueOf)
  const groupOf = new Map<string, ThreadGroup>()
  for (const [group, rows] of Object.entries(groups) as [ThreadGroup, { id: string }[]][]) for (const row of rows) groupOf.set(row.id, group)
  if (chatting || groups.running.length) return 'thinking'
  const newest = own.find(thread => groupOf.has(thread.id))
  return newest && groupOf.get(newest.id) === 'blocked' ? 'exclaim' : 'idle'
}
