import { captureRunFailure } from '@mikka/protocol/run-failure'
import { CLOUD_ERROR_CODES, CloudServiceError } from './cloud-services/errors'
import assert from 'node:assert/strict'
import test from 'node:test'
import { chatFailure, failureMessageKey } from './chat-failure'

test('native admission and quiet completion require an explicit native failure',()=>{
  const items=[{from:'person',native:true as const}]
  assert.equal(chatFailure({working:false,error:null,items}),null)
  assert.equal(chatFailure({working:true,error:'turn_failed',items}),null)
  assert.equal(chatFailure({working:false,error:'turn_failed',items})?.kind,'failed')
  assert.equal(chatFailure({working:false,error:null,items:[{from:'person'}]})?.kind,'failed','historical legacy failures retain their existing presentation')
})
import { chatBalanceRefusal } from './chat-balance'
import { failureLine } from '../apps/mobile/lib/chat-failure'

const person = { from: 'person' }, reply = { from: 'coordinator' }, event = { from: 'event' }
const balance = 'Step "step//@ai-sdk/workflow@2.0.80//doStreamStep" failed after 0 retries: Insufficient Balance (request_id: 11111111-1111-4111-8111-111111111111)'

test('exhausted tool recovery has a stable friendly failure and retry',()=>{
  const failure=chatFailure({working:false,error:'model_tool_unavailable'})!
  assert.deepEqual(failure,{kind:'failed',reason:'tools',raw:'model_tool_unavailable'})
  assert.deepEqual(failureMessageKey(failure),{namespace:'Coordinator',key:'replyToolUnavailable'})
  assert.deepEqual(failureLine(failure),{text:'回复未完成，请重试',retry:true,recovery:null})
  assert.equal(chatFailure({working:true,error:'model_tool_unavailable'}),null)
})

test('the observed model streaming balance refusal has safe copy and a model recovery without retry', () => {
  const failure = chatFailure({ working: false, error: balance })!
  assert.deepEqual(failure, { kind: 'failed', reason: 'balance' })
  assert.deepEqual(failureMessageKey(failure), { namespace: 'Coordinator', key: 'apiBalance' })
  assert.deepEqual(failureLine(failure), { text: 'API 余额不足', retry: false, recovery: 'model' })
  assert.doesNotMatch(JSON.stringify(failure), /request_id|11111111|doStreamStep/)
  assert.equal(chatFailure({ working: true, error: balance }), null)
})

test('balance display recognizes the same provider boundary across SDK versions and a bare refusal', () => {
  assert.equal(chatBalanceRefusal(balance.replace('2.0.80', '2.1.0')), true)
  assert.equal(chatBalanceRefusal(balance.replace('2.0.80', '3.0.0-beta.1')), true)
  assert.equal(chatBalanceRefusal('Insufficient Balance'), true)
  assert.equal(chatBalanceRefusal(null), false)
})

test('generic, quoted and tool errors never become a balance state from credit or quota words', () => {
  for (const error of [
    'model timed out', 'credit unavailable', 'quota exceeded', 'HTTP 402',
    'Tool output: Insufficient Balance',
    'Step "step//tools//doStreamStep" failed after 0 retries: Insufficient Balance',
    'Step "step//@ai-sdk/workflow@2.0.80//runToolStep" failed after 0 retries: Insufficient Balance',
    'Step "step//@ai-sdk/workflow@2.0.80//doStreamStep" failed after 0 retries: unrelated tool body says Insufficient Balance',
    `${balance} extra diagnostic text`,
  ]) {
    assert.equal(chatBalanceRefusal(error), false, error)
    const failure = chatFailure({ working: false, error })!
    assert.deepEqual(failure, chatBalanceRefusal(error) ? { kind: 'failed', reason: 'balance' } : { kind: 'failed', raw: error }, error)
    assert.equal(failureLine(failure).retry, true, error)
  }
})

test('a failed reply is named by what the person can do, never the raw error', () => {
  assert.deepEqual(chatFailure({ working: false, error: 'Step "step//./workflows/coordinator/agent-kit-steps//botRuntime" failed after 3 retries: binding_required' }), { kind: 'subscription', notice: 'selectionChanged', raw: 'binding_required' })
  assert.deepEqual(chatFailure({ working: false, error: 'Error: points_exhausted' }), { kind: 'hosted', code: 'points_exhausted', raw: 'points_exhausted' })
  assert.deepEqual(chatFailure({ working: false, error: 'wake_exhausted' }), { kind: 'wake', code: 'wake_exhausted', raw: 'wake_exhausted' })
  assert.deepEqual(chatFailure({ working: false, error: 'model timed out' }), { kind: 'failed', raw: 'model timed out' })
})

test('nothing while a turn works; a turn that ended with no reply and nothing recorded is a failure', () => {
  assert.equal(chatFailure({ working: true, error: 'binding_required' }), null)
  assert.equal(chatFailure({ working: false, error: null, items: [person, reply] }), null)
  assert.equal(chatFailure({ working: false, error: null, items: [] }), null)
  assert.deepEqual(chatFailure({ working: false, error: null, items: [reply, person, event] }), { kind: 'failed' })
  assert.equal(chatFailure({ working: false, error: null, items: [reply, { from: 'person', pending: true }] }), null, 'a message still waiting is not unanswered')
})

test('every actionable server subscription error remains readable in the mobile contract', () => {
  for (const code of ['binding_required', 'account_unavailable', 'reconnect_required', 'quota_exhausted', 'backend_unavailable', 'quota_unknown', 'subscription_rate_limited', 'provider_access_denied', 'provider_request_rejected', 'provider_route_unavailable']) {
    const failure = chatFailure({ working: false, error: code })
    assert.equal(failure?.kind, 'subscription', code)
    assert.ok(failure && failureLine(failure).text, code)
  }
})

test('详情 carries the stored codes as recorded: the line code, then the turn failure behind a wake code (decision 2026-11-05-0330)', () => {
  // A subscription turn the provider rejected: the line reads the subscription copy, 详情 the code with its detail.
  assert.deepEqual(chatFailure({ working: false, error: 'subscription_generation_failed (provider_request_rejected)' }),
    { kind: 'subscription', notice: 'retry', raw: 'subscription_generation_failed (provider_request_rejected)' })
  // Retries ran out: the line is 回复重试已停止, 详情 also names the last real failure.
  assert.deepEqual(chatFailure({ working: false, error: 'wake_exhausted', cause: 'subscription_generation_failed (provider_request_rejected)' }),
    { kind: 'wake', code: 'wake_exhausted', raw: 'wake_exhausted\nsubscription_generation_failed (provider_request_rejected)' })
  // An unknown code has no words of its own: the generic line, the code as it is under 详情.
  assert.deepEqual(chatFailure({ working: false, error: 'some_new_failure_code' }), { kind: 'failed', raw: 'some_new_failure_code' })
  // The same text twice is listed once; nothing while working.
  assert.equal(chatFailure({ working: false, error: 'wake_failed', cause: 'wake_failed' })?.raw, 'wake_failed')
  assert.equal(chatFailure({ working: true, error: 'wake_exhausted', cause: 'x' }), null)
})

test('structured details accompany existing failure discriminators and malformed legacy payloads stay absent', () => {
  const failureDetails = captureRunFailure({ statusCode: 400, error: { type: 'invalid_request_error', message: 'Unsupported request format.' } }, { runId: 'wrun_details', provider: 'codex' })
  const failure = chatFailure({ working: false, error: 'wake_exhausted', cause: 'subscription_generation_failed', failureDetails })
  assert.equal(failure?.kind, 'wake')
  assert.deepEqual(failure?.failureDetails, failureDetails)
  assert.equal(chatFailure({ working: true, error: 'wake_exhausted', failureDetails }), null)
  assert.equal(chatFailure({ working: false, error: null, failureDetails }), null, 'cached details cannot revive a cleared failure')
  assert.deepEqual(chatFailure({ working: false, error: 'some_new_failure_code', failureDetails: { providerMessage: 'untrusted' } }), { kind: 'failed', raw: 'some_new_failure_code' })
})

test('optional cloud recovery and main structured failure details survive the combined chat contract', () => {
  const failureDetails = captureRunFailure(new CloudServiceError('cloud_quota_exhausted'), { runId: 'wrun_cloud_quota' })
  const failure = chatFailure({ working: false, error: 'cloud_quota_exhausted', failureDetails })
  assert.equal(failure?.kind, 'failed')
  assert.equal(failure?.kind === 'failed' && failure.cloudCode, 'cloud_quota_exhausted')
  assert.deepEqual(failure?.failureDetails, failureDetails)
  assert.deepEqual(failureMessageKey(failure!), { namespace: 'RunErrors', key: 'cloud_quota_exhausted.default' })
  assert.equal(failureLine(failure!).recovery, 'cloudBilling')
  assert.equal(chatFailure({ working: true, error: 'cloud_quota_exhausted', failureDetails }), null)
})

test('a cloud refusal crossing the model streaming step keeps its code and billing recovery', () => {
  // Exact safely exported error from real run42449447361.
  const observed = 'Step "step//@ai-sdk/workflow@2.0.80//doStreamStep" failed after 0 retries: cloud_quota_exhausted'
  assert.deepEqual(chatFailure({ working: false, error: observed }),
    { kind: 'failed', cloudCode: 'cloud_quota_exhausted', raw: 'cloud_quota_exhausted' })
  for (const version of ['2.0.80', '2.1.0', '3.0.0-beta.1']) {
    for (const code of CLOUD_ERROR_CODES) {
      const error = `Step "step//@ai-sdk/workflow@${version}//doStreamStep" failed after 0 retries: ${code} (response)`
      const failure = chatFailure({ working: false, error })!
      assert.deepEqual(failure, { kind: 'failed', cloudCode: code, raw: `${code} (response)` })
      assert.deepEqual(failureMessageKey(failure), { namespace: 'RunErrors', key: `${code}.default` })
      assert.equal(chatFailure({ working: true, error }), null)
      if (code === 'cloud_quota_exhausted') {
        assert.equal(failureLine(failure).recovery, 'cloudBilling')
        assert.equal(failureLine(failure).retry, false)
      }
    }
  }
})

test('quoted cloud codes, tool bodies and other steps never become cloud recovery', () => {
  const stream = 'Step "step//@ai-sdk/workflow@2.0.80//doStreamStep" failed after 0 retries: '
  for (const error of [
    'Tool output: cloud_quota_exhausted',
    'Step "step//tools//doStreamStep" failed after 0 retries: cloud_quota_exhausted',
    stream.replace('doStreamStep', 'runToolStep') + 'cloud_quota_exhausted',
    stream + 'Provider says cloud_quota_exhausted',
    stream + 'cloud_quota_exhausted extra diagnostic text',
    stream + 'cloud_quota_exhausted (request_id: secret)',
    stream + 'cloud_not_a_known_code',
    'Error: ' + stream + 'cloud_quota_exhausted',
  ]) {
    const failure = chatFailure({ working: false, error })!
    assert.equal(failure.kind, 'failed', error)
    assert.equal(failure.kind === 'failed' ? failure.cloudCode : undefined, undefined, error)
    assert.notEqual(failureLine(failure).recovery, 'cloudBilling', error)
  }
})
