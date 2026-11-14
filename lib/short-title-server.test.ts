import assert from 'node:assert/strict'
import { after, before, beforeEach, mock, test } from 'node:test'

const saved = { gateway: process.env.AI_GATEWAY_API_KEY, zeroCat: process.env.ZEROCAT_API_KEY, url: process.env.ZEROCAT_BASE_URL }
let allowed = true
let task: { workspaceId: string | null; title: string; content: unknown; shortTitle: string | null } | null = null
let landed = true
let answer: () => Promise<{ text: string }> = async () => ({ text: '{"title":"登录回调修复"}' })
const writes: unknown[] = [], pushed: unknown[][] = [], models: unknown[] = []
const generateText = mock.fn(async () => answer())
mock.module('ai', { namedExports: { generateText } })
mock.module(new URL('./db/index.ts', import.meta.url).href, { namedExports: { db: {
  select: () => ({ from: () => ({ where: () => ({ limit: async () => (task ? [task] : []) }) }) }),
  transaction: async (work: (tx: object) => Promise<void>) => work({
    update: () => ({ set: (value: unknown) => ({ where: () => ({ returning: async () => { writes.push(value); return landed ? [{ id: 'task' }] : [] } }) }) }),
  }),
} } })
mock.module(new URL('./live/lists.ts', import.meta.url).href, { namedExports: { issueListChanged: async (...args: unknown[]) => { pushed.push(args.slice(1)) } } })
mock.module(new URL('./cloud-services/runtime.ts', import.meta.url).href, { namedExports: { cloudClient: { capability: async () => null } } })
mock.module(new URL('./abuse/model.ts', import.meta.url).href, { namedExports: {
  admitHostedModel: async (scope: { workspaceId: string; ownerId: string }) => {
    assert.deepEqual(scope, { workspaceId: 'fixture-workspace', ownerId: 'owner' })
    if (!allowed) throw new Error('modelRouteDenied')
    return null
  },
  hostedModel: async (workspace: string, modelId: string, provider: unknown, owner: string) => {
    assert.equal(workspace, 'fixture-workspace'); assert.equal(owner, 'owner'); assert.equal(provider, undefined); models.push(modelId); return { modelId } },
} })

let writeShortTitle: typeof import('./short-title-server').writeShortTitle
before(async () => { writeShortTitle = (await import('./short-title-server')).writeShortTitle })
beforeEach(() => {
  process.env.AI_GATEWAY_API_KEY = 'synthetic-short-title-key'
  delete process.env.ZEROCAT_API_KEY; delete process.env.ZEROCAT_BASE_URL
  allowed = true; landed = true
  task = { workspaceId: 'fixture-workspace', title: 'ALEX-1470: 登录回调在真机上失效，需要检查 OAuth proxy 回跳 2026-11-06', content: { type: 'doc', content: [] }, shortTitle: null }
  answer = async () => ({ text: '{"title":"登录回调修复"}' })
  writes.length = 0; pushed.length = 0; models.length = 0; generateText.mock.resetCalls()
})
after(() => {
  for (const [name, value] of [['AI_GATEWAY_API_KEY', saved.gateway], ['ZEROCAT_API_KEY', saved.zeroCat], ['ZEROCAT_BASE_URL', saved.url]] as const)
    if (value === undefined) delete process.env[name]; else process.env[name] = value
})

test('a new task gets one short title, written with the title it came from, and the title change is pushed', async () => {
  await writeShortTitle('task', 'owner')
  assert.deepEqual(models, ['deepseek/deepseek-v4.1-flash'], 'the default model, which picks ZeroCat or its Gateway fallback')
  assert.equal(generateText.mock.callCount(), 1)
  assert.deepEqual(writes, [{ shortTitle: '登录回调修复', shortTitleFrom: task!.title }])
  assert.deepEqual(pushed, [['task', true]])
})

test('a legacy task without a bound workspace cannot borrow another workspace for a model call', async () => {
  task = { ...task!, workspaceId: null }
  await writeShortTitle('task', 'owner')
  assert.equal(generateText.mock.callCount(), 0)
  assert.equal(writes.length, 0)
  assert.equal(pushed.length, 0)
})

test('a task that already has a short title is not named again', async () => {
  task = { ...task!, shortTitle: '登录回调修复' }
  await writeShortTitle('task', 'owner')
  assert.equal(generateText.mock.callCount(), 0)
  assert.equal(writes.length, 0)
})

test('the model writer stores a bounded title even if the answer ignores the language and length instructions', async () => {
  task = { ...task!, title: 'Fix login callback' }
  answer = async () => ({ text: '{"title":"修复登录后回跳丢前缀并保留工作区参数"}' })
  await writeShortTitle('task', 'owner')
  assert.deepEqual(writes, [{ shortTitle: '修复登录后回跳丢前缀并保', shortTitleFrom: 'Fix login callback' }])
})

test('a rename that lands first keeps the person\'s title: nothing is pushed', async () => {
  landed = false
  await writeShortTitle('task', 'owner')
  assert.equal(writes.length, 1)
  assert.equal(pushed.length, 0)
})

test('a denied route, an unusable answer, a failure or a missing task leave the title alone and never throw', async t => {
  t.mock.method(console, 'error', () => {})
  allowed = false
  await writeShortTitle('task', 'owner')
  assert.equal(generateText.mock.callCount(), 0)
  allowed = true
  answer = async () => ({ text: 'not json' })
  await writeShortTitle('task', 'owner')
  answer = async () => { throw new Error('timeout') }
  await writeShortTitle('task', 'owner')
  task = null
  await writeShortTitle('task', 'owner')
  assert.equal(writes.length, 0)
  assert.equal(pushed.length, 0)
})

test('with neither a ZeroCat nor a gateway credential nothing is called', async () => {
  delete process.env.AI_GATEWAY_API_KEY
  await writeShortTitle('task', 'owner')
  assert.equal(generateText.mock.callCount(), 0)
})

test('ZeroCat alone is enough to name a task', async () => {
  delete process.env.AI_GATEWAY_API_KEY
  process.env.ZEROCAT_API_KEY = 'synthetic-zerocat-key'; process.env.ZEROCAT_BASE_URL = 'https://zero.cat/v1'
  await writeShortTitle('task', 'owner')
  assert.equal(generateText.mock.callCount(), 1)
})
