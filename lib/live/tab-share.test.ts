import assert from 'node:assert/strict'
import test from 'node:test'
import { CLAIM_WINDOW_MS, RESULT_TIMEOUT_MS, TabShare, tabShareChannelName, type TabChannel, type TabShareClock } from './tab-share'
import { PersistentReadCache, readCacheShareNamespace } from '../swr/persistent-cache'
import { coversLiveRevisions } from './revisions'

/** BroadcastChannel semantics: same name, other instances only, delivered asynchronously. */
function hub() {
  const channels = new Map<string, Set<TabChannel>>()
  let now = 0
  const timers = new Map<number, { at: number; callback: () => void }>()
  let next = 0
  const clock: TabShareClock = { now: () => now, later: (callback, ms) => { timers.set(++next, { at: now + ms, callback }); return next }, cancel: id => { timers.delete(id as number) } }
  const open = (name: string): TabChannel => {
    const channel: TabChannel = {
      onmessage: null,
      postMessage(data: unknown) {
        const copy = structuredClone(data)
        for (const other of channels.get(name) ?? []) if (other !== channel) queueMicrotask(() => other.onmessage?.({ data: copy } as MessageEvent))
      },
      close() { channels.get(name)?.delete(channel) },
    }
    if (!channels.has(name)) channels.set(name, new Set())
    channels.get(name)!.add(channel)
    return channel
  }
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)) }
  const advance = async (ms: number) => {
    const until = now + ms
    for (;;) {
      await settle()
      const due = [...timers].sort((a, b) => a[1].at - b[1].at)[0]
      if (!due || due[1].at > until) break
      now = due[1].at; timers.delete(due[0]); due[1].callback()
    }
    now = until; await settle()
  }
  return { open, clock, advance, settle }
}

test('three tabs woken by one push: one reads, the others take its result', async () => {
  const h = hub(), name = 'mikka-live-read:owner:workspace'
  const tabs = [0, 1, 2].map(() => new TabShare(name, h.open, h.clock))
  let reads = 0
  const stored: unknown[] = []
  const runs = tabs.map(tab => tab.run('list', async () => { reads++; return { items: [1, 2], requestedAt: h.clock.now() - 5 } }, data => { stored.push(data) }))
  await h.advance(CLAIM_WINDOW_MS + 10)
  await Promise.all(runs)
  assert.equal(reads, 1)
  assert.equal(stored.length, 2)
  assert.deepEqual((stored[0] as { items: number[] }).items, [1, 2])
  assert.equal((stored[0] as { requestedAt: number }).requestedAt, CLAIM_WINDOW_MS - 5, "the read's age, rebased on this tab's own clock")
})

test('a newer push cannot be satisfied by a shared read started before that revision', async () => {
  const h = hub(), name = 'mikka-live-read:owner:workspace'
  const [leader, follower] = [new TabShare(name, h.open, h.clock), new TabShare(name, h.open, h.clock)]
  const key = 'bot_chat:00000000-0000-4000-8000-000000000001'
  const snapshot = (revision: number) => ({ live: { revisions: { [key]: revision } } })
  let release!: (data: ReturnType<typeof snapshot>) => void
  const first = leader.run('chat', () => new Promise<ReturnType<typeof snapshot>>(resolve => { release = resolve }), () => {})
  await h.advance(CLAIM_WINDOW_MS + 10)
  let reads = 0, stored = snapshot(5)
  const second = follower.run('chat', async () => { reads++; return stored = snapshot(6) }, data => { stored = data }, data => coversLiveRevisions(data, { [key]: 6 }))
  await h.settle()
  release(snapshot(5))
  await h.advance(CLAIM_WINDOW_MS + 10)
  await Promise.all([first, second])
  assert.equal(stored.live.revisions[key], 6)
  assert.equal(reads, 1, 'the follower reads once when the shared result does not cover its push')
  assert.equal(follower.adopted, 0, 'an older snapshot must never reach the cache')
  leader.close(); follower.close()
})

test('shared snapshots prove every required revision, including missing or malformed proofs', () => {
  const bot = 'bot_chat:00000000-0000-4000-8000-000000000001'
  const run = 'run:00000000-0000-4000-8000-000000000002'
  const required = { [bot]: 6, [run]: 3 }
  for (const data of [undefined, null, {}, { requestedAt: Number.MAX_SAFE_INTEGER }, { live: {} },
    ...[undefined, 5, '6', 6.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map(revision => ({ live: { revisions: { [bot]: revision, [run]: 3 } } })),
    { live: { revisions: { [bot]: 6 } } }, { live: { revisions: { [bot]: 6, [run]: 2 } } }]) {
    assert.equal(coversLiveRevisions(data, required), false)
  }
  assert.equal(coversLiveRevisions({ live: { revisions: required } }, required), true)
  assert.equal(coversLiveRevisions({ live: { revisions: { [bot]: 7, [run]: 4 } } }, required), true)
  assert.equal(coversLiveRevisions(undefined), true, 'unversioned sharing retains its existing behavior')
})

test('three tabs with the same revision requirement share one current read on every push', async t => {
  const h = hub(), name = 'mikka-live-read:owner:workspace'
  const tabs = [0, 1, 2].map(() => new TabShare(name, h.open, h.clock))
  t.after(() => { for (const tab of tabs) tab.close() })
  let reads = 0, adoptions = 0
  for (const revision of [6, 7]) {
    const required = { 'bot_chat:00000000-0000-4000-8000-000000000001': revision }
    const runs = tabs.map(tab => tab.run('chat', async () => { reads++; return { live: { revisions: required } } }, () => { adoptions++ }, data => coversLiveRevisions(data, required)))
    await h.advance(CLAIM_WINDOW_MS + 10)
    assert.equal(reads, revision - 5, 'a yielded claim must not hold the next push until its timeout')
    await Promise.all(runs)
    assert.equal(adoptions, 2 * (revision - 5))
  }
})

for (const count of [2, 3]) test(`${count} tabs reject an old in-flight result and share exactly one fresh read, including the leader's later refresh`, async t => {
  const h = hub(), name = 'mikka-live-read:owner:workspace'
  const tabs = Array.from({ length: count }, () => new TabShare(name, h.open, h.clock))
  t.after(() => { for (const tab of tabs) tab.close() })
  const key = 'bot_chat:00000000-0000-4000-8000-000000000001'
  const snapshot = (revision: number) => ({ live: { revisions: { [key]: revision } }, requestedAt: h.clock.now() })
  const stored = tabs.map(() => snapshot(5))
  let oldReads = 0, freshReads = 0, release!: () => void
  const old = tabs[0].run('chat', () => { oldReads++; return new Promise<ReturnType<typeof snapshot>>(resolve => { release = () => { stored[0] = snapshot(5); resolve(stored[0]) } }) }, () => assert.fail())
  await h.advance(CLAIM_WINDOW_MS + 10)
  const fresh = (index: number) => tabs[index].run('chat', async () => { freshReads++; return stored[index] = snapshot(6) }, data => { stored[index] = data }, data => coversLiveRevisions(data, { [key]: 6 }), true)
  const followers = tabs.slice(1).map((_, index) => fresh(index + 1))
  await h.settle(); release(); await old
  await h.advance(2_000)
  const trailing = fresh(0)
  await h.advance(CLAIM_WINDOW_MS + 10)
  await Promise.all([...followers, trailing])
  assert.equal(oldReads, 1)
  assert.equal(freshReads, 1, 'the retry participates in sharing, and a paced trailing refresh reuses its covered result')
  assert.ok(stored.every(data => data.live.revisions[key] === 6))
  for (const revision of [7, 8]) {
    const next = tabs.map((tab, index) => tab.run('chat', async () => { freshReads++; return stored[index] = snapshot(revision) }, data => { stored[index] = data }, data => coversLiveRevisions(data, { [key]: revision }), true))
    await h.advance(CLAIM_WINDOW_MS + 10)
    assert.equal(freshReads, revision - 5, 'each subsequent push shares a new read immediately, without waiting for abandoned election claims')
    await Promise.all(next)
    assert.ok(stored.every(data => data.live.revisions[key] === revision))
  }
})

test('completed results retain their observation age and require live coverage, an allowed reuse and an active channel', async t => {
  const h = hub(), name = 'mikka-live-read:owner:workspace'
  const [leader, follower] = [new TabShare(name, h.open, h.clock), new TabShare(name, h.open, h.clock)]
  t.after(() => { leader.close(); follower.close() })
  const required = { 'bot_chat:00000000-0000-4000-8000-000000000001': 6 }
  let reads = 0, requestedAt = 0
  const read = async () => { reads++; return { live: { revisions: required }, requestedAt: h.clock.now() - 5 } }
  const accepts = (data: unknown) => coversLiveRevisions(data, required)
  const first = leader.run('chat', read, () => assert.fail())
  await h.advance(CLAIM_WINDOW_MS + 10); await first
  await h.advance(2_000)
  await follower.run('chat', read, data => { requestedAt = data.requestedAt }, accepts, true)
  assert.equal(reads, 1)
  assert.equal(requestedAt, CLAIM_WINDOW_MS - 5, 'taking a completed snapshot does not make its observation newer')
  for (const [predicate, reuse] of [[accepts, false], [undefined, true]] as const) {
    const pending = follower.run('chat', read, () => assert.fail('this refresh requires a new read'), predicate, reuse)
    await h.advance(CLAIM_WINDOW_MS + 10); await pending
  }
  assert.equal(reads, 3, 'unversioned refreshes cannot borrow an earlier completion')
  await h.advance(RESULT_TIMEOUT_MS + 1)
  const expired = follower.run('chat', read, () => assert.fail('the retained result expired'), accepts, true)
  await h.advance(CLAIM_WINDOW_MS + 10); await expired
  assert.equal(reads, 4)
  follower.close()
  await follower.run('chat', read, () => assert.fail('a closed channel cannot reuse data'), accepts, true)
  assert.equal(reads, 5)
})

test('another user, workspace or key never shares; a closed channel or a silent leader reads itself', async () => {
  const h = hub()
  let reads = 0
  const read = async () => { reads++; return { reads } }
  const a = new TabShare('mikka-live-read:owner:workspace', h.open, h.clock)
  const peer = new TabShare('mikka-live-read:peer:workspace', h.open, h.clock)
  const other = new TabShare('mikka-live-read:owner:other', h.open, h.clock)
  const runs = [a.run('list', read, () => assert.fail('no adoption across scopes')), peer.run('list', read, () => assert.fail()), other.run('list', read, () => assert.fail())]
  await h.advance(CLAIM_WINDOW_MS + 10); await Promise.all(runs)
  assert.equal(reads, 3)
  const b = new TabShare('mikka-live-read:owner:workspace', h.open, h.clock)
  const keys = [a.run('list', read, () => assert.fail()), b.run('chat', read, () => assert.fail())]
  await h.advance(CLAIM_WINDOW_MS + 10); await Promise.all(keys)
  assert.equal(reads, 5, 'different keys in one scope read separately')

  // A leader that never answers (its tab closed mid-read): the follower reads after the timeout.
  let release!: () => void
  const stuck = a.run('slow', () => new Promise(resolve => { release = () => resolve({}) }), () => {})
  await h.advance(CLAIM_WINDOW_MS + 10)
  a.close()
  let followerRead = false
  const follower = b.run('slow', async () => { followerRead = true; return {} }, () => assert.fail('nothing to adopt'))
  await h.advance(RESULT_TIMEOUT_MS + 10)
  await follower
  assert.equal(followerRead, true)
  release(); await stuck
})

test('a failed leader read sends no data: the followers read themselves', async () => {
  const h = hub(), name = 'mikka-live-read:owner:workspace'
  const [leader, follower] = [new TabShare(name, h.open, h.clock), new TabShare(name, h.open, h.clock)]
  let followerReads = 0
  const first = leader.run('list', async () => { throw new Error('unavailable') }, () => {})
  const failed = assert.rejects(first)
  await h.settle()
  const second = follower.run('list', async () => { followerReads++; return { ok: true } }, () => assert.fail('nothing to adopt'))
  await h.advance(CLAIM_WINDOW_MS + 10)
  await failed
  await second
  assert.equal(followerReads, 1)
})

test('the default chat alias cannot share across authenticated workspace, build or role namespaces', async () => {
  const h = hub()
  const base = { userId: 'owner', workspaceId: 'team-a', build: 'build-a', role: 'admin' }
  const scopes = [base, { ...base, workspaceId: 'team-b' }, { ...base, build: 'build-b' }, { ...base, role: 'member' }]
  const caches = scopes.map(scope => new PersistentReadCache(scope))
  let reads = 0
  const tabs = caches.map(cache => {
    const namespace = readCacheShareNamespace(cache, base.userId)
    assert.ok(namespace)
    return new TabShare(tabShareChannelName(namespace, 'same-personal-home'), h.open, h.clock)
  })
  const pending = tabs.map((tab, index) => tab.run('coordinator-chat', async () => { reads++; return { botId: `bot-${index}` } }, () => assert.fail('another namespace must not populate this chat')))
  await h.advance(CLAIM_WINDOW_MS + 10)
  assert.deepEqual(await Promise.all(pending), scopes.map((_, index) => ({ botId: `bot-${index}` })))
  assert.equal(reads, scopes.length)
  assert.equal(readCacheShareNamespace(new Map(), base.userId), null, 'memory-only/unapproved scopes never join')
  assert.equal(readCacheShareNamespace(caches[0], 'other-owner'), null)
  caches[0].invalidate(false)
  assert.equal(readCacheShareNamespace(caches[0], base.userId), null, 'a retired namespace cannot adopt late data')
  for (const tab of tabs) tab.close()
})
