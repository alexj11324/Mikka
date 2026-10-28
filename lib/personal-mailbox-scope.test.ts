import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { SessionMailbox } from './session-mailbox'

// Bounded pool/interleaving model, not PostgreSQL. Actual agentScope and store
// run with five already-held transaction clients; global app re-entry fails.
let globalQueries = 0, membership = 'active'
mock.module(new URL('./db/index.ts', import.meta.url).href, { exports: {
  pool: {}, db: { select() { globalQueries++; throw Error('Nested app connection would exhaust max5') } },
} })
const workspaceDb = { select() {
  const chain = { from() { return chain }, where() { return chain }, limit: async () => membership === 'active' ? [{ status: 'active' }] : [] }
  return chain
} }
mock.module(new URL('./workspace-db.ts', import.meta.url).href, { exports: { workspaceDb } })
test('five actual mailbox transactions reuse their app client for Bot scope and retain active-member checks', async () => {
  const { agentScope } = await import('./agent-kit/service')
  let connections = 0, held = 0, max = 0, began = 0, committed = 0
  let enter!: () => void
  const allBegan = new Promise<void>(r => { enter = r })
  const pool = { async connect() {
    connections++; held++; max = Math.max(max, held); assert.ok(held <= 5)
    return { release() { held-- }, async query(sql: string) {
      if (sql === 'begin') { began++; if (began === 5) enter(); await allBegan }
      if (sql === 'commit') committed++
      if (sql.startsWith('select "workspaceId" from bots')) return { rows: [{ workspaceId: 'namespace' }] }
      if (sql.startsWith('select * from session_mailboxes')) return { rows: [{ userId: 'owner', workspaceId: 'namespace', kind: 'coordinator' }] }
      return { rows: [] }
    } }
  } }
  const store = new SessionMailbox(pool as unknown as ConstructorParameters<typeof SessionMailbox>[0], 'namespace', async client => {
    assert.equal((await agentScope('owner', '28700000-0000-4000-8000-000000000001', client)).workspaceId, 'namespace')
  })
  await Promise.all(Array.from({ length: 5 }, () => store.inbox({ userId: 'owner', workspaceId: 'namespace', mailboxId: 'box' })))
  assert.equal(connections, 5); assert.equal(max, 5); assert.equal(held, 0); assert.equal(committed, 5); assert.equal(globalQueries, 0)
  for (const status of ['removed', 'suspended']) {
    membership = status
    await assert.rejects(store.inbox({ userId: 'owner', workspaceId: 'namespace', mailboxId: 'box' }), /agentScopeNotFound/)
    assert.equal(committed, 5)
  }
  membership = 'active'
})
