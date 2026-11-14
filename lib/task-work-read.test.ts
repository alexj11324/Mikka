import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'
import { desktopActionSchemas } from './desktop-rpc/schemas'
import { FactoryError } from './factory/contract'

let visible = true
let authorized = true
let scopeMatches = true
let reads = 0
const reader = { id: 'owner' }
const published = { url: 'https://github.com/Example/Project/pull/5', state: 'open', additions: 12 }
const candidate = { url: 'https://github.com/example/project/pull/6', state: 'draft' }
const activity = { task: { id: 'factory', issueId: 'task', pullRequest: candidate }, artifacts: [
  { kind: 'pull_request', url: 'https://github.com/example/project/pull/5/', state: 'merged', title: 'Final review' },
  { kind: 'pull_request', url: 'https://example.invalid/untrusted', state: 'open' },
] }
const at = (path: string) => new URL(path, import.meta.url).href
mock.module(at('./task-presentation-read.ts'), { namedExports: { readTaskPresentations: async (_reader: unknown, query: { workspaceId: string; issueIds: string[]; includeFactoryIdentity: boolean }) => {
  assert.deepEqual(query, { workspaceId: 'workspace', issueIds: ['task'], includeFactoryIdentity: true, includePullRequests: true, includeLinkedChats: true })
  return { items: visible ? { task: { factoryTaskId: 'factory', pullRequests: [published] } } : {} }
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
  const foreign = await read(reader, 'workspace', 'task')
  assert.equal(foreign.factory,null)
  assert.deepEqual(foreign.presentation?.pullRequests, [published])
  scopeMatches = true
  const work = await read(reader, 'workspace', 'task')
  assert.deepEqual(work.factory,{ ...activity, liveWorkspaceId:'workspace' })
  assert.deepEqual(work.presentation?.pullRequests, [{ ...published, state: 'merged', title: 'Final review' }, candidate])
})


test('Web and Desktop can request work while existing thread-only reads retain their wire shape', () => {
  const id = '170f3967-5bdb-4d94-91b1-4aa2cd7d0728'
  const schema = desktopActionSchemas['agents.pollIssueThreads']
  assert.ok(schema.safeParse([id]).success)
  assert.ok(schema.safeParse([id, true]).success)
  const cursor = { version: 'a'.repeat(32), positions: [{ id, version: 'b'.repeat(32) }] }
  assert.ok(schema.safeParse([id, true, cursor]).success)
  assert.ok(schema.safeParse([id, true, {}]).success)
  assert.equal(schema.safeParse([id, true, { positions: Array.from({ length: 52 }, () => cursor.positions[0]) }]).success, false)
  assert.equal(schema.safeParse([id, true, { version: 'invalid' }]).success, false)
  assert.equal(schema.safeParse([id, 'true']).success, false)
})
