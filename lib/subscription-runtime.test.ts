import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'

const checkouts: string[] = []
const pool = {
  options: { connectionString: 'postgres://mikka.invalid/test' },
  query: async () => ({ rows: [] }),
  connect: async () => {
    const statements: string[] = []
    checkouts.push('connect')
    return { query: async (text: string) => { statements.push(text); return { rows: [] } }, release: () => { checkouts.push(statements.join(';')) } }
  },
}
let runtime: typeof import('./subscription-runtime')

before(async () => {
  mock.module('./db', { namedExports: { pool } })
  const switches = await import('./deployment-switches')
  for (const name of ['byos', 'byosClaudeOAuth', 'byosCodexOAuth'] as const) switches.overrideDeploymentSwitch(name, true)
  Object.assign(process.env, {
    MIKKA_BYOS_INFISICAL_ORIGIN: 'https://infisical.invalid', MIKKA_BYOS_INFISICAL_PROJECT: 'project', MIKKA_BYOS_INFISICAL_ENVIRONMENT: 'prod',
    MIKKA_BYOS_INFISICAL_PATH: '/custody', MIKKA_BYOS_ACCESS_INFISICAL_PATH: '/access', MIKKA_BYOS_CUSTODY_CLIENT_ID: 'custody', MIKKA_BYOS_CUSTODY_CLIENT_SECRET: 'secret',
    MIKKA_BYOS_SHARED_CUSTODY_IDENTITY: '1',
  })
  runtime = await import('./subscription-runtime')
})

// 连接 reserves its sign-in in a transaction. The runtime's repository once had
// only a bound query, so every new sign-in was refused as backend_unavailable.
test('连接 reserves a new sign-in on a checked-out connection', async () => {
  const service = runtime.subscriptionRuntime()
  const { created } = await service.repository.acquire('owner', '00000000-0000-4000-8000-000000000001', 'claude')
  assert.equal(created, true)
  assert.equal(checkouts[0], 'connect')
  assert.match(checkouts[1], /^begin;.*insert into byos_connections.*;commit$/s)
})
