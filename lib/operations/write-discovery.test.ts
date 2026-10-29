import test from 'node:test'
import assert from 'node:assert/strict'
import { createApprovedWriteDiscovery } from './write-discovery'
import { approvedWriteHandler } from './write-http'
import { createPersonalWriteRoute } from './write-route'
import { projectApprovedWriteView, type StoredWriteProposal } from './approved-writes'
import type { OperationRecord } from './ledger'
import { WRITE_ACTIONS, writeTarget } from './write-contract'
import { snapshotDigest } from './write-target'

const actor = { userId: 'owner', sessionId: 'session' }, now = '2026-10-27T12:00:01.000001Z'
type Row = StoredWriteProposal & { cursorCreatedAt: string; aliasCount: string; execution: (OperationRecord & { invokedAt: string | null }) | null }
const id = (n: number) => '00000000-0000-4000-8000-' + n.toString(16).padStart(12, '0')
function row(n: number, at = '2026-10-27T12:00:00.000009Z'): Row {
  const action = WRITE_ACTIONS[n % 3], input = action === 'send_slack_message' ? { channel: 'C12345678', text: 'Literal fixture' } : action === 'append_notion_paragraph' ? { page_id: id(n), text: 'Paragraph' } : { event_id: 'synthetic-event', send_updates: 'none' }
  const context = { targetId: 'synthetic-target' }
  return { id: id(n), userId: 'owner', action, input, context, intentKey: id(n), status: 'pending', createdAt: new Date(at), cursorCreatedAt: at, aliasCount: '1', operationBinding: { provider: 'synthetic', accountId: 'fixture-account', version: 'fixed', payloadDigest: snapshotDigest(input), contextDigest: snapshotDigest(context) }, execution: null }
}
function execute(p: Row, status: OperationRecord['status']) {
  const b = p.operationBinding
  p.execution = { operationId: p.id, ownerId: p.userId, workspaceId: 'personal:' + p.userId, binding: { operationId: p.id, ownerId: p.userId, workspaceId: 'personal:' + p.userId, provider: b.provider, accountId: b.accountId, action: p.action, target: writeTarget(p.action as typeof WRITE_ACTIONS[number], p.input), approvalId: p.id, proposalDigest: snapshotDigest([p.action, b]), payloadDigest: b.payloadDigest }, idempotencyKey: 'private-provider-key', status, attemptToken: 'private-attempt', runId: 'private-run', invokedAt: now, receipt: null }
}
function fixture(records: Row[]) {
  const statements: string[] = []
  let snap: Row[] = [], sessionValid = true, expiryChecks = 0, revoke = false, duplicate = false
  const pool = { connect: async () => ({ release() {}, query: async (sql: string, params: unknown[] = []) => {
    statements.push(sql)
    if (sql === 'BEGIN ISOLATION LEVEL REPEATABLE READ') { snap = structuredClone(records); expiryChecks = 0; return { rows: [] } }
    if (['COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] }
    if (sql.startsWith('SELECT id FROM "session"')) {
      if (sql.includes('expiresAt')) { expiryChecks++; if (revoke && expiryChecks > 1) sessionValid = false }
      return { rows: sessionValid && params[0] === 'session' && (!params[1] || params[1] === 'owner') ? [{ id: 'session' }] : [] }
    }
    if (sql.startsWith('SELECT to_char(clock_timestamp')) return { rows: [{ now }] }
    if (sql.startsWith('SELECT p.*')) {
      assert.ok(sql.includes('l."ownerId"=p."userId"') && sql.includes("l.\"workspaceId\"='personal:'||p.\"userId\""))
      assert.deepEqual(params[1], WRITE_ACTIONS)
      assert.ok(!sql.includes("status='pending'"), 'running/terminal must not disappear from discovery')
      const selected = snap.filter(p => p.userId === params[0] && p.cursorCreatedAt <= String(params[2]) && (!params[3] || p.cursorCreatedAt < String(params[3]) || p.cursorCreatedAt === params[3] && p.id < String(params[4])))
        .sort((a, b) => b.cursorCreatedAt.localeCompare(a.cursorCreatedAt) || b.id.localeCompare(a.id)).slice(0, Number(params[5]))
      return { rows: duplicate && selected[0] ? [selected[0], selected[0]] : selected }
    }
    throw Error('unexpected SQL or mutation: ' + sql)
  } }) } as unknown as Pool
  return { discovery: createApprovedWriteDiscovery(pool), statements, revoke: () => { revoke = true }, expire: () => { sessionValid = false }, duplicate: () => { duplicate = true } }
}

test('microsecond keyset pages cover all three actions without overlap or status-filter loss', async () => {
  const records = [row(1), row(2), row(3, '2026-10-27T12:00:00.000008Z'), row(4, '2026-10-27T12:00:00.000007Z')]
  execute(records[0], 'uncertain'); execute(records[1], 'succeeded'); records[3].status = 'declined'
  const other = row(99); other.userId = 'other'; records.push(other)
  const f = fixture(records), first = await f.discovery.list(actor, { limit: 2 })
  assert.deepEqual(first.items.map(p => p.id), [id(2), id(1)])
  assert.deepEqual(first.items.map(p => p.status), ['done', 'running'])
  assert.equal(first.asOf, now)
  assert.equal(JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString()).after.at, '2026-10-27T12:00:00.000009Z')
  records.push(row(5, '2026-10-27T12:00:02.000000Z'))
  records.push(row(6)) // Late commit with an older creation timestamp: needs refresh.
  execute(records[0], 'succeeded')
  const second = await f.discovery.list(actor, { limit: 2, cursor: first.nextCursor! })
  assert.deepEqual(second.items.map(p => p.id), [id(3), id(4)])
  assert.equal(second.nextCursor, null)
  assert.ok(!second.items.some(p => p.id === id(6)))
  assert.equal(new Set([...first.items, ...second.items].map(p => p.id)).size, 4)
  assert.deepEqual(new Set([...first.items, ...second.items].map(p => p.action)), new Set(WRITE_ACTIONS))
  const refreshed = await f.discovery.list(actor, { limit: 50 })
  assert.ok(refreshed.items.some(p => p.id === id(6)), 'creation cutoff is not a cross-request database snapshot')
  assert.equal(refreshed.items.find(p => p.id === id(1))?.status, 'done')
  assert.deepEqual(refreshed.items.find(p => p.id === id(1)), projectApprovedWriteView(records[0], records[0].execution))
  assert.ok(!JSON.stringify(first).includes('private-'))
  assert.ok(!f.statements.some(s => /^(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)/.test(s)))
})

test('bad bindings and ambiguous intents become redacted attention items without poisoning the page', async () => {
  const bad = row(1), ambiguous = row(2), valid = row(3)
  Reflect.deleteProperty(bad.operationBinding, 'contextDigest'); ambiguous.aliasCount = '2'
  const page = await fixture([bad, ambiguous, valid]).discovery.list(actor, {})
  assert.deepEqual(page.items.map(p => p.status), ['pending', 'attention', 'attention'])
  for (const item of page.items.filter(p => p.status === 'attention')) assert.deepEqual(Object.keys(item).sort(), ['action', 'createdAt', 'error', 'id', 'status'])
  assert.equal(page.items.find(p => p.id === id(1))?.error, 'operationBindingConflict')
  assert.equal(page.items.find(p => p.id === id(2))?.error, 'operationIntentAmbiguous')
})

test('cursors cannot replace actor/session, escape shape limits or survive session expiry', async () => {
  const f = fixture([row(1), row(2)]), first = await f.discovery.list(actor, { limit: 1 })
  const statements = f.statements.length
  await assert.rejects(f.discovery.list({ ...actor, userId: 'other' }, { cursor: first.nextCursor! }), /invalidWriteCursor/)
  await assert.rejects(f.discovery.list({ ...actor, sessionId: 'other' }, { cursor: first.nextCursor! }), /invalidWriteCursor/)
  for (const input of [{ cursor: '%' }, { cursor: 'x'.repeat(1025) }, { limit: 0 }, { limit: 51 }, { ownerId: 'other' }]) await assert.rejects(f.discovery.list(actor, input), /invalidWriteCursor/)
  assert.equal(f.statements.length, statements)
  const parsed = JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString()); parsed.asOf = '2099-01-01T00:00:00.000000Z'
  await assert.rejects(f.discovery.list(actor, { cursor: Buffer.from(JSON.stringify(parsed)).toString('base64url') }), /invalidWriteCursor/)
  f.expire(); await assert.rejects(f.discovery.list(actor, { cursor: first.nextCursor! }), /operationSessionUnavailable/)
  const revoked = fixture([row(1)]); revoked.revoke()
  await assert.rejects(revoked.discovery.list(actor, {}), /operationSessionUnavailable/)
  const duplicated = fixture([row(1)]); duplicated.duplicate()
  await assert.rejects(duplicated.discovery.list(actor, { limit: 2 }), /operationBindingConflict/)
})

test('registered HTTP list wiring authenticates, rejects authority fields and never constructs write services', async () => {
  const f = fixture([row(1)]), auth = { api: { getSession: async () => ({ user: { id: 'owner' }, session: { id: 'session' } }) } }
  const operations = () => { throw Error('list must not construct provider/write services') }
  const handler = createPersonalWriteRoute({ enabled: () => true, load: async () => ({ auth, operations, discovery: f.discovery }) })
  const req = (body: unknown, headers: Record<string, string> = {}) => new Request('https://candidate.invalid/api/approved-writes', { method: 'POST', headers: { origin: 'https://candidate.invalid', cookie: 'synthetic=fixture', ...headers }, body: JSON.stringify(body) })
  assert.equal((await handler(req({ op: 'list', ownerId: 'other' }))).status, 400)
  assert.equal((await handler(req({ op: 'list' }, { authorization: 'Bearer synthetic' }))).status, 401)
  assert.equal((await handler(req({ op: 'list' }, { origin: 'https://other.invalid' }))).status, 403)
  const response = await handler(req({ op: 'list' }))
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal((await response.json()).items[0].id, id(1))
  const missing = approvedWriteHandler(auth, operations)
  assert.equal((await missing(req({ op: 'list' }))).status, 503)
  const closed = createPersonalWriteRoute({ enabled: () => false, load: async () => { throw Error('must not load') } })
  assert.deepEqual(await (await closed(req({ op: 'list' }))).json(), { error: 'approvedWritesDisabled' })
})

// In-memory transport only; retain the real API pool type.
type Pool = Parameters<typeof createApprovedWriteDiscovery>[0]
