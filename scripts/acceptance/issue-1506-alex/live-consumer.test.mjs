import assert from 'node:assert/strict'
import test from 'node:test'
import { Worker } from 'node:worker_threads'
import { pathToFileURL } from 'node:url'
import { prepareLiveSource } from './live-source.mjs'
import { openLiveConsumers, summarizeLiveEvidence, validateLiveScope } from './live-consumer.mjs'
import { ALEX_OWNER_ID } from '../issue-1506-readonly/alex-session.mjs'
import { fixtureReceipt, WORKSPACE_ID, BOT_IDS, SHA, PRIVATE } from './fixture-support.mjs'

globalThis.fetch = () => { throw new Error('network_forbidden') }
const sourceRoot = process.env.MIKKA_LIVE_SOURCE_ROOT
const entity = 'bot_chat:' + BOT_IDS[0]
const chatAt = revision => ({ botId: BOT_IDS[0], enabled: true, working: false, items: [{ text: PRIVATE }],
  live: { ownerId: ALEX_OWNER_ID, workspaceId: WORKSPACE_ID, revisions: { [entity]: revision } } })
const fixture = { botId: BOT_IDS[0], workspace: fixtureReceipt().workspace }

test('live scope refuses another owner, another Bot and a personal workspace before a worker is created', () => {
  const session = { identity: { userId: ALEX_OWNER_ID }, version: { build: SHA } }
  assert.throws(() => validateLiveScope({ ...session, identity: { userId: 'wrong' } }, chatAt(1), fixture, SHA), /live_consumer_scope_invalid/)
  assert.throws(() => validateLiveScope(session, { ...chatAt(1), botId: BOT_IDS[1] }, fixture, SHA), /live_consumer_scope_invalid/)
  assert.throws(() => validateLiveScope(session, chatAt(1), { ...fixture, workspace: { ...fixture.workspace, kind: 'personal' } }, SHA), /live_consumer_scope_invalid/)
})

test('initial catch-up reads and unproven old adoption cannot count as production live coverage', () => {
  const evidence = summarizeLiveEvidence({ tabCount: 3, tabs: [], events: [
    { type: 'push', stage: 'turns', atMs: 10, revision: 2 },
    { type: 'adopt', stage: 'turns', requiredRevision: 2, resultRevision: 1 },
  ], network: [{ method: 'chat', stage: 'initial', requiredRevision: 2, resultRevision: 2, startedAtMs: 11 }] })
  assert.equal(evidence.eventToReadObserved, false); assert.equal(evidence.sharingObserved, false)
  assert.equal(evidence.staleResultProtection, 'not_covered'); assert.equal(evidence.allTabsCoverLatest, false)
})

test('exact reviewed sources compile and import actual exported classes without external dependencies', { skip: !sourceRoot }, async () => {
  const source = prepareLiveSource(sourceRoot)
  try {
    const channel = await import(pathToFileURL(source.directory + '/lib/live/channel.mjs').href)
    const shares = await import(pathToFileURL(source.directory + '/lib/live/tab-share.mjs').href)
    assert.equal(typeof channel.LiveChannel, 'function'); assert.equal(typeof shares.TabShare, 'function')
    assert.equal(shares.CLAIM_WINDOW_MS, 30)
  } finally { source.close() }
  assert.throws(() => prepareLiveSource('/no-such-live-source'), /live_source_missing/)
})

for (const withDelay of [false, true]) test(`three separate actual-core workers share one revision read${withDelay ? ' and reject a held older result' : ''}`, { skip: !sourceRoot, timeout: 15_000 }, async () => {
  const source = prepareLiveSource(sourceRoot), workers = []
  let currentRevision = 1, latestReport, revision3Sent = false, observation
  let finish
  const finished = new Promise(resolve => { finish = resolve })
  const watchdog = setTimeout(() => finish(false), 10_000)
  class OfflineWorker extends Worker {
    constructor(_url, options) {
      assert.deepEqual(options.env, {}, 'runner credentials never enter any worker environment')
      super(new URL('./live-worker-offline.mjs', import.meta.url), options)
      workers.push(this)
    }
  }
  const push = revision => {
    currentRevision = revision
    for (const worker of workers) worker.postMessage({ type: 'fixture-push', botId: BOT_IDS[0], revision })
  }
  const session = { identity: { userId: ALEX_OWNER_ID }, version: { build: SHA }, requests: [],
    async request(path, input = {}) {
      if (path === '/api/live/ticket?workspace=' + WORKSPACE_ID) return Response.json({
        url: 'wss://offline.invalid/v1/live/' + 'a'.repeat(64) + '/socket', protocol: PRIVATE, expiresAt: Date.now() + 60_000 })
      assert.equal(path, '/api/rpc'); assert.equal(input.body.action, 'coordinator.syncCoordinatorChat')
      assert.deepEqual(input.body.args, [BOT_IDS[0]])
      return Response.json({ ok: true, result: { chat: chatAt(currentRevision) } })
    } }
  try {
    observation = await openLiveConsumers(session, chatAt(1), { fixture, source, expectedSha: SHA,
      WorkerClass: OfflineWorker, readyTimeoutMs: 4_000, coverageTimeoutMs: 4_000, delayOneReturnedResult: withDelay,
      checkpoint(report) {
        latestReport = report
        const turnReads = report.network.filter(row => row.stage === 'turns' && row.method === 'chat')
        if (withDelay && !revision3Sent && turnReads.some(row => row.returnedAtMs && !row.deliveredAtMs)) {
          revision3Sent = true; queueMicrotask(() => push(3))
        }
        const target = withDelay ? 3 : 2
        if (turnReads.length && report.tabs.length === 3 && report.tabs.every(row => row.latestRevision >= target && row.activeRefreshes === 0)) finish(true)
      } })
    observation.begin(performance.now()); push(2)
    assert.equal(await finished, true, JSON.stringify(latestReport))
    assert.equal(await observation.close(), true, JSON.stringify(observation.report))
    const report = observation.report
    assert.equal(report.status, 'live_evidence_captured'); assert.equal(report.tabs.length, 3)
    assert.equal(report.tabs.every(row => row.socketCount === 1 && row.closed), true)
    assert.equal(report.network.filter(row => row.method === 'ticket').length, 3)
    assert.equal(report.network.filter(row => row.method === 'chat' && row.stage === 'turns').length, withDelay ? 2 : 1)
    assert.equal(report.evidence.eventToReadObserved, true); assert.equal(report.evidence.sharingObserved, true)
    assert.equal(report.evidence.allTabsCoverLatest, true)
    if (withDelay) assert.equal(report.evidence.staleResultProtection, 'observed')
    assert.equal(JSON.stringify(report).includes(PRIVATE), false)
  } finally {
    clearTimeout(watchdog)
    await observation?.close()
    await Promise.allSettled(workers.map(worker => worker.terminate()))
    source.close()
  }
})
