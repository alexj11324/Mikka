import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readCronPromotion } from './promotion.mjs'
const sourceCommit = 'a'.repeat(40)
const authority = async () => ({ provider: 'cloudflare', sha: sourceCommit })
const run = { id: 7, run_attempt: 1, head_sha: sourceCommit, head_branch: 'main', path: '.github/workflows/cloudflare-app-deploy.yml', event: 'workflow_dispatch', status: 'completed', conclusion: 'success', repository: { full_name: 'alexj11324/Mikka' }, head_repository: { full_name: 'alexj11324/Mikka' } }

test('observed promotion is reverified against current live serving evidence', async () => {
  const calls = []
  const read = async (path) => path.includes('/jobs?') ? { total_count: 1, jobs: [{ name: 'Serving release ' + sourceCommit + ' fixture', status: 'completed', conclusion: 'success' }] } : { workflow_runs: [run] }
  const verify = async (pin, opts) => { calls.push([pin, opts.token]); return { product: sourceCommit, releasePin: 'release-1' } }
  assert.deepEqual(await readCronPromotion({ sourceCommit, token: 'token', read, verify, authority }), { id: 'release-1', sha: sourceCommit })
  assert.deepEqual(calls, [['actions:7:1', 'token']])
})

test('wrong source, unobserved run and inconsistent job counts fail closed', async () => {
  const unobserved = async path => path.includes('/jobs?') ? { total_count: 0, jobs: [] } : { workflow_runs: [run] }
  assert.equal(await readCronPromotion({ sourceCommit, token: 't', read: unobserved, authority }), null)
  const read = async path => path.includes('/jobs?') ? { total_count: 1, jobs: [{ name: 'Serving release ' + sourceCommit + ' fixture', status: 'completed', conclusion: 'success' }] } : { workflow_runs: [run] }
  await assert.rejects(readCronPromotion({ sourceCommit, token: 't', read, authority, verify: async () => ({ product: 'b'.repeat(40), releasePin: 'x' }) }), /source_mismatch/)
  await assert.rejects(readCronPromotion({ sourceCommit, token: 't', authority, read: async path => path.includes('/jobs?') ? { total_count: 2, jobs: [] } : { workflow_runs: [run] } }), /jobs_invalid/)
})

// A later main workflow may observe an older served product: filtering by run
// head would miss the only current observation.
test('finds serving proof observed from a later main head', async () => {
  const later = { ...run, head_sha: 'b'.repeat(40) }
  const seen = []
  const read = async path => {
    seen.push(path)
    return path.includes('/jobs?') ? { total_count: 1, jobs: [{ name: 'Serving release ' + sourceCommit + ' overlay', status: 'completed', conclusion: 'success' }] } : { workflow_runs: [later] }
  }
  const result = await readCronPromotion({ sourceCommit, token: 't', read, authority, verify: async () => ({ product: sourceCommit, releasePin: 'release-1' }) })
  assert.deepEqual(result, { id: 'release-1', sha: sourceCommit })
  assert.equal(seen[0].includes('head_sha='), false)
})
