import assert from 'node:assert/strict'
import { EventEmitter, getEventListeners } from 'node:events'
import test from 'node:test'
import { createRequire } from 'node:module'
import { channel } from 'node:diagnostics_channel'
import { withMailboxDiagnostics } from './mailbox-diagnostics'
import { Client } from 'pg'
import { SessionMailbox, MailboxError } from './session-mailbox'
import { acquireWorkspaceMembership } from './workspace-membership-guard'
import type { MailboxTransactionGuard } from './mailbox-transaction-guard'

// Deterministic row-lock/pool/failure model. Actual guard and transaction code,
// not a Postgres emulator; real PG UPDATE/SHARE validation remains required.
function model() {
  const events: string[] = [], revocations: (() => void)[] = []
  const state = { active: true, shares: 0, appConnects: 0, wsConnects: 0, appHeld: 0, wsHeld: 0, staged: 0, committed: 0, appDestroyed: 0, wsDestroyed: 0 }
  const control = { data: async () => {}, commit: async () => {}, prepare: async () => {}, beforeMember: async () => {}, finalize: async () => {} }
  const wsClients: EventEmitter[] = []
  const wsPool = { async connect() {
    state.wsConnects++; state.wsHeld++; assert.ok(state.appHeld > 0, 'APP reservation precedes WS pool checkout')
    let shared = false, released = false
    const unlock = () => { if (shared) { shared = false; state.shares-- }; if (!state.shares) for (const apply of revocations.splice(0)) apply() }
    const c = Object.assign(new EventEmitter(), {
      async query(input: string | { text: string; values?: unknown[] }) {
        const sql = typeof input === 'string' ? input : input.text
        if (sql === 'select 1' && state.committed) await control.finalize()
        if (sql.includes('for share')) {
          assert.ok(!sql.includes('key share'))
          assert.deepEqual(typeof input === 'string' ? [] : input.values, ['namespace', 'owner'])
          await control.beforeMember()
          if (!state.active) return { rows: [], rowCount: 0 }
          state.shares++; shared = true; events.push('member:share'); return { rows: [{ status: 'active' }], rowCount: 1 }
        }
        if (sql === 'rollback') { events.push('member:rollback'); unlock() }
        return { rows: [{}], rowCount: 1 }
      },
      release(error?: Error) { assert.equal(released, false); released = true; state.wsHeld--; if (error) state.wsDestroyed++; unlock(); events.push('ws:release') },
    })
    wsClients.push(c); return c
  } }
  const appPool = { async connect() {
    state.appConnects++; state.appHeld++; events.push('app:reserve')
    let released = false
    return { async query(sql: string) {
      if (sql === 'begin') events.push('app:begin')
      if (sql.startsWith('select * from session_mailboxes')) return { rows: [{ userId: 'owner', workspaceId: 'namespace', kind: 'coordinator' }] }
      if (sql.startsWith('update run_messages')) { state.staged++; events.push('data:prepare'); await control.data(); return { rows: [] } }
      if (sql === 'commit') { events.push('app:commit-send'); await control.commit(); state.committed += state.staged; state.staged = 0; events.push('app:committed') }
      if (sql === 'rollback') { state.staged = 0; events.push('app:rollback') }
      return { rows: [] }
    }, release(error?: Error) { assert.equal(released, false); released = true; state.appHeld--; if (error) { state.appDestroyed++; state.staged = 0 }; events.push('app:release') } }
  } }
  const abort = new AbortController()
  const guard: MailboxTransactionGuard = Object.assign(async (_client: unknown, signal: AbortSignal) => {
    events.push('head:locked'); await control.prepare()
    return acquireWorkspaceMembership(wsPool as unknown as Parameters<typeof acquireWorkspaceMembership>[0], { userId: 'owner', workspaceId: 'namespace' }, signal)
  }, { signal: abort.signal })
  const store = new SessionMailbox(appPool as unknown as ConstructorParameters<typeof SessionMailbox>[0], 'namespace', undefined, guard)
  const read = () => store.inbox({ userId: 'owner', workspaceId: 'namespace', mailboxId: 'box' })
  const revoke = () => new Promise<void>(resolve => {
    const apply = () => { state.active = false; events.push('member:revoked'); resolve() }
    if (state.shares) revocations.push(apply); else apply()
  })
  return { state, control, events, wsClients, appPool, wsPool, guard, abort, read, revoke }
}
function barrier() { let enter!: () => void, release!: () => void; const entered = new Promise<void>(r => { enter = r }), waiting = new Promise<void>(r => { release = r }); return { entered, release, wait: async () => { enter(); await waiting } } }
// Instrument a real checkout Promise: schedule failure after the provider's
// fulfillment callback returns, before its consumer's await continuation.
function checkoutHandoff<T extends object>(client: T, after: () => void): Promise<T> {
  return promiseHandoff(Promise.resolve(client), after)
}
function promiseHandoff<T>(pending: Promise<T>, after: () => void): Promise<T> {
  return new Proxy(pending, { get(target, key) {
    if (key === 'then') return (fulfilled: (value: T) => unknown) => target.then(value => { const result = fulfilled(value); queueMicrotask(after); return result })
    const value = Reflect.get(target, key, target)
    return typeof value === 'function' ? value.bind(target) : value
  } }) as Promise<T>
}
test('authorization lease callback handoff abort retains WS custody until APP is released, then closes once', async () => {
  const h = model(); let closes = 0
  const guard = Object.assign((client: Parameters<MailboxTransactionGuard>[0], signal: AbortSignal) => promiseHandoff(h.guard(client, signal).then(lease => ({
    ...lease, async close() { closes++; await lease.close() },
  })), () => h.abort.abort()), { signal: h.abort.signal })
  const store = new SessionMailbox(h.appPool as unknown as ConstructorParameters<typeof SessionMailbox>[0], 'namespace', undefined, guard)
  await assert.rejects(store.inbox({ userId: 'owner', workspaceId: 'namespace', mailboxId: 'box' }), MailboxError)
  await Promise.resolve()
  assert.equal(h.state.appHeld, 0); assert.equal(h.state.wsHeld, 0); assert.equal(h.state.shares, 0); assert.equal(closes, 1); assert.equal(h.state.committed, 0)
  assert.ok(h.events.indexOf('app:release') < h.events.indexOf('ws:release'))
})
test('authorization lease arriving after aborted APP cleanup is still closed exactly once', async () => {
  const h = model(); let acquired!: (lease: Awaited<ReturnType<MailboxTransactionGuard>>) => void, entered!: () => void, closes = 0
  const ready = new Promise<void>(resolve => { entered = resolve })
  const pending = new Promise<Awaited<ReturnType<MailboxTransactionGuard>>>(resolve => { acquired = resolve })
  const guard = Object.assign(() => { entered(); return pending }, { signal: h.abort.signal })
  const store = new SessionMailbox(h.appPool as unknown as ConstructorParameters<typeof SessionMailbox>[0], 'namespace', undefined, guard)
  const effect = store.inbox({ userId: 'owner', workspaceId: 'namespace', mailboxId: 'box' })
  await ready; h.abort.abort(); await assert.rejects(effect, MailboxError)
  assert.equal(h.state.appHeld, 0)
  acquired({ async check() {}, async close() { closes++ } })
  await new Promise<void>(resolve => { setImmediate(resolve) })
  assert.equal(closes, 1); assert.equal(h.state.committed, 0)
})
test('APP checkout handoff abort microtask discards acquired reservation without opening WS', async () => {
  const h = model(), raw = await h.appPool.connect()
  const pool = { connect: () => checkoutHandoff(raw, () => h.abort.abort()) }
  const store = new SessionMailbox(pool as unknown as ConstructorParameters<typeof SessionMailbox>[0], 'namespace', undefined, h.guard)
  await assert.rejects(store.inbox({ userId: 'owner', workspaceId: 'namespace', mailboxId: 'box' }), MailboxError)
  await Promise.resolve(); assert.equal(h.state.appHeld, 0); assert.equal(h.state.wsConnects, 0); assert.equal(h.state.appDestroyed, 1); assert.equal(h.state.committed, 0)
})
for (const failure of ['abort-after-resolution', 'error', 'end']) test(`APP checkout handoff ${failure} owns and discards the reservation`, async () => {
  const h = model(), client = Object.assign(new EventEmitter(), await h.appPool.connect())
  const pool = { connect: () => checkoutHandoff(client, () => { if (failure === 'abort-after-resolution') queueMicrotask(() => h.abort.abort()); else client.emit(failure, Error('Synthetic APP checkout failure')) }) }
  const store = new SessionMailbox(pool as unknown as ConstructorParameters<typeof SessionMailbox>[0], 'namespace', undefined, h.guard)
  await assert.rejects(store.inbox({ userId: 'owner', workspaceId: 'namespace', mailboxId: 'box' }), MailboxError)
  await Promise.resolve(); assert.equal(h.state.appHeld, 0); assert.equal(h.state.wsConnects, 0); assert.equal(h.state.appDestroyed, 1); assert.equal(h.state.committed, 0)
  assert.equal(client.listenerCount('error') + client.listenerCount('end'), 0)
})
test('workspace checkout handoff abort microtask discards the acquired client exactly once before any query', async () => {
  const abort = new AbortController(); let releases = 0, queries = 0
  const client = Object.assign(new EventEmitter(), { query: async () => { queries++; return { rowCount: 1, rows: [{}] } }, release(error?: Error) { assert.ok(error); releases++ } })
  const pool = { connect: () => checkoutHandoff(client, () => abort.abort()) }
  await assert.rejects(acquireWorkspaceMembership(pool as unknown as Parameters<typeof acquireWorkspaceMembership>[0], { workspaceId: 'namespace', userId: 'owner' }, abort.signal), MailboxError)
  await Promise.resolve(); assert.equal(queries, 0); assert.equal(releases, 1)
})
for (const failure of ['abort-after-resolution', 'error', 'end']) test(`workspace checkout handoff ${failure} owns the client before continuation`, async () => {
  const abort = new AbortController(); let releases = 0, queries = 0
  const client = Object.assign(new EventEmitter(), { query: async () => { queries++; return { rowCount: 1, rows: [{}] } }, release(error?: Error) { assert.ok(error); releases++ } })
  const pool = { connect: () => checkoutHandoff(client, () => { if (failure === 'abort-after-resolution') queueMicrotask(() => abort.abort()); else client.emit(failure, Error('Synthetic checkout failure')) }) }
  await assert.rejects(acquireWorkspaceMembership(pool as unknown as Parameters<typeof acquireWorkspaceMembership>[0], { workspaceId: 'namespace', userId: 'owner' }, abort.signal), MailboxError)
  await Promise.resolve(); assert.equal(queries, 0); assert.equal(releases, 1)
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0); assert.equal(client.listenerCount('error') + client.listenerCount('end'), 0)
})
test('synchronous workspace checkout rejection removes admission listeners and preserves the cause', async () => {
  const abort = new AbortController(), failure = Error('Synthetic pool ending')
  await assert.rejects(acquireWorkspaceMembership({ connect() { throw failure } } as unknown as Parameters<typeof acquireWorkspaceMembership>[0], { workspaceId: 'namespace', userId: 'owner' }, abort.signal), error => error === failure)
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0)
})
test('admitted workspace query remains owned through cancellation before exactly-once discard', async t => {
  const abort = new AbortController(), atMember = barrier(), atCancel = barrier(); let releases = 0
  const client = Object.assign(new EventEmitter(), {
    processID: 321, secretKey: -12345, connectionParameters: { host: '127.0.0.1', port: 55587, ssl: false },
    async query(config: { text: string }) { if (config.text.includes('for share')) await atMember.wait(); return { rowCount: 1, rows: [{ status: 'active' }] } },
    release(error?: Error) { assert.ok(error); releases++ },
  })
  const sample = new Client() as unknown as { connection: EventEmitter }, prototype = Object.getPrototypeOf(sample.connection)
  let closeControl!: () => void
  t.mock.method(prototype, 'connect', function(this: EventEmitter) { closeControl = () => this.emit('end'); this.emit('connect') })
  t.mock.method(prototype, 'cancel', () => { void atCancel.wait() })
  const pending = acquireWorkspaceMembership({ connect: async () => client } as unknown as Parameters<typeof acquireWorkspaceMembership>[0], { workspaceId: 'namespace', userId: 'owner' }, abort.signal)
  await atMember.entered; abort.abort(); await atCancel.entered; assert.equal(releases, 0)
  closeControl(); await assert.rejects(pending, MailboxError); atMember.release(); atCancel.release(); assert.equal(releases, 1)
})
test('ordinary member UPDATE after prepare waits through app COMMIT; next operation is denied', async () => {
  const h = model(), atCommit = barrier(); h.control.commit = atCommit.wait
  const first = h.read(); await atCommit.entered
  const revoke = h.revoke(); assert.equal(h.state.active, true); assert.equal(h.state.shares, 1)
  atCommit.release(); await first; await revoke
  assert.equal(h.state.committed, 1)
  assert.ok(h.events.indexOf('app:committed') < h.events.indexOf('member:revoked'))
  assert.ok(h.events.indexOf('app:release') < h.events.indexOf('ws:release'))
  await assert.rejects(h.read(), MailboxError); assert.equal(h.state.committed, 1)
  assert.equal(h.state.appHeld + h.state.wsHeld, 0)
})
test('revocation winning before member lock denies after app preparation with zero effects', async () => {
  const h = model(); h.control.beforeMember = async () => { await h.revoke() }
  await assert.rejects(h.read(), MailboxError)
  assert.equal(h.state.committed, 0); assert.equal(h.events.includes('data:prepare'), false)
  assert.equal(h.state.appHeld + h.state.wsHeld, 0)
})
test('cancel or WS connection failure before COMMIT destroys only held clients and commits no effect', async () => {
  for (const failure of ['cancel', 'connection']) {
    const h = model(), atData = barrier(); h.control.data = atData.wait
    const effect = h.read(); await atData.entered
    if (failure === 'cancel') h.abort.abort(); else h.wsClients[0].emit('error', Error('Synthetic connection lost'))
    await assert.rejects(effect, MailboxError); atData.release()
    assert.equal(h.state.committed, 0); assert.equal(h.events.includes('app:commit-send'), false)
    assert.equal(h.state.appHeld + h.state.wsHeld, 0)
    assert.equal(h.state.appDestroyed, 1); assert.equal(h.state.wsDestroyed, 1)
  }
})
test('actual Next response-close signal reaches request and guarded APP discard before WS release without a server', async () => {
  const require = createRequire(import.meta.url)
  const { signalFromNodeResponse } = require('next/dist/server/web/spec-extension/adapters/next-request.js')
  const response = Object.assign(new EventEmitter(), { writableFinished: false, destroyed: false })
  const request = new Request('http://127.0.0.1:30587/mikka/v1/mailbox', { signal: signalFromNodeResponse(response) })
  const h = model(), atData = barrier(); h.control.data = atData.wait
  request.signal.addEventListener('abort', () => h.abort.abort(), { once: true })
  const observations: { stage: string; requestId?: string }[] = [], events = channel('mikka.personal-mailbox.lifecycle')
  const observe = (event: unknown) => observations.push(event as { stage: string; requestId?: string })
  events.subscribe(observe)
  try {
    const pending = withMailboxDiagnostics('synthetic-run', request.signal, h.read)
    await atData.entered; response.emit('close'); await assert.rejects(pending, MailboxError)
    assert.equal(request.signal.aborted, true); assert.equal(h.state.committed, 0)
    assert.ok(h.events.indexOf('app:release') < h.events.indexOf('ws:release'))
    assert.ok(observations.some(e => e.stage === 'http.abort')); assert.ok(observations.some(e => e.stage === 'app.release'))
    assert.equal(new Set(observations.map(e => e.requestId)).size, 1)
  } finally { atData.release(); events.unsubscribe(observe) }
})
test('an aborted APP remains checked out until the keyed cancel control closes, so a late cancel cannot hit a pooled borrower', async t => {
  const h = model(), atData = barrier(), atCancel = barrier(); h.control.data = atData.wait
  const connect = h.appPool.connect.bind(h.appPool)
  h.appPool.connect = async () => Object.assign(await connect(), { processID: 321, secretKey: -12345,
    connectionParameters: { host: '127.0.0.1', port: 55587, ssl: false } })
  const sample = new Client() as unknown as { connection: EventEmitter }, prototype = Object.getPrototypeOf(sample.connection)
  let closeControl: (() => void) | undefined
  t.mock.method(prototype, 'connect', function(this: EventEmitter) { closeControl = () => { this.emit('end') }; this.emit('connect') })
  t.mock.method(prototype, 'cancel', (pid: number, key: number) => { assert.equal(pid, 321); assert.equal(key, -12345); void atCancel.wait() })
  const pending = h.read(); await atData.entered; h.abort.abort(); await atCancel.entered
  assert.equal(h.state.appHeld, 1); assert.equal(h.state.wsHeld, 1); assert.equal(h.events.includes('app:release'), false)
  closeControl!(); await assert.rejects(pending, MailboxError)
  atData.release(); atCancel.release()
  assert.equal(h.state.appHeld + h.state.wsHeld, 0); assert.equal(h.events.includes('app:commit-send'), false)
})
test('a COMMIT already sent and never answered is bounded and explicitly unconfirmed, never retried', async () => {
  const h = model(), atCommit = barrier(); h.control.commit = atCommit.wait
  const effect = h.read(); await atCommit.entered; h.abort.abort()
  await assert.rejects(effect, e => e instanceof MailboxError && e.status === 409 && e.commitState === 'unconfirmed')
  assert.equal(h.events.filter(e => e === 'app:commit-send').length, 1)
  assert.equal(h.events.includes('app:rollback'), false, 'do not queue rollback behind a black-holed COMMIT')
  assert.equal(h.state.appHeld + h.state.wsHeld, 0)
})
test('WS failure racing a COMMIT can leave a durable effect and must remain explicitly unconfirmed', async () => {
  const h = model(); h.control.commit = async () => { h.wsClients[0].emit('error', Error('Synthetic WS failure at commit')) }
  await assert.rejects(h.read(), e => e instanceof MailboxError && e.commitState === 'unconfirmed')
  assert.equal(h.state.committed, 1); assert.equal(h.state.appHeld + h.state.wsHeld, 0)
})
test('post-acknowledgement lease loss reports known committed state instead of zero writes', async () => {
  const h = model(); h.control.finalize = async () => { h.wsClients[0].emit('error', Error('Synthetic WS finalization failure')) }
  await assert.rejects(h.read(), e => e instanceof MailboxError && e.commitState === 'committed')
  assert.equal(h.state.committed, 1); assert.equal(h.state.appHeld + h.state.wsHeld, 0)
})
test('deadline ends a never-settling app query without waiting for its socket', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const h = model(), atData = barrier(); h.control.data = atData.wait
  const effect = h.read(); await atData.entered; t.mock.timers.tick(20001)
  await assert.rejects(effect, MailboxError)
  assert.equal(h.state.committed, 0); assert.equal(h.state.appHeld + h.state.wsHeld, 0)
})
test('aborted pending APP reservation is released if it arrives late, without taking WS', async () => {
  const h = model(); let provide!: (value: Awaited<ReturnType<typeof h.appPool.connect>>) => void
  const pending = new Promise<Awaited<ReturnType<typeof h.appPool.connect>>>(r => { provide = r })
  const store = new SessionMailbox({ connect: () => pending } as unknown as ConstructorParameters<typeof SessionMailbox>[0], 'namespace', undefined, h.guard)
  const effect = store.inbox({ userId: 'owner', workspaceId: 'namespace', mailboxId: 'box' }); h.abort.abort()
  await assert.rejects(effect, MailboxError)
  provide(await h.appPool.connect()); await new Promise<void>(r => queueMicrotask(r))
  assert.equal(h.state.appHeld, 0); assert.equal(h.state.wsConnects, 0); assert.equal(h.state.appDestroyed, 1)
})
test('five-connection initialization/head ordering leaves WS capacity for the existing APP-head holder', async () => {
  const h = model(), baseline = await h.appPool.connect()
  let count = 0, prepared!: () => void, releaseHead!: () => void
  const fourPrepared = new Promise<void>(r => { prepared = r }), head = new Promise<void>(r => { releaseHead = r })
  h.control.prepare = async () => { if (++count === 4) prepared(); await head }
  const work = Array.from({ length: 4 }, () => h.read())
  await fourPrepared
  assert.equal(h.state.appHeld, 5); assert.equal(h.state.wsHeld, 0)
  // Shape of existing AgentKit beginExecution: owns APP/head, then requests WS.
  const member = await h.wsPool.connect(); member.release(); baseline.release(); releaseHead()
  await Promise.all(work)
  assert.equal(h.state.committed, 4); assert.equal(h.state.appHeld + h.state.wsHeld, 0)
})
test('abort microtask after the final check never dispatches COMMIT and is not mislabeled uncertain', async () => {
  const h = model(), abort = new AbortController(); let checks = 0
  const guard: MailboxTransactionGuard = async () => ({
    signal: abort.signal,
    async check() { if (++checks === 2) queueMicrotask(() => abort.abort()) },
    async close() {},
  })
  const store = new SessionMailbox(h.appPool as unknown as ConstructorParameters<typeof SessionMailbox>[0], 'namespace', undefined, guard)
  await assert.rejects(store.inbox({ userId: 'owner', workspaceId: 'namespace', mailboxId: 'box' }), e => e instanceof MailboxError && e.commitState === undefined)
  assert.equal(h.events.includes('app:commit-send'), false); assert.equal(h.state.committed, 0)
  assert.equal(h.state.appHeld, 0)
})
test('ordinary application SQL failure rolls back before releasing membership and preserves the cause', async () => {
  const h = model(), failure = new Error('Synthetic ordinary SQL failure')
  h.control.data = async () => { throw failure }
  await assert.rejects(h.read(), error => error === failure)
  assert.equal(h.state.committed, 0)
  assert.ok(h.events.indexOf('app:rollback') < h.events.indexOf('member:rollback'))
  assert.equal(h.state.appDestroyed + h.state.wsDestroyed, 0, 'healthy clients remain reusable after SQL rollback')
  h.control.data = async () => {}
  await h.read(); assert.equal(h.state.committed, 1)
  assert.equal(h.state.appHeld + h.state.wsHeld, 0)
})
test('pending workspace checkout arriving after cancellation is destroyed without SQL or effects', async () => {
  const h = model(), abort = new AbortController(); let provide!: (value: Awaited<ReturnType<typeof h.wsPool.connect>>) => void
  const pending = new Promise<Awaited<ReturnType<typeof h.wsPool.connect>>>(r => { provide = r })
  const app = await h.appPool.connect()
  const result = acquireWorkspaceMembership({ connect: () => pending } as unknown as Parameters<typeof acquireWorkspaceMembership>[0], { workspaceId: 'namespace', userId: 'owner' }, abort.signal)
  abort.abort(); await assert.rejects(result, MailboxError)
  provide(await h.wsPool.connect()); await new Promise<void>(r => queueMicrotask(r)); app.release()
  assert.equal(h.state.shares, 0); assert.equal(h.state.wsDestroyed, 1)
  assert.equal(h.state.appHeld + h.state.wsHeld, 0); assert.equal(h.state.committed, 0)
})
test('transport preserves known/unknown commit state for explicit stable-key reconciliation', async () => {
  const { personalMailboxAction } = await import('./personal-mailbox-action')
  for (const commitState of ['committed', 'unconfirmed'] as const) {
    const error = new MailboxError('Synthetic commit requires reconciliation', 409, commitState)
    const result = await personalMailboxAction({ action: 'inbox' }, {
      enabled: true,
      store: {} as Parameters<typeof personalMailboxAction>[1]['store'],
      async actor() { throw error },
    })
    assert.equal(result.status, 409)
    assert.deepEqual(result.body, { error: error.message, commitState })
  }
})
