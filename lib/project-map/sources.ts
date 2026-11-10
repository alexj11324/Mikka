import 'server-only'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { pool } from '@/lib/db'
import { issueForUser } from '@/lib/issue-access'
import { isCoordinationMessage } from '@/lib/run-message-prompt'
import { isPersonalWorkspace, runOutsideToken } from '@/lib/tokens/scope'
import { tokenWorkspace } from '@/lib/tokens/principal'
import { WORKSPACE_ID } from '@/lib/device-link'
import { maskFor, maskForRun } from '@/lib/secrets/runtime'
import { getArtifactObject } from '@/lib/artifacts/storage'
import { ARTIFACT_MAX_BYTES } from '@/lib/artifacts/limits'
import { decisionSourceLocatorSchema, ProjectMapError, type DecisionSourceInput, type DecisionSourceLocator } from './contracts'
import type { ProjectScope } from './scope'
const readerId = (reader: ProjectScope['reader']) => typeof reader === 'string' ? reader : reader.id
import { botChatResourceId, resourceActionAllowed } from '@/lib/resource-access/store'
import { db } from '@/lib/db'

type SourceMetadata = {
  locator: DecisionSourceLocator
  normalizedKey: string
  relation: 'host_verified' | 'declared' | 'inferred'
  occurredAt: Date
  authorId?: string
  authorKind?: 'human' | 'bot' | 'agent'
}
export type ResolvedDecisionSource = SourceMetadata & Pick<DecisionSourceInput, 'role' | 'optionId'>
export type DecisionSourceRead = SourceMetadata & { text: string; truncated: boolean }
type LoadedSource = Omit<SourceMetadata, 'normalizedKey'> & {
  content: unknown | (() => Promise<unknown>)
  ownerId?: string
  maskRunId?: string
}
type Run = { id: string; userId: string; issueId: string | null; botId: string | null; sessionId: string | null; mailboxId: string | null; questionContinuation: { questionId: string; originRunId: string } | null; createdAt: Date; status: string }
type Task = { id: string; userId: string; workspaceId: string; issueId: string; botId: string | null; revision: number; createdAt: Date; stage: string; status: string }
type Context = { scope: ProjectScope; issues: Set<string>; runs: Map<string, Run>; tasks: Map<string, Task> }
function unavailable(): never { throw new ProjectMapError('SOURCE_NOT_FOUND', 404) }
const uuid = (id: string) => { if (!z.uuid().safeParse(id).success) unavailable(); return id }
const context = (scope: ProjectScope): Context => ({ scope, issues: new Set(), runs: new Map(), tasks: new Map() })
const botScoped = (scope: ProjectScope) => Object.prototype.hasOwnProperty.call(scope, 'botId')

/** Locators contain coordinates, never permission. Every public entry resolves them anew. */
async function requireIssue(ctx: Context, issueId: string | null) {
  if (!issueId || !ctx.scope.issueIds.includes(issueId)) unavailable()
  if (!ctx.issues.has(issueId)) {
    if (!await issueForUser(ctx.scope.reader, issueId)) unavailable()
    ctx.issues.add(issueId)
  }
}
async function requireRun(ctx: Context, id: string, question?: { id: string; continuationRunId: string | null }): Promise<Run> {
  uuid(id)
  if (ctx.scope.runId && ctx.scope.runId !== id) {
    if (!question || question.continuationRunId !== ctx.scope.runId) unavailable()
    const current = await requireRun(ctx, ctx.scope.runId)
    if (current.questionContinuation?.questionId !== question.id || current.questionContinuation.originRunId !== id) unavailable()
  }
  const prior = ctx.runs.get(id)
  if (prior) return prior
  const { rows: [run] } = await pool.query<Run>('SELECT id,"userId","issueId","botId","sessionId","mailboxId","questionContinuation","createdAt",status FROM agent_runs WHERE id=$1 AND "userId"=$2', [id, ctx.scope.userId])
  if (!run || (botScoped(ctx.scope) && run.botId !== ctx.scope.botId)) unavailable()
  await requireIssue(ctx, run.issueId)
  if (!await resourceActionAllowed(db, readerId(ctx.scope.reader), { kind: 'thread', id: run.id, workspaceId: ctx.scope.workspaceId }, 'canReadContent')) unavailable()
  if (await runOutsideToken({ id: ctx.scope.userId, [tokenWorkspace]: ctx.scope.workspaceId }, id)) unavailable()
  ctx.runs.set(id, run)
  return run
}
async function requireTask(ctx: Context, id: string): Promise<Task> {
  uuid(id)
  const prior = ctx.tasks.get(id)
  if (prior) return prior
  const { rows: [task] } = await pool.query<Task>('SELECT id,"userId","workspaceId","issueId","botId",revision,"createdAt",stage,status FROM factory_tasks WHERE id=$1 AND "userId"=$2', [id, ctx.scope.userId])
  if (!task || (botScoped(ctx.scope) && task.botId !== ctx.scope.botId)) unavailable()
  await requireIssue(ctx, task.issueId)
  if (!await (await import('../factory/resource-access')).factoryContentReadable(pool, task, readerId(ctx.scope.reader))) unavailable()
  if (ctx.scope.runId) {
    const run = await requireRun(ctx, ctx.scope.runId)
    if (run.issueId !== task.issueId) unavailable()
    const { rowCount } = await pool.query('SELECT 1 FROM factory_attempts WHERE "taskId"=$1 AND "runId"=$2 UNION ALL SELECT 1 FROM factory_candidates WHERE "taskId"=$1 AND "runId"=$2 LIMIT 1', [id, run.id])
    if (!rowCount) unavailable()
  }
  ctx.tasks.set(id, task)
  return task
}
function repositoryKey(value: string): string | null {
  const raw = value.trim().replace(/\.git$/i, '').replace(/\/$/, '')
  const path = raw.replace(/^(?:https?:\/\/)?github\.com\//i, '').replace(/^git@github\.com:/i, '')
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(path) ? path.toLowerCase() : null
}
function constrain(input: DecisionSourceLocator, actual: DecisionSourceLocator) {
  for (const key of Object.keys(input) as (keyof DecisionSourceLocator)[]) {
    const supplied = key === 'repositoryKey' ? input.repositoryKey?.toLowerCase() : input[key]
    if (supplied !== actual[key]) unavailable()
  }
  // A Bot deletion sets agent_runs.botId to null without deleting its run.
  // Keep current-scope checks above, but persist only durable source coordinates.
  const stable = { ...actual }
  if (stable.runId) {
    delete stable.botId
    // The daemon may update a live run's sessionId. References to that run,
    // unlike a question's origin session or an acceptance's human session,
    // are identified by immutable record ids. Explicit input still matched above.
    if (!['question', 'answer', 'attempt', 'acceptance'].includes(stable.type)) delete stable.sessionId
  }
  return stable
}
function metadata(source: LoadedSource, participation?: Pick<DecisionSourceInput, 'role' | 'optionId'>): SourceMetadata {
  const locator = source.locator
  const canonical = Object.fromEntries(Object.entries(locator).sort(([a], [b]) => a.localeCompare(b)))
  return {
    locator,
    normalizedKey: createHash('sha256').update(JSON.stringify(participation ? { locator: canonical, role: participation.role, optionId: participation.optionId ?? null } : canonical)).digest('hex'),
    relation: source.relation,
    occurredAt: source.occurredAt,
    ...(source.authorId ? { authorId: source.authorId } : {}),
    ...(source.authorKind ? { authorKind: source.authorKind } : {}),
  }
}
function runCoordinates(run: Run) { return { runId: run.id, ...(run.issueId ? { issueId: run.issueId } : {}), botId: run.botId, ...(run.sessionId ? { sessionId: run.sessionId } : {}) } }
/** A personal mailbox is project evidence only through a real run address.
 * Bot/Coordinator inboxes without a task anchor are deliberately unavailable. */
async function requireMailboxRun(ctx: Context, mailboxId: string | null): Promise<Run> {
  if (!mailboxId) unavailable()
  const { rows: [box] } = await pool.query<{ id: string; workspaceId: string; sessionKey: string }>(`SELECT b.id,b."workspaceId",b."sessionKey"
    FROM session_mailboxes b JOIN agent_runs r ON r.id::text=b."sessionKey" AND r."mailboxId"=b.id AND r."userId"=b."userId" AND r.kind<>'group_review'
    WHERE b.id=$1 AND b."userId"=$2 AND b.kind='run'`, [mailboxId, ctx.scope.userId])
  if (!box || (box.workspaceId !== ctx.scope.workspaceId && !(box.workspaceId === WORKSPACE_ID && await isPersonalWorkspace(ctx.scope.userId, ctx.scope.workspaceId)))) unavailable()
  // A host-assigned retry can keep its original mailbox. This proof permits
  // only this mailbox message, never arbitrary evidence from the earlier run.
  if (ctx.scope.runId && ctx.scope.runId !== box.sessionKey) {
    const current = await requireRun(ctx, ctx.scope.runId)
    if (current.mailboxId !== box.id) unavailable()
    const original = await requireRun({ ...ctx, scope: { ...ctx.scope, runId: undefined } }, box.sessionKey)
    if (original.issueId !== current.issueId || original.mailboxId !== box.id) unavailable()
    return original
  }
  const run = await requireRun(ctx, box.sessionKey)
  if (run.mailboxId !== box.id) unavailable()
  return run
}


async function loadSource(ctx: Context, raw: DecisionSourceLocator): Promise<LoadedSource> {
  const parsed = decisionSourceLocatorSchema.safeParse(raw)
  if (!parsed.success) throw new ProjectMapError('INVALID_SOURCE')
  const input = parsed.data
  const { scope } = ctx
  // All primary keys below are UUIDs, including Factory event ids. An answer's
  // external answerId is separate from its question UUID.
  uuid(input.id)
  switch (input.type) {
    case 'issue': {
      await requireIssue(ctx, input.id)
      const issue = await issueForUser(scope.reader, input.id)
      if (!issue) unavailable()
      if (scope.runId && (await requireRun(ctx, scope.runId)).issueId !== issue.id) unavailable()
      return { locator: constrain(input, { type: input.type, id: issue.id, issueId: issue.id, ...(input.revision !== undefined ? { revision: issue.revision } : {}) }), relation: 'host_verified', occurredAt: issue.createdAt, ownerId: issue.userId, content: { title: issue.title, content: issue.content } }
    }
    case 'run': {
      const run = await requireRun(ctx, input.id)
      return { locator: constrain(input, { type: input.type, id: run.id, ...runCoordinates(run) }), relation: 'host_verified', occurredAt: run.createdAt, authorKind: 'agent', authorId: run.id, maskRunId: run.id, content: async () => (await pool.query('SELECT prompt,report,status FROM agent_runs WHERE id=$1 AND "userId"=$2 LIMIT 1', [run.id, scope.userId])).rows[0] }
    }
    case 'run_chunk': {
      const { rows: [row] } = await pool.query<{ id: string; runId: string; seq: number; chunk: unknown; createdAt: Date }>('SELECT id,"runId",seq,chunk,"createdAt" FROM run_chunks WHERE id=$1', [input.id])
      if (!row) unavailable()
      const run = await requireRun(ctx, row.runId)
      return { locator: constrain(input, { type: input.type, id: row.id, ...runCoordinates(run), seq: row.seq }), relation: 'host_verified', occurredAt: row.createdAt, authorKind: 'agent', authorId: run.id, maskRunId: run.id, content: row.chunk }
    }
    case 'run_message': {
      const { rows: [row] } = await pool.query<{ id: string; runId: string | null; mailboxId: string | null; userId: string; text: string; origin: string; createdAt: Date }>('SELECT id,"runId","mailboxId","userId",text,origin,"createdAt" FROM run_messages WHERE id=$1', [input.id])
      if (!row) unavailable()
      const run = row.runId ? await requireRun(ctx, row.runId) : await requireMailboxRun(ctx, row.mailboxId)
      return { locator: constrain(input, { type: input.type, id: row.id, ...runCoordinates(run) }), relation: 'host_verified', occurredAt: row.createdAt, ...(row.origin === 'owner' && !isCoordinationMessage(row.text) ? { authorKind: 'human' as const, authorId: row.userId } : {}), maskRunId: run.id, content: row.text }
    }
    case 'bot_message': {
      if (scope.runId) unavailable()
      const { rows: [row] } = await pool.query<{ id: string; userId: string; botId: string | null; position: number; message: Record<string, unknown>; createdAt: Date; humanEvent: boolean }>(`SELECT m.id,m."userId",m."botId",m.position,m.message,m."createdAt",
        EXISTS (SELECT 1 FROM coordinator_events e WHERE e.id::text=m.message->'mikkaUserEvent'->>'id' AND e."userId"=m."userId" AND e."botId" IS NOT DISTINCT FROM m."botId" AND e.kind='user_message' AND e.payload->>'humanSessionId' IS NOT NULL) AS "humanEvent"
        FROM coordinator_messages m LEFT JOIN bots b ON b.id=m."botId" AND b."ownerId"=m."userId" AND b."workspaceId"=$3
        WHERE m.id=$1 AND m."userId"=$2 AND (m."botId" IS NULL OR b.id IS NOT NULL)`, [input.id, scope.userId, scope.workspaceId])
      if (!row || (botScoped(scope) && row.botId !== scope.botId)) unavailable()
      if (row.botId === null && (readerId(scope.reader) !== row.userId || !await isPersonalWorkspace(scope.userId, scope.workspaceId))) unavailable()
      if (row.botId && !await resourceActionAllowed(db, readerId(scope.reader), { kind: 'chat', id: botChatResourceId(row.userId, row.botId), workspaceId: scope.workspaceId }, 'canReadContent')) unavailable()
      const author = row.message.role === 'user' && row.humanEvent ? { authorKind: 'human' as const, authorId: row.userId }
        : row.message.role === 'assistant' ? { authorKind: 'bot' as const, authorId: row.botId ?? row.userId } : {}
      return { locator: constrain(input, { type: input.type, id: row.id, botId: row.botId, position: row.position }), relation: 'declared', occurredAt: row.createdAt, ...author, ownerId: row.userId, content: row.message.content ?? row.message }
    }
    case 'group_message': {
      if (scope.runId) unavailable()
      const { rows: [row] } = await pool.query<{ id: string; conversationId: string; position: string; authorType: 'user' | 'bot' | 'agent'; authorId: string; body: string; createdAt: Date; activeRunId: string | null; turnUserId: string | null; turnBotId: string | null }>(`SELECT m.id,m."conversationId",m.position::text,m."authorType",m."authorId",m.body,m."createdAt",t."activeRunId",t."userId" AS "turnUserId",t."botId" AS "turnBotId"
        FROM conversation_messages m JOIN conversations c ON c.id=m."conversationId" AND c.kind='group' AND c."workspaceId"=$3
        JOIN conversation_members cm ON cm."conversationId"=c.id AND cm."memberType"='user' AND cm."memberId"=$2 AND cm."leftAt" IS NULL
        LEFT JOIN group_turns t ON t."messageId"=m.id AND t."conversationId"=c.id
        WHERE m.id=$1`, [input.id, readerId(scope.reader), scope.workspaceId])
      if (!row) unavailable()
      if (botScoped(scope)) {
        if (!scope.botId) unavailable()
        const { rowCount } = await pool.query(`SELECT 1 FROM conversation_members WHERE "conversationId"=$1 AND "memberType"='bot' AND "memberId"=$2 AND "leftAt" IS NULL`, [row.conversationId, scope.botId])
        if (!rowCount) unavailable()
      }
      let run: Run | undefined
      // A turn dispatch is a structural association only when the reader owns it.
      // Merely being in the same group never opens someone else's task transcript.
      if (row.activeRunId && row.turnUserId === scope.userId && (!botScoped(scope) || row.turnBotId === scope.botId)) run = await requireRun(ctx, row.activeRunId)
      const position = Number(row.position)
      return { locator: constrain(input, { type: input.type, id: row.id, conversationId: row.conversationId, ...(Number.isSafeInteger(position) ? { position } : {}), ...(run ? runCoordinates(run) : {}) }), relation: run ? 'host_verified' : 'declared', occurredAt: row.createdAt, authorKind: row.authorType === 'user' ? 'human' : row.authorType, authorId: row.authorId, ownerId: row.authorType === 'user' ? row.authorId : scope.userId, content: row.body }
    }
    case 'factory_task': {
      const task = await requireTask(ctx, input.id)
      return { locator: constrain(input, { type: input.type, id: task.id, taskId: task.id, issueId: task.issueId, botId: task.botId, ...(input.revision !== undefined ? { revision: task.revision } : {}) }), relation: 'host_verified', occurredAt: task.createdAt, content: async () => (await pool.query('SELECT stage,status,reason FROM factory_tasks WHERE id=$1 AND "userId"=$2 LIMIT 1', [task.id, scope.userId])).rows[0] }
    }
    case 'attempt': {
      const { rows: [row] } = await pool.query<{ id: string; taskId: string; runId: string | null; sessionId: string | null; stage: string; status: string; reason: string; output: unknown; evidence: unknown; createdAt: Date }>('SELECT id,"taskId","runId","sessionId",stage,status,reason,output,evidence,"createdAt" FROM factory_attempts WHERE id=$1', [input.id])
      if (!row) unavailable()
      const task = await requireTask(ctx, row.taskId)
      const run = row.runId ? await requireRun(ctx, row.runId) : undefined
      if (run && run.issueId !== task.issueId) unavailable()
      if (scope.runId && !run) unavailable()
      return { locator: constrain(input, { type: input.type, id: row.id, taskId: task.id, issueId: task.issueId, botId: task.botId, ...(run ? { runId: run.id } : {}), ...(row.sessionId ? { sessionId: row.sessionId } : {}) }), relation: 'host_verified', occurredAt: row.createdAt, ...(run ? { authorKind: 'agent' as const, authorId: run.id, maskRunId: run.id } : {}), content: { stage: row.stage, status: row.status, reason: row.reason, output: row.output, evidence: row.evidence } }
    }
    case 'candidate':
    case 'commit': {
      const { rows: [row] } = await pool.query<{ id: string; taskId: string; runId: string; kind: string; sha: string | null; repository: string; environment: string; scope: string; createdAt: Date }>('SELECT id,"taskId","runId",kind,sha,repository,environment,scope,"createdAt" FROM factory_candidates WHERE id=$1', [input.id])
      if (!row) unavailable()
      const task = await requireTask(ctx, row.taskId)
      const run = await requireRun(ctx, row.runId)
      if (run.issueId !== task.issueId) unavailable()
      const repo = repositoryKey(row.repository)
      const sha = row.sha?.toLowerCase()
      if (input.type === 'commit' && (row.kind !== 'repository' || !repo || !sha || !/^[a-f0-9]{40}$/.test(sha))) unavailable()
      return { locator: constrain(input, { type: input.type, id: row.id, taskId: task.id, ...runCoordinates(run), ...(repo ? { repositoryKey: repo } : {}), ...(sha && /^[a-f0-9]{40}$/.test(sha) ? { commitSha: sha } : {}) }), relation: 'host_verified', occurredAt: row.createdAt, authorKind: 'agent', authorId: run.id, maskRunId: run.id, content: { kind: row.kind, sha: row.sha, repository: row.repository, environment: row.environment, scope: row.scope } }
    }
    case 'factory_event': {
      if (!input.taskId) unavailable()
      const task = await requireTask(ctx, input.taskId)
      const { rows: [row] } = await pool.query<{ eventId: string; taskId: string; request: unknown; result: unknown; createdAt: Date }>('SELECT "eventId","taskId",request,result,"createdAt" FROM factory_events WHERE "eventId"=$1 AND "taskId"=$2', [input.id, task.id])
      if (!row) unavailable()
      return { locator: constrain(input, { type: input.type, id: row.eventId, taskId: task.id, issueId: task.issueId, botId: task.botId }), relation: 'host_verified', occurredAt: row.createdAt, content: { request: row.request, result: row.result } }
    }
    case 'acceptance': {
      const { rows: [row] } = await pool.query<{ id: string; taskId: string; candidateId: string; userId: string; sessionId: string; createdAt: Date }>('SELECT id,"taskId","candidateId","userId","sessionId","createdAt" FROM factory_deliverable_acceptances WHERE id=$1 AND "userId"=$2', [input.id, scope.userId])
      if (!row) unavailable()
      const task = await requireTask(ctx, row.taskId)
      const { rows: [candidate] } = await pool.query<{ runId: string }>('SELECT "runId" FROM factory_candidates WHERE id=$1 AND "taskId"=$2', [row.candidateId, task.id])
      if (!candidate) unavailable()
      const run = await requireRun(ctx, candidate.runId)
      if (run.issueId !== task.issueId) unavailable()
      return { locator: constrain(input, { type: input.type, id: row.id, taskId: task.id, issueId: task.issueId, runId: run.id, botId: task.botId, sessionId: row.sessionId }), relation: 'host_verified', occurredAt: row.createdAt, authorKind: 'human', authorId: row.userId, maskRunId: run.id, content: { accepted: true, candidateId: row.candidateId } }
    }
    case 'question':
    case 'answer': {
      const { rows: [row] } = await pool.query<{ id: string; userId: string; issueId: string; taskId: string; originRunId: string; originSessionId: string; originRevision: number; continuationRunId: string | null; question: string; context: string; options: string[]; answerId: string | null; answerSource: string | null; answer: unknown; createdAt: Date; answeredAt: Date | null }>('SELECT id,"userId","issueId","taskId","originRunId","originSessionId","originRevision","continuationRunId",question,context,options,"answerId","answerSource",answer,"createdAt","answeredAt" FROM factory_questions WHERE id=$1 AND "userId"=$2', [input.id, scope.userId])
      if (!row) unavailable()
      const task = await requireTask(ctx, row.taskId)
      const run = await requireRun(ctx, row.originRunId, { id: row.id, continuationRunId: row.continuationRunId })
      if (row.issueId !== task.issueId || run.issueId !== task.issueId) unavailable()
      if (input.type === 'answer' && (!input.answerId || input.answerId !== row.answerId || !row.answeredAt)) unavailable()
      const human = input.type === 'answer' && (row.answerSource === 'human' || row.answerSource === 'human_event')
      return { locator: constrain(input, { type: input.type, id: row.id, taskId: task.id, ...runCoordinates(run), sessionId: row.originSessionId, revision: row.originRevision, ...(input.type === 'answer' && row.answerId ? { answerId: row.answerId } : {}) }), relation: 'host_verified', occurredAt: input.type === 'answer' ? row.answeredAt! : row.createdAt, ...(human ? { authorKind: 'human' as const, authorId: row.userId } : input.type === 'question' ? { authorKind: 'agent' as const, authorId: run.id } : {}), maskRunId: run.id, content: input.type === 'answer' ? row.answer : { question: row.question, context: row.context, options: row.options } }
    }
    case 'artifact_version': {
      // artifacts.runId is only the initial creator. Each later version belongs
      // to its exact host submission receipt, including its own issue and title.
      // Before receipts existed, only v1 can safely fall back to the creator.
      // Joining every matching dedupe key makes a conflicting receipt fail closed.
      const { rows: [row] } = await pool.query<{ artifactId: string; versionId: string; version: number; userId: string; issueId: string | null; runId: string | null; title: string; kind: string; size: number; storageKey: string | null; inlineContent: string | null; createdAt: Date }>(`SELECT a.id AS "artifactId",v.id AS "versionId",v.version,a."userId",
          CASE WHEN e.id IS NULL THEN a."issueId" ELSE e."issueId" END AS "issueId",
          CASE WHEN e.id IS NULL THEN a."runId" ELSE e."runId" END AS "runId",
          COALESCE(NULLIF(e.payload->>'title',''),a.title) AS title,a.kind,v.size,v."storageKey",v."inlineContent",v."createdAt"
        FROM artifacts a JOIN artifact_versions v ON v."artifactId"=a.id
        LEFT JOIN coordinator_events e ON e."dedupeKey"='artifact_submitted:' || a.id::text || ':' || v.version::text
        WHERE a.id=$1 AND v.id=$2 AND a."userId"=$3
          AND ((e.id IS NULL AND v.version=1) OR
            (e.kind='artifact_submitted' AND e."userId"=a."userId" AND e.payload->>'artifactId'=a.id::text
             AND jsonb_typeof(e.payload->'version')='number' AND e.payload->>'version'=v.version::text))`, [input.id, input.versionId ? uuid(input.versionId) : unavailable(), scope.userId])
      if (!row) unavailable()
      await requireIssue(ctx, row.issueId)
      if (!await resourceActionAllowed(db, readerId(scope.reader), { kind: 'artifact', id: row.artifactId, workspaceId: scope.workspaceId }, 'canReadContent')) unavailable()
      const run = row.runId ? await requireRun(ctx, row.runId) : undefined
      if (run && run.issueId !== row.issueId) unavailable()
      if (scope.runId && !run) unavailable()
      return { locator: constrain(input, { type: input.type, id: row.artifactId, versionId: row.versionId, revision: row.version, ...(row.issueId ? { issueId: row.issueId } : {}), ...(run ? runCoordinates(run) : {}) }), relation: 'host_verified', occurredAt: row.createdAt, ...(run ? { authorKind: 'agent' as const, authorId: run.id, maskRunId: run.id } : {}), ownerId: row.userId, content: async () => {
        if (row.kind !== 'markdown' && row.kind !== 'html') unavailable()
        const maxBytes = ARTIFACT_MAX_BYTES[row.kind]
        if (!Number.isSafeInteger(row.size) || row.size < 0 || row.size > maxBytes) unavailable()
        const content = row.inlineContent ?? (row.storageKey ? await getArtifactObject(row.storageKey) : unavailable())
        if (Buffer.byteLength(content, 'utf8') > maxBytes) unavailable()
        return { title: row.title, kind: row.kind, content }
      } }
    }
    case 'pull_request': {
      const run = await requireRun(ctx, input.id)
      const { rows: [row] } = await pool.query<{ runId: string; issueId: string; remoteKey: string; pullRequest: { url: string; title?: string; state: string } | null; createdAt: Date }>('SELECT "runId","issueId","remoteKey","pullRequest","createdAt" FROM run_publications WHERE "runId"=$1 AND "userId"=$2', [run.id, scope.userId])
      if (!row?.pullRequest || row.issueId !== run.issueId) unavailable()
      const repo = repositoryKey(row.remoteKey)
      if (!URL.canParse(row.pullRequest.url)) unavailable()
      const url = new URL(row.pullRequest.url)
      const match = /^\/([^/]+\/[^/]+)\/pull\/([1-9][0-9]*)\/?$/.exec(url.pathname)
      if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || !repo || !match || match[1].toLowerCase() !== repo) unavailable()
      return { locator: constrain(input, { type: input.type, id: run.id, ...runCoordinates(run), repositoryKey: repo, prNumber: Number(match[2]) }), relation: 'host_verified', occurredAt: row.createdAt, maskRunId: run.id, content: row.pullRequest }
    }
  }
}

/** Persist only this metadata. Transcript text is intentionally absent. */
export async function resolveDecisionSources(scope: ProjectScope, sources: readonly DecisionSourceInput[]): Promise<ResolvedDecisionSource[]> {
  if (sources.length > 50) throw new ProjectMapError('TOO_MANY_SOURCES')
  const ctx = context(scope)
  const resolved: ResolvedDecisionSource[] = []
  for (const source of sources) {
    const loaded = await loadSource(ctx, source.source)
    resolved.push({ ...metadata(loaded, source), role: source.role, ...(source.optionId ? { optionId: source.optionId } : {}) })
  }
  return resolved
}

/** Display privacy is applied after workspace/credential masking, never persisted. */
export function sanitizeSourceText(text: string): string {
  return text
    .replace(/https?:\/\/[^\s"'<>\\]+/gi, value => {
      try {
        const url = new URL(value)
        url.username = ''; url.password = ''; url.search = ''; url.hash = ''
        return url.toString()
      } catch { return '[url]' }
    })
    .replace(/file:\/\/[^\s"'<>]+/gi, '[path]')
    .replace(/(?<![A-Z0-9._%+-])[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/(?<![A-Za-z0-9])\/(?:home|root|Users|workspace|workspaces|tmp|private|var|etc|opt|mnt|srv|app|repo|repos|workdir|code)(?:\/[^\s"'<>\\]*)?/g, '[path]')
    .replace(/\b[A-Z]:[\\/][^\s"'<>]*/gi, '[path]')
}

/** Read one original record after current authorization; mask before clipping it. */
export async function readDecisionSource(scope: ProjectScope, locator: DecisionSourceLocator, options: { maxChars?: number } = {}): Promise<DecisionSourceRead> {
  const loaded = await loadSource(context(scope), locator)
  const raw = typeof loaded.content === 'function' ? await loaded.content() : loaded.content
  const safe = loaded.maskRunId ? await maskForRun(loaded.maskRunId, raw) : await maskFor({ workspaceId: scope.workspaceId, ownerId: loaded.ownerId ?? scope.userId }, raw)
  const text = sanitizeSourceText(typeof safe === 'string' ? safe : JSON.stringify(safe) ?? '')
  const limit = Math.max(1, Math.min(131_072, options.maxChars ?? 16_000))
  return { ...metadata(loaded), text: text.slice(0, limit), truncated: text.length > limit }
}
