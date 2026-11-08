import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { candidateIdentity, cleanupOwnedRuntime, guardReceipt, observeHmr, validateJournal, validPorts } from './workspace-ingress-acceptance.mjs'

const source = 'a'.repeat(40), ops = 'b'.repeat(40), worker = 'c'.repeat(40), digest = 'd'.repeat(64)
const execution = { runId: '1234', runAttempt: '1' }
const fixture = '11111111-2222-3333-4444-555555555555'
const guard = { ok: true, version: 1, sourceSha256: digest, bootId: fixture, installedTicks: 200,
  providerPorts: [49983], preparedBeforeWorker: true, rulesVerified: { ipv4: true, ipv6: true },
  workerPid: 301, workerStartTicks: 205, workerStartedAfterGuard: true }
const journal = { version: 1, purpose: 'mikka-workspace-ingress-acceptance', sourceCommit: source, opsSource: ops,
  workerSha: worker, fixtureId: fixture, templateId: 'owned-template', kind: 'claude', ...execution,
  creationRequested: true, sandboxId: 'owned-sandbox' }

test('a marker alone cannot establish prelistener protection or a valid resumed worker', () => {
  assert.deepEqual(guardReceipt(guard, digest), guard)
  for (const value of [
    { ...guard, sourceSha256: 'e'.repeat(64) }, { ...guard, preparedBeforeWorker: false },
    { ...guard, workerStartTicks: 199 }, { ...guard, workerStartedAfterGuard: false },
    { ...guard, rulesVerified: { ipv4: true, ipv6: false } },
    { ...guard, providerPorts: [49983, 8080] }, { ...guard, providerPorts: [49983, 49983] },
    { ...guard, bootId: '' },
  ]) assert.throws(() => guardReceipt(value, digest), /workspace_acceptance_guard/)
  assert.deepEqual(guardReceipt(guard, digest, guard), guard)
  assert.throws(() => guardReceipt({ ...guard, workerPid: 302 }, digest, guard), /workspace_acceptance_resume/)
  assert.throws(() => guardReceipt({ ...guard, bootId: '66666666-2222-3333-4444-555555555555' }, digest, guard), /workspace_acceptance_resume/)
})

test('raw fixtures cannot substitute duplicate or provider-reserved listeners', () => {
  const ports = { userLoopback4: 3101, userPublic4: 3102, userLoopback6: 3103, rootMarked: 3104 }
  assert.deepEqual(validPorts(ports), ports)
  assert.throws(() => validPorts({ ...ports, rootMarked: 3101 }), /workspace_acceptance_ports/)
  assert.throws(() => validPorts({ ...ports, rootMarked: 49983 }), /workspace_acceptance_ports/)
  const { userLoopback6: omitted, ...withoutV6 } = ports
  assert.ok(omitted)
  assert.throws(() => validPorts(withoutV6), /workspace_acceptance_ports/)
})

test('candidate acceptance requires both exact private templates and positive conservation', () => {
  const row = kind => ({ baseTemplate: kind, templateId: `owned-${kind}`, buildId: `build-${kind}`,
    preinstalled: true, privateVerified: true, conservation: { before: { entries: 123, sha256: digest }, after: { entries: 123, sha256: digest } } })
  const report = { sourceCommit: source, workerSha: worker, templates: { claude: row('claude'), codex: row('codex') } }
  assert.equal(candidateIdentity(report, source), report)
  const publicCandidate = structuredClone(report); publicCandidate.templates.codex.privateVerified = false
  assert.throws(() => candidateIdentity(publicCandidate, source), /workspace_acceptance_candidate/)
  const changed = structuredClone(report); changed.templates.claude.conservation.after.entries--
  assert.throws(() => candidateIdentity(changed, source), /workspace_acceptance_candidate/)
  assert.throws(() => candidateIdentity({ ...report, templates: { claude: row('claude') } }, source), /workspace_acceptance_candidate/)
})

function provider({ metadataChanged = false, templateChanged = false, absentAfterKill = true, lostCreate = false, rows = 1, next = false } = {}) {
  class Missing extends Error {}
  let killed = false
  const calls = []
  const metadata = { application: journal.purpose, issue: '1724', sourceCommit: source, workerSha: worker,
    fixtureId: fixture, opsSource: ops, ...execution, kind: 'claude' }
  const sdk = { SandboxNotFoundError: Missing, Sandbox: {
    list(options) {
      calls.push(['list', options.query])
      return { hasNext: next, nextItems: async () => Array.from({ length: rows }, () => ({ sandboxId: 'owned-sandbox' })) }
    },
    async getInfo(id) {
      calls.push(['get', id])
      if (killed && absentAfterKill) throw new Missing()
      return { sandboxId: id, templateId: templateChanged ? 'foreign-template' : 'owned-template',
        metadata: metadataChanged ? { ...metadata, fixtureId: 'foreign' } : metadata }
    },
    async kill(id) { calls.push(['kill', id]); killed = true; return true },
    async connect() { assert.fail('cleanup must never resume a VM') },
  } }
  return { sdk, calls, record: lostCreate ? { ...journal, sandboxId: null } : journal }
}

test('cleanup rejects another run/attempt and inconsistent journals before provider access', async () => {
  const state = provider()
  for (const value of [{ ...journal, runId: '1235' }, { ...journal, runAttempt: '2' },
    { ...journal, sourceCommit: 'f'.repeat(40) }, { ...journal, creationRequested: false }]) {
    assert.throws(() => validateJournal(value, source, ops, execution), /workspace_acceptance_journal/)
    await assert.rejects(cleanupOwnedRuntime(value, source, ops, state.sdk, {}, execution), /workspace_acceptance_journal/)
  }
  assert.equal(state.calls.length, 0)
})

test('cleanup needs exact resource scope and a fresh provider absence after kill', async () => {
  for (const options of [{ metadataChanged: true }, { templateChanged: true }]) {
    const state = provider(options)
    await assert.rejects(cleanupOwnedRuntime(state.record, source, ops, state.sdk, {}, execution), /workspace_acceptance_cleanup/)
    assert.equal(state.calls.some(([name]) => name === 'kill'), false)
  }
  const good = provider()
  const result = await cleanupOwnedRuntime(good.record, source, ops, good.sdk, {}, execution)
  assert.equal(result.stopped, true); assert.equal(result.absent, true)
  assert.deepEqual(good.calls.map(([name]) => name), ['get', 'kill', 'get'])
  const visible = provider({ absentAfterKill: false })
  assert.equal((await cleanupOwnedRuntime(visible.record, source, ops, visible.sdk, {}, execution)).stopped, false)
})

test('lost-create reconciliation includes paused VMs, refuses ambiguity and never treats missing proof as cleanup', async () => {
  const good = provider({ lostCreate: true })
  assert.equal((await cleanupOwnedRuntime(good.record, source, ops, good.sdk, {}, execution)).stopped, true)
  assert.deepEqual(good.calls[0][1].state, ['running', 'paused'])
  assert.equal(good.calls[0][1].metadata.fixtureId, fixture)
  for (const options of [{ rows: 2 }, { next: true }]) {
    const state = provider({ ...options, lostCreate: true })
    await assert.rejects(cleanupOwnedRuntime(state.record, source, ops, state.sdk, {}, execution), /workspace_acceptance_cleanup/)
    assert.equal(state.calls.some(([name]) => name === 'kill'), false)
  }
  const missing = provider({ lostCreate: true, rows: 0 })
  const result = await cleanupOwnedRuntime(missing.record, source, ops, missing.sdk, {}, execution)
  assert.deepEqual(result, { stopped: false, absent: false, outcome: 'creation_unconfirmed' })
})

class Socket extends EventEmitter {
  static OPEN = 1
  static last
  readyState = Socket.OPEN
  constructor() { super(); Socket.last = this }
  send() {}
  terminate() { this.readyState = 3; this.emit('close', 1000) }
}

test('a WS that closed or produced invalid traffic before revoke cannot satisfy the revoke receipt', async () => {
  for (const fail of [socket => socket.terminate(), socket => socket.emit('error', new Error('transport')),
    socket => socket.emit('message', Buffer.from('not JSON'), false)]) {
    const observer = observeHmr('wss://owned.example.invalid', [], {}, Socket)
    const socket = Socket.last
    socket.emit('open'); socket.emit('message', Buffer.from('{"type":"connected"}'), false)
    await observer.ready()
    fail(socket)
    assert.throws(() => observer.expectRevoke(), /workspace_acceptance_revoke/)
    observer.close()
  }
  const observer = observeHmr('wss://owned.example.invalid', [], {}, Socket)
  const socket = Socket.last
  socket.emit('open'); socket.emit('message', Buffer.from('{"type":"connected"}'), false)
  await observer.ready(); observer.expectRevoke(); socket.terminate()
  assert.equal((await observer.revoked()).closed, true)
})
