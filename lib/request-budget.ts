/** A caller-owned deadline for bounded reads. Rotating credential refreshes
 * use it for admission only; once sent, they must finish and commit before
 * the caller observes cancellation. */
export type RequestBudget = { deadline: number; signal?: AbortSignal }

export function remainingRequestBudget(budget: RequestBudget, reserveMs = 0): number {
  budget.signal?.throwIfAborted()
  const remaining = Math.floor(budget.deadline - Date.now())
  if (!Number.isFinite(remaining) || remaining <= reserveMs) throw new DOMException('Request deadline exceeded', 'TimeoutError')
  return remaining
}

export function requestBudgetSignal(budget: RequestBudget, maximumMs = 10_000): AbortSignal {
  const timeout = AbortSignal.timeout(Math.min(maximumMs, remainingRequestBudget(budget)))
  return budget.signal ? AbortSignal.any([budget.signal, timeout]) : timeout
}
