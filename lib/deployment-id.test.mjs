import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildDeploymentId, configuredDeploymentId, isValidDeploymentId } from './deployment-id.mjs'

const SHA = 'b8382fabe0123456789abcdef0123456789abcde'

test('builds a Vercel-valid id from the commit and run', () => {
  const id = buildDeploymentId({ sha: SHA, runId: '19234567890', runAttempt: '1' })
  assert.equal(id, 'b8382fabe012-19234567890-1')
  assert.ok(id.length <= 32)
  assert.match(id, /^[A-Za-z0-9_-]+$/)
  assert.ok(!id.startsWith('dpl_'))
  assert.ok(isValidDeploymentId(id))
})

test('a re-run of the same commit gets a different id', () => {
  const ids = ['1', '2', '3'].map(runAttempt => buildDeploymentId({ sha: SHA, runId: '19234567890', runAttempt }))
  assert.equal(new Set(ids).size, ids.length)
})

test('long run fields shorten the commit, never the run attempt', () => {
  const id = buildDeploymentId({ sha: SHA, runId: '1234567890123456', runAttempt: '12' })
  assert.ok(id.length <= 32, id)
  assert.ok(id.endsWith('-1234567890123456-12'), id)
  assert.throws(() => buildDeploymentId({ sha: SHA, runId: '1'.repeat(24), runAttempt: '1' }))
})

test('rejects missing or malformed inputs', () => {
  assert.throws(() => buildDeploymentId({ sha: undefined, runId: '1', runAttempt: '1' }))
  assert.throws(() => buildDeploymentId({ sha: 'dpl_abc1234', runId: '1', runAttempt: '1' }))
  assert.throws(() => buildDeploymentId({ sha: SHA, runId: '', runAttempt: '1' }))
  assert.throws(() => buildDeploymentId({ sha: SHA, runId: '1', runAttempt: undefined }))
})

test('validates the Vercel id rules', () => {
  assert.ok(!isValidDeploymentId('dpl_abc'))
  assert.ok(!isValidDeploymentId('a'.repeat(33)))
  assert.ok(isValidDeploymentId('a'.repeat(32)))
  assert.ok(!isValidDeploymentId('abc.def'))
  assert.ok(!isValidDeploymentId(''))
})

test('build config sets no id outside the production workflow', () => {
  assert.equal(configuredDeploymentId({}), undefined)
  assert.equal(configuredDeploymentId({ MIKKA_DEPLOYMENT_ID: '' }), undefined)
  assert.equal(configuredDeploymentId({ MIKKA_DEPLOYMENT_ID: 'b8382fabe012-1-1' }), 'b8382fabe012-1-1')
  assert.throws(() => configuredDeploymentId({ MIKKA_DEPLOYMENT_ID: 'dpl_x' }))
  assert.throws(() => configuredDeploymentId({ MIKKA_DEPLOYMENT_ID: 'b8382fabe012-1-1', NEXT_DEPLOYMENT_ID: 'other' }))
})

test('the workflow command prints the id for the current run', () => {
  const out = execFileSync(process.execPath, [fileURLToPath(new URL('./deployment-id.mjs', import.meta.url))], {
    env: { PATH: process.env.PATH, GITHUB_SHA: SHA, GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '3' }, encoding: 'utf8',
  })
  assert.equal(out, 'b8382fabe012-42-3\n')
})
