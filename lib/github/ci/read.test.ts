import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { generateKeyPairSync } from 'node:crypto'
import { CiReadError, readCi } from './read'

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { format: 'pem', type: 'pkcs8' }, publicKeyEncoding: { format: 'pem', type: 'spki' } })
const env = { GITHUB_APP_ID: '123', GITHUB_APP_PRIVATE_KEY: privateKey }
const binding = { remoteKey: 'v2/github.com/owner/repo', installationId: 5, repositoryId: 7, prNumber: 9, branch: 'mikka/issue-9' }
const sha = 'a'.repeat(40)

test('scoped token cache reuses bounded branch rules without requesting an App token',async()=>{
  const calls:string[]=[];let saved:{branch:unknown;rules:unknown[][]}|null=null
  const cache={async get(){return saved},async put(_key:string,value:{branch:unknown;rules:unknown[][]}){saved=value}}
  const fetcher:typeof fetch=async url=>{const path=String(url);calls.push(path);if(path.includes('/pulls/'))return Response.json({state:'open',head:{sha,ref:binding.branch,repo:{id:7}},base:{ref:'main',repo:{id:7}}});if(path.includes('check-runs'))return Response.json({total_count:1,check_runs:[{id:4,name:'build',status:'completed',conclusion:'success'}]});if(path.includes('/rules/branches/'))return Response.json([]);if(path.includes('/branches/'))return Response.json({protected:false,protection:{enabled:false}});if(path.includes('/actions/runs?'))return Response.json({total_count:0,workflow_runs:[]});return Response.json({total_count:0,statuses:[]})}
  await readCi(binding,{},fetcher,{scopedToken:'synthetic-token',staticCache:cache})
  await readCi(binding,{},fetcher,{scopedToken:'synthetic-token',staticCache:cache})
  assert.equal(calls.filter(x=>x.includes('/branches/main')).length,2) // branch + rules once each
  assert.equal(calls.some(x=>x.includes('/access_tokens')),false)
})

test('reads scoped PR head and all checks; never follows arbitrary URLs', async () => {
  const calls: { url: string; init?: RequestInit }[] = []
  const fetcher: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    if (String(url).includes('access_tokens')) return Response.json({ token: 'fixture-token' })
    if (String(url).includes('/pulls/')) return Response.json({ state: 'open', head: { sha, ref: 'mikka/issue-9', repo: { id: 7 } }, base: { ref: 'main', repo: { id: 7 } } })
    if (String(url).includes('check-runs')) return Response.json({ total_count: 1, check_runs: [{ id: 4, name: 'build', status: 'completed', conclusion: 'success' }] })
    if (String(url).includes('/rules/branches/')) return Response.json([])
    if (String(url).includes('/branches/')) return Response.json({ protected: false, protection: { enabled: false } })
    if (String(url).includes('/actions/runs?')) return Response.json({ total_count: 0, workflow_runs: [] })
    return Response.json({ total_count: 1, statuses: [{ id: 8, context: 'deploy', state: 'failure' }] })
  }
  const result = await readCi(binding, env, fetcher)
  assert.equal(result.head, sha)
  assert.equal(result.snapshot.statuses[0].state, 'failure')
  assert.ok(calls.every(call => call.url.startsWith('https://api.github.com/') && call.init?.redirect === 'error'))
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { repository_ids: [7], permissions: { metadata: 'read', pull_requests: 'read', checks: 'read', statuses: 'read', contents: 'read', actions: 'read' } })
})

test('permission failures and truncated data never become successful results', async () => {
  await assert.rejects(readCi(binding, env, async () => new Response(null, { status: 403 })), (e: unknown) => e instanceof CiReadError && e.code === 'permission')
  const fetcher: typeof fetch = async url => {
    if (String(url).includes('access_tokens')) return Response.json({ token: 'fixture-token' })
    if (String(url).includes('/pulls/')) return Response.json({ state: 'open', head: { sha, ref: 'mikka/issue-9', repo: { id: 7 } }, base: { ref: 'main', repo: { id: 7 } } })
    return Response.json({ total_count: 2, check_runs: [{ id: 4, name: 'build', status: 'completed', conclusion: 'success' }] })
  }
  await assert.rejects(readCi(binding, env, fetcher), (e: unknown) => e instanceof CiReadError && e.code === 'invalid_response')
})

test('recovers a missed workflow completion using bounded repository-scoped actions reads', async () => {
  const { readPendingCiAttempts } = await import('./read')
  const calls: { url: string; init?: RequestInit }[] = []
  const fetcher: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    if (String(url).includes('access_tokens')) return Response.json({ token: 'fixture-token' })
    const id = Number(String(url).split('/').at(-1))
    return Response.json({ id, head_sha: sha, head_branch: binding.branch, repository: { id: 7 }, run_attempt: 2, status: 'completed' })
  }
  const pending = Array.from({ length: 12 }, (_, i) => ({ runId: String(i + 1), attempt: 1, state: 'requested' as const }))
  const resolved = await readPendingCiAttempts(binding, sha, pending, env, fetcher)
  assert.equal(resolved.length, 10)
  assert.deepEqual(resolved[0], { runId: '1', attempt: 2, state: 'completed' })
  assert.equal(calls.length, 11)
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { repository_ids: [7], permissions: { metadata: 'read', actions: 'read' } })
  assert.ok(calls.every(call => call.url.startsWith('https://api.github.com/') && call.init?.redirect === 'error'))
})

test('attempt recovery fails closed on permission errors, stale or mismatched responses and deadline', async () => {
  const { readPendingCiAttempts } = await import('./read')
  const pending = [{ runId: '4', attempt: 2, state: 'in_progress' as const }]
  await assert.rejects(readPendingCiAttempts(binding, sha, pending, env, async () => new Response(null, { status: 403 })), (e: unknown) => e instanceof CiReadError && e.code === 'permission')
  await assert.rejects(readPendingCiAttempts(binding, sha, pending, env, async () => new Response(null, { status: 422 })), (e: unknown) => e instanceof CiReadError && e.code === 'permission')
  for (const patch of [{ head_sha: 'b'.repeat(40) }, { run_attempt: 1 }, { repository: { id: 8 } }, { status: 'unknown' }]) {
    const fetcher: typeof fetch = async url => String(url).includes('access_tokens') ? Response.json({ token: 'fixture-token' }) : Response.json({ id: 4, head_sha: sha, head_branch: binding.branch, repository: { id: 7 }, run_attempt: 2, status: 'completed', ...patch })
    await assert.rejects(readPendingCiAttempts(binding, sha, pending, env, fetcher), (e: unknown) => e instanceof CiReadError && e.code === 'invalid_response')
  }
  await assert.rejects(readPendingCiAttempts(binding, sha, pending, env, async () => { throw Error('not reached') }, { deadline: Date.now() - 1 }), (e: unknown) => e instanceof CiReadError && e.code === 'unavailable')
})

test('protects against queued workflows and a required check that has not registered', async () => {
  const { summarize } = await import('./snapshot')
  let queued = true, registered = false
  const fetcher: typeof fetch = async url => {
    const path = String(url)
    if (path.includes('access_tokens')) return Response.json({ token: 'fixture-token' })
    if (path.includes('/pulls/')) return Response.json({ state: 'open', head: { sha, ref: binding.branch, repo: { id: 7 } }, base: { ref: 'main', repo: { id: 7 } } })
    if (path.includes('check-runs')) {
      const check_runs = [{ id: 1, name: 'A', status: 'completed', conclusion: 'success', app: { id: 10 } }, ...(registered ? [{ id: 2, name: 'B', status: 'completed', conclusion: 'success', app: { id: 10 } }] : [])]
      return Response.json({ total_count: check_runs.length, check_runs })
    }
    if (path.includes('/status?')) return Response.json({ total_count: 0, statuses: [] })
    if (path.includes('/rules/branches/')) return Response.json([{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'B', integration_id: 10 }] } }])
    if (path.includes('/branches/')) return Response.json({ protected: true, protection: { enabled: true, required_status_checks: { checks: [{ context: 'B', app_id: 10 }], contexts: ['B'] } } })
    if (path.includes('/actions/runs?')) return Response.json({ total_count: 1, workflow_runs: [{ id: 8, workflow_id: 3, event: 'pull_request', created_at: '2026-10-30T00:00:00Z', run_attempt: 1, head_sha: sha, head_branch: binding.branch, name: 'B', status: queued ? 'queued' : 'completed', conclusion: queued ? null : 'success' }] })
    throw Error('unexpected provider request')
  }
  assert.equal(summarize((await readCi(binding, env, fetcher)).snapshot).kind, 'pending')
  queued = false
  assert.equal(summarize((await readCi(binding, env, fetcher)).snapshot).kind, 'pending')
  registered = true
  assert.equal(summarize((await readCi(binding, env, fetcher)).snapshot).kind, 'complete')
})

test('missing branch protection detail and unsupported reusable workflow rules fail closed', async () => {
  let unsupported = false
  const fetcher: typeof fetch = async url => {
    const path = String(url)
    if (path.includes('access_tokens')) return Response.json({ token: 'fixture-token' })
    if (path.includes('/pulls/')) return Response.json({ state: 'open', head: { sha, ref: binding.branch, repo: { id: 7 } }, base: { ref: 'main', repo: { id: 7 } } })
    if (path.includes('check-runs')) return Response.json({ total_count: 1, check_runs: [{ id: 4, name: 'A', status: 'completed', conclusion: 'success' }] })
    if (path.includes('/status?')) return Response.json({ total_count: 0, statuses: [] })
    if (path.includes('/rules/branches/')) return Response.json([{ type: 'workflows' }])
    if (path.includes('/branches/')) return Response.json(unsupported ? { protected: true, protection: { enabled: false } } : { protected: true })
    throw Error('unexpected provider request')
  }
  await assert.rejects(readCi(binding, env, fetcher), (e: unknown) => e instanceof CiReadError && e.code === 'invalid_response')
  unsupported = true
  await assert.rejects(readCi(binding, env, fetcher), (e: unknown) => e instanceof CiReadError && e.code === 'unsupported_required_workflow')
})
