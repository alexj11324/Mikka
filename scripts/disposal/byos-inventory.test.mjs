import assert from 'node:assert/strict'
import test from 'node:test'
import { inventoryByosOAuthAttempts } from './byos-inventory.mjs'

const connectionId = '10000000-0000-4000-8000-000000000001'
const operationId = '20000000-0000-4000-8000-000000000001'
const scope = { connectionId, ownerId: 'fixture-owner', workspaceId: 'fixture-workspace', provider: 'codex' }
const row = (suffix = '1') => ({
  scopeConnectionId: connectionId, scopeOwnerId: scope.ownerId, scopeWorkspaceId: scope.workspaceId, scopeProvider: scope.provider,
  stateHash: suffix.repeat(64), attemptConnectionId: connectionId, attemptOwnerId: scope.ownerId,
  attemptWorkspaceId: scope.workspaceId, attemptOperationId: operationId,
  secretName: `mikka-byos-30000000-0000-4000-8000-00000000000${suffix}`,
  artifactName: `mikka-byos-30000000-0000-4000-8000-00000000000${suffix}`,
  artifactConnectionId: connectionId, artifactOwnerId: scope.ownerId, artifactWorkspaceId: scope.workspaceId,
  artifactProvider: scope.provider, artifactKind: 'oauth', artifactOperationId: operationId,
  artifactDeletedAt: new Date('2026-10-26T00:00:00Z'),
})
const mock = rows => ({ async query(sql, values) {
  assert.match(sql, /^SELECT /)
  assert.doesNotMatch(sql, /\b(?:DELETE|DROP|UPDATE|INSERT|TRUNCATE|FOR UPDATE)\b/i)
  assert.match(sql, /o\."secretName" = a\.name/)
  assert.match(sql, /a\."connectionId" = c\.id AND a\."deletedAt" IS NOT NULL/)
  assert.doesNotMatch(sql, /WHERE[^]*o\."(?:ownerId|workspaceId)"\s*=/)
  assert.equal(values[0], connectionId)
  assert.ok(Number.isInteger(values[1]))
  return { rows }
} })

test('inventory reports exact primary keys and artifact links with explicit scope budget using only SELECT', async () => {
  const result = await inventoryByosOAuthAttempts(mock([row(), row('2')]), scope, 2)
  assert.equal(result.count, 2); assert.equal(result.budget, 2)
  assert.deepEqual(result.rows.map(r => r.primaryKey), [{ stateHash: '1'.repeat(64) }, { stateHash: '2'.repeat(64) }])
  assert.equal(result.rows[0].secretArtifact.name, row().artifactName)
  assert.equal(result.rows[0].secretArtifact.deletedAt, '2026-10-26T00:00:00.000Z')
  assert.doesNotMatch(JSON.stringify(result), /sessionHash|access_token|refresh_token/)
})

test('inventory permits known empty scope but refuses missing connection ownership', async () => {
  const empty = row()
  for (const key of Object.keys(empty)) if (!key.startsWith('scope')) empty[key] = null
  assert.equal((await inventoryByosOAuthAttempts(mock([empty]), scope, 0)).count, 0)
  await assert.rejects(inventoryByosOAuthAttempts(mock([]), scope, 0))
  await assert.rejects(inventoryByosOAuthAttempts(mock([{ ...empty, artifactName: 'unexpected' }]), scope, 0))
})

test('inventory rejects unknown or cross-scope ownership and mismatched associations', async () => {
  for (const key of ['scopeConnectionId', 'scopeOwnerId', 'scopeWorkspaceId', 'scopeProvider',
    'attemptConnectionId', 'attemptOwnerId', 'attemptWorkspaceId', 'artifactConnectionId',
    'artifactOwnerId', 'artifactWorkspaceId', 'artifactProvider', 'artifactKind', 'artifactOperationId',
    'attemptOperationId', 'secretName', 'artifactName', 'stateHash', 'artifactDeletedAt']) {
    for (const value of [null, 'foreign']) await assert.rejects(inventoryByosOAuthAttempts(mock([{ ...row(), [key]: value }]), scope, 1))
  }
})

test('inventory rejects duplicate keys, ambiguous artifact reuse and budget overflow', async () => {
  for (const rows of [[row(), row()], [row(), { ...row(), stateHash: '2'.repeat(64) }]]) {
    await assert.rejects(inventoryByosOAuthAttempts(mock(rows), scope, 2))
  }
  await assert.rejects(inventoryByosOAuthAttempts(mock([row(), row('2')]), scope, 1))
  await assert.rejects(inventoryByosOAuthAttempts(mock([row()]), scope, 0))
})

test('inventory validates explicit input before any query and does not swallow query errors', async () => {
  const never = { query() { assert.fail('invalid input reached database') } }
  for (const budget of [undefined, -1, 1.5, '1', 10001]) await assert.rejects(inventoryByosOAuthAttempts(never, scope, budget))
  for (const invalid of [null, {}, { ...scope, ownerId: '' }, { ...scope, connectionId: 'any' }, { ...scope, extra: true }]) {
    await assert.rejects(inventoryByosOAuthAttempts(never, invalid, 1))
  }
  const error = new Error('synthetic query failure')
  await assert.rejects(inventoryByosOAuthAttempts({ async query() { throw error } }, scope, 1), error)
})
