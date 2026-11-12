// Shared service recovery only. Task machines have their own lifecycle owner.
const delays = [1, 5, 30]

export function stoppedHost(state, releaseId) {
  return { ...state, releaseId, stopped: true }
}

export function restartPlan(state, releaseId, now) {
  if (state?.stopped || (state?.releaseId && state.releaseId !== releaseId)) return null
  const stable = Number.isFinite(state?.startedAt) && now - state.startedAt >= 10 * 60_000
  const attempt = stable ? 0 : state?.attempt ?? 0
  if (!Number.isInteger(attempt) || attempt < 0 || attempt >= delays.length) return null
  return { releaseId, attempt: attempt + 1, dueAt: now + delays[attempt] * 1000, stopped: false }
}

export function mayRestart(state, expected) {
  return Boolean(state && !state.stopped && state.releaseId === expected.releaseId && state.attempt === expected.attempt)
}
