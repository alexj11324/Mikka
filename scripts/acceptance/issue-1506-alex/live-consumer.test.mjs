import assert from 'node:assert/strict'
import test from 'node:test'
import { copyFileSync, mkdtempSync, mkdirSync, rmSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { pathToFileURL } from 'node:url'
import { prepareLiveSource, LIVE_SOURCE_COMMIT, LIVE_SOURCE_CONTENT_BASE, LIVE_SOURCE_HASHES } from './live-source.mjs'
import { openLiveConsumers, summarizeLiveEvidence, validateLiveScope } from './live-consumer.mjs'
import { runLiveCacheTurns } from './live-cache-turns.mjs'
import { ALEX_OWNER_ID } from '../issue-1506-readonly/alex-session.mjs'
import { fixtureReceipt, WORKSPACE_ID, BOT_IDS, SHA, PRIVATE } from './fixture-support.mjs'

globalThis.fetch = () => { throw new Error('network_forbidden') }
const sourceRoot = process.env.MIKKA_LIVE_SOURCE_ROOT
const sourceBase = process.env.MIKKA_LIVE_TEST_SOURCE_BASE ?? LIVE_SOURCE_COMMIT ?? LIVE_SOURCE_CONTENT_BASE
const prepare = root => prepareLiveSource(root, { sourceBase })
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

test('an unset or malformed published source pin fails before any checkout or runtime work', () => {
  for (const value of [null, '', 'main', 'aaecbdba', 'A'.repeat(40)]) {
    assert.throws(() => prepareLiveSource('/no-such-live-source', { sourceBase: value }), /live_source_commit_unset/)
  }
  if (LIVE_SOURCE_COMMIT === null) assert.throws(() => prepareLiveSource('/no-such-live-source'), /live_source_commit_unset/)
})

test('a missing published source pin stops cache-live before its model driver or observer starts', async () => {
  let calls = 0
  await assert.rejects(runLiveCacheTurns({ fixtureReceipt: fixtureReceipt(), checkpoint: false,
    env: { MIKKA_FIXTURE_KIND: 'haiku', MIKKA_ACCEPTANCE_SHA: SHA, MIKKA_LIVE_SOURCE_ROOT: '/no-such-live-source' },
    sourceFactory: root => prepareLiveSource(root, { sourceBase: null }),
    cacheDriver: async () => { calls++; assert.fail('model driver must not start') },
    observer: async () => { calls++; assert.fail('observer must not start') },
  }), /live_source_commit_unset/)
  assert.equal(calls, 0)
})

test('an unrelated commit cannot label otherwise matching source bytes', { skip: !sourceRoot }, () => {
  assert.throws(() => prepareLiveSource(sourceRoot, { sourceBase: '0'.repeat(40) }), /live_source_commit_mismatch/)
})

for (const path of ['lib/live/presence.ts', 'hooks/use-live-key.tsx', 'components/coordinator/coordinator-chat.tsx', 'lib/swr/read-observer.ts', 'components/swr-defaults.tsx']) {
  test(`source pin rejects drift in ${path} before creating a worker`, { skip: !sourceRoot }, () => {
    const directory = mkdtempSync(join(tmpdir(), 'mikka-live-pin-test-'))
    try {
      for (const file of Object.keys(LIVE_SOURCE_HASHES)) {
        mkdirSync(dirname(join(directory, file)), { recursive: true })
        copyFileSync(join(sourceRoot, file), join(directory, file))
      }
      appendFileSync(join(directory, path), '\n// offline source-drift fixture\n')
      assert.throws(() => prepare(directory), /live_source_mismatch/)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
}

test('exact reviewed sources compile and import actual exported classes without external dependencies', { skip: !sourceRoot }, async () => {
  const source = prepare(sourceRoot)
  try {
    const channel = await import(pathToFileURL(source.directory + '/lib/live/channel.mjs').href)
    const shares = await import(pathToFileURL(source.directory + '/lib/live/tab-share.mjs').href)
    const presence = await import(pathToFileURL(source.directory + '/lib/live/presence.mjs').href)
    assert.equal(typeof channel.LiveChannel, 'function'); assert.equal(typeof shares.TabShare, 'function')
    assert.equal(shares.CLAIM_WINDOW_MS, 30)
    assert.equal(Object.keys(source.hashes).length, 12)
    assert.equal(source.sourceCommit, sourceBase)
    assert.deepEqual(presence.presenceReply({ type: 'presence_ready', version: 1 }), { type: 'presence_ready', version: 1 })
  } finally { source.close() }
  assert.throws(() => prepare('/no-such-live-source'), /live_source_missing/)
})

for (const withDelay of [false, true]) test(`three separate actual-core workers share one revision read${withDelay ? ' and reject a held older result' : ''}`, { skip: !sourceRoot, timeout: 15_000 }, async () => {
  const source = prepare(sourceRoot), workers = []
  let currentRevision = 1, latestReport, revision3Sent = false, observation, unsubscribe
  const completionRevisions = [], completionErrors = []
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
    unsubscribe = observation.subscribe?.(() => completionRevisions.push(observation.revision), error => completionErrors.push(error.message))
    observation.begin(performance.now()); push(2)
    assert.equal(await finished, true, JSON.stringify(latestReport))
    assert.equal(typeof observation.subscribe, 'function', 'cache completion needs the same real workers revision listener')
    assert.equal(observation.revision, withDelay ? 3 : 2)
    assert.deepEqual(completionRevisions, withDelay ? [2, 3] : [2], 'three duplicate tab pushes wake completion once per revision')
    assert.deepEqual(completionErrors, [])
    unsubscribe(); unsubscribe = null
    assert.equal(await observation.close(), true, JSON.stringify(observation.report))
    const report = observation.report
    assert.equal(report.status, 'live_evidence_captured'); assert.equal(report.tabs.length, 3)
    assert.equal(report.tabs.every(row => row.socketCount === 1 && row.closed), true)
    assert.equal(report.network.filter(row => row.method === 'ticket').length, 3)
    assert.equal(report.network.filter(row => row.method === 'chat' && row.stage === 'turns').length, withDelay ? 2 : 1)
    assert.equal(report.evidence.eventToReadObserved, true); assert.equal(report.evidence.sharingObserved, true)
    assert.equal(report.evidence.allTabsCoverLatest, true)
    if (withDelay) {
      assert.equal(report.evidence.staleResultProtection, 'observed')
      assert.equal(revision3Sent, true)
      assert.equal(report.adaptation.delay?.resultRevision, 2)
      assert.equal(report.adaptation.delay?.newRevision, 3)
      assert.equal(report.adaptation.delay?.releaseReason, 'new_real_revision_observed')
    }
    assert.equal(JSON.stringify(report).includes(PRIVATE), false)
  } finally {
    clearTimeout(watchdog)
    unsubscribe?.()
    await observation?.close()
    await Promise.allSettled(workers.map(worker => worker.terminate()))
    source.close()
  }
})

test('the same actual sockets latch an early revision, deduplicate all tabs and propagate a genuine socket close', { skip: !sourceRoot, timeout: 10_000 }, async () => {
  const source = prepare(sourceRoot), workers = [], changes = [], errors = []
  let currentRevision = 1, observation, unsubscribe, early, caughtUp, failed
  const earlyPush = new Promise(resolve => { early = resolve })
  const covered = new Promise(resolve => { caughtUp = resolve })
  const errorObserved = new Promise(resolve => { failed = resolve })
  const watchdog = setTimeout(() => { early(false); caughtUp(false); failed(false) }, 8_000)
  class OfflineWorker extends Worker {
    constructor(_url, options) { super(new URL('./live-worker-offline.mjs', import.meta.url), options); workers.push(this) }
  }
  const push = revision => {
    currentRevision = Math.max(currentRevision, revision)
    for (const worker of workers) worker.postMessage({ type: 'fixture-push', botId: BOT_IDS[0], revision })
  }
  const session = { identity: { userId: ALEX_OWNER_ID }, version: { build: SHA }, requests: [],
    async request(path, input = {}) {
      if (path === '/api/live/ticket?workspace=' + WORKSPACE_ID) return Response.json({
        url: 'wss://offline.invalid/v1/live/' + 'a'.repeat(64) + '/socket', protocol: PRIVATE, expiresAt: Date.now() + 60_000 })
      assert.equal(path, '/api/rpc'); assert.equal(input.body.action, 'coordinator.syncCoordinatorChat')
      return Response.json({ ok: true, result: { chat: chatAt(currentRevision) } })
    } }
  try {
    observation = await openLiveConsumers(session, chatAt(1), { fixture, source, expectedSha: SHA,
      WorkerClass: OfflineWorker, readyTimeoutMs: 3_000, coverageTimeoutMs: 3_000,
      checkpoint(report) {
        if (report.events.filter(row => row.type === 'push' && row.revision === 2).length === 3) early(true)
        if (report.tabs.length === 3 && report.tabs.every(row => row.latestRevision === 3 && row.activeRefreshes === 0)) caughtUp(true)
      } })
    push(2); assert.equal(await earlyPush, true); assert.equal(observation.revision, 2)
    unsubscribe = observation.subscribe(() => changes.push(observation.revision), error => { errors.push(error.message); failed(true) })
    observation.begin(performance.now()); push(2); push(1); push(3)
    assert.equal(await covered, true); assert.deepEqual(changes, [3]); assert.equal(observation.revision, 3)
    workers[0].postMessage({ type: 'fixture-disconnect' })
    assert.equal(await errorObserved, true); assert.deepEqual(errors, ['live_worker_failed'])
    assert.throws(() => observation.subscribe(() => {}, () => {}), /live_worker_failed/)
    assert.equal(await observation.close(), false)
    assert.equal(observation.summary.unexpectedDisconnect, true); assert.equal(observation.summary.closed, true)
    assert.equal(observation.report.tabs.every(row => row.socketCount === 1 && row.closed), true)
    assert.equal(observation.report.network.filter(row => row.method === 'ticket').length, 3)
    assert.equal(JSON.stringify(observation.report).includes(PRIVATE), false)
  } finally {
    clearTimeout(watchdog); unsubscribe?.(); await observation?.close()
    await Promise.allSettled(workers.map(worker => worker.terminate())); source.close()
  }
})


test('only exact pinned runtime dependencies can cross directories', async () => {
  const { resolveLiveImport } = await import('./live-source.mjs')
  assert.equal(resolveLiveImport('lib/live/channel.ts', '../swr/read-observer'), '../swr/read-observer.mjs')
  assert.equal(resolveLiveImport('lib/live/channel.ts', './events'), './events.mjs')
  for (const path of ['node:fs', 'react', '../../outside', '../swr/not-pinned', '../swr/read-observer?x=1', '../swr/../swr/defaults.tsx', '..\\swr\\read-observer']) {
    assert.throws(() => resolveLiveImport('lib/live/channel.ts', path), /live_source_import_invalid/)
  }
})

for (const order of ['after', 'before', 'later-revision']) test(
  'same-realm observed read respects the real push boundary: ' + order,
  { skip: !sourceRoot, timeout: 8_000 }, async () => {
    const source = prepare(sourceRoot), records = []
    let worker, phase = 'initial', held, released = false, refreshObserved = false, lastState
    let ready, readStarted, finished, closed
    const readyPromise = new Promise(resolve => { ready = resolve })
    const readStartedPromise = new Promise(resolve => { readStarted = resolve })
    const finishPromise = new Promise(resolve => { finished = resolve })
    const closedPromise = new Promise(resolve => { closed = resolve })
    const watchdog = setTimeout(() => { ready(false); readStarted(false); finished(false); closed(false) }, 6_000)
    const target = order === 'later-revision' ? 3 : 2
    const reply = (message, value) => worker.postMessage({ type: 'response', id: message.id, ok: true, value })
    const push = revision => worker.postMessage({ type: 'fixture-push', botId: BOT_IDS[0], revision })
    try {
      worker = new Worker(new URL('./live-worker-offline.mjs', import.meta.url), { env: {}, workerData: {
        sourceDirectory: source.directory, tabId: 1, ownerId: ALEX_OWNER_ID,
        workspaceId: WORKSPACE_ID, transportScope: WORKSPACE_ID, build: SHA,
        botId: BOT_IDS[0], initialChat: chatAt(1),
      } })
      worker.on('error', () => { ready(false); readStarted(false); finished(false) })
      worker.on('message', message => {
        if (message.type === 'request') {
          if (message.method === 'ticket') {
            reply(message, { url: 'wss://offline.invalid/v1/live/' + 'a'.repeat(64) + '/socket',
              protocol: PRIVATE, expiresAt: Date.now() + 60_000 })
          } else {
            assert.equal(message.method, 'chat')
            if (phase === 'initial') reply(message, chatAt(1))
            else {
              records.push({ id: message.id, requiredRevision: message.requiredRevision })
              if (!held) { held = message; readStarted(true) }
              else reply(message, chatAt(target))
            }
          }
        } else if (message.type === 'ready') ready(true)
        else if (message.type === 'refresh' && phase === 'turns' && message.requiredRevision >= 2 && !released) {
          refreshObserved = true
          assert.ok(held, 'the independent actual read was already in flight at this flush')
          released = true
          if (order === 'later-revision') push(3)
          reply(held, chatAt(2))
        } else if (message.type === 'state') {
          lastState = message
          if (phase === 'turns' && released && refreshObserved && message.latestRevision >= target && message.activeRefreshes === 0) finished(true)
        } else if (message.type === 'fatal') finished(false)
        else if (message.type === 'closed') closed(true)
      })
      assert.equal(await readyPromise, true)
      phase = 'turns'
      if (order === 'before') {
        worker.postMessage({ type: 'fixture-read', requiredRevision: 0 })
        assert.equal(await readStartedPromise, true)
        push(2)
      } else {
        push(2)
        worker.postMessage({ type: 'fixture-read', requiredRevision: 0 })
        assert.equal(await readStartedPromise, true)
      }
      assert.equal(await finishPromise, true, JSON.stringify({ records, lastState }))
      assert.equal(lastState.latestRevision, target)
      assert.equal(records.length, order === 'after' ? 1 : 2,
        'only an actual read beginning after this push can satisfy it; a later push still needs a new read')
      worker.postMessage({ type: 'close' })
      assert.equal(await closedPromise, true)
    } finally {
      clearTimeout(watchdog)
      await worker?.terminate()
      source.close()
    }
  })
