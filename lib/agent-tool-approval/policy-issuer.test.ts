import assert from 'node:assert/strict'
import { IncomingMessage } from 'node:http'
import { Socket } from 'node:net'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { BASE_PATH } from '../base-path'
import * as server from './policy-distribution'
import { NodeNextRequest } from 'next/dist/server/base-http/node'
import { addRequestMeta } from 'next/dist/server/request-meta'
import { NextRequestAdapter } from 'next/dist/server/web/spec-extension/adapters/next-request'
import { removePathPrefix } from 'next/dist/shared/lib/router/utils/remove-path-prefix'
import { defaultRunPolicy } from '@mikka/protocol/agent-policy'
import { HttpServerLink } from '../../packages/daemon/src/server-link-http'

const origin = 'http://localhost:3100'
const deviceId = 'bb053a69-908b-420c-925c-78aceb15d0ec'
const runId = 'c708f6b3-d3f2-4419-9c93-882b0f7e4bf7'

/** base-server strips config.basePath before the real adapter constructs Request.url. */
function routeRequest(path: string, basePath: string, method: string) {
  const incoming = new IncomingMessage(new Socket())
  incoming.method = method
  incoming.url = `${basePath}${path}`
  incoming.headers = { host: 'localhost:3100' }
  const node = new NodeNextRequest(incoming)
  addRequestMeta(node, 'initURL', `${origin}${node.url}`)
  node.url = removePathPrefix(node.url, basePath)
  const request = NextRequestAdapter.fromNodeNextRequest(node, new AbortController().signal)
  assert.equal(new URL(request.url).pathname, path.split('?')[0])
  return { request, close: () => incoming.destroy() }
}

if (process.env.MIKKA_POLICY_ISSUER_FIXTURE !== '1') {
  test('real Next normalization preserves the configured issuer through signed claim and daemon verification', async t => {
    for (const basePath of ['/mikka', '']) await t.test(basePath || 'direct HTTP without basePath', () => {
      // A fresh process loads the actual public config before any import; no
      // mocked issuer/key or alternate validation path can make this pass.
      const env: NodeJS.ProcessEnv = { ...process.env, MIKKA_POLICY_ISSUER_FIXTURE: '1', MIKKA_BASE_PATH: basePath, BETTER_AUTH_SECRET: 'isolated-next-policy-issuer-fixture-only' }
      delete env.NODE_TEST_CONTEXT
      const result = spawnSync(process.execPath, ['--import', './tests/support/server-only.mjs', '--import', 'tsx', '--test', fileURLToPath(import.meta.url)], {
        cwd: fileURLToPath(new URL('../../', import.meta.url)), encoding: 'utf8', timeout: 20_000,
        env,
      })
      assert.match(result.stdout, /configured deployment issuer survives the actual Next request adapter/)
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    })
  })
} else {
  test('configured deployment issuer survives the actual Next request adapter', async t => {
    const basePath = process.env.MIKKA_BASE_PATH!
    assert.equal(BASE_PATH, basePath)
    const claim = routeRequest(`/v1/devices/${deviceId}/runs/${runId}/claim`, basePath, 'POST')
    const metadata = routeRequest(`/v1/runs/${runId}/policy-snapshot?deviceId=${deviceId}`, basePath, 'GET')
    t.after(() => { claim.close(); metadata.close() })
    const current = { revision: 'a'.repeat(64), workspaceIds: [], hierarchy: undefined, policySnapshotRequired: true }
    const context = server.policyDistributionContext(server.requestPolicyIssuer(claim.request), 'owner', deviceId, runId, current)
    const independentlyFetched = server.policyDistributionContext(server.requestPolicyIssuer(metadata.request), 'owner', deviceId, runId, current)
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
