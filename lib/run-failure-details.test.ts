import assert from 'node:assert/strict'
import test from 'node:test'
import { CodedError } from '@mikka/protocol/coded-error'
import { runCompleteRequest, runCompletion, type RunCompleteRequest } from '@mikka/protocol/run'
import { type RunFailure } from '@mikka/protocol/run-failure'
import { APP_BUILD } from './app-build'
import { completionFailureDetails, serverRunFailure } from './run-failure-details'
import { readCompactRunFailure } from './run-failure-view'

const runId = '10000000-0000-4000-8000-000000000001'
const failure: RunFailure = {
  schemaVersion: 1, code: 'run_api_key_invalid', category: 'api_key', provider: 'openai', status: 401,
  providerMessage: 'Authentication failed for the private task text', causes: [{ name: 'APIError', code: 'invalid_api_key' }],
  recovery: 'configure_api_key', runId: 'untrusted-run', occurredAt: '2026-11-07T12:00:00.000Z', appVersion: 'untrusted-version',
}
const report = { summary: 'Finished', filesChanged: [], verify: { status: 'passed' as const }, openQuestions: [], nextStep: null }

test('completion diagnostics stay outside the model report and bind to the host run and version', () => {
  const parsed = runCompleteRequest.parse({ stopReason: 'error', failureDetails: failure, report: { ...report, failureDetails: failure } })
  assert.equal('failureDetails' in parsed.report!, false)
  assert.equal(runCompletion.parse({ stopReason: 'error', report, failureDetails: failure }).failureDetails?.code, failure.code)
  const stored = completionFailureDetails(parsed, runId, { status: 'failed', sensitiveText: ['private task text'] })!
  assert.equal(stored.runId, runId)
  assert.equal(stored.appVersion, APP_BUILD || 'unknown')
  assert.equal(stored.code, 'run_api_key_invalid')
  assert.equal(stored.status, 401)
  assert.doesNotMatch(stored.providerMessage ?? '', /private task text/)
  assert.equal(stored.occurredAt, failure.occurredAt)
})

test('success, cancellation and normal stops discard conflicting provider diagnostics', () => {
  for (const stopReason of ['submitted', 'cancelled', 'turn_ended', 'asked_human'] as const) {
    assert.equal(completionFailureDetails({ stopReason, report, failureDetails: failure }, runId), null)
  }
  assert.equal(completionFailureDetails({ stopReason: 'error', failureDetails: failure }, runId, { status: 'stopped', stopRequested: true }), null)
})

test('an actually failed verification or blocked run gets a safe generic failure', () => {
  for (const stopReason of ['submitted', 'blocked'] as const) {
    const stored = completionFailureDetails({ stopReason, report, failureDetails: failure }, runId, { status: 'failed' })!
    assert.equal(stored.code, 'run_failed')
    assert.equal(stored.runId, runId)
    assert.equal(stored.providerMessage, undefined)
    assert.equal(stored.provider, undefined)
  }
})

test('legacy completion failures get code-only diagnostics without copying arbitrary report text', () => {
  for (const [stopReason, code] of [['error', 'run_failed'], ['device_lost', 'run_failed'], ['timeout', 'run_timeout'], ['quota_exhausted', 'run_quota_exceeded']] as const) {
    const stored = completionFailureDetails({ stopReason, report: { ...report, summary: 'Bearer private-token: the full private prompt' } }, runId)!
    assert.equal(stored.code, code)
    assert.equal(stored.providerMessage, undefined)
    assert.equal(JSON.stringify(stored).includes('private'), false)
  }
  const invalid = { ...failure, schemaVersion: 2 }
  assert.equal(runCompleteRequest.safeParse({ stopReason: 'error', failureDetails: invalid }).success, false)
  assert.equal(completionFailureDetails({ stopReason: 'error', failureDetails: invalid } as unknown as RunCompleteRequest, runId)?.code, 'run_failed')
})

test('server terminal failures keep a trusted registered code and terminal clock', () => {
  const now = new Date('2026-11-07T13:00:00.000Z')
  const stored = serverRunFailure(runId, now, new CodedError('subscription_local_runtime_unavailable', { detail: 'cli_missing' }))
  assert.equal(stored.code, 'subscription_local_runtime_unavailable')
  assert.equal(stored.detail, 'cli_missing')
  assert.equal(stored.runId, runId)
  assert.equal(stored.occurredAt, now.toISOString())
  assert.equal(stored.providerMessage, undefined)
})

test('compact projections accept full or compact diagnostics, with no raw provider text or causes', () => {
  const compact = readCompactRunFailure(failure)!
  assert.equal(compact.code, failure.code)
  assert.equal('providerMessage' in compact, false)
  assert.equal('causes' in compact, false)
  assert.deepEqual(readCompactRunFailure(compact), compact)
  for (const historical of [null, undefined, {}, { schemaVersion: 2 }, 'legacy string']) assert.equal(readCompactRunFailure(historical), null)
})
