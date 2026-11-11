import assert from 'node:assert/strict'
import { after, before, beforeEach, mock, test } from 'node:test'
import { overrideDeploymentSwitch } from '../deployment-switches'
import { makeSnapshot } from '../agent-kit/definition'
import { DEFAULT_AGENT_DEFINITION } from '../agent-kit/builtin'
import { executionInstructions } from '../agent-kit/execution-instructions'
import { withCoordinatorPresentation } from './native-prompt'
import { cachedContextLines, instructionsWithPersonal, promptWithCachedContext, type StoredMessage } from './context'
import { SCHEDULE_INSTRUCTIONS } from '../schedules/contract'

const owner = 'synthetic-prompt-owner', bot = '10000000-0000-4000-8000-000000000001'
const snapshot = makeSnapshot('10000000-0000-4000-8000-000000000002', 1, DEFAULT_AGENT_DEFINITION, 'Synthetic frozen host policy', { harness: 'ai_sdk', model: 'synthetic' })
const conversation: { summary: string | null; memory: string; messages: StoredMessage[] } = {
  summary: null, memory: 'Synthetic saved memory', messages: [{ position: 1, message: { role: 'user', content: 'Synthetic request' } }],
}
type Reader = 'execution' | 'personal' | 'github' | 'repositories' | 'profile'
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

stub('./store.ts', { loadProductPromptContext: async () => ({ ...conversation, personalInstructions: personal }), saveSummary: forbidden })
stub('./bot-instructions.ts', { botInstructions: forbidden })
stub('./personal-instructions.ts', { withPersonalInstructionText: async (...args: unknown[]) => {
  await enter('personal', args)
  if (denied) throw denied
  return instructionsWithPersonal(args[1] as string, args[2] as string)
} })
stub('./github-context.ts', { githubPromptContext: async (...args: unknown[]) => { await enter('github', args); return github },
  // The turn asks which repositories this chat works in before reading the person's facts.
  usedRepositoriesForBot: async (...args: unknown[]) => { await enter('repositories', args); return ['synthetic/repository'] } })
stub('../profile/store.ts', { profilePromptSection: async (...args: unknown[]) => { await enter('profile', args); return '' } })
stub('./execution-context.ts', { executionContextParts: async (...args: unknown[]) => { await enter('execution', args); return facts } })
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

let prepareEveInstructions: typeof import('../../workflows/coordinator/steps')['prepareEveInstructions']
before(async () => {
  overrideDeploymentSwitch('factoryRouting', false)
  ;({ prepareEveInstructions } = await import('../../workflows/coordinator/steps'))
})
after(() => overrideDeploymentSwitch('factoryRouting', undefined))
beforeEach(() => {
  calls.length = 0; gates = {}; firstStarted = deferred(); denied = null
  personal = 'Synthetic personal instruction'; github = 'Synthetic authorized repositories'
  facts = { models: 'Synthetic allowed models', live: 'Synthetic current availability' }
})

function expectedPrompt() {
  const rules = instructionsWithPersonal(withCoordinatorPresentation(executionInstructions(snapshot)), personal)
  return promptWithCachedContext(rules, cachedContextLines(github, facts.models), conversation.memory, '\n' + SCHEDULE_INSTRUCTIONS + '\n' + facts.live).instructions
}

test('all independent prompt reads start before any completes, keeping bytes, scope and one call each', async () => {
  gates = { execution: deferred(), personal: deferred(), github: deferred() }
  const pending = prepareEveInstructions(owner, bot, snapshot)
  await firstStarted.promise
  try {
    // The old serial code starts only execution here. No sleeps or timing threshold.
    // The profile read runs after these three, from the repositories this chat works in,
    // so only the parallel set is asserted here against the gates.
    assert.deepEqual(calls.map(call => call.reader).filter(reader => reader !== 'repositories' && reader !== 'profile'), ['execution', 'personal', 'github'])
    assert.deepEqual(calls.find(call => call.reader === 'execution')?.args, [owner, bot])
    assert.deepEqual(calls.find(call => call.reader === 'github')?.args, [owner, { hosted: true, readOnly: false, effectiveTools: snapshot.effectiveTools }, undefined, undefined, bot])
    assert.deepEqual(calls.find(call => call.reader === 'personal')?.args, [owner, withCoordinatorPresentation(executionInstructions(snapshot)), personal, { servers: [], skills: [] }])
  } finally {
    // Complete in reverse order; assembly order and the cache boundary must not change.
    gates.github!.resolve(); gates.personal!.resolve(); gates.execution!.resolve()
    await pending
  }
  assert.deepEqual(await pending, expectedPrompt())
  // Exactly five reads and no more: the three parallel context parts, then the
  // repositories this chat works in, then what Mikka has learnt about the person.
  assert.equal(calls.length, 5)
})

test('a later turn reads current context again without caching or changing the frozen host', async () => {
  const first = await prepareEveInstructions(owner, bot, snapshot)
  assert.deepEqual(first, expectedPrompt())
  personal = 'Updated synthetic instruction'; github = 'Updated authorized repositories'
  facts = { models: 'Updated allowed models', live: 'Updated availability' }
  const second = await prepareEveInstructions(owner, bot, snapshot)
  assert.deepEqual(second, expectedPrompt())
  assert.notEqual(second, first)
  for (const reader of ['execution', 'personal', 'github'] as const) assert.equal(calls.filter(call => call.reader === reader).length, 2)
  // What Mikka learnt about the person is re-read every turn too, never carried over.
  assert.equal(calls.filter(call => call.reader === 'profile').length, 2)
  assert.equal(calls.filter(call => call.reader === 'repositories').length, 2)
})

test('an instruction read refusal is propagated unchanged without retry or a partial prompt', async () => {
  denied = new Error('Synthetic instruction read refusal')
  await assert.rejects(prepareEveInstructions(owner, bot, snapshot), error => error === denied)
  assert.equal(calls.filter(call => call.reader === 'personal').length, 1)
})

test('Eve instructions keep frozen discovery grants and leave history to eve', async () => {
  const selected = { ...snapshot, effectiveTools: [] }
  const instructions = await prepareEveInstructions(owner, bot, selected)
  assert.deepEqual(calls.find(call => call.reader === 'github')?.args, [owner, { hosted: true, readOnly: false, effectiveTools: [] }, undefined, undefined, bot])
  assert.equal(typeof instructions, 'string')
  assert.doesNotMatch(instructions, /Synthetic request/)
})
