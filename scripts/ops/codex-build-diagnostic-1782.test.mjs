import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TARGET, OPS_PARENT, assertTarget, guardContext, guardProduct, publicFailure } from './codex-build-diagnostic-1782.mjs'
import { diagnoseExistingBuild } from './workspace-private-acceptance.mjs'

const SHA = 'a'.repeat(40)
function context() {
  const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'alexj11324/Mikka',
    GITHUB_REF: 'refs/heads/ops/self-hosted-vault-closeout-20261108', GITHUB_ACTOR: 'alexj11324',
    GITHUB_TRIGGERING_ACTOR: 'alexj11324', GITHUB_EVENT_NAME: 'push', GITHUB_SHA: SHA,
    GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', GITHUB_JOB: 'codex_deleted_build_readonly',
    GITHUB_WORKFLOW_REF: 'alexj11324/Mikka/.github/workflows/issue1782-codex-build-diagnostic.yml@refs/heads/ops/self-hosted-vault-closeout-20261108' }
  const event = { repository: { id: 1427517699, owner: { id: 183887963 } }, ref: env.GITHUB_REF,
    after: SHA, before: OPS_PARENT, forced: false, deleted: false }
  return { env, event }
}

test('the only compiled target is the verified closed b315 Codex artifact', () => {
  assertTarget()
  for (const field of ['runId', 'opsSource', 'sourceCommit', 'sourceTree', 'workerSha', 'templateId', 'buildId', 'artifactSha256']) {
    assert.throws(() => assertTarget({ ...TARGET, [field]: 'different' }), /diagnostic_target_refused/)
  }
  assert.throws(() => assertTarget({ ...TARGET, artifactId: TARGET.artifactId + 1 }), /diagnostic_target_refused/)
})

test('a normal owned single-child new-workflow push is accepted', () => {
  const { env, event } = context(); guardContext(env, event, SHA, [OPS_PARENT], false)
})

test('old workflow, actor, attempt, job and numeric repository substitutions are refused', () => {
  const { env, event } = context()
  for (const [field, value] of [['GITHUB_TRIGGERING_ACTOR', 'another'], ['GITHUB_ACTOR', 'another'],
    ['GITHUB_RUN_ATTEMPT', '2'], ['GITHUB_JOB', 'private_candidates'],
    ['GITHUB_WORKFLOW_REF', env.GITHUB_WORKFLOW_REF.replace('issue1782-codex-build-diagnostic.yml', 'self-hosted-vault-closeout.yml')]]) {
    assert.throws(() => guardContext({ ...env, [field]: value }, event, SHA, [OPS_PARENT], false))
  }
  for (const repository of [{ ...event.repository, id: 1 }, { ...event.repository, owner: { id: 1 } }]) {
    assert.throws(() => guardContext(env, { ...event, repository }, SHA, [OPS_PARENT], false), /diagnostic_context_refused/)
  }
})

test('future pushes, merged parents, forced events and dirty checkouts cannot reread the key', () => {
  const { env, event } = context()
  for (const parents of [[], [SHA], [OPS_PARENT, SHA]]) {
    assert.throws(() => guardContext(env, event, SHA, parents, false), /diagnostic_parent_refused/)
  }
  assert.throws(() => guardContext(env, { ...event, before: SHA }, SHA, [OPS_PARENT], false), /diagnostic_parent_refused/)
  for (const change of [{ forced: true }, { deleted: true }, { after: 'b'.repeat(40) }]) {
    assert.throws(() => guardContext(env, { ...event, ...change }, SHA, [OPS_PARENT], false), /diagnostic_context_refused/)
  }
  assert.throws(() => guardContext(env, event, SHA, [OPS_PARENT], true), /diagnostic_context_refused/)
})

test('diagnostic product is fixed b315 independently of later private candidate P0 pins', () => {
  const value = { source: TARGET.sourceCommit, tree: TARGET.sourceTree, workerSha: TARGET.workerSha, nodeMajor: '24', dirty: false }
  guardProduct(value)
  for (const change of [{ source: SHA }, { tree: SHA }, { workerSha: SHA }, { nodeMajor: '22' }, { dirty: true }]) {
    assert.throws(() => guardProduct({ ...value, ...change }), /diagnostic_source_refused/)
  }
})

test('the reused deleted-build path performs one fixed GET and closes absent evidence without mutation', async () => {
  let calls = 0
  const result = await diagnoseExistingBuild('synthetic-only-key', { fetchImpl: async (url, options) => {
    calls++
    assert.equal(new URL(url).origin, 'https://api.e2b.dev')
    assert.equal(new URL(url).pathname, `/templates/${TARGET.templateId}/builds/${TARGET.buildId}/status`)
    assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error')
    return new Response(null, { status: 404 })
  } })
  assert.equal(calls, 1); assert.equal(result.failure.code, 'not_found')
  assert.equal(result.resourcesCreated, false); assert.equal(result.mutationsPerformed, false)
  assert.deepEqual(result.target, TARGET); assert.equal(JSON.stringify(result).includes('synthetic-only-key'), false)
})

test('unexpected failures cannot disclose raw provider text or credentials', () => {
  assert.deepEqual(publicFailure(new Error('synthetic-private-provider-text')), {
    event: 'fixed_codex_diagnostic_refused', code: 'diagnostic_failed',
  })
  assert.equal(publicFailure(new Error('diagnostic_target_refused')).code, 'diagnostic_target_refused')
})
