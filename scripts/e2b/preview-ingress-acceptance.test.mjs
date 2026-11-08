import assert from 'node:assert/strict'
import test from 'node:test'
import { cleanupOwnedProbe, probeMarkedIngress } from './preview-ingress-acceptance.mjs'

const SOURCE = 'a'.repeat(40)
const MARKER = 'mikka-synthetic-socket-mark-probe-v1'

function fixture({ unavailable = false, reusedPortExposed = false } = {}) {
  const calls = []
  let stage = 'before', send, finished = false, resolveCompletion
  const completion = new Promise(accept => { resolveCompletion = accept })
  const sandbox = {
    sandboxId: 'sandbox-fixture', getInfo: async () => ({ templateId: 'template-fixture' }),
    getHost: port => `${port}.example.test`, files: { write: async () => {} },
    commands: { run: async (command, options) => {
      if (!options.background) return { stdout: '' }
      assert.equal(options.user, 'root')
      assert.equal(options.stdin, true)
      send = value => options.onStdout(JSON.stringify(value) + '\n')
      const diagnostic = { capabilities: { netAdmin: !unavailable, netRaw: !unavailable }, tools: Object.fromEntries(
        ['iptables', 'ip6tables'].map(name => [name, { present: !unavailable, source: 'private', version: unavailable ? null : '1.8.11' }])) }
      if (unavailable) {
        send({ phase: 'failed', code: 'socket_mark_unavailable', privateText: 'must-never-leave-fixture', ...diagnostic })
        send({ phase: 'finished', rulesRemoved: true })
        finished = true; resolveCompletion()
      } else send({ phase: 'ready', ...diagnostic, ports: { rootMarked: 41001, userLoopback4: 41002, userPublic4: 41003 },
        user: { canSetSocketMark: false, sudoNonInteractiveRoot: true }, privateText: 'must-never-leave-fixture' })
      return {
        wait: () => completion,
        sendStdin: async data => {
          if (finished) throw new Error('Synthetic closed process')
          calls.push(data)
          if (data === 'protect\n') { stage = 'after'; send({ phase: 'protected', rules: { ipv4: true, ipv6: true } }) }
          else if (data === 'replace\n') { stage = 'replacement'; send({ phase: 'replaced', port: 41001 }) }
          else if (data === 'finish\n') { send({ phase: 'finished', rulesRemoved: true }); finished = true; resolveCompletion() }
          else assert.fail('Unknown stdin operation')
        },
      }
    } },
  }
  const fetchImpl = async (url, options) => {
    assert.equal(options.redirect, 'manual')
    assert.equal(options.headers.connection, 'close')
    const permitted = stage === 'before' || stage === 'after' && new URL(url).hostname.startsWith('41001.')
      || stage === 'replacement' && reusedPortExposed
    return new Response(permitted ? MARKER : 'Denied', { status: permitted ? 200 : 403 })
  }
  return { sandbox, fetchImpl, calls }
}

test('missing root/kernel capabilities preserve closed diagnostics and never start public samples', async () => {
  const value = fixture({ unavailable: true })
  await assert.rejects(probeMarkedIngress(value.sandbox, SOURCE, async () => assert.fail('No network sample')), error => {
    assert.equal(error.message, 'socket_mark_unavailable')
    assert.deepEqual(error.evidence.capabilities, { netAdmin: false, netRaw: false })
    assert.equal(error.evidence.tools.ip6tables.present, false)
    assert.equal(error.evidence.passed, false)
    assert.ok(!JSON.stringify(error.evidence).includes('must-never-leave-fixture'))
    return true
  })
})

test('source scope is checked before SDK commands or fixture creation', async () => {
  await assert.rejects(probeMarkedIngress({}, 'not-an-immutable-source'), /source_invalid/)
})

test('socket mark proof requires positive controls, raw port refusal, same-port replacement refusal and cleanup', async () => {
  const value = fixture()
  const report = await probeMarkedIngress(value.sandbox, SOURCE, value.fetchImpl)
  assert.equal(report.passed, true)
  assert.equal(report.user.sudoNonInteractiveRoot, true, 'an available sudo boundary is disclosed, never hidden')
  assert.deepEqual(value.calls, ['protect\n', 'replace\n', 'finish\n'])
  assert.equal(report.before.userLoopback4.markerMatched, true)
  assert.equal(report.after.userLoopback4.markerMatched, false)
  assert.equal(report.after.rootMarked.markerMatched, true)
  assert.equal(report.replacement.markerMatched, false)
  assert.equal(report.rulesRemoved, true)
  assert.ok(!JSON.stringify(report).includes('must-never-leave-fixture'))
})

test('a user listener inheriting the old root port is a failed proof even when every other check passes', async () => {
  const value = fixture({ reusedPortExposed: true })
  const report = await probeMarkedIngress(value.sandbox, SOURCE, value.fetchImpl)
  assert.equal(report.passed, false)
  assert.equal(report.replacement.markerMatched, true)
  assert.equal(report.rulesRemoved, true)
})

const journal = () => ({ version: 1, purpose: 'mikka-preview-ingress-spike', sourceCommit: SOURCE,
  fixtureId: '99999999-0000-4000-8000-000000000001', requestedTemplate: 'claude', sandboxId: 'owned-sandbox' })
const metadata = value => ({ application: value.purpose, issue: '1724', sourceCommit: value.sourceCommit,
  fixtureId: value.fixtureId, requestedTemplate: value.requestedTemplate })

test('cleanup checks the recorded source, unique fixture, template and exact VM before deletion', async () => {
  const value = journal(), deleted = []
  let info = { sandboxId: value.sandboxId, metadata: metadata(value) }
  const sdk = { Sandbox: { getInfo: async () => info, kill: async id => { deleted.push(id); return true } } }
  await assert.rejects(cleanupOwnedProbe(value, 'b'.repeat(40), sdk), /cleanup_scope/)
  for (const changed of [{ sandboxId: 'foreign' }, { metadata: { ...info.metadata, fixtureId: 'foreign' } },
    { metadata: { ...info.metadata, sourceCommit: 'b'.repeat(40) } }, { metadata: { ...info.metadata, requestedTemplate: 'codex' } }]) {
    info = { sandboxId: value.sandboxId, metadata: metadata(value), ...changed }
    await assert.rejects(cleanupOwnedProbe(value, SOURCE, sdk), /cleanup_scope/)
  }
  assert.deepEqual(deleted, [])
  info = { sandboxId: value.sandboxId, metadata: metadata(value) }
  assert.deepEqual(await cleanupOwnedProbe(value, SOURCE, sdk),
    { stopped: true, outcome: 'provider_kill_acknowledged', scopeVerified: true })
  assert.deepEqual(deleted, [value.sandboxId])
})

test('a lost create reply reconciles only one exact metadata match and never sweeps ambiguous results', async () => {
  const value = { ...journal(), sandboxId: null }, deleted = []
  let found = [], more = false
  const sdk = { Sandbox: {
    list: options => {
      assert.deepEqual(options.query, { metadata: metadata(value) })
      assert.equal(options.limit, 2)
      return { nextItems: async () => found, get hasNext() { return more } }
    },
    getInfo: async id => ({ sandboxId: id, metadata: metadata(value) }),
    kill: async id => { deleted.push(id); return true },
  } }
  assert.deepEqual(await cleanupOwnedProbe(value, SOURCE, sdk),
    { stopped: false, outcome: 'creation_unconfirmed', scopeVerified: false })
  found = [{ sandboxId: 'first' }, { sandboxId: 'second' }]
  await assert.rejects(cleanupOwnedProbe(value, SOURCE, sdk), /cleanup_scope/)
  found = [{ sandboxId: 'only' }]; more = true
  await assert.rejects(cleanupOwnedProbe(value, SOURCE, sdk), /cleanup_scope/)
  assert.deepEqual(deleted, [])
  more = false
  assert.equal((await cleanupOwnedProbe(value, SOURCE, sdk)).stopped, true)
  assert.deepEqual(deleted, ['only'])
})

test('cleanup recognizes provider absence while transport failure never becomes a cleanup acknowledgment', async () => {
  class SandboxNotFoundError extends Error {}
  let failure = new SandboxNotFoundError('Synthetic absence')
  const sdk = { SandboxNotFoundError, Sandbox: {
    getInfo: async () => { throw failure }, kill: async () => assert.fail('An absent or unverified VM is never killed'),
  } }
  assert.deepEqual(await cleanupOwnedProbe(journal(), SOURCE, sdk),
    { stopped: true, outcome: 'provider_already_absent', scopeVerified: false })
  failure = new Error('Synthetic transport failure')
  await assert.rejects(cleanupOwnedProbe(journal(), SOURCE, sdk), error => {
    assert.equal(error.message, 'preview_ingress_cleanup_read_failed')
    assert.equal(error.cause, failure)
    return true
  })
})
