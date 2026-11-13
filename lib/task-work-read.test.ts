import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'
import { FactoryError } from './factory/contract'

let visible = true
let authorized = true
let scopeMatches = true
let reads = 0
const reader = { id: 'owner' }
const activity = { task: { id: 'factory', issueId: 'task' }, artifacts: [{ id: 'allowed' }] }
const at = (path: string) => new URL(path, import.meta.url).href
mock.module(at('./task-presentation-read.ts'), { namedExports: { readTaskPresentations: async (_reader: unknown, query: { workspaceId: string; issueIds: string[]; includeFactoryIdentity: boolean }) => {
  assert.deepEqual(query, { workspaceId: 'workspace', issueIds: ['task'], includeFactoryIdentity: true })
  return { items: visible ? { task: { factoryTaskId: 'factory' } } : {} }
} } })
mock.module(at('./acting-user.ts'), { namedExports: { actAs: async (principal: unknown, work: () => Promise<unknown>) => { assert.equal(principal, reader); return work() } } })
mock.module(at('./db/index.ts'), { namedExports: { pool: {} } })
mock.module(at('./factory/server.ts'), { namedExports: { factoryHumanStore: {} } })
mock.module(at('./factory/workspace-reader.ts'), { namedExports: { withFactoryWorkspace: async (userId: string, work: () => Promise<unknown>) => {
  assert.equal(userId,'owner')
  if (!authorized) throw new FactoryError('factoryNotFound')
  return work()
} } })
mock.module(at('./factory/activity.ts'), { namedExports: { readFactoryActivity: async (_pool: unknown, _store: unknown, userId: string, id: string) => {
  assert.equal(userId, 'owner'); assert.equal(id, 'factory'); reads++
  return scopeMatches ? activity : { ...activity, task: { ...activity.task, issueId: 'other' } }
} } })
let read: typeof import('./task-work-read')['readTaskWork']
before(async () => { ({ readTaskWork: read } = await import('./task-work-read')) })
test('only a discovered, canonically authorized Factory for the same issue enters its work projection', async () => {
  visible = false
  assert.deepEqual(await read(reader, 'workspace', 'task'), { presentation: null, factory: null })
  visible = true; authorized = false
  assert.deepEqual(await read(reader, 'workspace', 'task'), { presentation: null, factory: null })
  assert.equal(reads,0)
  authorized = true; scopeMatches = false
  assert.equal((await read(reader, 'workspace', 'task')).factory,null)
  scopeMatches = true
  assert.deepEqual((await read(reader, 'workspace', 'task')).factory,{ ...activity, liveWorkspaceId:'workspace' })
})
