import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { beforeEach, mock, test } from 'node:test'
import type { PoolClient } from 'pg'
import type { ProjectScope } from './scope'
import { MAP_METADATA_BYTES } from './read-contracts'

const scope = {
  reader: 'owner', userId: 'owner', workspaceId: randomUUID(), projectId: randomUUID(), issueIds: [randomUUID()], personalWorkspace: false,
  project: { id: randomUUID(), userId: 'owner', name: 'Bounded map', revision: 1, issueIds: [], createdAt: new Date() },
} as ProjectScope
let queries: { sql: string; values: unknown[] }[] = [], rejectBytes = false, masked = false, revoked = false
let resolved = 0, released = 0
let returnedBytes: number[] = [], currentScopes: ProjectScope[] = []
const query = async (sql: string, values: unknown[] = []) => {
  queries.push({ sql, values })
  if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [] }
  const batches = [...sql.matchAll(/projection_\d+ AS MATERIALIZED/g)].length
  return { rows: [{ bytes: returnedBytes.shift() ?? 0, rows: rejectBytes ? null : batches ? Array.from({ length: batches }, () => []) : [] }] }
}
const client = { query, release: () => { released++ } }
const reauthorize = async () => {
  resolved++
  if (revoked) throw Object.assign(new Error('Fixture membership revoked'), { status: 404 })
  return currentScopes.shift() ?? scope
}
mock.module(new URL('../db/index.ts', import.meta.url).href, { namedExports: { pool: { connect: async () => client } } })
mock.module(new URL('../tokens/scope.ts', import.meta.url).href, { namedExports: { isPersonalWorkspace: async () => false } })
mock.module(new URL('../secrets/runtime.ts', import.meta.url).href, { namedExports: { maskFor: async (_target: unknown, value: unknown) => { masked = true; return value } } })
mock.module(new URL('./scope.ts', import.meta.url).href, { namedExports: { resolveProjectScope: reauthorize, resolveProjectReadScope: reauthorize } })
mock.module(new URL('./sources.ts', import.meta.url).href, { namedExports: { sanitizeSourceText: (value: string) => value } })
const reads = import('./read-store')

beforeEach(() => { queries = []; rejectBytes = false; masked = false; revoked = false; resolved = 0; released = 0; returnedBytes = []; currentScopes = [] })

test('map metadata without decision sources needs at most two bounded SQL roundtrips', async () => {
  const facts = await (await reads).collectMapFacts({ query } as Pick<PoolClient, 'query'>, scope)
  assert.equal(facts.project.title, 'Bounded map')
  assert.ok(queries.length <= 2, `metadata used ${queries.length} roundtrips`)
  assert.equal(masked, true)
})

test('SQL byte rejection stops projection processing before masking or further reads', async () => {
  rejectBytes = true
  await assert.rejects((await reads).collectMapFacts({ query } as Pick<PoolClient, 'query'>, scope), { code: 'map_too_large' })
  assert.equal(queries.length, 1)
  assert.equal(masked, false)
})

test('the metadata byte allowance is cumulative across independent batches', async () => {
  returnedBytes = [600 * 1024, 500 * 1024]
  await assert.rejects((await reads).collectMapFacts({ query } as Pick<PoolClient, 'query'>, scope), { code: 'map_too_large' })
  assert.equal(queries.length, 2)
  assert.equal(queries[0].values.at(-1), MAP_METADATA_BYTES)
  assert.equal(queries[1].values.at(-1), MAP_METADATA_BYTES - 600 * 1024)
  assert.equal(masked, false)
})

test('a membership revoked after the metadata snapshot cannot return facts', async () => {
  revoked = true
  await assert.rejects((await reads).readMapFacts(scope), { status: 404 })
  assert.equal(resolved, 1)
  assert.equal(released, 1)
  assert.ok(queries.some(query => query.sql === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'))
  assert.ok(queries.some(query => query.sql === 'COMMIT'))
})

test('a changed task scope discards the first snapshot and rereads under current authorization', async () => {
  const current = { ...scope, issueIds: [], project: { ...scope.project, name: 'Current map', revision: 2 } }
  currentScopes = [current, current]
  const facts = await (await reads).readMapFacts(scope)
  assert.equal(facts.project.title, 'Current map')
  assert.equal(resolved, 2); assert.equal(released, 2)
  assert.equal(queries.filter(query => query.sql === 'COMMIT').length, 2)
})

test('a workspace classification change cannot return the earlier source authority', async () => {
  currentScopes = [{ ...scope, personalWorkspace: true }, { ...scope, personalWorkspace: false }]
  await assert.rejects((await reads).readMapFacts(scope), { code: 'map_snapshot_changed' })
  assert.equal(resolved, 2); assert.equal(released, 2)
})
