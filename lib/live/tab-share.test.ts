import assert from 'node:assert/strict'
import test from 'node:test'
import { CLAIM_WINDOW_MS, RESULT_TIMEOUT_MS, TabShare, tabShareChannelName, type TabChannel, type TabShareClock } from './tab-share'
import { PersistentReadCache, readCacheShareNamespace } from '../swr/persistent-cache'

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
