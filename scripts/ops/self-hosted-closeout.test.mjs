import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { workflowGuard, sourceGuard } from './self-hosted-closeout.mjs'

const valid = { GITHUB_REPOSITORY: 'alexj11324/Mikka', GITHUB_REF: 'refs/heads/ops/self-hosted-closeout-20261108',
  GITHUB_ACTOR: 'alexj11324', GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '12345', GITHUB_EVENT_NAME: 'push' }
test('only the exact authorized workload can touch production', () => {
  workflowGuard(valid)
  for (const [key, value] of Object.entries({ GITHUB_REPOSITORY: 'fork/Mikka', GITHUB_REF: 'refs/heads/main',
    GITHUB_ACTOR: 'outsider', GITHUB_SHA: 'moving-ref', GITHUB_RUN_ID: 'not-a-run', GITHUB_EVENT_NAME: 'pull_request' })) {
    assert.throws(() => workflowGuard({ ...valid, [key]: value }))
  }
})
test('invalid workload fails before credentials or any network access', async () => {
  const env = { ...valid, GITHUB_REF: 'refs/heads/unsafe' }
  for (const name of ['GITHUB_TOKEN', 'SMOKE_OWNER_EMAIL', 'SMOKE_OWNER_PASSWORD', 'VERCEL_TEAM_TOKEN']) {
    Object.defineProperty(env, name, { get() { assert.fail('credential read before source authorization') } })
  }
  await assert.rejects(sourceGuard(env))
})
test('a drifted public deployment cannot pass even after green source CI', async () => {
  const fetchOriginal = globalThis.fetch
  const plan = JSON.parse(await readFile(new URL('./self-hosted-closeout-plan.json', import.meta.url)))
  globalThis.fetch = async url => Response.json(String(url).includes('/actions/runs/')
    ? { repository: { full_name: plan.repository }, head_sha: plan.source, event: 'push', status: 'completed', conclusion: 'success' }
    : { build: 'b'.repeat(40) })
  try { await assert.rejects(sourceGuard({ ...valid, GITHUB_TOKEN: 'fixture-only' }), /PUBLIC_SOURCE_DRIFT/) }
  finally { globalThis.fetch = fetchOriginal }
})
