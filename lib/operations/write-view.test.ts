import test from 'node:test'
import assert from 'node:assert/strict'
import { createApprovedWrites } from './approved-writes'
import { approvedWriteHandler } from './write-http'
import { snapshotDigest } from './write-target'
import { writeTarget, type WriteProvider } from './write-contract'

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const action = 'send_slack_message'
function fixture() {
  const input = { channel: 'C12345678', text: 'Literal fixture' }, context = { targetId: 'C12345678' }
  const binding = { provider: 'synthetic', accountId: 'bound', version: 'fixed', payloadDigest: snapshotDigest(input), contextDigest: snapshotDigest(context) }
  const row = { id, userId: 'owner', action, input, context, intentKey: id, operationBinding: binding, status: 'pending', createdAt: new Date('2026-10-27T12:00:00Z') }
  const operationBinding = { operationId: id, ownerId: 'owner', workspaceId: 'personal:owner', provider: binding.provider, accountId: binding.accountId, action, target: writeTarget(action, input), approvalId: id, proposalDigest: snapshotDigest([action, binding]), payloadDigest: binding.payloadDigest }
  let execution: null | { binding: typeof operationBinding; status: string; invokedAt: Date | null; idempotencyKey: string; attemptToken: string } = null
  let validSession = true, aliases = 1, expiryCheck = 0, revokeDuringRead = false
  const statements: string[] = []
  const pool = { connect: async () => ({ release() {}, query: async (sql: string, params: unknown[] = []) => {
    statements.push(sql)
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql) || sql.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [] }
    if (sql.startsWith('SELECT * FROM operation_ledger') || sql.startsWith('SELECT status,"invokedAt" FROM operation_ledger')) return { rows: params[0] === id && params[1] === 'owner' && (!params[2] || params[2] === 'personal:owner') && execution ? [execution] : [] }
    if (sql.startsWith('SELECT id FROM "session"')) {
      if (sql.includes('expiresAt')) { expiryCheck++; if (revokeDuringRead && expiryCheck > 1) validSession = false }
      return { rows: validSession && params[0] === 'session' && (!params[1] || params[1] === 'owner') ? [{ id: 'session' }] : [] }
    }
    if (sql.startsWith('SELECT * FROM pending_actions')) return { rows: params[0] === id && params[1] === row.userId ? [row] : [] }
    if (sql.startsWith('SELECT id FROM pending_actions')) return { rows: Array.from({ length: aliases }, () => ({ id })) }
    throw Error('mutation or unexpected SQL attempted: ' + sql)
  } }) } as unknown as Pool
  const forbidden = async (): Promise<never> => { throw Error('view must never call provider') }
  const provider: WriteProvider = { name: 'synthetic', prepare: forbidden, execute: forbidden, lookup: forbidden }
  return { row, statements, service: createApprovedWrites(pool, provider, action), otherAction: createApprovedWrites(pool, provider, 'cancel_calendar_event'), setSession: (v: boolean) => { validSession = v }, revokeDuringRead: () => { revokeDuringRead = true }, setAliases: (v: number) => { aliases = v }, execute: (status: string) => { execution = { binding: { ...operationBinding }, status, invokedAt: new Date(), idempotencyKey: 'private-provider-key', attemptToken: 'private-attempt-token' }; return execution } }
}

test('owned approval view returns exact stored snapshot without approving, invoking or exposing ledger tokens', async () => {
  const f = fixture(), actor = { userId: 'owner', sessionId: 'session' }
  const view = await f.service.view(actor, id)
  assert.deepEqual(view, { id, action, input: f.row.input, approvalContext: f.row.context, account: { provider: 'synthetic', accountId: 'bound', version: 'fixed' }, createdAt: '2026-10-27T12:00:00.000Z', approvalExpiresAt: '2026-11-03T12:00:00.000Z', status: 'pending', error: null })
  assert.equal(f.row.status, 'pending')
  assert.ok(!f.statements.some(s => /^(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)/.test(s)))
  f.execute('uncertain')
  for (let i = 0; i < 2; i++) {
    const unknown = await f.service.view(actor, id)
    assert.equal(unknown.status, 'running'); assert.equal(unknown.error, 'operationUncertain')
    assert.ok(!JSON.stringify(unknown).includes('private-'))
  }
  f.execute('succeeded'); f.row.status = 'running'
  assert.equal((await f.service.view(actor, id)).status, 'done')
  assert.equal(f.row.status, 'running', 'view never writes back a stale pending_actions projection')
})

test('view rejects owner/session/action mismatch, ambiguous intents, tampering and mid-read expiry', async () => {
  const actor = { userId: 'owner', sessionId: 'session' }
  await assert.rejects(fixture().service.view({ ...actor, userId: 'other' }, id), /operationSessionUnavailable/)
  await assert.rejects(fixture().service.view({ ...actor, sessionId: 'other' }, id), /operationSessionUnavailable/)
  await assert.rejects(fixture().otherAction.view(actor, id), /pendingActionUnavailable/)
  const absent = fixture(); absent.row.userId = 'other'
  await assert.rejects(absent.service.view(actor, id), /pendingActionUnavailable/)
  const expired = fixture(); expired.setSession(false)
  await assert.rejects(expired.service.view(actor, id), /operationSessionUnavailable/)
  const revoked = fixture(); revoked.revokeDuringRead()
  await assert.rejects(revoked.service.view(actor, id), /operationSessionUnavailable/)
  const ambiguous = fixture(); ambiguous.setAliases(2)
  await assert.rejects(ambiguous.service.view(actor, id), /operationIntentAmbiguous/)
  const tampered = fixture(); tampered.row.input.text = 'Not approved'
  await assert.rejects(tampered.service.view(actor, id), /operationBindingConflict/)
  const legacy = fixture(); Reflect.deleteProperty(legacy.row.operationBinding, 'contextDigest')
  await assert.rejects(legacy.service.view(actor, id), /operationBindingConflict/)
  await assert.rejects(legacy.service.decide(actor, id, true), /operationBindingConflict/)
  const wrongLedger = fixture(); wrongLedger.execute('succeeded').binding.accountId = 'other'
  await assert.rejects(wrongLedger.service.view(actor, id), /operationBindingConflict/)
  const inconsistent = fixture(); inconsistent.row.status = 'done'
  await assert.rejects(inconsistent.service.view(actor, id), /operationBindingConflict/)
  const falselyDeclined = fixture(); falselyDeclined.execute('uncertain'); falselyDeclined.row.status = 'declined'
  await assert.rejects(falselyDeclined.service.view(actor, id), /operationBindingConflict/)
})

test('HTTP view uses authenticated actor only and preserves strict browser envelope', async () => {
  const f = fixture()
  const handler = approvedWriteHandler({ api: { getSession: async () => ({ user: { id: 'owner' }, session: { id: 'session' } }) } }, () => f.service)
  const request = (body: unknown, headers: Record<string, string> = {}) => new Request('https://candidate.invalid/api/approved-writes', { method: 'POST', headers: { origin: 'https://candidate.invalid', cookie: 'synthetic=fixture', ...headers }, body: JSON.stringify(body) })
  const body = { op: 'view', action, id }
  for (const bad of [{ ...body, approve: true }, { ...body, ownerId: 'other' }, { ...body, id: 'bad' }]) assert.equal((await handler(request(bad))).status, 400)
  assert.equal((await handler(request(body, { authorization: 'Bearer synthetic' }))).status, 401)
  assert.equal((await handler(request(body, { origin: 'https://other.invalid' }))).status, 403)
  assert.equal(f.statements.length, 0)
  const response = await handler(request(body))
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal((await response.json()).status, 'pending')
})

// In-memory transport only; retain the real API pool type.
type Pool = Parameters<typeof createApprovedWrites>[0]
