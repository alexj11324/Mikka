import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'

// The route and lib/github/plugin-permissions.ts run as written; only the
// session and the transaction are replaced. Rows are kept per owner, as
// agent_kit_heads keeps them per (owner_id, 'coordinator').
type Row = { cli: Record<string, unknown>; cliVersion: number; external: Record<string, unknown>; externalVersion: number }
const rows = new Map<string, Row>()
const queries: { sql: string; params: unknown[] }[] = []
let sessionUser: string | null = 'owner'

const client = {
  async query(sql: string, params: unknown[] = []) {
    queries.push({ sql, params })
    const owner = params[0] as string
    if (sql.startsWith('INSERT INTO agent_kit_heads')) { if (!rows.has(owner)) rows.set(owner, { cli: {}, cliVersion: 0, external: {}, externalVersion: 0 }); return { rows: [] } }
    const view = (row: Row | undefined) => row ? [{ cli: row.cli, cliVersion: String(row.cliVersion), external: row.external, externalVersion: String(row.externalVersion) }] : []
    if (sql.startsWith('SELECT cli_run_policy')) return { rows: view(rows.get(owner)) }
    if (sql.startsWith('UPDATE agent_kit_heads')) {
      const row = rows.get(owner)!
      const [, cli, external] = params as [string, Record<string, unknown>, Record<string, unknown>]
      if (JSON.stringify(cli) !== JSON.stringify(row.cli)) { row.cli = cli; row.cliVersion++ }
      if (JSON.stringify(external) !== JSON.stringify(row.external)) { row.external = external; row.externalVersion++ }
      return { rows: view(row) }
    }
    return { rows: [] }
  },
}
mock.module(new URL('../../../../../lib/auth.ts', import.meta.url).href, { namedExports: { auth: { api: { getSession: async () => sessionUser ? { user: { id: sessionUser } } : null } } } })
mock.module(new URL('../../../../../lib/db/index.ts', import.meta.url).href, { namedExports: { pool: {}, db: {} } })
mock.module(new URL('../../../../../lib/request-log.ts', import.meta.url).href, { namedExports: { withRequestLog: (_route: string, handler: unknown) => handler, noteLogUser: () => {} } })
mock.module(new URL('../../../../../lib/operations/write-transaction.ts', import.meta.url).href, { namedExports: { writeTransaction: async (_pool: unknown, work: (tx: typeof client) => Promise<unknown>) => work(client) } })

let GET: typeof import('./route')['GET']
let PATCH: typeof import('./route')['PATCH']
before(async () => { ({ GET, PATCH } = await import('./route')) })
beforeEach(() => { rows.clear(); queries.length = 0; sessionUser = 'owner' })

const origin = 'https://mikka.example'
const read = () => GET(new Request(`${origin}/api/integrations/github/permissions`))
const patch = (body: unknown, from: string | null = origin) => PATCH(new Request(`${origin}/api/integrations/github/permissions`, {
  method: 'PATCH', headers: { 'Content-Type': 'application/json', ...(from ? { origin: from } : {}) }, body: JSON.stringify(body),
}))

test('unset settings read as today: push asks, the pull request opens', async () => {
  const response = await read()
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { viewerId: 'owner', push: 'ask', pullRequest: 'allow', version: '0:0' })
})

test('requires a session, the page origin and only the two decisions', async () => {
  sessionUser = null
  assert.equal((await read()).status, 401)
  assert.equal((await patch({ version: '0:0', push: 'allow' })).status, 401)
  sessionUser = 'owner'
  for (const from of ['https://other.example', null]) assert.equal((await patch({ version: '0:0', push: 'allow' }, from)).status, 403)
  for (const body of [
    { version: '0:0' }, { version: '0:0', push: 'always' }, { version: 'x', push: 'allow' }, { push: 'allow' },
    { version: '0:0', push: 'allow', userId: 'victim' }, { version: '0:0', network: 'allow' }, null,
  ]) assert.equal((await patch(body)).status, 400, JSON.stringify(body))
  assert.ok(!queries.some(query => query.sql.startsWith('UPDATE')), 'nothing was written')
})

test('writes the Coordinator\'s own git_push and github_pull_request, keeping its other choices', async () => {
  rows.set('owner', { cli: { permissions: { network: 'deny' }, approvalMode: 'ask' }, cliVersion: 2, external: { gmail_send_email: 'ask' }, externalVersion: 5 })
  const first = await patch({ version: '2:5', push: 'deny' })
  assert.deepEqual(await first.json(), { viewerId: 'owner', push: 'deny', pullRequest: 'allow', version: '3:5' })
  const second = await patch({ version: '3:5', pullRequest: 'ask' })
  assert.deepEqual(await second.json(), { viewerId: 'owner', push: 'deny', pullRequest: 'ask', version: '3:6' })
  assert.deepEqual(rows.get('owner'), { cli: { permissions: { network: 'deny', git_push: 'deny' }, approvalMode: 'ask' }, cliVersion: 3, external: { gmail_send_email: 'ask', github_pull_request: 'ask' }, externalVersion: 6 })
  for (const query of queries.filter(query => /agent_kit_heads/.test(query.sql))) assert.equal(query.params[0], 'owner')
})

test('a stale version is refused, and one person never reaches another\'s row', async () => {
  rows.set('other', { cli: {}, cliVersion: 0, external: {}, externalVersion: 0 })
  assert.equal((await patch({ version: '0:0', push: 'allow' })).status, 200)
  const stale = await patch({ version: '0:0', pullRequest: 'deny' })
  assert.equal(stale.status, 409)
  assert.equal((await stale.json()).error, 'githubPermissionsChanged')
  assert.deepEqual(rows.get('other'), { cli: {}, cliVersion: 0, external: {}, externalVersion: 0 })
  sessionUser = 'other'
  assert.deepEqual(await (await read()).json(), { viewerId: 'other', push: 'ask', pullRequest: 'allow', version: '0:0' })
})

test('a malformed stored setting is unavailable, never a default', async () => {
  rows.set('owner', { cli: { permissions: { git_push: 'sometimes' } }, cliVersion: 1, external: {}, externalVersion: 0 })
  const response = await read()
  assert.equal(response.status, 409)
  assert.equal((await response.json()).error, 'githubPermissionsUnavailable')
  assert.equal((await patch({ version: '1:0', push: 'allow' })).status, 409)
})
