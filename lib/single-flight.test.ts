import assert from 'node:assert/strict'
import test from 'node:test'
import type { PoolClient } from 'pg'
import { singleFlight, singleFlightJoined } from './single-flight'
import { withDatabaseClient } from './db/request-scope'

const deferred = () => { let resolve!: (value: string) => void; const promise = new Promise<string>(done => { resolve = done }); return { promise, resolve } }

test('identical concurrent keys share one read; any differing part, or a settled read, reads again', async () => {
  let reads = 0
  const gate = deferred()
  const read = () => { reads++; return gate.promise }
  const joined = singleFlightJoined()
  const same = [singleFlight(['/read', 'user-a', 'workspace-1', 'admin'], read), singleFlight(['/read', 'user-a', 'workspace-1', 'admin'], read)]
  const other = [singleFlight(['/read', 'user-b', 'workspace-1', 'admin'], read), singleFlight(['/read', 'user-a', 'workspace-2', 'admin'], read), singleFlight(['/read', 'user-a', 'workspace-1', 'member'], read)]
  gate.resolve('value')
  assert.deepEqual(await Promise.all([...same, ...other]), Array(5).fill('value'))
  assert.equal(reads, 4, 'only the identical user, workspace and role shared')
  assert.equal(singleFlightJoined() - joined, 1)
  await singleFlight(['/read', 'user-a', 'workspace-1', 'admin'], async () => { reads++; return 'next' })
  assert.equal(reads, 5, 'no result outlives its flight')
})

test('a failed read fails its joiners and is not kept', async () => {
  let reads = 0
  const failing = () => { reads++; return Promise.reject(new Error('unavailable')) }
  await Promise.all([assert.rejects(singleFlight(['/fail'], failing)), assert.rejects(singleFlight(['/fail'], failing))])
  assert.equal(reads, 1)
  assert.equal(await singleFlight(['/fail'], async () => { reads++; return 'ok' }), 'ok')
})

test('a read inside a write transaction is never shared', async () => {
  let reads = 0
  const client = { query: async () => ({ rows: [] }) } as unknown as PoolClient
  const gate = deferred()
  const read = () => { reads++; return gate.promise }
  const inside = withDatabaseClient(client, () => Promise.all([singleFlight(['/tx'], read), singleFlight(['/tx'], read)]))
  const outside = singleFlight(['/tx'], read)
  gate.resolve('value')
  await Promise.all([inside, outside])
  assert.equal(reads, 3)
})
