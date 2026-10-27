import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Pool } from 'pg'
import type * as provider from './e2b-provider'
import { threadResultDownload } from './thread-result-download'

const runId = '8fe7d6f8-7af0-4d84-96f6-f88bb27b45aa'
const actor = { userId: 'owner', workspaceId: '153bd012-55b3-44c0-8ff3-f78528775392' }

test('result downloads remain owner scoped and destroy the reader when consumed or cancelled', async () => {
  const pool = { async query(_sql: string, params: string[]) { return { rows: params[1] === actor.workspaceId && params[2] === actor.userId ? [{ resultSnapshotId: 'fixture-snapshot' }] : [] } } } as unknown as Pool
  let created = 0, killed = 0
  const runtime = { async createResultReader() {
    created++
    return { async kill() { killed++ }, commands: { async run() {} }, files: { async read() {
      return new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); controller.close() } })
    } } }
  } } as unknown as typeof provider
  assert.equal(await threadResultDownload(pool, { ...actor, userId: 'other' }, runId, runtime), null)
  assert.equal(created, 0)
  const first = await threadResultDownload(pool, actor, runId, runtime)
  assert.deepEqual([...new Uint8Array(await new Response(first).arrayBuffer())], [1, 2, 3])
  assert.equal(killed, 1)
  const second = await threadResultDownload(pool, actor, runId, runtime)
  await second!.cancel()
  assert.equal(killed, 2)
})
