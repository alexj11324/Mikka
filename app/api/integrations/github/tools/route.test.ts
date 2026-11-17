import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'

let owner: string | null = 'owner'
let catalogue: Record<string, unknown> | Error = {}
const asked: string[] = []
const stub = (path: string, namedExports: Record<string, unknown>) => mock.module(new URL(path, import.meta.url).href, { namedExports })
stub('../../../../../lib/api-auth.ts', { auth: { api: { getSession: async () => owner ? { user: { id: owner } } : null } } })
stub('../../../../../lib/request-log.ts', { withRequestLog: (_path: string, handler: unknown) => handler })
stub('../../../../../lib/app-tool-catalogue.ts', { readAppToolCatalogue: async (userId: string, app: string) => {
  asked.push(`${userId}:${app}`)
  if (catalogue instanceof Error) throw catalogue
  return catalogue
} })
let route: typeof import('./route')
before(async () => { route = await import('./route') })
beforeEach(() => { owner = 'owner'; asked.length = 0 })
const read = async () => { const response = await route.GET(new Request('https://mikka.example/api/integrations/github/tools')); return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control') } }

test('the signed-in person gets every tool GitHub lists for them, with its title, description and read-only mark', async () => {
  catalogue = { app: 'github', count: 2, readOnlyCount: 1, truncated: false, tools: [
    { name: 'get_file_contents', displayName: 'Get file or directory contents', readOnly: true, description: 'Get the contents of a file.' },
    { name: 'merge_pull_request', displayName: 'Merge pull request', readOnly: false },
  ] }
  const { status, body, cache } = await read()
  assert.equal(status, 200)
  assert.deepEqual(asked, ['owner:github'])
  assert.equal(cache, 'private, no-store')
  assert.deepEqual(body, { viewerId: 'owner', count: 2, readOnlyCount: 1, truncated: false, tools: [
    { name: 'get_file_contents', displayName: 'Get file or directory contents', readOnly: true, description: 'Get the contents of a file.' },
    { name: 'merge_pull_request', displayName: 'Merge pull request', readOnly: false },
  ] })
})

test('no session asks GitHub for nothing', async () => {
  owner = null
  const { status, body } = await read()
  assert.equal(status, 401); assert.deepEqual(body, { error: 'authRequired' })
  assert.deepEqual(asked, [])
})

test('not connected, reconnect and unreachable GitHub are distinct answers, never a partial list', async () => {
  const cases: [unknown, number, string][] = [
    ['githubNotConnected', 409, 'githubNotConnected'], ['githubNotConfigured', 409, 'githubNotConnected'],
    ['githubReconnectRequired', 401, 'githubReconnectRequired'],
    ['mcpUnavailable', 502, 'githubUnavailable'], ['githubToolCatalogueInvalid', 502, 'githubUnavailable'],
  ]
  for (const [error, expectedStatus, code] of cases) {
    catalogue = { app: 'github', count: 1, readOnlyCount: 1, truncated: true, tools: [{ name: 'partial', displayName: 'Partial', readOnly: true }], error }
    const { status, body } = await read()
    assert.equal(status, expectedStatus, String(error))
    assert.deepEqual(body, { viewerId: 'owner', error: code })
  }
  catalogue = new Error('synthetic failure')
  const { status, body } = await read()
  assert.equal(status, 502); assert.deepEqual(body, { viewerId: 'owner', error: 'githubUnavailable' })
})
