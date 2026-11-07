import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { RetryableError } from 'workflow'
import { CloudServiceError } from '../../lib/cloud-services/errors'

const original = new CloudServiceError('cloud_unavailable', 'network', new Error('fixture network failure'))
mock.module(new URL('../../lib/mobile-push-delivery.ts', import.meta.url).href, { namedExports: { checkPhonePushReceipts: async () => { throw original } } })

test('receipt retries preserve the original failure cause', async () => {
  const { checkReceipts } = await import('./steps')
  await assert.rejects(checkReceipts('fixture', false), error => error instanceof RetryableError && error.cause === original)
})
