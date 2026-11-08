import test from 'node:test'
import assert from 'node:assert/strict'
import { PROBE, assertOpsContext, assertProbeIdentity, summarizeProbe } from './self-hosted-ingress-probe.mjs'

const branch = 'ops/self-hosted-vault-closeout-20261108'
const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'alexj11324/Mikka', GITHUB_REF: `refs/heads/${branch}`,
  GITHUB_ACTOR: 'alexj11324', GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '123', GITHUB_EVENT_NAME: 'push',
  GITHUB_WORKFLOW_REF: `alexj11324/Mikka/.github/workflows/self-hosted-vault-closeout.yml@refs/heads/${branch}` }
const event = { repository: { id: 1427517699, owner: { id: 183887963 } }, ref: env.GITHUB_REF,
  after: env.GITHUB_SHA, deleted: false, forced: false }

test('only the original trusted vault workload can carry the probe; main impersonation and forks fail', () => {
  assertOpsContext(env, event, env.GITHUB_SHA)
  for (const mutation of [{ GITHUB_REF: 'refs/heads/main' }, { GITHUB_ACTOR: 'other' }, { GITHUB_EVENT_NAME: 'pull_request' },
    { GITHUB_WORKFLOW_REF: 'alexj11324/Mikka/.github/workflows/preview-ingress-probe.yml@refs/heads/main' },
    { GITHUB_ACTIONS: 'false' }]) assert.throws(() => assertOpsContext({ ...env, ...mutation }, event, env.GITHUB_SHA))
  for (const mutation of [{ forced: true }, { deleted: true }, { after: 'b'.repeat(40) }, { ref: 'refs/heads/main' },
    { repository: { id: 1, owner: { id: 183887963 } } }, { repository: { id: 1427517699, owner: { id: 1 } } }]) {
    assert.throws(() => assertOpsContext(env, { ...event, ...mutation }, env.GITHUB_SHA))
  }
  assert.throws(() => assertOpsContext(env, event, 'b'.repeat(40)))
})

test('probe content is bound to the reviewed commit, complete tree and all three file hashes', () => {
  const identity = { source: PROBE.source, tree: PROBE.tree, files: PROBE.files, dirty: false }
  assertProbeIdentity(identity)
  for (const mutation of [{ source: 'b'.repeat(40) }, { tree: 'b'.repeat(40) }, { dirty: true }, { files: {} }]) {
    assert.throws(() => assertProbeIdentity({ ...identity, ...mutation }))
  }
  for (const path of Object.keys(PROBE.files)) assert.throws(() => assertProbeIdentity({ ...identity,
    files: { ...PROBE.files, [path]: '0'.repeat(64) } }))
})

const journal = { version: 1, purpose: 'mikka-preview-ingress-spike', sourceCommit: PROBE.source,
  requestedTemplate: 'claude', fixtureId: '00000000-0000-4000-8000-000000000001', sandboxId: 'owned-sandbox' }
const report = { ...journal, passed: true, probeSha256: PROBE.files['scripts/e2b/preview-ingress-probe.py'],
  user: { sudoNonInteractiveRoot: true }, privateText: 'must-not-be-reported' }
const cleanupReport = { ...journal, cleanup: { stopped: true, outcome: 'provider_kill_acknowledged', scopeVerified: true } }

test('capability failure stays failed while a confirmed cleanup permits the next independent template', () => {
  const result = summarizeProbe('claude', { journal, report: { ...report, passed: false }, cleanupReport })
  assert.equal(result.capabilityPassed, false)
  assert.equal(result.cleanupConfirmed, true)
  assert.equal(result.preListenerIsolationProven, false)
  assert.equal(result.agentPrivilegeBoundaryProven, false)
  assert.equal(result.derivedRuntimeAcceptance, false)
  assert.ok(!JSON.stringify(result).includes('must-not-be-reported'))
})

test('every missing, failed or mismatched cleanup target prevents another VM even after a capability pass', () => {
  for (const changed of [null, { ...cleanupReport, fixtureId: 'foreign' }, { ...cleanupReport, sandboxId: 'foreign' },
    { ...cleanupReport, sourceCommit: 'b'.repeat(40) }, { ...cleanupReport, requestedTemplate: 'codex' },
    { ...cleanupReport, cleanup: { stopped: false, outcome: 'cleanup_failed', scopeVerified: false } },
    { ...cleanupReport, cleanup: { stopped: true, outcome: 'provider_kill_acknowledged', scopeVerified: false } }]) {
    assert.equal(summarizeProbe('claude', { journal, report, cleanupReport: changed }).cleanupConfirmed, false)
  }
  assert.equal(summarizeProbe('codex', { journal, report, cleanupReport }).cleanupConfirmed, false)
  assert.equal(summarizeProbe('claude', { journal, report, cleanupReport }).cleanupConfirmed, true)
})

test('provider absence and no creation are explicit receipts, never inferred from a missing report', () => {
  assert.equal(summarizeProbe('claude', { journal, report, cleanupReport: {
    ...cleanupReport, cleanup: { stopped: true, outcome: 'provider_already_absent', scopeVerified: false },
  } }).cleanupConfirmed, true)
  const noCreation = { version: 1, purpose: journal.purpose, sourceCommit: PROBE.source,
    cleanup: { stopped: true, outcome: 'no_creation_requested', scopeVerified: false } }
  assert.equal(summarizeProbe('claude', { journal: null, report: null, cleanupReport: noCreation }).cleanupConfirmed, true)
  assert.equal(summarizeProbe('claude', { journal: null, report: null, cleanupReport: null }).cleanupConfirmed, false)
  assert.equal(summarizeProbe('claude', { journal, report, cleanupReport: noCreation }).cleanupConfirmed, false)
})

test('a pass never claims early ingress, sudo isolation or a derived-template acceptance', () => {
  const result = summarizeProbe('claude', { journal, report, cleanupReport })
  assert.equal(result.capabilityPassed, true)
  assert.equal(result.cleanupConfirmed, true)
  assert.equal(result.sudoNonInteractiveRoot, true)
  assert.equal(result.preListenerIsolationProven, false)
  assert.equal(result.agentPrivilegeBoundaryProven, false)
  assert.equal(result.derivedRuntimeAcceptance, false)
  assert.equal(summarizeProbe('claude', { journal, cleanupReport, report: { ...report, probeSha256: '0'.repeat(64) } }).capabilityPassed, false)
})
