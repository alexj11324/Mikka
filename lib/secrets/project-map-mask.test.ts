import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { beforeEach, mock, test } from 'node:test'
import { drizzle } from 'drizzle-orm/node-postgres'
import { e2bKeyAad, sealSecret, secretAad, userE2bKeyAad, userSecretAad } from './crypto'

const env = { WORKSPACE_SECRETS_KEY: randomBytes(32).toString('hex') }
const workspaceId = randomUUID(), otherWorkspace = randomUUID()
const ownerId = 'map-owner', peerId = 'map-peer', removedId = 'map-removed', outsiderId = 'map-outsider'
const target = { workspaceId, ownerId }
const stamp = new Date('2026-11-05T00:00:00.000Z')
type Row = Record<string, unknown>
let workspaceRows: Row[] = [], ownerRows: Row[] = [], memberKeys: Row[] = [], legacyKeys: Row[] = []
let members: { workspaceId: string; userId: string; status: string }[] = []
let calls: { database: string; sql: string; values: unknown[] }[] = [], failure: Error | undefined

function selected(table: string, values: unknown[]): Row[] {
  if (table === 'workspace_secrets') return workspaceRows.filter(row => row.workspaceId === values[0] && row.kind === 'secret')
  if (table === 'user_secrets') return ownerRows.filter(row => row.userId === values[0])
  if (table === 'user_e2b_keys') return memberKeys.filter(row => values.includes(row.userId))
  if (table === 'workspace_e2b_keys') return legacyKeys.filter(row => row.workspaceId === values[0])
  if (table === 'mikka_workspace_members') return members.filter(row => row.workspaceId === values[0] && row.status === 'active')
  throw new Error('Unexpected fixture table')
}
const application = {
  query: async (input: string | { text: string; rowMode?: string }, values: unknown[] = []) => {
    const sql = typeof input === 'string' ? input : input.text
    calls.push({ database: 'app', sql, values })
    if (failure) throw failure
    if (typeof input !== 'string' && input.rowMode === 'array') return drizzleRows(sql, values)
    // The real PostgreSQL companion test checks the four SQL predicates. This
    // transport stub keeps crypto, masking, error policy and DB boundaries real.
    assert.equal(values[0], workspaceId)
    const active = values[2] as string[]
    assert.deepEqual(active, members.filter(row => row.workspaceId === workspaceId && row.status === 'active').map(row => row.userId))
    assert.ok(!sql.includes('mikka_workspace_members'), 'workspace authority stays on its own database')
    return { rows: [{
      workspaceSecrets: selected('workspace_secrets', [values[0]]),
      ownerSecrets: selected('user_secrets', [values[1]]),
      memberKeys: selected('user_e2b_keys', active),
      legacyKeys: selected('workspace_e2b_keys', [values[0]]),
    }] }
  },
}
function drizzleRows(sql: string, values: unknown[]) {
  const match = /^select (.+) from "([a-z0-9_]+)" /i.exec(sql)
  assert.ok(match, 'fixture expects the existing Drizzle SELECT')
  const columns = [...match[1].matchAll(/"([A-Za-z0-9_]+)"/g)].map(item => item[1])
  return { rows: selected(match[2], values).map(row => columns.map(key => row[key] instanceof Date ? (row[key] as Date).toISOString() : row[key] ?? null)) }
}
const workspace = {
  query: async (input: string | { text: string; rowMode?: string }, values: unknown[] = []) => {
    const sql = typeof input === 'string' ? input : input.text
    calls.push({ database: 'workspace', sql, values })
    assert.ok(sql.includes('mikka_workspace_members'))
    assert.ok(!/workspace_secrets|user_secrets|user_e2b_keys|workspace_e2b_keys/.test(sql))
    if (typeof input !== 'string' && input.rowMode === 'array') return drizzleRows(sql, values)
    return { rows: selected('mikka_workspace_members', values).map(({ userId }) => ({ userId })) }
  },
}
class WorkspaceError extends Error {}
mock.module(new URL('../db/index.ts', import.meta.url).href, { namedExports: { db: drizzle(application as never), pool: application,
  withDatabaseTransaction: () => { throw new Error('Masking must not open an ACL write transaction') },
} })
mock.module(new URL('../workspace-db.ts', import.meta.url).href, { namedExports: { workspaceDb: drizzle(workspace as never), workspacePool: workspace } })
mock.module(new URL('../workspace-access.ts', import.meta.url).href, { namedExports: { WorkspaceError, requireWorkspace: () => { throw new Error('Not a settings mutation') } } })
const legacy = import('./runtime')
const compact = import('./project-map-mask')

const wsSecret = (name: string, value: string, scopeType = 'workspace', chosenWorkspace = workspaceId, kind = 'secret') => {
  const row = { id: randomUUID(), workspaceId: chosenWorkspace, name, kind, scopeType, scopeRef: scopeType === 'repository' ? 'fixture/repo' : '',
    note: '', createdBy: ownerId, updatedBy: ownerId, createdAt: stamp, updatedAt: stamp }
  return { ...row, ...sealSecret(value, secretAad(row), env) }
}
const ownSecret = (name: string, value: string, userId = ownerId, kind = 'secret') => {
  const row = { id: randomUUID(), userId, name, kind, note: '', createdAt: stamp, updatedAt: stamp }
  return { ...row, ...sealSecret(value, userSecretAad(row), env) }
}
beforeEach(() => {
  calls = []; failure = undefined
  members = [{ workspaceId, userId: ownerId, status: 'active' }, { workspaceId, userId: peerId, status: 'active' },
    { workspaceId, userId: removedId, status: 'suspended' }, { workspaceId: otherWorkspace, userId: outsiderId, status: 'active' }]
  workspaceRows = [wsSecret('WORKSPACE', 'workspace-value-123'), wsSecret('REPOSITORY', 'repository-value-123', 'repository'),
    wsSecret('WORKSPACE_FIRST', 'same-value-in-scopes'), wsSecret('FOREIGN', 'foreign-workspace-123', 'workspace', otherWorkspace),
    wsSecret('ENV', 'visible-workspace-env', 'workspace', workspaceId, 'env')]
  ownerRows = [ownSecret('OWN', 'owner-value-123'), ownSecret('OWNER_DUPLICATE', 'same-value-in-scopes'), ownSecret('OWN_ENV', 'visible-owner-env', ownerId, 'env'),
    ownSecret('OTHER_OWNER', 'other-owner-value-123', peerId)]
  memberKeys = [ownerId, peerId, removedId, outsiderId].map(userId => ({ userId, ...sealSecret(userId + '-e2b-value-123', userE2bKeyAad(userId), env),
    last4: '1234', e2bTeamHint: null, verifiedAt: null, lastErrorCode: null, lastErrorAt: null, createdAt: stamp, updatedAt: stamp }))
  legacyKeys = [workspaceId, otherWorkspace].map(id => ({ workspaceId: id, ...sealSecret(id === workspaceId ? 'legacy-e2b-value-123' : 'foreign-legacy-value-123', e2bKeyAad(id), env),
    last4: '1234', e2bTeamHint: null, verifiedAt: null, lastErrorCode: null, lastErrorAt: null, createdBy: outsiderId, updatedBy: outsiderId, createdAt: stamp, updatedAt: stamp }))
})

test('map masking equals the existing owner masker with two authority-separated reads', async () => {
  const input = { 'owner-value-123': ['workspace-value-123', 'repository-value-123', 'owner-value-123', 'same-value-in-scopes',
    ownerId + '-e2b-value-123', peerId + '-e2b-value-123', 'legacy-e2b-value-123', removedId + '-e2b-value-123', outsiderId + '-e2b-value-123',
    'foreign-workspace-123', 'other-owner-value-123', 'foreign-legacy-value-123', 'visible-workspace-env', 'visible-owner-env',
    Buffer.from('repository-value-123').toString('base64'), 'ghp_abcdefghijklmnopqrstuvwx'], nested: { out: 'owner-value-123' } }
  const expected = await (await legacy).maskFor(target, input, env)
  assert.equal(calls.length, 5)
  calls = []
  const actual = await (await compact).maskProjectMapFacts(target, input, env)
  assert.deepEqual(actual, expected)
  assert.equal(JSON.stringify(actual), JSON.stringify(expected), 'masking preserves object key order for snapshot fingerprints')
  assert.equal(calls.length, 2)
  assert.deepEqual(calls.map(call => call.database), ['workspace', 'app'])
  const fields = actual as unknown as Record<string, string[]>
  assert.equal(fields['[secret:OWN]'][3], '[secret:WORKSPACE_FIRST]', 'workspace labels win before owner labels')
  assert.equal(fields['[secret:OWN]'][6], '[secret:E2B_API_KEY]', 'legacy keys are masked regardless of their creator')
})

test('active-member masking is reread on every request without adopting or updating a key', async () => {
  const value = peerId + '-e2b-value-123'
  assert.equal(await (await compact).maskProjectMapFacts(target, value, env), '[secret:E2B_API_KEY]')
  members.find(row => row.userId === peerId)!.status = 'suspended'
  assert.equal(await (await compact).maskProjectMapFacts(target, value, env), await (await legacy).maskFor(target, value, env))
  assert.equal(calls.filter(call => call.database === 'workspace').length, 3)
  assert.ok(calls.every(call => /^\s*(SELECT|WITH)/i.test(call.sql)))
})

test('absent and empty encryption keys still mask credential patterns with no database reads', async () => {
  for (const off of [{}, { WORKSPACE_SECRETS_KEY: '  ' }]) {
    const input = { text: 'ghp_abcdefghijklmnopqrstuvwx owner-value-123' }
    assert.deepEqual(await (await compact).maskProjectMapFacts(target, input, off), await (await legacy).maskFor(target, input, off))
  }
  assert.equal(calls.length, 0)
})

test('ordinary workspace, owner secret and owner env corruption keep the existing fail-closed result', async t => {
  for (const group of ['workspace', 'owner', 'owner-env'] as const) await t.test(group, async () => {
    const row = group === 'workspace' ? workspaceRows[0] : group === 'owner' ? ownerRows[0] : ownerRows[2]
    const original = row.ciphertext; row.ciphertext = 'invalid'
    const log = t.mock.method(console, 'error', () => undefined)
    try {
      for (const fn of [(await legacy).maskFor, (await compact).maskProjectMapFacts]) {
        await assert.rejects(fn(target, { out: 'visible-owner-env' }, env), (error: unknown) =>
          error instanceof Error && (error as Error & { code?: string }).code === 'e2b_unavailable' && error.cause === undefined)
      }
      assert.ok(log.mock.calls.every(call => !JSON.stringify(call.arguments).includes('invalid')))
    } finally { row.ciphertext = original; log.mock.restore() }
  })
})

test('unreadable member and legacy E2B keys retain the existing safe log-and-skip policy', async t => {
  memberKeys[0].ciphertext = 'invalid'; legacyKeys[0].ciphertext = 'invalid'
  const log = t.mock.method(console, 'error', () => undefined)
  const input = [ownerId + '-e2b-value-123', peerId + '-e2b-value-123', 'legacy-e2b-value-123']
  assert.deepEqual(await (await compact).maskProjectMapFacts(target, input, env), await (await legacy).maskFor(target, input, env))
  assert.equal(log.mock.calls.length, 4)
  assert.ok(log.mock.calls.every(call => String(call.arguments[0]).startsWith('[secrets] e2b_unavailable id=')))
  assert.ok(log.mock.calls.every(call => !JSON.stringify(call.arguments).includes('invalid')))
})

test('the real secrets DB guard removes query causes and parameters from map masking failures', async () => {
  failure = Object.assign(new Error('private-query-fixture'), { code: 'XX000', query: 'private-query-fixture', params: ['private-parameter-fixture'] })
  await assert.rejects((await compact).maskProjectMapFacts(target, {}, env), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.equal(error.name, 'SecretsStoreError')
    assert.equal(error.cause, undefined)
    assert.ok(!JSON.stringify(error).includes('private-'))
    assert.ok(!error.message.includes('private-'))
    return true
  })
})
