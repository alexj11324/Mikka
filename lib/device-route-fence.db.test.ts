import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { mock, test } from 'node:test'
import { Pool } from 'pg'
import { disposableDatabase } from '../tests/helpers/e2e-target.mjs'

// withDeviceRoute has no check up front: a revoked token is refused by the handler's first
// database statement (lib/db/device-scope.ts). That holds only while no route acts before its
// first statement. Every route here runs with a caller that passed authentication and whose
// token was revoked right after: none may succeed, call out, or issue a credential.
const url = disposableDatabase() ? process.env.E2E_DATABASE_URL : undefined
if (process.env.REQUIRE_DB === '1' && !url) throw new Error('Device route fence test requires a loopback *_e2e database')

const issued: string[] = []

async function routeFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const nested = await Promise.all(entries.map(entry => entry.isDirectory() ? routeFiles(join(dir, entry.name)) : Promise.resolve(entry.name === 'route.ts' ? [join(dir, entry.name)] : [])))
  return nested.flat()
}

test('every device route refuses a token revoked after authentication before it calls out or issues anything', { skip: !url }, async t => {
  // The issuing steps of the three routes that hand out credentials record any call.
  const [githubAccess, runtime] = await Promise.all([import('./github/user-access'), import('./subscription-runtime')])
  mock.module(new URL('./github/user-access.ts', import.meta.url).href, { namedExports: {
    ...githubAccess,
    githubTokenForUser: async () => { issued.push('github-token'); return { token: 'fixture', expiresAt: null } },
  } })
  mock.module(new URL('./subscription-runtime.ts', import.meta.url).href, { namedExports: {
    ...runtime,
    subscriptionRuntime: () => { issued.push('subscription-runtime'); return { nativeRun: async () => { issued.push('subscription-run') }, nativeLease: async () => { issued.push('subscription-lease'); return {} } } },
  } })
  const distribution = await import('./agent-tool-approval/policy-distribution')
  mock.module(new URL('./agent-tool-approval/policy-distribution.ts', import.meta.url).href, { namedExports: {
    ...distribution,
    issuePolicySnapshot: (...args: unknown[]) => { issued.push('policy-snapshot'); return (distribution.issuePolicySnapshot as (...a: unknown[]) => unknown)(...args) },
    policyDistributionContext: (...args: unknown[]) => { issued.push('policy-context'); return (distribution.policyDistributionContext as (...a: unknown[]) => unknown)(...args) },
  } })
  const admin = new Pool({ connectionString: url, max: 2 })
  const { readFile } = await import('node:fs/promises')
  const { deviceRequestCaller } = await import('./device-request-context')
  const owner = `fence-${randomUUID()}`, device = randomUUID(), workspace = randomUUID(), token = randomUUID()
  const outbound: string[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => { outbound.push(String(input instanceof Request ? input.url : input)); throw new Error('no outbound call in this test') }) as typeof fetch
  try {
    await admin.query('INSERT INTO devices(id,"ownerId",name,kind) VALUES($1,$2,$3,$4)', [device, owner, 'Fence fixture', 'cloud'])
    await admin.query('INSERT INTO device_tokens(id,"userId","tokenHash","revokedAt","boundDeviceId","boundWorkspaceId","expiresAt") VALUES($1,$2,$3,now(),$4,$5,now()+interval \'1 hour\')',
      [token, owner, randomBytes(32).toString('hex'), device, workspace])
    // Authentication passed (as withDeviceRoute's own authenticateDevice call would admit it); the token is already revoked.
    const caller = { userId: owner, tokenId: token, scopeDeviceId: device, scopeWorkspaceId: workspace }
    const routes = (await routeFiles('app/v1')).filter(file => !file.includes('/register/'))
    const fenced: string[] = []
    for (const file of routes) {
      const source = await readFile(file, 'utf8')
      if (!source.includes('withDeviceRoute(')) continue
      const route = await import(`../${file}`) as Record<string, unknown>
      for (const method of ['GET', 'POST', 'PATCH', 'PUT', 'DELETE']) {
        const handler = route[method] as ((request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>) | undefined
        if (!handler) continue
        const path = file.replace(/^app/, '').replace(/\/route\.ts$/, '').replaceAll('[deviceId]', device).replace(/\[[^\]]+\]/g, () => randomUUID())
        const request = new Request(`http://127.0.0.1/mikka${path}?deviceId=${device}`, {
          method, headers: { authorization: 'Bearer revoked', 'content-type': 'application/json' },
          ...(method === 'GET' ? {} : { body: JSON.stringify({ deviceId: device }) }),
        })
        const params = Promise.resolve({ deviceId: device, runId: randomUUID(), captureId: randomUUID(), requestId: randomUUID() })
        const response = await deviceRequestCaller.run(caller, () => handler(request, { params }))
        assert.ok(response.status >= 400, `${method} ${file} answered ${response.status} for a revoked token`)
        fenced.push(`${method} ${file} ${response.status}`)
      }
    }
    t.diagnostic(JSON.stringify({ routes: fenced.length }))
    // The three routes that hand out credentials answer a revoked token as what it is, an authentication failure.
    for (const route of ['POST app/v1/devices/[deviceId]/github-token/route.ts', 'GET app/v1/runs/[runId]/policy-snapshot/route.ts', 'POST app/v1/devices/[deviceId]/runs/[runId]/subscription-lease/route.ts']) {
      assert.ok(fenced.includes(`${route} 401`), `${route} answered ${fenced.find(line => line.startsWith(route)) ?? 'nothing'}`)
    }
    assert.deepEqual(issued, [], 'nothing was issued for a revoked token')
    assert.deepEqual(outbound, [], 'no route called out for a revoked token')
  } finally {
    globalThis.fetch = realFetch
    await admin.query('DELETE FROM device_tokens WHERE id=$1', [token])
    await admin.query('DELETE FROM devices WHERE id=$1', [device])
    await admin.end()
  }
})
