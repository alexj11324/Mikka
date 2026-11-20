import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { BASE_PATH } from '../base-path'
import * as server from './policy-distribution'
import { NextRequest } from '@/lib/server-runtime/server'
import { defaultRunPolicy } from '@mikka/protocol/agent-policy'
import { HttpServerLink } from '../../packages/daemon/src/server-link-http'

const origin = 'http://localhost:3100'
const deviceId = 'bb053a69-908b-420c-925c-78aceb15d0ec'
const runId = 'c708f6b3-d3f2-4419-9c93-882b0f7e4bf7'

/**
 * The two request shapes the server actually produces for a route handler:
 *
 * - the transport hands over the original Request, whose URL still carries the
 *   deployment base path;
 * - the server facade (`NextRequest`) exposes `nextUrl` with the base path
 *   stripped, while `request.url` keeps it.
 *
 * Both must yield the same issuer: the configured deployment origin.
 */
function routeRequest(path: string) {
  const request = new NextRequest(`${origin}${BASE_PATH}${path}`, { nextConfig: { basePath: BASE_PATH } })
  assert.equal(request.nextUrl.pathname, path.split('?')[0], 'the facade strips the base path from nextUrl')
  assert.equal(new URL(request.url).pathname, `${BASE_PATH}${path.split('?')[0]}`, 'the transport URL keeps it')
  return request
}

if (process.env.MIKKA_POLICY_ISSUER_FIXTURE !== '1') {
  test('real request adaptation preserves the configured issuer through signed claim and daemon verification', async t => {
    for (const basePath of ['/mikka', '']) await t.test(basePath || 'direct HTTP without basePath', () => {
      // A fresh process loads the actual public config before any import; no
      // mocked issuer/key or alternate validation path can make this pass.
      const env: NodeJS.ProcessEnv = { ...process.env, MIKKA_POLICY_ISSUER_FIXTURE: '1', MIKKA_BASE_PATH: basePath, BETTER_AUTH_SECRET: 'isolated-policy-issuer-fixture-only' }
      delete env.NODE_TEST_CONTEXT
      const result = spawnSync(process.execPath, ['--import', './tests/support/server-only.mjs', '--import', 'tsx', '--test', fileURLToPath(import.meta.url)], {
        cwd: fileURLToPath(new URL('../../', import.meta.url)), encoding: 'utf8', timeout: 20_000,
        env,
      })
      assert.match(result.stdout, /configured deployment issuer survives the actual request adapter/)
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    })
  })
} else {
  test('configured deployment issuer survives the actual request adapter', async t => {
    const basePath = process.env.MIKKA_BASE_PATH!
    assert.equal(BASE_PATH, basePath)
    const claim = routeRequest(`/v1/devices/${deviceId}/runs/${runId}/claim`)
    const metadata = routeRequest(`/v1/runs/${runId}/policy-snapshot?deviceId=${deviceId}`)
    t.after(() => {})
    const current = { revision: 'a'.repeat(64), workspaceIds: [], hierarchy: undefined, policySnapshotRequired: true }
    const context = server.policyDistributionContext(server.requestPolicyIssuer(claim), 'owner', deviceId, runId, current)
    const independentlyFetched = server.policyDistributionContext(server.requestPolicyIssuer(metadata), 'owner', deviceId, runId, current)
    const policy = defaultRunPolicy()
    const assignment = { runId, deviceId, repoId: 'repo', issueId: 'issue', harness: 'mock' as const, prompt: 'task', policy,
      policyRevision: current.revision, policySnapshotRequired: true, policySnapshot: server.issuePolicySnapshot(context, policy) }
    const link = new HttpServerLink(`${origin}${basePath}`, async () => Response.json(independentlyFetched))
    await link.verifyRunPolicy(assignment, new AbortController().signal)
    assert.equal(context.issuer, `${origin}${basePath}`)
    assert.equal(assignment.policySnapshot.payload.issuer, context.issuer)
    // A plain Request whose prefix remains intact must not receive it twice.
    assert.equal(server.requestPolicyIssuer(new Request(`${origin}${basePath}/v1/runs/${runId}/policy-snapshot`)), `${origin}${basePath}`)
  })
}
