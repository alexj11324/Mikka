import assert from 'node:assert/strict'
import test from 'node:test'
import { verifyCloudEdition } from './verify-cloud-edition'

const env = { MIKKA_EDITION: 'cloud', VERCEL_TOKEN: 'test-only', VERCEL_PROJECT_ID: 'project', VERCEL_ORG_ID: 'team' }
test('official rollout requires both the source and actual production runtime edition', async () => {
  const seen: string[] = []
  const reader = (value: string, rows = [{ id: 'edition', key: 'MIKKA_EDITION', target: ['production'] }]) => (async input => {
    seen.push(String(input))
    return Response.json(String(input).includes('/env/edition') ? { value } : { envs: rows })
  }) as typeof fetch
  await verifyCloudEdition(env, reader('cloud'))
  assert.equal(seen.length, 2)
  seen.length = 0
  await assert.rejects(verifyCloudEdition({ ...env, MIKKA_EDITION: undefined }, reader('cloud')), /infisicalCloudEditionRequired/)
  assert.equal(seen.length, 0)
  await assert.rejects(verifyCloudEdition(env, reader('community')), /vercelCloudEditionRequired/)
  await assert.rejects(verifyCloudEdition(env, reader('cloud', [])), /vercelCloudEditionRequired/)
  await assert.rejects(verifyCloudEdition(env, reader('cloud', [{ id: 'edition', key: 'MIKKA_EDITION', target: ['preview'] }])), /vercelCloudEditionRequired/)
})
