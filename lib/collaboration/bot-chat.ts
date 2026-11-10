import 'server-only'
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { eq } from 'drizzle-orm'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import { splitChatFiles } from '@mikka/protocol/chat-attachments'
import { ActionFailureError } from '@/lib/action-error'
import { db, pool, withDatabaseClient } from '@/lib/db'
import { coordinatorEvents, coordinatorMessages } from '@/lib/db/schema'
import type { IssueReader } from '@/lib/issue-visibility'
import { enterprisePrincipal, type EnterprisePrincipal } from '@/lib/enterprise/principal'
import { enterpriseWorkspaceAllowed } from '@/lib/enterprise/access'
import { tokenWorkspace } from '@/lib/tokens/principal'
import { taskReaderScope, withTaskWorkspace } from '@/lib/task-workspace'
import { authorizedBotChat } from '@/lib/resource-access/chat'
import { lockResourceAccess, readResourceCapabilities } from '@/lib/resource-access/store'
import { normalizeUserImages, type UserImageInput } from '@/lib/coordinator/user-attachments'
import { personalSubmissionInput, recordPersonalSubmission, SubmissionConflictError } from '@/lib/coordinator-submission'
import { sourcedEventMessage } from '@/lib/coordinator/message-safety'
import { assertCredentialSafeChat } from '@/lib/credentials/chat-guard'
import { credentialMasker, maskDeep } from '@/lib/secrets/mask'
import { botChatChanged } from '@/lib/live/chats'
import { wakeCoordinatorAfterCommit } from '@/lib/coordinator/wake-after-commit'
import { organizationConnectionAuthority } from '@/lib/organization-connections-access'
import { organizationCollaboratorModelAllowed, organizationCredentialOwner } from '@/lib/organization-model-policy'
import { botApiKeyChoice, usableApiKeys } from '@/lib/model-api-keys'
import { apiKeyServesBotModel } from '@/lib/bot-model-choice'
import { hostedApiKeySnapshotSchema, type HostedApiKeySnapshot, type HostedRuntimeSnapshot } from '@/lib/subscription-model-snapshot'
import type { BotChatContributionPolicy, BotChatSubmissionAuthority, SharedBotChatScope } from './bot-chat-contract'

type Query = Pick<PoolClient, 'query'>
type ContributionPrincipal = Extract<EnterprisePrincipal, { kind: 'session' | 'pat' }> | Extract<EnterprisePrincipal, { kind: 'delegation' }>
const MAX_TURN_MS = 10 * 60_000
const contributionInput = personalSubmissionInput.safeExtend({ submissionId: z.uuid(), mode: z.enum(['comment', 'reply']) }).strict()
const unavailable = () => new ActionFailureError('executionModelUnknown')

export async function botChatOwnerExclusive(query: Query, ownerId: string, botId: string): Promise<boolean> {
  const { rows: [row] } = await query.query<{ allowed: boolean }>('SELECT mikka_bot_chat_owner_exclusive($1,$2::uuid) AS allowed', [ownerId, botId])
  return row?.allowed === true
}

function principalFields(principal: ContributionPrincipal) {
  if (principal.kind === 'session') return { principalKind: 'session' as const, principalId: principal.sessionId }
  if (principal.kind === 'pat') return { principalKind: 'pat' as const, principalId: principal.tokenId }
  if (principal.credentialKind !== 'oauth') throw new ActionFailureError('authRequired')
  return { principalKind: 'oauth' as const, principalId: principal.credentialId }
}

export function botChatActorReader(authority: BotChatSubmissionAuthority): Exclude<IssueReader, string> {
  const principal: ContributionPrincipal = authority.principalKind === 'session' ? { kind: 'session', sessionId: authority.principalId }
    : authority.principalKind === 'pat' ? { kind: 'pat', tokenId: authority.principalId, workspaceId: authority.workspaceId }
      : { kind: 'delegation', credentialKind: 'oauth', credentialId: authority.principalId, workspaceId: authority.workspaceId }
  return { id: authority.actorId, [tokenWorkspace]: authority.workspaceId, [enterprisePrincipal]: principal }
}

/** Authentication is checked even for organizations that do not enforce SSO.
 * An absent/expired request session cannot become an owner's system trigger. */
async function principalDeadline(query: Query, actorId: string, workspaceId: string,
  principal: Pick<BotChatSubmissionAuthority, 'principalKind' | 'principalId'>): Promise<Date> {
  const args = [principal.principalId, actorId, workspaceId]
  const { rows: [row] } = principal.principalKind === 'session'
    ? await query.query<{ expiresAt: Date }>('SELECT "expiresAt" FROM session WHERE id=$1 AND "userId"=$2 AND "expiresAt">clock_timestamp()', args.slice(0, 2))
    : principal.principalKind === 'pat'
      ? await query.query<{ expiresAt: Date | null }>('SELECT "expiresAt" FROM personal_access_tokens WHERE id=$1 AND "userId"=$2 AND "workspaceId"=$3 AND "revokedAt" IS NULL AND ("expiresAt" IS NULL OR "expiresAt">clock_timestamp())', args)
      : await query.query<{ expiresAt: Date }>(`SELECT LEAST(t."expiresAt",s."expiresAt") AS "expiresAt" FROM "oauthAccessToken" t
          JOIN "oauthClient" c ON c."clientId"=t."clientId" LEFT JOIN session s ON s.id=t."sessionId"
          WHERE t.id=$1 AND t."userId"=$2 AND t.revoked IS NULL AND t."expiresAt">clock_timestamp()
            AND coalesce(c.disabled,false)=false AND t.scopes ? 'mikka'
            AND (t."sessionId" IS NULL OR s."expiresAt">clock_timestamp())`, args.slice(0, 2))
  if (!row) throw new ActionFailureError('authRequired')
  const expires = row.expiresAt === null ? Date.now() + MAX_TURN_MS : new Date(row.expiresAt).getTime()
  if (!Number.isFinite(expires) || expires <= Date.now()) throw new ActionFailureError('authRequired')
  return new Date(Math.min(expires, Date.now() + MAX_TURN_MS))
}

async function requestPrincipal(reader: IssueReader, workspaceId: string, humanSessionId?: string) {
  const actorId = taskReaderScope(reader).userId
  let principal = typeof reader === 'string' ? undefined : reader[enterprisePrincipal]
  if (!principal && humanSessionId) principal = { kind: 'session', sessionId: humanSessionId }
  if (!principal) {
    const { getSession } = await import('@/lib/session')
    const session = await getSession()
    if (session?.user.id === actorId) principal = { kind: 'session', sessionId: session.session.id }
  }
  if (!principal || !['session', 'pat', 'delegation'].includes(principal.kind)
    || principal.kind === 'delegation' && principal.credentialKind !== 'oauth'
    || 'workspaceId' in principal && principal.workspaceId && principal.workspaceId !== workspaceId)
    throw new ActionFailureError('authRequired')
  const fields = principalFields(principal as ContributionPrincipal)
  const expiresAt = await principalDeadline(pool, actorId, workspaceId, fields)
  return { actorId, principal: principal as ContributionPrincipal, ...fields, expiresAt }
}

async function sharedModel(query: Query, ownerId: string, actorId: string, botId: string, workspaceId: string, eventId: string) {
  const bot = await query.query('SELECT 1 FROM bots WHERE id=$1 AND "ownerId"=$2 AND "workspaceId"=$3 AND "archivedAt" IS NULL', [botId, ownerId, workspaceId])
  if (!bot.rowCount) throw new ActionFailureError('botNotFound')
  const owner = await organizationConnectionAuthority(workspaceId, ownerId)
  const actor = await organizationConnectionAuthority(workspaceId, actorId)
  if (!owner || !actor || owner.organizationId !== actor.organizationId || !actor.modelPolicy.sharedChat) throw unavailable()
  const choice = await botApiKeyChoice(query, { ownerId, workspaceId }, botId)
  if (!choice || !organizationCollaboratorModelAllowed(actor.modelPolicy, choice.model, choice.keyId)) throw unavailable()
  const key = (await usableApiKeys(query, actorId, workspaceId, choice.keyId)).find(item => item.id === choice.keyId)
  if (!key || key.ownership !== 'organization' || key.organizationId !== actor.organizationId
    || key.ownerId !== organizationCredentialOwner(actor.organizationId) || !apiKeyServesBotModel(key, choice.model) || !key.revision) throw unavailable()
  const modelSnapshot = hostedApiKeySnapshotSchema.parse({ type: 'api_key', keyId: key.id, ownerId, actorId, consumerId: botId,
    workspaceId, modelId: choice.model, credentialOwnerId: key.ownerId, credentialRevision: key.revision,
    organizationId: actor.organizationId, collaborationEventId: eventId })
  return { modelSnapshot, organizationId: actor.organizationId, modelPolicyRevision: actor.revision, budget: actor.modelPolicy.sharedChat }
}

/** Safe composer data contains no credential suffix, token or owner-private
 * preference. The same deliberate organization policy is rechecked at submit. */
export async function botChatContributionPolicy(reader: IssueReader, botId: string): Promise<BotChatContributionPolicy> {
  const chat = await authorizedBotChat(reader, botId)
  const collaborative = !await botChatOwnerExclusive(pool, chat.ownerId, botId)
  const capabilities = await readResourceCapabilities(reader, chat.reference)
  if (!capabilities.canSteer) return { collaborative, canReply: false, reason: 'chatReplyPermissionRequired' }
  if (!collaborative) return { collaborative, canReply: chat.viewerId === chat.ownerId }
  try {
    const model = await sharedModel(pool, chat.ownerId, chat.viewerId, botId, chat.workspaceId, randomUUID())
    const { rows: [usage] } = await pool.query<{ exhausted: boolean }>(`SELECT count(*)>=$2::integer AS exhausted
      FROM bot_chat_submission_authorities WHERE "organizationId"=$1 AND mode='reply'
        AND "createdAt">=date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`, [model.organizationId, model.budget.maxRepliesPerDay])
    return { collaborative, canReply: !usage.exhausted, ...(usage.exhausted ? { reason: 'botChatDailyBudgetExceeded' } : {}), modelName: model.modelSnapshot.modelId,
      billingOrganizationId: model.organizationId, ...model.budget }
  } catch (error) {
    if (error instanceof ActionFailureError && error.code === 'executionModelUnknown')
      return { collaborative, canReply: false, reason: 'organizationChatConnectionRequired' }
    throw error
  }
}

/** Only this authenticated host entry creates a contribution receipt. Content
 * ACLs and organization funding are independent checks. Comments cost nothing
 * and never enter the daemon/hosted model inbox. */
export async function submitBotChatMessage(reader: IssueReader, botId: string,
  input: { text: string; images?: readonly UserImageInput[]; submissionId: string; mode: 'comment' | 'reply' },
  options: { humanSessionId?: string } = {}) {
  const value = contributionInput.parse(input)
  const chat = await authorizedBotChat(reader, botId, value.mode === 'reply' ? 'canSteer' : 'canComment')
  const principal = await requestPrincipal(reader, chat.workspaceId, options.humanSessionId)
  const actorReader = { id: principal.actorId, [tokenWorkspace]: chat.workspaceId, [enterprisePrincipal]: principal.principal }
  const images = normalizeUserImages(value.images)
  const fingerprint = createHash('sha256').update(JSON.stringify({ actorId: principal.actorId,
    principalKind: principal.principalKind, principalId: principal.principalId, mode: value.mode, text: value.text, images })).digest('hex')
  return withTaskWorkspace(actorReader, chat.workspaceId, async () => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const result = await withDatabaseClient(client, async () => {
        await lockResourceAccess(db, principal.actorId, chat.reference, value.mode === 'reply' ? 'canSteer' : 'canComment')
        await principalDeadline(client, principal.actorId, chat.workspaceId, principal)
        if (splitChatFiles(value.text).files.length) {
          const { validateChatFiles } = await import('@/lib/chat-attachments/store')
          await validateChatFiles(actorReader, { kind: 'bot', id: botId }, value.text, client)
        }
        const contextIsolation = await botChatOwnerExclusive(client, chat.ownerId, botId) ? 'private' : 'shared_clean'
        if (contextIsolation === 'private' && principal.actorId !== chat.ownerId) throw new ActionFailureError('workspaceAccessDenied')
        await assertCredentialSafeChat(principal.actorId, value, db)
        if (principal.actorId !== chat.ownerId) await assertCredentialSafeChat(chat.ownerId, value, db)
        const submission = await recordPersonalSubmission(db, chat.ownerId, value.text,
          { botId, submissionId: value.submissionId, images: value.images, filesValidated: true })
        if (submission.duplicate) {
          const { rows: [prior] } = await client.query<BotChatSubmissionAuthority>('SELECT * FROM bot_chat_submission_authorities WHERE "eventId"=$1', [submission.eventId])
          if (!prior || prior.fingerprint !== fingerprint || prior.actorId !== principal.actorId) throw new SubmissionConflictError()
          return { ...submission, queued: prior.mode === 'reply' }
        }
        const model = value.mode === 'reply' && contextIsolation === 'shared_clean'
          ? await sharedModel(client, chat.ownerId, principal.actorId, botId, chat.workspaceId, submission.eventId) : null
        if (model) {
          // Serialize reservations for this organization across all its Bots.
          await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`bot-chat-budget:${model.organizationId}`])
          const { rows: [usage] } = await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM bot_chat_submission_authorities
            WHERE "organizationId"=$1 AND mode='reply' AND "createdAt">=date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`, [model.organizationId])
          if (Number(usage.count) >= model.budget.maxRepliesPerDay) throw new ActionFailureError('botChatDailyBudgetExceeded')
        }
        await client.query(`INSERT INTO bot_chat_submission_authorities("eventId","ownerId","actorId","botId","workspaceId","principalKind","principalId",mode,
          "contextIsolation",fingerprint,"modelSnapshot","organizationId","modelPolicyRevision","maxModelCalls","maxOutputTokens","expiresAt")
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16)`,
        [submission.eventId, chat.ownerId, principal.actorId, botId, chat.workspaceId, principal.principalKind, principal.principalId,
          value.mode, contextIsolation, fingerprint, model ? JSON.stringify(model.modelSnapshot) : null, model?.organizationId ?? null,
          model?.modelPolicyRevision ?? null, model?.budget.maxModelCallsPerTurn ?? 0, model?.budget.maxOutputTokens ?? 0, principal.expiresAt])
        if (value.mode === 'comment') {
          const { nextPosition } = await import('@/lib/coordinator/store')
          const position = await nextPosition(db, chat.ownerId, botId)
          const now = new Date()
          await db.insert(coordinatorMessages).values({ id: randomUUID(), userId: chat.ownerId, botId, position,
            message: maskDeep(sourcedEventMessage({ id: submission.eventId, kind: 'user_message', issueId: null, runId: null,
              createdAt: now, payload: { text: value.text, ...(images.length ? { images } : {}) } }, value.text), credentialMasker) })
          await db.update(coordinatorEvents).set({ deliveredAt: now, tier: 'background' }).where(eq(coordinatorEvents.id, submission.eventId))
        } else wakeCoordinatorAfterCommit(client, chat.ownerId)
        await botChatChanged(client, chat.ownerId, botId)
        return { ...submission, queued: value.mode === 'reply' }
      })
      await client.query('COMMIT')
      return result
    } catch (error) { await client.query('ROLLBACK'); throw error }
    finally { client.release() }
  })
}

/** Minimal durable proof for the Enterprise owner gate. Never recurse through
 * owner authorization; the caller separately validates the real Actor's SSO. */
export async function botChatExecutionProof(query: Query, ownerId: string, workspaceId: string, eventId: string) {
  if (!z.uuid().safeParse(eventId).success) return null
  const { rows: [authority] } = await query.query<BotChatSubmissionAuthority>(`SELECT a.* FROM bot_chat_submission_authorities a
    JOIN bots b ON b.id=a."botId" AND b."ownerId"=a."ownerId" AND b."workspaceId"=a."workspaceId"
    WHERE a."eventId"=$1 AND a."ownerId"=$2 AND a."workspaceId"=$3 AND a.mode='reply' AND a."contextIsolation"='shared_clean'
      AND a."expiresAt">clock_timestamp() AND mikka_resource_acl_allowed('account',a."actorId",a."workspaceId",'chat',
        mikka_chat_resource_id(a."ownerId",a."botId"),'canSteer')`, [eventId, ownerId, workspaceId])
  if (!authority) return null
  try { await principalDeadline(query, authority.actorId, workspaceId, authority) }
  catch (error) { if (error instanceof ActionFailureError) return null; throw error }
  const reader = botChatActorReader(authority)
  return { actorId: authority.actorId, principal: reader[enterprisePrincipal]! }
}

/** Read at every model and tool boundary. A stored payload, a stale session or
 * a current edit permission alone can never authorize someone else's resources. */
export async function liveBotChatAuthority(query: Query, eventId: string, expected: { ownerId: string; botId: string }) {
  const { rows: [authority] } = await query.query<BotChatSubmissionAuthority>('SELECT * FROM bot_chat_submission_authorities WHERE "eventId"=$1 AND "ownerId"=$2 AND "botId"=$3', [eventId, expected.ownerId, expected.botId])
  if (!authority || authority.mode !== 'reply' || new Date(authority.expiresAt).getTime() <= Date.now()) throw new ActionFailureError('authRequired')
  await principalDeadline(query, authority.actorId, authority.workspaceId, authority)
  const reader = botChatActorReader(authority)
  if (!await enterpriseWorkspaceAllowed(authority.actorId, authority.workspaceId, reader[enterprisePrincipal], undefined, query))
    throw new ActionFailureError('workspaceAccessDenied')
  if (authority.contextIsolation === 'private') {
    if (authority.actorId !== authority.ownerId || !await botChatOwnerExclusive(query, authority.ownerId, authority.botId)) throw unavailable()
    return authority
  }
  const proof = await botChatExecutionProof(query, authority.ownerId, authority.workspaceId, eventId)
  const ownerPrincipal: EnterprisePrincipal = authority.actorId === authority.ownerId ? reader[enterprisePrincipal]!
    : { kind: 'bot_chat', eventId, workspaceId: authority.workspaceId }
  if (!proof || !await enterpriseWorkspaceAllowed(authority.ownerId, authority.workspaceId, ownerPrincipal, undefined, query))
    throw new ActionFailureError('workspaceAccessDenied')
  const current = await sharedModel(query, authority.ownerId, authority.actorId, authority.botId, authority.workspaceId, eventId)
  if (current.organizationId !== authority.organizationId || current.modelPolicyRevision !== authority.modelPolicyRevision
    || !isDeepStrictEqual(current.modelSnapshot, authority.modelSnapshot)
    || current.budget.maxModelCallsPerTurn !== authority.maxModelCalls || current.budget.maxOutputTokens !== authority.maxOutputTokens)
    throw unavailable()
  const revoked = await query.query(`SELECT 1 FROM bot_chat_resource_reads WHERE "eventId"=$1
    AND NOT mikka_shared_bot_resource_visible("resourceKind","resourceId","workspaceId") LIMIT 1`, [eventId])
  if (revoked.rowCount) throw new ActionFailureError('workspaceAccessDenied')
  return authority
}

export async function sharedBotToolContext(ownerId: string, scope: SharedBotChatScope) {
  const authority = await liveBotChatAuthority(pool, scope.eventId, { ownerId, botId: scope.botId })
  return { authority, reader: botChatActorReader(authority), workspaceId: authority.workspaceId }
}

/** Persists only identifiers; source content and model credentials stay in
 * their existing stores. Later projection checks the current source ACL. */
export async function recordBotChatResourceRead(ownerId: string, scope: SharedBotChatScope, kind: 'task' | 'thread', id: string) {
  const { authority } = await sharedBotToolContext(ownerId, scope)
  const { rows } = await pool.query(`WITH allowed AS (SELECT $3::uuid AS id WHERE mikka_shared_bot_resource_visible($2,$3,$4)
      AND mikka_resource_acl_allowed('account',$5,$4,$2,$3,'canReadContent')),
    written AS (INSERT INTO bot_chat_resource_reads("eventId","resourceKind","resourceId","workspaceId")
      SELECT $1,$2,id,$4 FROM allowed ON CONFLICT DO NOTHING)
    SELECT id FROM allowed`,
  [scope.eventId, kind, id, authority.workspaceId, authority.actorId])
  return rows.length === 1
}

export async function sharedBotRuntime(ownerId: string, botId: string, sourceEventId?: string): Promise<HostedRuntimeSnapshot | null> {
  if (await botChatOwnerExclusive(pool, ownerId, botId)) return null
  if (!sourceEventId) throw new ActionFailureError('authRequired')
  const authority = await liveBotChatAuthority(pool, sourceEventId, { ownerId, botId })
  if (authority.contextIsolation !== 'shared_clean' || !authority.modelSnapshot) throw unavailable()
  return { harness: 'ai_sdk', model: authority.modelSnapshot.modelId, actorId: authority.actorId, modelSelection: authority.modelSnapshot }
}

export async function sharedBotHasAuthorizedReply(ownerId: string, botId: string) {
  const { rows } = await pool.query<{ eventId: string }>(`SELECT a."eventId" FROM bot_chat_submission_authorities a
    JOIN coordinator_events e ON e.id=a."eventId" WHERE a."ownerId"=$1 AND a."botId"=$2
      AND a.mode='reply' AND a."contextIsolation"='shared_clean' AND e."deliveredAt" IS NULL ORDER BY e."createdAt" LIMIT 50`, [ownerId, botId])
  for (const row of rows) {
    try { await liveBotChatAuthority(pool, row.eventId, { ownerId, botId }); return true }
    catch (error) {
      if (!(error instanceof ActionFailureError)) throw error
      await pool.query(`UPDATE coordinator_events SET "deliveredAt"=clock_timestamp(),tier='background'
        WHERE id=$1 AND "userId"=$2 AND "botId"=$3 AND "deliveredAt" IS NULL`, [row.eventId, ownerId, botId])
    }
  }
  return false
}

/** One row per real outbound attempt, including an attempt with an unknown
 * provider outcome. A workflow retry cannot replay a consumed call for free. */
export async function reserveBotChatModelCall(selection: HostedApiKeySnapshot, identity: { workflowRunId?: string | null; stepId?: string | null }) {
  if (!selection.collaborationEventId || !selection.consumerId) throw unavailable()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const authority = await withDatabaseClient(client, async () => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`bot-chat-call:${selection.collaborationEventId}`])
      const current = await liveBotChatAuthority(client, selection.collaborationEventId!, { ownerId: selection.ownerId, botId: selection.consumerId! })
      if (current.contextIsolation !== 'shared_clean' || !isDeepStrictEqual(current.modelSnapshot, selection)) throw unavailable()
      const { rows: [usage] } = await client.query<{ count: string }>('SELECT count(*)::text AS count FROM bot_chat_model_calls WHERE "eventId"=$1', [current.eventId])
      if (Number(usage.count) >= current.maxModelCalls) throw new ActionFailureError('botChatModelCallBudgetExceeded')
      await client.query('INSERT INTO bot_chat_model_calls(id,"eventId","workflowId","stepId") VALUES($1,$2,$3,$4)',
        [randomUUID(), current.eventId, identity.workflowRunId ?? null, identity.stepId ?? null])
      return current
    })
    await client.query('COMMIT')
    return { maxOutputTokens: authority.maxOutputTokens, expiresAt: new Date(authority.expiresAt).getTime() }
  } catch (error) { await client.query('ROLLBACK'); throw error }
  finally { client.release() }
}
