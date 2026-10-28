import type { Pool } from 'pg'
import type { TestAccountPool } from './pool.mjs'
import type { loadEnvironment } from './environment.mjs'

export type TestEnvironment = Awaited<ReturnType<typeof loadEnvironment>>
export type AccountLease = Awaited<ReturnType<TestAccountPool['acquire']>>
export type TestAccount = {
  userId: string
  slotId: string
  namespace: string
  role: 'owner' | 'peer'
  storageStatePath: string
  request(path: string, init?: RequestInit): Promise<Response>
}
export type AccountScope = {
  pool: TestAccountPool
  readonly lease: AccountLease
  owner: TestAccount
  peer: TestAccount
  assertActive(): Promise<void>
  renew(): Promise<AccountLease>
  release(options?: { outcome?: 'clean' | 'dirty' | 'cancelled' }): Promise<AccountLease>
  onLeaseLost(listener: () => void): () => void
  recordResource(resource: { type: string; id: string; ownerId: string }): Promise<void>
  markResourceCleaned(resource: { type: string; id: string }): Promise<void>
}
export type AccountOptions = {
  database?: Pool
  environment?: TestEnvironment
  runId: string
  workerId: string
  requestId: string
  ttlMs?: number
  stateDirectory?: string
}
export function acquireTestAccounts(options: AccountOptions): Promise<AccountScope>
export function withTestAccounts<T>(options: AccountOptions, callback: (scope: AccountScope) => Promise<T>): Promise<T>
export function auditEvidence(paths: string[], options?: { environment?: TestEnvironment; stateDirectory?: string }): Promise<{ files: number; result: string; checked: string }>
export function recordAuthenticationSecrets(values: string[], options?: { environment?: TestEnvironment }): Promise<void>
