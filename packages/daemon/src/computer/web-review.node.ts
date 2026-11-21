import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { ComputerBroker } from './broker.mjs'
import { applyWebComputerDecisions, followWebComputerReviews, syncWebComputerReviews, webComputerSnapshots } from './web-review'
import { computerSyncBody } from '@mikka/protocol/computer'
import { DeviceWorkSignal } from '../device-work-signal'
import { ServerUnreachableError } from '../errors'

/** An open device session whose redial reopens at once, as a reconnecting socket would. */
function openSession() {
  const signal = new DeviceWorkSignal()
  signal.setConnected(true)
  const redial = () => queueMicrotask(() => { signal.setConnected(false); signal.setConnected(true) })
  return { signal, redial }
}

test('web decision releases original MCP call and scripted model continues screenshot -> click; no raw driver or repeated execution', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cua-web-'))
  let calls = 0
  let allowed = true
  const broker = new ComputerBroker({ socketPath: join(dir, 'socket'),
    driver: { installed: true, path: '/fake', version: 'test', fingerprint: 'f'.repeat(64) },
    permitted: () => allowed,
    execute: async (_, call) => { calls++; return { content: [{ type: 'text', text: JSON.stringify(call) }] } },
  })
  await broker.listen()
  t.after(async () => { await broker.close(); await rm(dir, { recursive: true, force: true }) })
  const grant = broker.spec(randomUUID(), 'ask', { display: ':2' })!
  const child = spawn(process.execPath, [new URL('./proxy.mjs', import.meta.url).pathname, grant.socketPath, grant.token])
  t.after(() => child.kill())
  const lines = createInterface({ input: child.stdout })
  t.after(() => lines.close())
  const replies: any[] = []
  lines.on('line', text => replies.push(JSON.parse(text)))
  const waitFor = async (ok: () => boolean) => {
    for (let n = 0; n < 200 && !ok(); n++) await new Promise(r => setTimeout(r, 5))
    assert.ok(ok(), 'MCP step reached')
  }
  for (const [id, call] of [[1, { name: 'get_desktop_state', arguments: {} }], [2, { name: 'click', arguments: { x: 3, y: 4 } }]] as const) {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: call }) + '\n')
    await waitFor(() => broker.list().length === 1)
    const snapshot = webComputerSnapshots(broker)[0]
    assert.ok(computerSyncBody.safeParse({ requests: [snapshot] }).success)
    assert.equal(snapshot.display, ':2')
    assert.equal(replies.length, id - 1)
    await applyWebComputerDecisions(broker, [{ id: snapshot.id, digest: 'a'.repeat(64), approve: true }])
    assert.equal(calls, id - 1)
    const decisions = [{ id: snapshot.id, digest: snapshot.digest, approve: true }]
    await syncWebComputerReviews(broker, 'device', { syncComputerReviews: async (_device, requests) => { assert.equal(requests[0].digest, snapshot.digest); return decisions } })
    await waitFor(() => replies.length === id)
    assert.equal(replies[id - 1].id, id)
    assert.equal(JSON.parse(replies[id - 1].result.content[0].text).name, call.name)
    await applyWebComputerDecisions(broker, decisions)
    assert.equal(calls, id)
  }
  const grant2 = broker.spec(randomUUID(), 'ask')!
  const rejected = assert.rejects(broker.request(grant2.token, { name: 'click', arguments: { x: 1, y: 2 } }))
  const [row] = webComputerSnapshots(broker)
  allowed = false
  await applyWebComputerDecisions(broker, [{ id: row.id, digest: row.digest, approve: true }])
  await rejected
  assert.equal(calls, 2)
})

test('review sync retries transport failures through the redialed session without granting and stops on abort', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cua-poll-'))
  let executed = 0, attempts = 0
  const broker = new ComputerBroker({ socketPath: join(dir, 'socket'),
    driver: { installed: true, path: '/fake', version: 'test', fingerprint: 'f'.repeat(64) }, permitted: () => true,
    execute: async () => { executed++; return 'ok' },
  })
  t.after(async () => { await broker.close(); await rm(dir, { recursive: true, force: true }) })
  const grant = broker.spec(randomUUID(), 'ask', { display: ':1' })!
  const result = broker.request(grant.token, { name: 'click', arguments: { x: 1, y: 2 } })
  const abort = new AbortController()
  const session = openSession()
  const polling = followWebComputerReviews(broker, 'device', { async syncComputerReviews(_id, requests) {
    attempts++
    if (attempts === 1) { assert.equal(executed, 0); throw new ServerUnreachableError('offline') }
    return [{ id: requests[0].id, digest: requests[0].digest, approve: true }]
  } }, abort.signal, session.signal, session.redial)
  assert.equal(await result, 'ok')
  abort.abort()
  await polling
  assert.equal(attempts, 2)
  assert.equal(executed, 1)
})

test('idle review sync sends one cleanup, resumes for a pending call and retries the final cleanup', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cua-idle-'))
  let executed = 0, attempts = 0, emptyAttempts = 0
  const broker = new ComputerBroker({ socketPath: join(dir, 'socket'),
    driver: { installed: true, path: '/fake', version: 'test', fingerprint: 'f'.repeat(64) }, permitted: () => true,
    execute: async () => { executed++; return 'ok' },
  })
  const abort = new AbortController()
  let localReads = 0
  const list = broker.list.bind(broker)
  broker.list = () => { localReads++; return list() }
  let polling: Promise<void> | undefined
  t.after(async () => { abort.abort(); await polling; await broker.close(); await rm(dir, { recursive: true, force: true }) })
  const session = openSession()
  polling = followWebComputerReviews(broker, 'device', { async syncComputerReviews(_id, requests) {
    attempts++
    if (!requests.length) {
      emptyAttempts++
      // The first empty sync is the cleanup on open; the second is the final cleanup.
      if (emptyAttempts === 2) throw new ServerUnreachableError('cleanup offline')
      return []
    }
    return [{ id: requests[0].id, digest: requests[0].digest, approve: true }]
  } }, abort.signal, session.signal, session.redial)
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(attempts, 1, 'an empty broker must not generate periodic network traffic')
  assert.equal(localReads, 2, 'after startup cleanup, an empty broker sleeps on local events instead of polling')
  const grant = broker.spec(randomUUID(), 'ask')!
  const result = broker.request(grant.token, { name: 'click', arguments: { x: 1, y: 2 } })
  assert.equal(await result, 'ok')
  for (let n = 0; n < 100 && emptyAttempts < 3; n++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(emptyAttempts, 3, 'failed final empty snapshot must be retried')
  assert.equal(executed, 1)
  const settledAttempts = attempts
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(attempts, settledAttempts, 'idle sync stops after successful cleanup')
  abort.abort()
  await polling
})
