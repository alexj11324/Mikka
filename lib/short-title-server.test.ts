import assert from 'node:assert/strict'
import { after, before, beforeEach, mock, test } from 'node:test'

const savedKey = process.env.AI_GATEWAY_API_KEY
let allowed = true
let task: { title: string; content: unknown; shortTitle: string | null } | null = null
let landed = true
let answer: () => Promise<{ text: string }> = async () => ({ text: '{"title":"登录回调修复"}' })
const writes: unknown[] = [], pushed: unknown[][] = [], keys: unknown[] = []
const generateText = mock.fn(async () => answer())
mock.module('ai', { namedExports: { generateText } })
mock.module(new URL('./db/index.ts', import.meta.url).href, { namedExports: { db: {
  select: () => ({ from: () => ({ where: () => ({ limit: async () => (task ? [task] : []) }) }) }),
  transaction: async (work: (tx: object) => Promise<void>) => work({
    update: () => ({ set: (value: unknown) => ({ where: () => ({ returning: async () => { writes.push(value); return landed ? [{ id: 'task' }] : [] } }) }) }),
  }),
} } })
mock.module(new URL('./live/lists.ts', import.meta.url).href, { namedExports: { issueListChanged: async (...args: unknown[]) => { pushed.push(args.slice(1)) } } })
mock.module(new URL('./execution-settings.ts', import.meta.url).href, { namedExports: { executionWorkspace: async () => 'fixture-workspace' } })
mock.module(new URL('./model-admission/runtime.ts', import.meta.url).href, { namedExports: { modelAdmission: { gateway: async () => { if (!allowed) throw new Error('modelRouteDenied'); return null } } } })
mock.module(new URL('./abuse/model.ts', import.meta.url).href, { namedExports: {
  createTrustedGatewayModel: async (modelId: string, key: string) => { keys.push(key); return { modelId } },
  hostedModel: async (workspace: string, _id: string, provider: object, owner: string) => { assert.equal(workspace, 'fixture-workspace'); assert.equal(owner, 'owner'); return provider },
} })

let writeShortTitle: typeof import('./short-title-server').writeShortTitle
before(async () => { writeShortTitle = (await import('./short-title-server')).writeShortTitle })
beforeEach(() => {
  process.env.AI_GATEWAY_API_KEY = 'synthetic-short-title-key'
  allowed = true; landed = true
  task = { title: 'ALEX-1470: 登录回调在真机上失效，需要检查 OAuth proxy 回跳 2026-11-06', content: { type: 'doc', content: [] }, shortTitle: null }
  answer = async () => ({ text: '{"title":"登录回调修复"}' })
  writes.length = 0; pushed.length = 0; keys.length = 0; generateText.mock.resetCalls()
})
after(() => { if (savedKey === undefined) delete process.env.AI_GATEWAY_API_KEY; else process.env.AI_GATEWAY_API_KEY = savedKey })

test('a new task gets one short title, written with the title it came from, and the title change is pushed', async () => {
  await writeShortTitle('task', 'owner')
  assert.deepEqual(keys, [undefined], 'the app\'s one gateway credential, no key of its own')
  assert.equal(generateText.mock.callCount(), 1)
  assert.deepEqual(writes, [{ shortTitle: '登录回调修复', shortTitleFrom: task!.title }])
  assert.deepEqual(pushed, [['task', true]])
})

test('a task that already has a short title is not named again', async () => {
  task = { ...task!, shortTitle: '登录回调修复' }
  await writeShortTitle('task', 'owner')
  assert.equal(generateText.mock.callCount(), 0)
  assert.equal(writes.length, 0)
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

test('without a gateway credential nothing is called', async () => {
  delete process.env.AI_GATEWAY_API_KEY
  await writeShortTitle('task', 'owner')
  assert.equal(generateText.mock.callCount(), 0)
})
