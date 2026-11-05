// A stand-in for the Workflow runtime's `sleep` and `createHook`, on a virtual
// clock, so a workflow's wait loop can be driven through hours in a test.
// Install with mock.module('workflow', { namedExports: fake.exports }) before
// importing the workflow code, and mock Date.now with fake.now.

type Timer = { at: number; resolve: () => void }

export function fakeWorkflowRuntime(start = Date.UTC(2026, 10, 5)) {
  let clock = start
  const timers: Timer[] = []
  const hooks = new Map<string, { buffered: number; waiting: (() => void) | null; disposed: boolean }>()
  const created: string[] = []
  const held = new Set<string>()

  function sleep(until: Date | number | string) {
    const at = until instanceof Date ? until.getTime() : typeof until === 'number' ? clock + until : clock + parseDuration(until)
    return new Promise<void>(resolve => { timers.push({ at, resolve }) })
  }
  function createHook<T>({ token }: { token: string }) {
    created.push(token)
    const conflict = held.has(token)
    const state = { buffered: 0, waiting: null as (() => void) | null, disposed: false }
    if (!conflict) { held.add(token); hooks.set(token, state) }
    return {
      token,
      getConflict: async () => conflict ? { runId: 'other-execution' } : null,
      dispose() { state.disposed = true; if (!conflict && hooks.get(token) === state) { hooks.delete(token); held.delete(token) } },
      // oxlint-disable-next-line unicorn/no-thenable -- a Workflow hook is a thenable.
      then<R>(onFulfilled: (value: T) => R, onRejected?: (error: unknown) => R) {
        return new Promise<T>(resolve => {
          if (state.buffered > 0) { state.buffered--; resolve({} as T); return }
          // Like the real hook, awaits made while nothing is buffered share one awaiter.
          const previous = state.waiting
          state.waiting = () => { previous?.(); resolve({} as T) }
        }).then(onFulfilled, onRejected)
      },
    }
  }
  /** What resumeHook does: delivers to the waiting await, or buffers for the next. */
  function resume(token: string) {
    const state = hooks.get(token)
    if (!state) throw new Error('HookNotFound')
    if (state.waiting) { const wake = state.waiting; state.waiting = null; wake() } else state.buffered++
  }
  async function settle() { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)) }
  /** Runs timers in order up to `until`, letting the workflow react to each. */
  async function advanceTo(until: number) {
    await settle()
    for (;;) {
      timers.sort((a, b) => a.at - b.at)
      const next = timers[0]
      if (!next || next.at > until) break
      timers.shift()
      clock = Math.max(clock, next.at)
      next.resolve()
      await settle()
    }
    clock = Math.max(clock, until)
    await settle()
  }
  return {
    exports: { sleep, createHook },
    now: () => clock,
    resume,
    advanceTo,
    advance: (ms: number) => advanceTo(clock + ms),
    settle,
    created,
    pendingTimers: () => timers.length,
  }
}

function parseDuration(value: string) {
  const match = /^(\d+)\s*(ms|s|m|h)$/.exec(value)
  if (!match) throw new Error(`fake sleep: unsupported duration ${value}`)
  return Number(match[1]) * { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[match[2] as 'ms' | 's' | 'm' | 'h']
}
