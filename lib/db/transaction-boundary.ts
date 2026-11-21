import { AsyncLocalStorage } from 'node:async_hooks'

// Independent background work may inherit request routing and identity, but
// cannot borrow transactions or derived leases owned by its scheduling branch.
const boundary = new AsyncLocalStorage<object>()

export function currentTransactionBoundary(): object | undefined {
  return boundary.getStore()
}

export function withIndependentTransactionBoundary<T>(work: () => T): T {
  return boundary.run({}, work)
}
