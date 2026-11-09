import assert from 'node:assert/strict'
import { after, before, beforeEach, mock, test } from 'node:test'
import { overrideDeploymentSwitch } from '../deployment-switches'
import { makeSnapshot } from '../agent-kit/definition'
import { DEFAULT_AGENT_DEFINITION } from '../agent-kit/builtin'
import { executionInstructions } from '../agent-kit/execution-instructions'
import { withCoordinatorPresentation } from './native-prompt'
import { cachedContextLines, instructionsWithPersonal, promptMessages, promptWithCachedContext, type StoredMessage } from './context'
import { SCHEDULE_INSTRUCTIONS } from '../schedules/contract'

const owner = 'synthetic-prompt-owner', bot = '10000000-0000-4000-8000-000000000001'
const snapshot = makeSnapshot('10000000-0000-4000-8000-000000000002', 1, DEFAULT_AGENT_DEFINITION, 'Synthetic frozen host policy', { harness: 'ai_sdk', model: 'synthetic' })
const conversation: { summary: string | null; memory: string; messages: StoredMessage[] } = {
  summary: null, memory: 'Synthetic saved memory', messages: [{ position: 1, message: { role: 'user', content: 'Synthetic request' } }],
}
type Reader = 'execution' | 'personal' | 'github'
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
const calls: { reader: Reader; args: unknown[] }[] = []
let gates: Partial<Record<Reader, ReturnType<typeof deferred>>> = {}, firstStarted = deferred()
let personal = 'Synthetic personal instruction', github = 'Synthetic authorized repositories'
let facts = { models: 'Synthetic allowed models', live: 'Synthetic current availability' }
let denied: Error | null = null
const enter = async (reader: Reader, args: unknown[]) => {
  calls.push({ reader, args }); firstStarted.resolve()
  await gates[reader]?.promise
}
const forbidden = () => { throw new Error('No database, provider or tool effects in prompt concurrency fixture') }
const stub = (path: string, namedExports: Record<string, unknown>) => mock.module(new URL(path, import.meta.url).href, { namedExports })

stub('./store.ts', { loadConversationForPrompt: async () => ({ ...conversation, personalInstructions: personal }), saveSummary: forbidden })
stub('./bot-instructions.ts', { botInstructions: forbidden })
stub('./personal-instructions.ts', { withPersonalInstructionText: async (...args: unknown[]) => {
  await enter('personal', args)
  if (denied) throw denied
  return instructionsWithPersonal(args[1] as string, args[2] as string)
} })
stub('./github-context.ts', { githubPromptContext: async (...args: unknown[]) => { await enter('github', args); return github } })
stub('./execution-context.ts', { executionContextParts: async (...args: unknown[]) => { await enter('execution', args); return facts } })
stub('./summary-model.ts', { summarizeConversation: forbidden })
stub('../personal-mailbox-config.ts', { personalMailboxEnabled: () => false })
stub('../db/index.ts', { db: null, pool: null, withDatabaseClient: forbidden })
stub('../issue-visibility.ts', { issueVisibility: forbidden })
stub('../agent-runs.ts', { addRunMessage: forbidden, queueRun: forbidden, queueFactoryRun: forbidden, readRun: forbidden, requestRunStop: forbidden, visibleRuns: forbidden })
stub('../search/index.ts', { webSearch: forbidden })
// The real prompt/tool graph imports session helpers, but prompt assembly must never authenticate.
const unexpectedAuth = () => { throw new Error('Unexpected authentication or OAuth effect in pure prompt fixture') }
stub('../auth.ts', { auth: new Proxy({}, { get: unexpectedAuth }), authBaseURL: 'https://auth-fixture.example.invalid' })
stub('../device-link.ts', { DEVICE_ONLINE_WINDOW_MS: 60000, WORKSPACE_ID: 'synthetic-unused', issueDeviceToken: unexpectedAuth })
stub('../composio.ts', { runComposioAction: forbidden })
stub('../github/user-access.ts', { readAuthorizedIssue: forbidden })
stub('../pending-action-store.ts', { proposeAction: forbidden, writeAccountAction: forbidden, proposeRepositoryPush: forbidden })
stub('../issue-access.ts', { issueForUser: forbidden, requireUser: forbidden })
stub('../telegram/client.ts', { postTelegramText: forbidden })
stub('../attention/store.ts', { recordDecision: forbidden, settleTurn: forbidden })
stub('../../workflows/coordinator/tool-scope.ts', { assertNativeToolScope: forbidden })

let preparePrompt: typeof import('../../workflows/coordinator/steps')['preparePrompt']
let prepareTurn: typeof import('../../workflows/coordinator/steps')['prepareTurn']
before(async () => {
  overrideDeploymentSwitch('factoryRouting', false)
  ;({ preparePrompt, prepareTurn } = await import('../../workflows/coordinator/steps'))
})
after(() => overrideDeploymentSwitch('factoryRouting', undefined))
beforeEach(() => {
  calls.length = 0; gates = {}; firstStarted = deferred(); denied = null
  personal = 'Synthetic personal instruction'; github = 'Synthetic authorized repositories'
  facts = { models: 'Synthetic allowed models', live: 'Synthetic current availability' }
})

function expectedPrompt() {
  const rules = instructionsWithPersonal(withCoordinatorPresentation(executionInstructions(snapshot)), personal)
  return {
    ...promptWithCachedContext(rules, cachedContextLines(github, facts.models), conversation.memory, '\n' + SCHEDULE_INSTRUCTIONS + '\n' + facts.live),
    messages: promptMessages(conversation.summary, conversation.messages, { key: process.env.BETTER_AUTH_SECRET ?? '', scope: JSON.stringify([owner, bot]) }),
  }
}

test('all independent prompt reads start before any completes, keeping bytes, scope and one call each', async () => {
  gates = { execution: deferred(), personal: deferred(), github: deferred() }
  const pending = preparePrompt(owner, bot, snapshot)
  await firstStarted.promise
  try {
    // The old serial code starts only execution here. No sleeps or timing threshold.
    assert.deepEqual(calls.map(call => call.reader), ['execution', 'personal', 'github'])
    assert.deepEqual(calls.find(call => call.reader === 'execution')?.args, [owner, bot])
    assert.deepEqual(calls.find(call => call.reader === 'github')?.args, [owner, undefined, undefined, undefined, bot])
    assert.deepEqual(calls.find(call => call.reader === 'personal')?.args, [owner, withCoordinatorPresentation(executionInstructions(snapshot)), personal, { servers: [], skills: [] }])
  } finally {
    // Complete in reverse order; assembly order and the cache boundary must not change.
    gates.github!.resolve(); gates.personal!.resolve(); gates.execution!.resolve()
    await pending
  }
  assert.deepEqual(await pending, expectedPrompt())
  assert.equal(calls.length, 3)
})

test('a later turn reads current context again without caching or changing the frozen host', async () => {
  const first = await preparePrompt(owner, bot, snapshot)
  assert.deepEqual(first, expectedPrompt())
  personal = 'Updated synthetic instruction'; github = 'Updated authorized repositories'
  facts = { models: 'Updated allowed models', live: 'Updated availability' }
  const second = await preparePrompt(owner, bot, snapshot)
  assert.deepEqual(second, expectedPrompt())
  assert.notEqual(second.instructions, first.instructions)
  for (const reader of ['execution', 'personal', 'github'] as const) assert.equal(calls.filter(call => call.reader === reader).length, 2)
})

test('an instruction read refusal is propagated unchanged without retry or a partial prompt', async () => {
  denied = new Error('Synthetic instruction read refusal')
  await assert.rejects(preparePrompt(owner, bot, snapshot), error => error === denied)
  assert.equal(calls.filter(call => call.reader === 'personal').length, 1)
})

test('prepareTurn returns only fixed numeric context timings beside the unchanged model prompt', async () => {
  const prepared = await prepareTurn(owner, bot, 'synthetic-holder', { snapshot, mailboxEnabled: false, runtime: null })
  assert.deepEqual(prepared.prompt, expectedPrompt())
  assert.deepEqual(Object.keys(prepared.contextMs).sort(), ['execution', 'github', 'personal'])
  assert.ok(Object.values(prepared.contextMs).every(value => Number.isFinite(value) && value >= 0))
  assert.deepEqual(prepared.mailboxTools, [])
  assert.deepEqual(calls.map(call => call.reader), ['execution', 'personal', 'github'])
  assert.doesNotMatch(JSON.stringify(prepared.contextMs), /Synthetic|owner|request|instruction|repositories/)
  assert.ok(!('contextMs' in prepared.prompt) && !('phaseMs' in prepared.prompt), 'diagnostics never become model options or cached text')
})

test('hosted preparation forwards only its frozen discovery grant and scheduled-read restriction', async () => {
  for (const input of [
    { snapshot, runtime: {} },
    { snapshot: { ...snapshot, effectiveTools: [] }, runtime: {} },
    { snapshot, runtime: null },
  ]) {
    calls.length = 0
    await prepareTurn(owner, bot, 'synthetic-holder', { ...input, mailboxEnabled: false })
    assert.deepEqual(calls.find(call => call.reader === 'github')?.args, [
      owner, { hosted: true, readOnly: input.runtime === null, effectiveTools: input.snapshot.effectiveTools }, undefined, undefined, bot,
    ])
  }
})
