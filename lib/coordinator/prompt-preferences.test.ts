/* eslint-disable unicorn/no-thenable -- The transport fixture implements Drizzle's awaitable query contract. */
import assert from 'node:assert/strict'
import { after, before, beforeEach, mock, test } from 'node:test'
import { PgDialect } from 'drizzle-orm/pg-core'
import { SQL } from 'drizzle-orm'
import { attentionSettings, coordinatorMessages, coordinatorSessions, userPreferences } from '../db/schema'
import { overrideDeploymentSwitch } from '../deployment-switches'
import { makeSnapshot } from '../agent-kit/definition'
import { DEFAULT_AGENT_DEFINITION } from '../agent-kit/builtin'
import { executionInstructions } from '../agent-kit/execution-instructions'
import { withCoordinatorPresentation } from './native-prompt'
import { instructionsWithPersonal, cachedContextLines, promptMessages, promptWithCachedContext } from './context'
import { SCHEDULE_INSTRUCTIONS } from '../schedules/contract'

const owner = 'synthetic-prompt-owner', peer = 'synthetic-prompt-peer'
const bot = '10000000-0000-4000-8000-000000000001'
const snapshot = makeSnapshot('10000000-0000-4000-8000-000000000002', 1, DEFAULT_AGENT_DEFINITION, 'Synthetic frozen host policy', { harness: 'ai_sdk', model: 'synthetic' })
const dialect = new PgDialect()
type ReadKind = 'session' | 'messages' | 'preferences' | 'attention'
type Preference = { memoryEnabled: boolean; personalInstructions: string }
type Message = { position: number; message: Record<string, unknown> }
const reads: { kind: ReadKind; owner: string; params: unknown[]; selection?: string[] }[] = []
let preferences: Record<string, Preference>, sessions: Record<string, { summary: string | null; summaryThrough: number; memory: string }>, messages: Record<string, Message[]>
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
let gates: Partial<Record<ReadKind, ReturnType<typeof deferred>>> = {}, started: Record<string, ReturnType<typeof deferred>> = {}
let errors: Partial<Record<ReadKind, Error>> = {}
let profileText = ''
const profileReads: { owner: string; bot: string; enabled: boolean | undefined }[] = []
const forbidden = () => { throw new Error('External, write and model effects are forbidden in prompt preference fixture') }
const database = {
  select(selection?: Record<string, unknown>) {
    let table: unknown, condition: SQL | undefined
    const joins: { table: unknown; condition: SQL }[] = []
    let result: Promise<unknown[]> | undefined
    const read = () => result ??= (async () => {
      const source = table instanceof SQL ? table : condition
      assert.ok(source instanceof SQL, 'every read has an explicit SQL owner boundary')
      const query = dialect.sqlToQuery(source)
      const who = query.params[0] as string
      assert.ok([owner, peer].includes(who), 'every read retains its requested owner')
      const joined = table instanceof SQL
      const kind = joined || table === userPreferences ? 'preferences' : table === coordinatorSessions ? 'session' : table === coordinatorMessages ? 'messages' : undefined
      assert.ok(kind, 'only the prompt input tables and the exact legacy preference join are read')
      if (joined) {
        assert.equal(condition, undefined)
        assert.equal(query.sql, '(values ($1::text)) as preference_owner("userId")')
        assert.deepEqual(selection, { preferences: userPreferences, proactive: attentionSettings.enabled })
        assert.equal(joins.length, 2)
        for (const [index, expected] of [
          { table: userPreferences, sql: '"user_preferences"."userId" = preference_owner."userId"' },
          { table: attentionSettings, sql: '"attention_settings"."userId" = preference_owner."userId"' },
        ].entries()) {
          assert.equal(joins[index].table, expected.table)
          const join = dialect.sqlToQuery(joins[index].condition)
          assert.equal(join.sql, expected.sql)
          assert.deepEqual(join.params, [])
        }
      } else {
        assert.equal(joins.length, 0)
        assert.match(query.sql, /"userId" = \$1/)
      }
      if (kind === 'preferences') assert.deepEqual(query.params, [who])
      else { assert.equal(query.params[1], bot); assert.match(query.sql, /"botId" = \$2/) }
      reads.push({ kind, owner: who, params: query.params, selection: selection && Object.keys(selection) })
      started[kind]?.resolve()
      await gates[kind]?.promise
      if (errors[kind]) throw errors[kind]
      if (kind === 'session') return sessions[who] ? [{ ...sessions[who] }] : []
      if (kind === 'messages') {
        assert.equal(query.params[2], sessions[who]?.summaryThrough ?? 0)
        return messages[who].filter(row => row.position > Number(query.params[2])).sort((a, b) => a.position - b.position)
      }
      const row = preferences[who]
      // VALUES retains one owner row even when either optional table is empty.
      // This fixture has no attention row, matching the original true default.
      if (joined) return [{ preferences: row ? { ...row } : null, proactive: null }]
      if (!row) return []
      if (selection && 'text' in selection) return [{ text: row.personalInstructions }]
      return [{ ...row }]
    })()
    const q = {
      from(value: unknown) { table = value; return q },
      leftJoin(value: unknown, on: SQL) { joins.push({ table: value, condition: on }); return q },
      where(value: SQL) { condition = value; return q },
      orderBy() { return q },
      limit() { return read() },
      then(resolve: (value: unknown[]) => unknown, reject: (error: unknown) => unknown) { return read().then(resolve, reject) },
    }
    return q
  },
}
const stub = (path: string, namedExports: Record<string, unknown>) => mock.module(new URL(path, import.meta.url).href, { namedExports })
stub('../db/index.ts', { db: database, pool: null, withDatabaseClient: forbidden })
stub('../attention/store.ts', {
  attentionEnabled: async (who: string) => { reads.push({ kind: 'attention', owner: who, params: [who] }); return true },
  setAttentionEnabled: forbidden, recordDecision: forbidden, settleTurn: forbidden,
})
stub('../agent-runs.ts', { addRunMessage: forbidden, queueRun: forbidden, queueFactoryRun: forbidden, readRun: forbidden, requestRunStop: forbidden, visibleRuns: forbidden })
stub('../issue-visibility.ts', { issueVisibility: forbidden })
stub('../issue-access.ts', { issueForUser: forbidden, requireUser: forbidden })
stub('../task-identifier-server.ts', { taskIdentifiers: forbidden, taskPrefixInput: forbidden, issueView: forbidden })
stub('../artifacts/store.ts', { artifactSummaries: forbidden })
stub('./bot-instructions.ts', { botInstructions: forbidden })
stub('./execution-context.ts', { executionContextParts: async () => ({ models: 'Synthetic allowed models', live: 'Synthetic current availability' }) })
stub('./github-context.ts', { githubPromptContext: async () => 'Synthetic authorized repositories' })
stub('../profile/memory.ts', { memoryForBotPrompt: async (who: string, botId: string, enabled?: boolean) => {
  profileReads.push({ owner: who, bot: botId, enabled })
  assert.equal(enabled, true, 'the same prompt preference snapshot supplies the profile switch')
  return profileText
} })
stub('./summary-model.ts', { summarizeConversation: forbidden })
stub('../personal-mailbox-config.ts', { personalMailboxEnabled: () => false })
stub('../search/index.ts', { webSearch: forbidden })
// The real prompt/tool graph imports session helpers; reading preferences must never authenticate.
const unexpectedAuth = () => { throw new Error('Unexpected authentication or OAuth effect in pure prompt fixture') }
stub('../auth.ts', { auth: new Proxy({}, { get: unexpectedAuth }), authBaseURL: 'https://auth-fixture.example.invalid' })
stub('../device-link.ts', { DEVICE_ONLINE_WINDOW_MS: 60000, WORKSPACE_ID: 'synthetic-unused', issueDeviceToken: unexpectedAuth })
stub('../composio.ts', { runComposioAction: forbidden })
stub('../github/user-access.ts', { readAuthorizedIssue: forbidden })
stub('../pending-action-store.ts', { proposeAction: forbidden, writeAccountAction: forbidden, proposeRepositoryPush: forbidden })
stub('../telegram/client.ts', { postTelegramText: forbidden })
stub('../../workflows/coordinator/tool-scope.ts', { assertNativeToolScope: forbidden })
mock.module('next/server', { namedExports: { NextResponse: Response, after: () => {} } })

let sdk: typeof import('../../workflows/coordinator/steps'), store: typeof import('./store'), personal: typeof import('./personal-instructions')
before(async () => {
  overrideDeploymentSwitch('factoryRouting', false)
  ;[sdk, store, personal] = await Promise.all([import('../../workflows/coordinator/steps'), import('./store'), import('./personal-instructions')])
})
after(() => overrideDeploymentSwitch('factoryRouting', undefined))
beforeEach(() => {
  reads.length = 0; gates = {}; errors = {}; started = {}
  profileReads.length = 0; profileText = ''
  preferences = {
    [owner]: { memoryEnabled: true, personalInstructions: 'Synthetic personal instruction' },
    [peer]: { memoryEnabled: false, personalInstructions: 'Synthetic peer instruction' },
  }
  sessions = {
    [owner]: { summary: null, summaryThrough: 1, memory: 'Synthetic saved memory' },
    [peer]: { summary: null, summaryThrough: 1, memory: 'Synthetic peer memory' },
  }
  messages = Object.fromEntries([owner, peer].map(who => [who, [
    { position: 1, message: { role: 'user', content: 'Already summarized' } },
    { position: 4, message: { role: 'user', content: `${who} current request`, mikkaStreamId: 'synthetic-stream', mikkaStopped: true, mikkaFailure: 'synthetic', mikkaFailureDetails: {}, mikkaRetried: false } },
    { position: 2, message: { role: 'user', content: 'Replaced request', mikkaRetried: true } },
    { position: 3, message: { role: 'assistant', content: 'Synthetic previous reply' } },
  ]]))
})

test('actual hosted preparation reads prompt preferences once without attention or a second instruction query', async () => {
  const prompt = await sdk.preparePrompt(owner, bot, snapshot)
  assert.equal(reads.filter(row => row.kind === 'preferences' || row.kind === 'attention').length, 1)
  assert.deepEqual(reads.filter(row => row.kind === 'preferences').map(row => row.selection), [['memoryEnabled', 'personalInstructions']])
  const plainMessages = [{ position: 3, message: { role: 'assistant' as const, content: 'Synthetic previous reply' } }, { position: 4, message: { role: 'user' as const, content: `${owner} current request` } }]
  assert.deepEqual(prompt, {
    ...promptWithCachedContext(instructionsWithPersonal(withCoordinatorPresentation(executionInstructions(snapshot)), preferences[owner].personalInstructions), cachedContextLines('Synthetic authorized repositories', 'Synthetic allowed models'), sessions[owner].memory, '\n' + SCHEDULE_INSTRUCTIONS + '\nSynthetic current availability'),
    messages: promptMessages(null, plainMessages, { key: process.env.BETTER_AUTH_SECRET ?? '', scope: JSON.stringify([owner, bot]) }),
  })
  assert.equal(reads.length, 3, 'session, messages and one shared preference query only')
  assert.deepEqual(profileReads, [{ owner, bot, enabled: true }])
})

test('approved profile facts join the current owner prompt and the memory switch suppresses all profile reads', async () => {
  profileText = 'Synthetic approved profile fact'
  const first = await sdk.preparePrompt(owner, bot, snapshot)
  assert.match(first.instructions, /Synthetic approved profile fact/)
  assert.match(first.instructions, /Synthetic saved memory/)
  preferences[owner].memoryEnabled = false
  const second = await sdk.preparePrompt(owner, bot, snapshot)
  assert.doesNotMatch(second.instructions, /Synthetic approved profile fact|Synthetic saved memory/)
  assert.deepEqual(profileReads, [{ owner, bot, enabled: true }], 'disabled memory does not query or record usage')
  assert.equal(reads.filter(row => row.kind === 'preferences').length, 2, 'one preference read per preparation')
})

test('next hosted prompt uses fresh changed and cleared values without changing stored memory', async () => {
  const first = await sdk.preparePrompt(owner, bot, snapshot)
  preferences[owner] = { memoryEnabled: false, personalInstructions: '' }
  const second = await sdk.preparePrompt(owner, bot, snapshot)
  assert.match(first.instructions, /Synthetic personal instruction/)
  assert.match(first.instructions, /Synthetic saved memory/)
  assert.doesNotMatch(second.instructions, /Synthetic personal instruction|Synthetic saved memory/)
  assert.equal(sessions[owner].memory, 'Synthetic saved memory')
  assert.equal(reads.filter(row => row.kind === 'preferences').length, 2)
  assert.equal(reads.filter(row => row.kind === 'attention').length, 0)
})

test('prompt reader keeps missing-row defaults, owner scope and the legacy/native output contract', async () => {
  delete preferences[owner]
  const result = await store.loadConversationForPrompt(owner, bot)
  assert.equal(result.memory, 'Synthetic saved memory'); assert.equal(result.personalInstructions, ''); assert.equal(result.memoryEnabled, true)
  assert.deepEqual(result.messages.map(row => row.position), [3, 4])
  assert.deepEqual(result.messages[1].message, { role: 'user', content: `${owner} current request` })
  const other = await store.loadConversationForPrompt(peer, bot)
  assert.equal(other.memory, ''); assert.equal(other.personalInstructions, 'Synthetic peer instruction'); assert.equal(other.memoryEnabled, false)
  assert.doesNotMatch(JSON.stringify(other), /synthetic-prompt-owner|Synthetic saved memory/)
  const legacy = await store.loadConversation(owner, bot)
  assert.deepEqual(legacy, { summary: result.summary, memory: result.memory, messages: result.messages })
  assert.equal('personalInstructions' in legacy, false)
})

test('already-read personal formatter preserves bytes and the legacy reader still reads each invocation', async () => {
  const plugins = { servers: [], skills: [] }
  const text = preferences[owner].personalInstructions
  const legacy = await personal.withPersonalInstructions(owner, 'Synthetic rules', plugins)
  const before = reads.length
  assert.equal(await personal.withPersonalInstructionText(owner, 'Synthetic rules', text, plugins), legacy)
  assert.equal(reads.length, before)
  preferences[owner].personalInstructions = ''
  assert.equal(await personal.withPersonalInstructions(owner, 'Synthetic rules', plugins), 'Synthetic rules')
  assert.equal(reads.filter(row => row.kind === 'preferences').length, 2)
})

test('preference read overlaps session and messages without making messages outrun summaryThrough', async () => {
  gates = { session: deferred(), preferences: deferred() }
  started = { session: deferred(), preferences: deferred(), messages: deferred() }
  const pending = store.loadConversationForPrompt(owner, bot)
  try {
    await Promise.all([started.session.promise, started.preferences.promise])
    assert.equal(reads.some(row => row.kind === 'messages'), false)
    gates.session!.resolve()
    await started.messages.promise
    assert.equal(reads.filter(row => row.kind === 'preferences').length, 1)
  } finally {
    gates.session!.resolve(); gates.preferences!.resolve()
    await pending
  }
})

test('early preference failure waits for the active conversation read before rejecting with its original cause', async () => {
  gates = { session: deferred() }; started = { preferences: deferred(), messages: deferred() }
  const denied = errors.preferences = new Error('Synthetic preference refusal')
  let settled = false
  const pending = store.loadConversationForPrompt(owner, bot)
  const observed = pending.then(() => { settled = true; return undefined }, error => { settled = true; return error })
  await started.preferences.promise
  await Promise.resolve()
  assert.equal(settled, false)
  gates.session!.resolve()
  assert.equal(await observed, denied)
  assert.equal(reads.filter(row => row.kind === 'messages').length, 1)
})

for (const failure of ['session', 'messages', 'preferences', 'both'] as const) {
  test(`prompt input ${failure} failure retains the original cause with no retry or default fallback`, async () => {
    const conversationError = new Error('Synthetic conversation refusal'), preferenceError = new Error('Synthetic preference refusal')
    if (failure === 'session' || failure === 'both') errors.session = conversationError
    if (failure === 'messages') errors.messages = conversationError
    if (failure === 'preferences' || failure === 'both') errors.preferences = preferenceError
    await assert.rejects(store.loadConversationForPrompt(owner, bot), error => error === (failure === 'preferences' ? preferenceError : conversationError))
    assert.equal(reads.filter(row => row.kind === 'preferences').length, 1)
    assert.equal(reads.filter(row => row.kind === 'session').length, 1)
  })
}
