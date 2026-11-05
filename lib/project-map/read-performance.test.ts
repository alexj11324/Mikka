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
let resolved = 0
let returnedBytes: number[] = [], currentScopes: ProjectScope[] = []
const query = async (sql: string, values: unknown[] = []) => {
  queries.push({ sql, values })
  if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [] }
  const batches = [...sql.matchAll(/projection_\d+ AS MATERIALIZED/g)].length
  return { rows: [{ bytes: returnedBytes.shift() ?? 0, rows: rejectBytes ? null : batches ? Array.from({ length: batches }, (_, index) => index < 2 ? { count: 0, columns: Object.fromEntries((index === 0
      ? ['id', 'title', 'status', 'createdAt', 'blockedByIds']
      : ['id', 'issueId', 'status', 'outcome', 'createdAt', 'finishedAt', 'retryOf', 'continuesRunId', 'threadReplacedBy', 'harness', 'modelId', 'owned']).map(key => [key, []])) } : []) : [] }] }
}
const reauthorize = async () => {
  resolved++
  if (revoked) throw Object.assign(new Error('Fixture membership revoked'), { status: 404 })
  return currentScopes.shift() ?? scope
}
mock.module(new URL('../db/index.ts', import.meta.url).href, { namedExports: { pool: { query } } })
mock.module(new URL('../tokens/scope.ts', import.meta.url).href, { namedExports: { isPersonalWorkspace: async () => false } })
mock.module(new URL('../secrets/project-map-mask.ts', import.meta.url).href, { namedExports: { maskProjectMapFacts: async (_target: unknown, value: unknown) => { masked = true; return value } } })
mock.module(new URL('./scope.ts', import.meta.url).href, { namedExports: { resolveProjectScope: reauthorize, resolveProjectReadScope: reauthorize } })
mock.module(new URL('./sources.ts', import.meta.url).href, { namedExports: { sanitizeSourceText: (value: string) => value } })
const reads = import('./read-store')

beforeEach(() => { queries = []; rejectBytes = false; masked = false; revoked = false; resolved = 0; returnedBytes = []; currentScopes = [] })

test('all map metadata and source authorization use one bounded SQL statement', async () => {
  const facts = await (await reads).collectMapFacts({ query } as Pick<PoolClient, 'query'>, scope)
  assert.equal(facts.project.title, 'Bounded map')
  assert.equal(queries.length, 1)
  assert.equal(masked, true)
})

test('SQL byte rejection stops projection processing before masking or further reads', async () => {
  rejectBytes = true
  await assert.rejects((await reads).collectMapFacts({ query } as Pick<PoolClient, 'query'>, scope), { code: 'map_too_large' })
  assert.equal(queries.length, 1)
  assert.equal(masked, false)
})

test('compact output cannot bypass the complete logical metadata byte allowance', async () => {
  returnedBytes = [1100 * 1024]
  await assert.rejects((await reads).collectMapFacts({ query } as Pick<PoolClient, 'query'>, scope), { code: 'map_too_large' })
  assert.equal(queries.length, 1)
  assert.equal(queries[0].values.at(-1), MAP_METADATA_BYTES)
  assert.equal(masked, false)
})

test('a membership revoked after the metadata snapshot cannot return facts', async () => {
  revoked = true
  await assert.rejects((await reads).readMapFacts(scope), { status: 404 })
  assert.equal(resolved, 1)
  assert.equal(queries.length, 1)
  assert.ok(!queries.some(query => /^(BEGIN|COMMIT|ROLLBACK)/.test(query.sql)))
})

test('a changed task scope discards the first snapshot and rereads under current authorization', async () => {
  const current = { ...scope, issueIds: [], project: { ...scope.project, name: 'Current map', revision: 2 } }
  currentScopes = [current, current]
  const facts = await (await reads).readMapFacts(scope)
  assert.equal(facts.project.title, 'Current map')
  assert.equal(resolved, 2)
  assert.equal(queries.length, 2)
})

test('a workspace classification change cannot return the earlier source authority', async () => {
  currentScopes = [{ ...scope, personalWorkspace: true }, { ...scope, personalWorkspace: false }]
  await assert.rejects((await reads).readMapFacts(scope), { code: 'map_snapshot_changed' })
  assert.equal(resolved, 2)
})
