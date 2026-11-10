import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { beforeEach, mock, test } from 'node:test'
import type { DecisionSourceLocator } from './contracts'
import type { ProjectScope } from './scope'
import { questionAnswerPrompt } from '../factory/questions/answer-prompt'

const id = { project: randomUUID(), workspace: randomUUID(), issue: randomUUID(), outside: randomUUID(), run: randomUUID(), otherRun: randomUUID(), bot: randomUUID(), otherBot: randomUUID(), chunk: randomUUID(), message: randomUUID(), task: randomUUID(), attempt: randomUUID(), candidate: randomUUID(), question: randomUUID(), artifact: randomUUID(), version: randomUUID(), group: randomUUID(), event: randomUUID(), acceptance: randomUUID(), mailbox: randomUUID() }
const now = new Date('2026-11-04T10:00:00Z')
const scope = { reader: 'owner', userId: 'owner', workspaceId: id.workspace, projectId: id.project, issueIds: [id.issue], project: {} } as ProjectScope
let visible = true, personalWorkspace = false, runOutside = false, resourceVisible = true
let resourceReaders: string[] = []
let records: Record<string, Record<string, unknown>>
let queries: { sql: string; values: unknown[] }[]
let masks: { type: string; target: unknown; value: unknown }[]
let reads = 0
const masked = (value: unknown) => JSON.parse(JSON.stringify(value).replaceAll('fixture-secret-value', '[REDACTED]'))
mock.module(new URL('../db/index.ts', import.meta.url).href, { namedExports: { db: {}, pool: { query: async (sql: string, values: unknown[] = []) => {
  queries.push({ sql, values })
  let key = ''
  if (sql.includes('FROM agent_runs')) key = 'run'
  else if (sql.includes('FROM run_chunks')) key = 'chunk'
  else if (sql.includes('FROM run_messages')) key = 'message'
  else if (sql.includes('FROM session_mailboxes')) key = 'mailbox'
  else if (sql.includes('FROM coordinator_messages')) key = 'botMessage'
  else if (sql.includes('FROM conversation_messages')) key = 'groupMessage'
  else if (sql.includes('FROM conversation_members')) return { rows: [{}], rowCount: 1 }
  else if (sql.includes('FROM factory_tasks')) key = 'task'
  else if (sql.includes('UNION ALL')) return { rows: [{}], rowCount: 1 }
  else if (sql.includes('FROM factory_attempts')) key = 'attempt'
  else if (sql.includes('FROM factory_candidates')) key = 'candidate'
  else if (sql.includes('FROM factory_events')) key = 'event'
  else if (sql.includes('FROM factory_deliverable_acceptances')) key = 'acceptance'
  else if (sql.includes('FROM factory_questions')) key = 'question'
  else if (sql.includes('FROM artifacts')) key = 'artifact'
  else if (sql.includes('FROM run_publications')) key = 'publication'
  else throw Error(`Unexpected source query: ${sql}`)
  const row = key === 'run' && values[0] === records.currentRun?.id ? records.currentRun : records[key]
  if (!row) return { rows: [], rowCount: 0 }
  if (key === 'run' && (values[0] !== row.id || values[1] !== row.userId)) return { rows: [], rowCount: 0 }
  if (['task', 'botMessage', 'question', 'acceptance'].includes(key) && values[1] !== row.userId) return { rows: [], rowCount: 0 }
  if (key === 'botMessage' && row.botId !== null && values[2] !== row.workspaceId) return { rows: [], rowCount: 0 }
  if (key === 'artifact' && (values[0] !== row.artifactId || values[1] !== row.versionId || values[2] !== row.userId)) return { rows: [], rowCount: 0 }
  if (key === 'mailbox' && (values[0] !== row.id || values[1] !== row.userId || row.kind !== 'run')) return { rows: [], rowCount: 0 }
  if (key === 'groupMessage' && (values[2] !== row.workspaceId || row.member !== true || row.kind !== 'group')) return { rows: [], rowCount: 0 }
  return { rows: [row], rowCount: 1 }
} } } })
mock.module(new URL('../device-link.ts', import.meta.url).href, { namedExports: { WORKSPACE_ID: '00000000-0000-4000-8000-000000000001' } })
mock.module(new URL('../tokens/scope.ts', import.meta.url).href, { namedExports: { isPersonalWorkspace: async (userId: string, workspaceId: string) => personalWorkspace && userId === 'owner' && workspaceId === id.workspace, runOutsideToken: async () => runOutside } })
mock.module(new URL('../issue-access.ts', import.meta.url).href, { namedExports: { issueForUser: async (_reader: unknown, issueId: string) => visible && issueId === id.issue ? { id: issueId, userId: 'owner', title: 'Source fixture', content: {}, revision: 1, createdAt: now } : null } })
mock.module(new URL('../secrets/runtime.ts', import.meta.url).href, { namedExports: {
  maskFor: async (target: unknown, value: unknown) => { masks.push({ type: 'owner', target, value }); return masked(value) },
  maskForRun: async (target: unknown, value: unknown) => { masks.push({ type: 'run', target, value }); return masked(value) },
} })
mock.module(new URL('../artifacts/storage.ts', import.meta.url).href, { namedExports: { getArtifactObject: async () => { reads++; return 'Original fixture-secret-value document' } } })
mock.module(new URL('../resource-access/store.ts', import.meta.url).href, { namedExports: { botChatResourceId: (_owner: string, botId: string) => botId, resourceActionAllowed: async (_db: unknown, reader: string) => { resourceReaders.push(reader); return resourceVisible } } })
mock.module(new URL('../factory/resource-access.ts', import.meta.url).href, { namedExports: { factoryContentReadable: async () => resourceVisible } })
const sourceModule = import('./sources')
const readDecisionSource = (...args: Parameters<typeof import('./sources').readDecisionSource>) => sourceModule.then(module => module.readDecisionSource(...args))
const resolveDecisionSources = (...args: Parameters<typeof import('./sources').resolveDecisionSources>) => sourceModule.then(module => module.resolveDecisionSources(...args))

beforeEach(() => {
  visible = true; personalWorkspace = false; runOutside = false; resourceVisible = true; resourceReaders = []; queries = []; masks = []; reads = 0
  records = {
    mailbox: { id: id.mailbox, userId: 'owner', workspaceId: id.workspace, kind: 'run', sessionKey: id.run },
    run: { id: id.run, mailboxId: id.mailbox, userId: 'owner', issueId: id.issue, botId: id.bot, sessionId: 'runtime-session', prompt: 'fixture-secret-value prompt', report: null, status: 'completed', createdAt: now },
    chunk: { id: id.chunk, runId: id.run, seq: 7, chunk: { type: 'text', text: 'fixture-secret-value' }, createdAt: now },
    message: { id: id.message, userId: 'owner', runId: id.run, origin: 'owner', text: 'Use the smaller design', createdAt: now },
    botMessage: { id: id.message, userId: 'owner', workspaceId: id.workspace, botId: id.bot, position: 8, message: { role: 'user', content: 'Original request' }, humanEvent: true, createdAt: now },
    groupMessage: { id: id.message, conversationId: id.group, position: '10', authorType: 'user', authorId: 'owner', body: 'Group source', createdAt: now, activeRunId: null, turnUserId: null, turnBotId: null, workspaceId: id.workspace, member: true, kind: 'group' },
    task: { id: id.task, userId: 'owner', issueId: id.issue, botId: id.bot, revision: 4, stage: 'verify', status: 'complete', reason: 'Checked', createdAt: now },
    attempt: { id: id.attempt, taskId: id.task, runId: id.run, sessionId: 'runtime-session', stage: 'verify', status: 'complete', reason: 'Checked', output: {}, evidence: [], createdAt: now },
    candidate: { id: id.candidate, taskId: id.task, runId: id.run, kind: 'repository', sha: 'a'.repeat(40), repository: 'https://github.com/owner/repo.git', environment: 'test', scope: 'repository', createdAt: now },
    event: { eventId: id.event, taskId: id.task, request: {}, result: {}, createdAt: now },
    acceptance: { id: id.acceptance, taskId: id.task, candidateId: id.candidate, userId: 'owner', sessionId: 'human-session', createdAt: now },
    question: { id: id.question, userId: 'owner', issueId: id.issue, taskId: id.task, originRunId: id.run, originSessionId: 'runtime-session', originRevision: 2, question: 'Which path?', context: 'Original work', options: ['A', 'B'], answerId: 'answer-stable-id', answerSource: 'human', answer: { text: 'Use A' }, createdAt: now, answeredAt: now },
    artifact: { artifactId: id.artifact, versionId: id.version, version: 3, userId: 'owner', issueId: id.issue, runId: id.run, title: 'Design', kind: 'markdown', size: 100, storageKey: 'private-storage-key', inlineContent: null, createdAt: now },
    publication: { runId: id.run, issueId: id.issue, remoteKey: 'github.com/owner/repo', pullRequest: { url: 'https://github.com/owner/repo/pull/21', title: 'A result', state: 'open' }, createdAt: now },
  }
})
const resolve = (source: DecisionSourceLocator, target = scope) => resolveDecisionSources(target, [{ role: 'evidence', source }])
const missing = (operation: Promise<unknown>) => assert.rejects(operation, { code: 'SOURCE_NOT_FOUND', status: 404 })

test('resolution returns coordinates and host metadata without retaining transcript copies', async () => {
  const [source] = await resolve({ type: 'run', id: id.run })
  assert.equal(source.relation, 'host_verified')
  assert.equal(source.locator.runId, id.run)
  assert.equal(source.occurredAt, now)
  assert.equal(source.authorKind, 'agent')
  assert.equal('text' in source, false)
  assert.equal('content' in source, false)
  assert.equal(JSON.stringify(source).includes('fixture-secret-value'), false)
  assert.equal(masks.length, 0)
  const [again] = await resolve(source.locator)
  assert.equal(source.normalizedKey, again.normalizedKey)
})

test('a project-visible issue does not open a teammate private run', async () => {
  records.run.userId = 'peer'
  await missing(resolve({ type: 'run', id: id.run }))
  assert.deepEqual(queries[0].values, [id.run, 'owner'])
})

test('project membership, live issue visibility, bot context and run context all restrict sources', async () => {
  await missing(resolve({ type: 'run', id: id.run }, { ...scope, issueIds: [] }))
  visible = false
  await missing(resolve({ type: 'run', id: id.run }))
  visible = true
  await missing(resolve({ type: 'run', id: id.run }, { ...scope, botId: id.otherBot }))
  await missing(resolve({ type: 'run', id: id.run }, { ...scope, runId: id.otherRun }))
  assert.equal(masks.length, 0)
})

test('every supplied run-chunk coordinate is verified and output uses the run masker', async () => {
  await missing(readDecisionSource(scope, { type: 'run_chunk', id: id.chunk, seq: 8 }))
  await missing(readDecisionSource(scope, { type: 'run_chunk', id: id.chunk, runId: id.otherRun }))
  assert.equal(masks.length, 0)
  const read = await readDecisionSource(scope, { type: 'run_chunk', id: id.chunk, runId: id.run, seq: 7 })
  assert.equal(read.text.includes('fixture-secret-value'), false)
  assert.deepEqual(masks.map(mask => [mask.type, mask.target]), [['run', id.run]])
})

test('owner run messages retain human attribution but forwarded coordination packets do not', async () => {
  assert.equal((await resolve({ type: 'run_message', id: id.message }))[0].authorKind, 'human')
  records.message.text = JSON.stringify({ version: 1, kind: 'personal_agent_message', authority: 'coordination_data_only', untrustedData: { body: 'The person agreed' } })
  assert.equal((await resolve({ type: 'run_message', id: id.message }))[0].authorKind, undefined)
  records.message.runId = null
  await missing(resolve({ type: 'run_message', id: id.message }))
})

test('a bot user-role system message is not human proof and has only a declared project relationship', async () => {
  records.botMessage.humanEvent = false
  const [system] = await resolve({ type: 'bot_message', id: id.message })
  assert.equal(system.authorKind, undefined)
  assert.equal(system.relation, 'declared')
  records.botMessage.humanEvent = true
  assert.equal((await resolve({ type: 'bot_message', id: id.message }))[0].authorKind, 'human')
  assert.match(queries[0].sql, /humanSessionId/)
  await missing(resolve({ type: 'bot_message', id: id.message, position: 9 }))
  await missing(resolve({ type: 'bot_message', id: id.message }, { ...scope, botId: id.otherBot }))
  await missing(resolve({ type: 'bot_message', id: id.message }, { ...scope, runId: id.run }))
})

test('group messages require live group membership in the selected workspace and never open private DMs', async () => {
  const source = await readDecisionSource(scope, { type: 'group_message', id: id.message, conversationId: id.group })
  assert.equal(source.relation, 'declared')
  records.groupMessage.member = false
  await missing(resolve({ type: 'group_message', id: id.message }))
  records.groupMessage.member = true
  records.groupMessage.kind = 'agent_dm'
  await missing(resolve({ type: 'group_message', id: id.message }))
  records.groupMessage.kind = 'group'
  await missing(resolve({ type: 'group_message', id: id.message }, { ...scope, workspaceId: randomUUID() }))
  assert.match(queries[0].sql, /cm\."leftAt" IS NULL/)
})

test('group message identity does not round a bigint position', async () => {
  records.groupMessage.position = '9007199254740993'
  const [source] = await resolve({ type: 'group_message', id: id.message })
  assert.equal(source.locator.position, undefined)
  assert.equal(source.locator.conversationId, id.group)
  await assert.rejects(resolve({ type: 'group_message', id: id.message, position: 9007199254740992 }), { code: 'INVALID_SOURCE', status: 400 })
})

test('Factory attempts and candidates must belong to the declared task and project run', async () => {
  await missing(resolve({ type: 'attempt', id: id.attempt, taskId: randomUUID() }))
  const [candidate] = await resolve({ type: 'candidate', id: id.candidate })
  assert.equal(candidate.locator.commitSha, 'a'.repeat(40))
  assert.equal(candidate.locator.repositoryKey, 'owner/repo')
  records.run.issueId = id.outside
  await missing(resolve({ type: 'candidate', id: id.candidate }))
})

test('commit references are existing repository candidates, never caller-provided code or URLs', async () => {
  await missing(resolve({ type: 'commit', id: id.candidate, commitSha: 'b'.repeat(40) }))
  await missing(resolve({ type: 'commit', id: id.candidate, repositoryKey: 'other/repo' }))
  const [source] = await resolve({ type: 'commit', id: id.candidate, repositoryKey: 'owner/repo', commitSha: 'a'.repeat(40) })
  assert.equal(source.locator.taskId, id.task)
  records.candidate.kind = 'report'
  await missing(resolve({ type: 'commit', id: id.candidate }))
})

test('Factory events require the composite task key and acceptances use the recorded human', async () => {
  await missing(resolve({ type: 'factory_event', id: id.event }))
  assert.equal((await resolve({ type: 'factory_event', id: id.event, taskId: id.task }))[0].relation, 'host_verified')
  const [acceptance] = await resolve({ type: 'acceptance', id: id.acceptance })
  assert.equal(acceptance.authorKind, 'human')
  assert.equal(acceptance.authorId, 'owner')
  await missing(resolve({ type: 'acceptance', id: id.acceptance, sessionId: 'invented-session' }))
})

test('an answer is tied to its stable answer identity and orchestrator answers are not human evidence', async () => {
  await missing(resolve({ type: 'answer', id: id.question }))
  await missing(resolve({ type: 'answer', id: id.question, answerId: 'invented-answer' }))
  const [source] = await resolve({ type: 'answer', id: id.question, answerId: 'answer-stable-id' })
  assert.equal(source.authorKind, 'human')
  assert.equal(source.locator.revision, 2)
  records.question.answerSource = 'orchestrator'
  assert.equal((await resolve(source.locator))[0].authorKind, undefined)
  records.question.originSessionId = 'other-session'
  await missing(resolve(source.locator))
})

test('artifact version references never leak storage keys or fetch raw content while recording', async () => {
  const [source] = await resolve({ type: 'artifact_version', id: id.artifact, versionId: id.version })
  assert.equal(reads, 0)
  assert.equal(source.locator.revision, 3)
  assert.equal(JSON.stringify(source).includes('private-storage-key'), false)
  await missing(resolve({ type: 'artifact_version', id: id.artifact, versionId: randomUUID() }))
  const read = await readDecisionSource(scope, source.locator)
  assert.equal(reads, 1)
  assert.equal(read.text.includes('fixture-secret-value'), false)
  assert.equal(read.text.includes('private-storage-key'), false)
})

test('PR references are bound to the run publication repository and pull request number', async () => {
  const [source] = await resolve({ type: 'pull_request', id: id.run })
  assert.equal(source.locator.prNumber, 21)
  await missing(resolve({ type: 'pull_request', id: id.run, prNumber: 22 }))
  records.publication.pullRequest = { url: 'https://github.com/other/repo/pull/21', state: 'open' }
  await missing(resolve({ type: 'pull_request', id: id.run }))
  records.publication.pullRequest = { url: 'https://example.invalid/owner/repo/pull/21', state: 'open' }
  await missing(resolve({ type: 'pull_request', id: id.run }))
})

test('masking runs on the whole original before the displayed excerpt is clipped', async () => {
  records.message.text = 'a'.repeat(15_995) + 'fixture-secret-value' + 'z'.repeat(100)
  const read = await readDecisionSource(scope, { type: 'run_message', id: id.message })
  assert.equal(read.truncated, true)
  assert.equal(read.text.length, 16_000)
  assert.equal(read.text.endsWith('[REDA'), true)
  assert.equal(read.text.includes('fixture'), false)
  assert.equal((masks[0].value as string).includes('fixture-secret-value'), true)
})

test('malformed, irrelevant or unavailable coordinates never produce a successful placeholder', async () => {
  await missing(resolve({ type: 'run', id: 'not-a-uuid' }))
  await missing(resolve({ type: 'run', id: id.run, taskId: id.task }))
  delete records.run
  await missing(readDecisionSource(scope, { type: 'run', id: id.run }))
  await assert.rejects(resolveDecisionSources(scope, Array.from({ length: 51 }, () => ({ role: 'evidence', source: { type: 'run', id: id.run } }))), { code: 'TOO_MANY_SOURCES' })
})

test('only a doubly bound question continuation may cite its original run evidence', async () => {
  records.currentRun = { ...records.run, id: id.otherRun, questionContinuation: { questionId: id.question, originRunId: id.run } }
  records.question.continuationRunId = id.otherRun
  const continuationScope = { ...scope, runId: id.otherRun }
  const followUp = questionAnswerPrompt({ questionId: id.question, question: 'Which path?', answerId: 'answer-stable-id', answerSource: 'human', answerText: 'Use A' })
  const { source: locator } = JSON.parse(followUp.split('\n')[0])
  const [source] = await resolve(locator, continuationScope)
  assert.equal(source.authorKind, 'human')
  assert.equal(source.locator.runId, id.run)
  // The exception belongs to this question, not all records in that old run.
  await missing(resolve({ type: 'run_chunk', id: id.chunk }, continuationScope))
  records.currentRun.questionContinuation = { questionId: randomUUID(), originRunId: id.run }
  await missing(resolve({ type: 'answer', id: id.question, answerId: 'answer-stable-id' }, continuationScope))
  records.currentRun.questionContinuation = { questionId: id.question, originRunId: id.run }
  records.question.continuationRunId = null
  await missing(resolve({ type: 'answer', id: id.question, answerId: 'answer-stable-id' }, continuationScope))
})

test('one source retains different evidence roles and option bindings', async () => {
  const source = { type: 'run' as const, id: id.run }
  const resolved = await resolveDecisionSources(scope, [
    { role: 'evidence', source }, { role: 'stopped_at', optionId: 'A', source }, { role: 'stopped_at', optionId: 'B', source },
  ])
  assert.equal(new Set(resolved.map(item => item.normalizedKey)).size, 3)
})

test('owned bot history cannot cross workspace boundaries or lose its tenant binding', async () => {
  await missing(resolve({ type: 'bot_message', id: id.message }, { ...scope, workspaceId: randomUUID() }))
  records.botMessage.botId = null
  await missing(resolve({ type: 'bot_message', id: id.message }))
  assert.equal(masks.length, 0)
})

test('artifact content is type and size checked before any storage read', async () => {
  records.artifact.size = 2_000_001
  await missing(readDecisionSource(scope, { type: 'artifact_version', id: id.artifact, versionId: id.version }))
  records.artifact.size = 10
  records.artifact.kind = 'video'
  await missing(readDecisionSource(scope, { type: 'artifact_version', id: id.artifact, versionId: id.version }))
  assert.equal(reads, 0)
})

test('raw excerpts hide account emails, server paths and credentials carried by URLs', async () => {
  records.run.report = { email: 'subscription@example.invalid', path: '/home/agent/private/repo/file.ts', windows: 'C:\\Users\\Alex\\repo', url: 'https://username:password@example.invalid/path?token=unknown-token#secret-fragment', secret: 'fixture-secret-value' }
  const read = await readDecisionSource(scope, { type: 'run', id: id.run })
  for (const value of ['subscription@example.invalid', '/home/agent', 'C:', 'username', 'password', 'unknown-token', 'secret-fragment', 'fixture-secret-value']) assert.equal(read.text.includes(value), false, value)
  assert.equal(read.text.includes('[email]'), true)
  assert.equal(read.text.includes('[path]'), true)
  assert.equal(read.text.includes('https://example.invalid/path'), true)
})

test('legacy null-bot Coordinator history remains available only in its owner personal workspace', async () => {
  records.botMessage.botId = null
  personalWorkspace = true
  const [source] = await resolve({ type: 'bot_message', id: id.message, botId: null })
  assert.equal(source.relation, 'declared')
  await missing(resolve({ type: 'bot_message', id: id.message }, { ...scope, workspaceId: randomUUID() }))
  personalWorkspace = false
  await missing(resolve({ type: 'bot_message', id: id.message }))
})

test('a visible issue cannot override the run bot or computer workspace binding', async () => {
  runOutside = true
  await missing(resolve({ type: 'run', id: id.run }))
  await missing(resolve({ type: 'run_message', id: id.message }))
})

test('unbound-run mailbox messages require a real owner/workspace/run address', async () => {
  records.message.runId = null
  records.message.mailboxId = id.mailbox
  records.message.origin = 'peer'
  const [source] = await resolve({ type: 'run_message', id: id.message })
  assert.equal(source.locator.runId, id.run)
  assert.equal(source.locator.issueId, id.issue)
  assert.equal(source.relation, 'host_verified')
  assert.equal(source.authorKind, undefined)
  records.mailbox.workspaceId = randomUUID()
  await missing(resolve({ type: 'run_message', id: id.message }))
  records.mailbox.workspaceId = id.workspace
  records.run.mailboxId = randomUUID()
  await missing(resolve({ type: 'run_message', id: id.message }))
  records.run.mailboxId = id.mailbox
  records.mailbox.kind = 'bot'
  await missing(resolve({ type: 'run_message', id: id.message }))
})

test('mailbox retry authority is confined to the exact host-bound inbox', async () => {
  records.message.runId = null
  records.message.mailboxId = id.mailbox
  records.currentRun = { ...records.run, id: id.otherRun }
  const retryScope = { ...scope, runId: id.otherRun }
  const [source] = await resolve({ type: 'run_message', id: id.message }, retryScope)
  assert.equal(source.locator.runId, id.run)
  await missing(resolve({ type: 'run_chunk', id: id.chunk }, retryScope))
  records.currentRun.mailboxId = randomUUID()
  await missing(resolve({ type: 'run_message', id: id.message }, retryScope))
})

test('legacy mailbox namespace is restricted to its owner personal workspace', async () => {
  records.message.runId = null
  records.message.mailboxId = id.mailbox
  records.mailbox.workspaceId = '00000000-0000-4000-8000-000000000001'
  await missing(resolve({ type: 'run_message', id: id.message }))
  personalWorkspace = true
  assert.equal((await resolve({ type: 'run_message', id: id.message }))[0].locator.issueId, id.issue)
})

test('source issue anchors come only from the verified host record', async () => {
  const [source] = await resolve({ type: 'run', id: id.run })
  assert.equal(source.locator.issueId, id.issue)
  await missing(resolve({ type: 'run', id: id.run, issueId: id.outside }))
})

test('deleting a bot does not erase owned run evidence from project history', async () => {
  const [saved] = await resolve({ type: 'run', id: id.run })
  // agent_runs.botId uses ON DELETE SET NULL; its run/chunks remain owned.
  records.run.botId = null
  const current = await readDecisionSource(scope, saved.locator)
  assert.equal(current.locator.runId, id.run)
  const [reloaded] = await resolve({ type: 'run', id: id.run })
  assert.equal(reloaded.normalizedKey, saved.normalizedKey)
})

test('live session updates do not change run or chunk identity, while explicit filters are checked', async () => {
  for (const locator of [{ type: 'run' as const, id: id.run }, { type: 'run_chunk' as const, id: id.chunk }]) {
    records.run.sessionId = 'runtime-session'
    const [saved] = await resolve(locator)
    // PATCH /v1/runs/:id may replace sessionId on a LIVE/paused run.
    records.run.sessionId = 'resumed-session'
    assert.equal((await readDecisionSource(scope, saved.locator)).locator.runId, id.run)
    await missing(resolve({ ...locator, sessionId: 'runtime-session' }))
    const [after] = await resolve(locator)
    assert.equal(after.normalizedKey, saved.normalizedKey)
  }
})

test('question and answer retain their frozen origin session after a run session update', async () => {
  for (const locator of [{ type: 'question' as const, id: id.question }, { type: 'answer' as const, id: id.question, answerId: 'answer-stable-id' }]) {
    records.run.sessionId = 'runtime-session'
    const [saved] = await resolve(locator)
    records.run.sessionId = 'resumed-session'
    const read = await readDecisionSource(scope, saved.locator)
    assert.equal(read.locator.sessionId, 'runtime-session')
    assert.equal(read.locator.runId, id.run)
    await missing(resolve({ ...locator, sessionId: 'resumed-session' }))
  }
})

test('an exact artifact version uses its submitter for authority, attribution and masking', async () => {
  records.currentRun = { ...records.run, id: id.otherRun }
  // The version query returned B's receipt; A is only the artifact creator.
  records.artifact = { ...records.artifact, version: 2, runId: id.otherRun, title: 'B version' }
  const source = { type: 'artifact_version' as const, id: id.artifact, versionId: id.version }
  const [resolved] = await resolve(source, { ...scope, runId: id.otherRun })
  assert.equal(resolved.locator.runId, id.otherRun)
  assert.equal(resolved.locator.revision, 2)
  assert.equal(resolved.authorId, id.otherRun)
  await missing(resolve(source, { ...scope, runId: id.run }))
  await missing(resolve({ ...source, runId: id.run }))
  await readDecisionSource(scope, resolved.locator)
  assert.equal(masks[0].type, 'run')
  assert.equal(masks[0].target, id.otherRun)
})

test('shared project evidence rechecks the actual viewer on each private Thread and Artifact', async () => {
  const member = { ...scope, reader: { id: 'member' } }
  assert.equal((await readDecisionSource(member, { type: 'run', id: id.run })).locator.id, id.run)
  assert.deepEqual(resourceReaders, ['member'])
  resourceVisible = false
  await missing(readDecisionSource(member, { type: 'run_chunk', id: id.chunk }))
  await missing(readDecisionSource(member, { type: 'artifact_version', id: id.artifact, versionId: id.version }))
  assert.equal(reads, 0)
})
test('a shared message keeps its actual author, and private Bot or Factory evidence is not inherited from its owner', async () => {
  records.message.userId = 'member'
  const source = await readDecisionSource(scope, { type: 'run_message', id: id.message })
  assert.equal(source.authorId, 'member')
  resourceVisible = false
  await missing(readDecisionSource({ ...scope, reader: { id: 'member' } }, { type: 'bot_message', id: id.message }))
  await missing(readDecisionSource({ ...scope, reader: { id: 'member' } }, { type: 'factory_event', id: id.event, taskId: id.task }))
})
