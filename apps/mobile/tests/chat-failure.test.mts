import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { failureLine, failureSettingsPath } from '../lib/chat-failure.ts'
import { subscriptionRecovery, type SubscriptionRefusalNotice } from '../../../lib/subscription-refusal.ts'
import { CLOUD_ERROR_CODES, type CloudErrorCode } from '../../../lib/cloud-services/errors.ts'

const copy = JSON.parse(readFileSync(new URL('../../../messages/zh-CN.json', import.meta.url), 'utf8')).Coordinator.subscriptionRefusal
const notices: SubscriptionRefusalNotice[] = ['unavailable', 'reconnect', 'quotaUsed', 'retry', 'quotaChecking', 'rateLimited', 'accessDenied', 'modelRejected', 'runtimeUnavailable', 'selectionChanged']

test('every server subscription notice has the same words and recovery on the phone', () => {
  for (const notice of notices) {
    const line = failureLine({ kind: 'subscription', notice })
    assert.equal(line.text, copy[notice], notice)
    const recovery = subscriptionRecovery(notice)
    assert.equal(line.retry, recovery === 'retry', notice)
    assert.equal(line.recovery, recovery === 'retry' ? null : recovery === 'settings' ? 'models' : 'model', notice)
  }
})

test('an unknown notice from a newer server stays readable and does not expose its value', () => {
  const line = failureLine({ kind: 'subscription', notice: 'fixture_private_provider_value' as SubscriptionRefusalNotice })
  assert.equal(line.text, copy.retry)
  assert.equal(line.retry, true)
  assert.equal(line.recovery, null)
})

test('hosted billing and model refusals open their corresponding recovery', () => {
  assert.equal(failureLine({ kind: 'hosted', code: 'points_exhausted' }).recovery, 'billing')
  assert.equal(failureLine({ kind: 'hosted', code: 'verification_required' }).recovery, 'billing')
  assert.equal(failureLine({ kind: 'hosted', code: 'platform_paused' }).recovery, 'model')
  assert.equal(failureLine({ kind: 'hosted', code: 'usage_concurrency_limit' }).retry, true)
})

test('API balance uses the shared fixed copy and model action, while ordinary failures retain retry', () => {
  const messages = JSON.parse(readFileSync(new URL('../../../messages/zh-CN.json', import.meta.url), 'utf8'))
  assert.deepEqual(failureLine({ kind: 'failed', reason: 'balance' }), {
    text: messages.Coordinator.apiBalance, retry: false, recovery: 'model',
  })
  assert.deepEqual(failureLine({ kind: 'failed' }), { text: messages.Coordinator.failedTitle, retry: true, recovery: null })
})

test('billing recovery retains the selected workspace rather than a browser default', () => {
  const workspace = 'F778B9A0-ECEC-4ADE-97A6-B7AA4221A177'
  assert.equal(failureSettingsPath('billing', workspace), `/settings?section=billing&workspace=${workspace.toLowerCase()}`)
  assert.equal(failureSettingsPath('models', workspace), `/settings?section=models&workspace=${workspace.toLowerCase()}`)
  assert.equal(failureSettingsPath('billing', undefined), null)
  assert.equal(failureSettingsPath('billing', 'private-text'), null)
  assert.equal(failureSettingsPath('models'), '/settings?section=models')
})

test('cloud failures reuse fixed web copy, preserve native model recovery and open cloud billing only for quota', () => {
  const messages = JSON.parse(readFileSync(new URL('../../../messages/zh-CN.json', import.meta.url), 'utf8'))
  for (const code of CLOUD_ERROR_CODES) {
    const line = failureLine({ kind: 'failed', cloudCode: code })
    assert.equal(line.text, messages.RunErrors[code].default, code)
    const retry = code === 'cloud_rate_limited' || code === 'cloud_unavailable'
    assert.equal(line.retry, retry, code)
    assert.equal(line.recovery, code === 'cloud_quota_exhausted' ? 'cloudBilling' : retry ? null : 'model', code)
  }
  const unknown = failureLine({ kind: 'failed', cloudCode: 'fixture_private_cloud_value' as CloudErrorCode })
  assert.deepEqual(unknown, failureLine({ kind: 'failed' }))
})
