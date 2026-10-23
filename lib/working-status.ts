import type { AgentHistory } from '@/lib/agent-history'

export type Worker = { id: string; name: string; image?: string | null }
export type WorkingLabel =
  | { key: 'one'; values: { a: string } }
  | { key: 'two'; values: { a: string; b: string } }
  | { key: 'three'; values: { a: string; b: string; c: string } }
  | { key: 'many'; values: { a: string; b: string; count: number } }

export const MAX_WORKING_AVATARS = 3

/** Picks the message key and ICU params for the names of who is working. */
export function workingLabel(names: string[]): WorkingLabel | null {
  const [a, b, c] = names
  if (!a) return null
  if (!b) return { key: 'one', values: { a } }
  if (!c) return { key: 'two', values: { a, b } }
  if (names.length === 3) return { key: 'three', values: { a, b, c } }
  return { key: 'many', values: { a, b, count: names.length - 2 } }
}

/** Splits workers into the avatars shown and the "+N" overflow count. */
export function workingAvatars<T>(workers: T[]) {
  return { shown: workers.slice(0, MAX_WORKING_AVATARS), overflow: Math.max(0, workers.length - MAX_WORKING_AVATARS) }
}

/** The person's Agent is working while its latest session has a pending turn. */
export function agentIsWorking(history: Pick<AgentHistory, 'turns'> | undefined) {
  return Boolean(history?.turns.some(turn => turn.status === 'pending'))
}

/** Stable identity for a set of workers, so equal polls do not replay the roll. */
export function workersKey(workers: Worker[]) {
  return workers.map(worker => worker.id).join('|')
}
