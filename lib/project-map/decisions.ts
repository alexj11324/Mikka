import 'server-only'
import { createHash, randomUUID } from 'node:crypto'
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { db, pool } from '@/lib/db'
import { agentRuns, bots, factoryAttempts, factoryTasks, issues, projectDecisions, projectDecisionSources, runTokens } from '@/lib/db/schema'
import { workspaceDb } from '@/lib/workspace-db'
import { workspaceMembers, workspaces } from '@/lib/db/workspace-schema'
import type { IssueReader } from '@/lib/issue-visibility'
import { issueForUser } from '@/lib/issue-access'
import { isPersonalWorkspace } from '@/lib/tokens/scope'
import { readIssueMetadata } from '@/lib/issue-metadata'
import { requireLockedIssueScope } from '@/lib/issue-scope-authorization'
import { revalidateExecutionIdentity } from '@/lib/execution-identity'
import { maskFor, maskForRun } from '@/lib/secrets/runtime'
import { ProjectMapError, recordDecisionSchema, type DecisionActor, type DecisionSourceInput, type RecordDecisionInput } from './contracts'
import { projectForIssue, readerId, resolveProjectScope, withProjectWriteScope, type ProjectScope } from './scope'
import { resolveDecisionSources, readDecisionSource } from './sources'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  return '{' + Object.keys(value as object).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}'
}
function unavailable(): never { throw new ProjectMapError('SOURCE_NOT_FOUND', 404) }

async function actorContext(actor: DecisionActor, input: ReturnType<typeof recordDecisionSchema.parse>) {
  const userId = actor.kind === 'human' ? readerId(actor.user) : actor.userId
  let reader: IssueReader = actor.kind === 'human' ? actor.user : userId
  let workspaceId = actor.workspaceId
  let run: typeof agentRuns.$inferSelect | undefined
  if (actor.kind === 'run') {
    if (!actor.token) throw new ProjectMapError('RUN_NOT_AUTHORIZED', 403)
    const { verifyRunToken, workerActorReader } = await import('@/lib/mcp/worker')
    const authorization = await verifyRunToken(new Request('http://localhost'), actor.token)
    if (authorization?.extra?.runId !== actor.runId || authorization.extra.userId !== userId) throw new ProjectMapError('RUN_NOT_AUTHORIZED', 403)
    reader = workerActorReader(authorization)
    ;[run] = await db.select().from(agentRuns).where(and(eq(agentRuns.id, actor.runId), eq(agentRuns.userId, userId))).limit(1)
    if (!run?.issueId) throw new ProjectMapError('RUN_PROJECT_REQUIRED')
    const identity = await revalidateExecutionIdentity(pool, run)
    if (identity?.workspaceId) {
      if (workspaceId && workspaceId !== identity.workspaceId) throw new ProjectMapError('SCOPE_MISMATCH', 409)
      workspaceId = identity.workspaceId
    }
    if (input.runId && input.runId !== run.id) throw new ProjectMapError('SCOPE_MISMATCH', 409)
    if (input.issueId && input.issueId !== run.issueId) throw new ProjectMapError('SCOPE_MISMATCH', 409)
  } else if (actor.kind === 'bot' && actor.botId) {
    const [bot] = await db.select().from(bots).where(and(eq(bots.id, actor.botId), eq(bots.ownerId, userId), isNull(bots.archivedAt))).limit(1)
    if (!bot || bot.workspaceId !== workspaceId) throw new ProjectMapError('BOT_NOT_AUTHORIZED', 403)
  }
  if (!workspaceId) {
    const [personal] = await workspaceDb.select({ id: workspaces.id }).from(workspaces)
      .innerJoin(workspaceMembers, and(eq(workspaceMembers.workspaceId, workspaces.id), eq(workspaceMembers.userId, userId), eq(workspaceMembers.status, 'active')))
      .where(and(eq(workspaces.userId, userId), eq(workspaces.kind, 'personal'))).limit(1)
    workspaceId = personal?.id
  }
  if (!workspaceId) throw new ProjectMapError('PROJECT_NOT_FOUND', 404)
  if (actor.kind === 'bot' && !actor.botId && !await isPersonalWorkspace(userId, workspaceId)) throw new ProjectMapError('BOT_NOT_AUTHORIZED', 403)
  if (input.workspaceId && input.workspaceId !== workspaceId) throw new ProjectMapError('SCOPE_MISMATCH', 409)
  let issueId = run?.issueId ?? input.issueId ?? null
  let factoryTaskId = input.factoryTaskId ?? null
  if (run) {
    const [binding] = await db.select({ task: factoryTasks }).from(factoryAttempts)
      .innerJoin(factoryTasks, eq(factoryTasks.id, factoryAttempts.taskId)).where(eq(factoryAttempts.runId, run.id)).limit(1)
    if (binding) {
      if (factoryTaskId && factoryTaskId !== binding.task.id) throw new ProjectMapError('SCOPE_MISMATCH', 409)
      factoryTaskId = binding.task.id
    } else if (factoryTaskId) throw new ProjectMapError('SCOPE_MISMATCH', 409)
  }
  if (factoryTaskId) {
    const [task] = await db.select().from(factoryTasks).where(eq(factoryTasks.id, factoryTaskId)).limit(1)
    if (!task || task.userId !== userId || (issueId && issueId !== task.issueId)) unavailable()
    issueId = task.issueId
  }
  // A human/bot may cite an existing run, but it cannot claim to be its live worker.
  if (!run && input.runId) {
    const [referencedRun] = await db.select().from(agentRuns).where(and(eq(agentRuns.id, input.runId), eq(agentRuns.userId, userId))).limit(1)
    if (!referencedRun || (issueId && referencedRun.issueId !== issueId)) unavailable()
    issueId = referencedRun.issueId
    if (factoryTaskId) {
      const [attempt] = await db.select({ id: factoryAttempts.id }).from(factoryAttempts)
        .where(and(eq(factoryAttempts.taskId, factoryTaskId), eq(factoryAttempts.runId, referencedRun.id))).limit(1)
      if (!attempt) throw new ProjectMapError('SCOPE_MISMATCH', 409)
    }
  }
  const scope = input.projectId
    ? await resolveProjectScope(reader, input.projectId, workspaceId)
    : issueId ? await projectForIssue(reader, issueId, workspaceId) : null
  if (!scope) throw new ProjectMapError('PROJECT_REQUIRED')
  if (issueId && !scope.issueIds.includes(issueId)) unavailable()
  return { userId, reader, workspaceId, scope, run, issueId, factoryTaskId }
}

/** One authorization and persistence path for bot, run-token and human callers. */
export async function recordProjectDecision(actor: DecisionActor, raw: RecordDecisionInput) {
  const parsed = recordDecisionSchema.safeParse(raw)
  if (!parsed.success) throw new ProjectMapError('INVALID_DECISION')
  const context = await actorContext(actor, parsed.data)
  const { userId, reader, workspaceId, run, issueId, factoryTaskId } = context
  const runId = run?.id ?? parsed.data.runId ?? null
  const input = runId ? await maskForRun(runId, parsed.data) : await maskFor({ workspaceId, ownerId: userId }, parsed.data)
  const namespace = actor.kind === 'run' ? 'run:' + actor.runId
    : actor.kind === 'bot' ? 'bot:' + (actor.botId ?? userId) + ':' + (actor.sessionId ?? 'chat')
      : 'human:' + userId
  const idempotencyKey = namespace + ':' + input.idempotencyKey
  const sources: DecisionSourceInput[] = [...input.sources]
  if (runId && !sources.some(source => source.source.type === 'run' && source.source.id === runId))
    sources.push({ role: 'evidence', source: { type: 'run', id: runId } })
  if (sources.length > 50) throw new ProjectMapError('TOO_MANY_SOURCES')
  const recordedBy = {
    kind: actor.kind === 'run' ? 'agent' as const : actor.kind,
    id: actor.kind === 'run' ? actor.runId : actor.kind === 'bot' ? actor.botId ?? userId : userId,
    userId, botId: actor.kind === 'bot' ? actor.botId : run?.botId ?? null, runId: actor.kind === 'run' ? actor.runId : null,
    modelId: run?.agentDefinition?.model ?? run?.agentDefinition?.subscription?.modelId ?? run?.agentDefinition?.apiKey?.model ?? (actor.kind === 'bot' ? actor.modelId ?? null : null),
    harness: run?.agentDefinition?.harness ?? (actor.kind === 'bot' ? actor.harness ?? null : null),
    identityAssurance: actor.kind === 'run' ? 'run_token' : actor.kind === 'bot' ? 'host_context' : 'authenticated_user',
  }
  const requestedDecider = input.decidedBy ?? (input.provenance === 'inferred' ? { kind: 'unknown' as const, id: 'unknown' } : { kind: recordedBy.kind, id: recordedBy.id })
  const captureMode = input.provenance === 'inferred' ? 'reconstructed' as const : actor.kind === 'human' ? 'human_marked' as const : 'live' as const
  const sourceScope = { ...context.scope, userId, ...(actor.kind === 'run' ? { runId: actor.runId } : {}), ...(actor.kind === 'bot' ? { botId: actor.botId } : {}) }
    const resolved = await resolveDecisionSources(sourceScope, sources)
    const humanAuthors = [...new Set(resolved.filter(source => source.authorKind === 'human' && source.authorId).map(source => source.authorId!))]
    const deciderId = requestedDecider.id ?? (requestedDecider.kind === 'human'
      ? actor.kind === 'human' ? userId : humanAuthors.length === 1 ? humanAuthors[0] : undefined
      : requestedDecider.kind === 'unknown' ? 'unknown' : requestedDecider.kind === recordedBy.kind ? recordedBy.id : undefined)
    if (!deciderId) throw new ProjectMapError('DECIDER_REQUIRES_EVIDENCE')
    const decidedBy = { kind: requestedDecider.kind, id: deciderId }
    const payloadHash = hash(canonical({ input, sources, decidedBy, captureMode, issueId, factoryTaskId, runId }))
    if (decidedBy.kind === 'human') {
      if (!(actor.kind === 'human' && decidedBy.id === userId) && !resolved.some(source => source.authorId === decidedBy.id && source.authorKind === 'human'))
        throw new ProjectMapError('HUMAN_DECISION_REQUIRES_EVIDENCE')
    } else if (!(decidedBy.kind === 'unknown' && input.provenance === 'inferred') && (decidedBy.kind !== recordedBy.kind || decidedBy.id !== recordedBy.id)) throw new ProjectMapError('DECIDER_MISMATCH')
    const optionIds = new Set(input.options.map(option => option.id))
    if (input.contextOptionRef) optionIds.add(input.contextOptionRef.optionId)
    for (const source of sources) {
      if (source.optionId && !optionIds.has(source.optionId)) throw new ProjectMapError('UNKNOWN_OPTION')
      if (source.role !== 'evidence' && !source.optionId && !input.contextOptionRef) throw new ProjectMapError('SOURCE_ROUTE_REQUIRED')
    }
    for (const option of input.options) {
      if (!option.stoppedAtSourceRef) continue
      const [source] = await db.select({ source: projectDecisionSources }).from(projectDecisionSources)
        .innerJoin(projectDecisions, eq(projectDecisions.id, projectDecisionSources.decisionId))
        .where(and(eq(projectDecisionSources.id, option.stoppedAtSourceRef), eq(projectDecisions.ownerId, userId),
          eq(projectDecisions.workspaceId, workspaceId), eq(projectDecisions.projectId, context.scope.projectId))).limit(1)
      if (!source) unavailable()
      await resolveDecisionSources(sourceScope, [{ role: source.source.role, source: source.source.locator }])
    }
    const observedIssue = issueId ? await issueForUser(reader, issueId) : null
    if (issueId && !observedIssue) unavailable()
  return withProjectWriteScope(reader, context.scope.projectId, workspaceId, async scope => {
    if (issueId && !scope.issueIds.includes(issueId)) unavailable()
    const result = await db.transaction(async tx => {
      // Serialize same-project append/correction checks; no mutable graph order is stored.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${workspaceId + ':' + scope.projectId}))`)
      if (observedIssue) {
        const [locked] = await tx.select().from(issues).where(eq(issues.id, observedIssue.id)).for('update')
        try { requireLockedIssueScope(locked, userId, observedIssue.scopeVersion, observedIssue.workspaceId) } catch { unavailable() }
        if (readIssueMetadata(locked.content).deletedAt) unavailable()
      }
      if (actor.kind === 'bot' && actor.botId) {
        const [currentBot] = await tx.select().from(bots).where(eq(bots.id, actor.botId)).for('share')
        if (!currentBot || currentBot.ownerId !== userId || currentBot.workspaceId !== workspaceId || currentBot.archivedAt) throw new ProjectMapError('BOT_NOT_AUTHORIZED', 403)
      }
      if (actor.kind === 'run') {
        const [current] = await tx.select().from(agentRuns).where(and(eq(agentRuns.id, actor.runId), eq(agentRuns.userId, userId))).for('update')
        const [token] = await tx.select().from(runTokens).where(and(eq(runTokens.runId, actor.runId), eq(runTokens.tokenHash, hash(actor.token!)))).for('update')
        if (!current || !token || token.userId !== userId || token.revokedAt || token.expiresAt <= new Date() ||
          !['queued', 'preparing', 'running', 'waiting_input', 'finishing'].includes(current.status) || current.stopRequestedAt ||
          (current.deviceId && ['preparing', 'running', 'waiting_input', 'finishing'].includes(current.status) && (!current.leaseExpiresAt || current.leaseExpiresAt <= new Date())) ||
          current.issueId !== issueId) throw new ProjectMapError('RUN_NOT_AUTHORIZED', 403)
        if (canonical(current.agentDefinition) !== canonical(run?.agentDefinition ?? null)) throw new ProjectMapError('RUN_NOT_AUTHORIZED', 403)
      }
      const [existing] = await tx.select().from(projectDecisions).where(and(eq(projectDecisions.workspaceId, workspaceId), eq(projectDecisions.projectId, scope.projectId), eq(projectDecisions.ownerId, userId), eq(projectDecisions.idempotencyKey, idempotencyKey))).limit(1)
      if (existing) {
        if (existing.payloadHash !== payloadHash) throw new ProjectMapError('IDEMPOTENCY_CONFLICT', 409)
        return { decisionId: existing.id, duplicate: true, recordedAt: existing.recordedAt.toISOString(), projectId: scope.projectId, workspaceId }
      }
      const references = [...input.predecessorDecisionIds, ...input.options.flatMap(option => option.derivedFrom ? [option.derivedFrom.decisionId] : []),
        ...(input.contextOptionRef ? [input.contextOptionRef.decisionId] : []), ...(input.supersedesId ? [input.supersedesId] : [])]
      const referenced = references.length ? await tx.select().from(projectDecisions).where(and(inArray(projectDecisions.id, references),
        eq(projectDecisions.workspaceId, workspaceId), eq(projectDecisions.projectId, scope.projectId), eq(projectDecisions.ownerId, userId))) : []
      if (new Set(references).size !== referenced.length) unavailable()
      // All references point to already committed records, making cycles impossible on append.
      for (const ref of [input.contextOptionRef, ...input.options.map(option => option.derivedFrom)].filter(Boolean)) {
        if (!referenced.find(row => row.id === ref!.decisionId)?.options.some(option => option.id === ref!.optionId)) throw new ProjectMapError('UNKNOWN_OPTION')
      }
      if (input.supersedesId) {
        const [successor] = await tx.select({ id: projectDecisions.id }).from(projectDecisions).where(eq(projectDecisions.supersedesId, input.supersedesId)).limit(1)
        if (successor) throw new ProjectMapError('DECISION_VERSION_CONFLICT', 409)
      }
      if (input.kind === 'merge' && input.predecessorDecisionIds.length < 2) throw new ProjectMapError('MERGE_REQUIRES_PREDECESSORS')
      const id = randomUUID(), now = new Date()
      const eventTimes = resolved.filter(source => ['bot_message', 'group_message', 'run_message', 'question', 'answer', 'acceptance'].includes(source.locator.type))
        .map(source => source.occurredAt.getTime()).filter(Number.isFinite)
      const occurredAt = actor.kind === 'human' && actor.originalMessageAt ? actor.originalMessageAt
        : captureMode === 'reconstructed' && eventTimes.length ? new Date(Math.max(...eventTimes)) : now
      await tx.insert(projectDecisions).values({
        id, ownerId: userId, workspaceId, projectId: scope.projectId, issueId, factoryTaskId, runId,
        kind: input.kind, title: input.title, summary: input.summary, reason: input.reason,
        options: input.options, selectedOptionId: input.selectedOptionId, contextOptionRef: input.contextOptionRef,
        predecessorDecisionIds: input.predecessorDecisionIds, provenance: input.provenance, captureMode, decidedBy, recordedBy,
        occurredAt, recordedAt: now, supersedesId: input.supersedesId ?? null, recordStatus: input.recordStatus, idempotencyKey, payloadHash,
      })
      const unique = new Map(resolved.map(source => [source.normalizedKey, source]))
      if (unique.size) await tx.insert(projectDecisionSources).values([...unique.values()].map(source => ({
        id: randomUUID(), decisionId: id, ownerId: userId, workspaceId,
        role: source.role, optionId: source.optionId ?? null, sourceType: source.locator.type, sourceId: source.locator.id,
        locator: source.locator, relation: input.provenance === 'inferred' ? 'inferred' as const : source.relation,
        normalizedKey: source.normalizedKey, verifiedAt: now, createdAt: now,
      })))
      await (await import('@/lib/live/project-map')).projectMapChanged(tx, scope.projectId)
      return { decisionId: id, duplicate: false, recordedAt: now.toISOString(), projectId: scope.projectId, workspaceId }
    })
    return result
  })
}

/** Decisions keep their original content ownership, including after a project is shared. */
export async function listProjectDecisions(scope: ProjectScope, limit = 100) {
  const rows = await db.select().from(projectDecisions).where(and(eq(projectDecisions.workspaceId, scope.workspaceId),
    eq(projectDecisions.projectId, scope.projectId))).orderBy(desc(projectDecisions.recordedAt), desc(projectDecisions.id)).limit(limit)
  const visible = rows.filter(row => !row.issueId || scope.issueIds.includes(row.issueId))
  const sources = visible.length ? await db.select().from(projectDecisionSources).where(inArray(projectDecisionSources.decisionId, visible.map(row => row.id))) : []
  const readable = []
  for (const row of visible) {
    const references = []
    let hidden = false
    for (const source of sources.filter(source => source.decisionId === row.id)) {
      try {
        await resolveDecisionSources({ ...scope, userId: row.ownerId }, [{ role: source.role, ...(source.optionId ? { optionId: source.optionId } : {}), source: source.locator }])
        references.push({ sourceRef: source.id, role: source.role, optionId: source.optionId, relation: source.relation, availability: 'available' as const, locator: source.locator })
      } catch (error) {
        if (!(error instanceof ProjectMapError && [400, 404].includes(error.status))) throw error
        // A saved locator is never an authorization grant. Only a verified
        // deletion may be shown as unavailable; permission failures hide the fact.
        if (!['run', 'run_chunk', 'run_message'].includes(source.sourceType) || !source.locator.issueId || !scope.issueIds.includes(source.locator.issueId)) { hidden = true; break }
        const sourceRun = source.locator.runId ?? (source.sourceType === 'run' ? source.sourceId : null)
        const exists = sourceRun ? await db.select({ id: agentRuns.id }).from(agentRuns).where(eq(agentRuns.id, sourceRun)).limit(1) : [true]
        if (exists.length) { hidden = true; break }
        references.push({ sourceRef: source.id, role: source.role, optionId: source.optionId, relation: source.relation, availability: 'unavailable' as const, locator: null })
      }
    }
    if (hidden) continue
    const { payloadHash: _payloadHash, idempotencyKey: _key, ...decision } = row
    readable.push(await maskFor({ workspaceId: scope.workspaceId, ownerId: row.ownerId }, { ...decision, sources: references }))
  }
  return readable
}

export async function markMessageAsDecision(actor: Extract<DecisionActor, { kind: 'human' }>, projectId: string, input: RecordDecisionInput, locator: Parameters<typeof readDecisionSource>[1]) {
  const scope = await resolveProjectScope(actor.user, projectId, actor.workspaceId)
  const source = await readDecisionSource(scope, locator)
  if (!source || !['bot_message', 'group_message', 'run_message', 'question', 'answer', 'acceptance'].includes(locator.type)) unavailable()
  return recordProjectDecision({ ...actor, originalMessageAt: source.occurredAt }, { ...input, projectId, workspaceId: actor.workspaceId, sources: [
    ...(input.sources ?? []), { role: 'evidence', source: locator },
  ] })
}
