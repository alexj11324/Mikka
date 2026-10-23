import type { AgentHistory } from '@/lib/agent-history'

/** Matches an entry of MIK-7 `GET /api/agent/sessions/active` → `{ agents: Worker[] }`. */
export type Worker = { id: string; name: string; avatarUrl?: string | null; startedAt?: string }
export type ActiveAgentsResponse = { agents: Worker[] }

/** Adapter for the MIK-7 active-agents response; drops malformed entries. */
export function workersFromActiveAgents(body: ActiveAgentsResponse | undefined): Worker[] {
  return (body?.agents ?? []).filter(agent => agent && typeof agent.id === 'string' && typeof agent.name === 'string')
    .map(({ id, name, avatarUrl, startedAt }) => ({ id, name, avatarUrl: avatarUrl ?? null, startedAt }))
}
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

export type TrackedWorker = Worker & { misses: number }

/**
 * Applies removal hysteresis to one poll: new workers appear at once, and a
 * worker only leaves after `confirmations` consecutive polls without it.
 */
export function nextTrackedWorkers(previous: TrackedWorker[], current: Worker[], confirmations = 2): TrackedWorker[] {
  const now = new Map(current.map(worker => [worker.id, worker]))
  const kept = previous.flatMap(worker => {
    const fresh = now.get(worker.id)
    if (fresh) return [{ ...fresh, misses: 0 }]
    const misses = worker.misses + 1
    return misses >= confirmations ? [] : [{ ...worker, misses }]
  })
  const known = new Set(previous.map(worker => worker.id))
  return [...kept, ...current.filter(worker => !known.has(worker.id)).map(worker => ({ ...worker, misses: 0 }))]
}

export const COALESCE_MS = 300

/**
 * Coalesces bursts: each push restarts the timer and only the last value
 * pushed within `delay` reaches `onSettle`.
 */
export function createCoalescer<T>(delay: number, onSettle: (value: T) => void) {
  let timer: ReturnType<typeof setTimeout> | undefined
  return {
    push(value: T) {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { timer = undefined; onSettle(value) }, delay)
    },
    cancel() { if (timer) clearTimeout(timer); timer = undefined },
  }
}
