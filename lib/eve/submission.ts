import { z } from 'zod'
import type { MessageContent } from 'eve/channels'
import type { Session } from 'eve/sessions'
import { scopeAuth, assertEveScope, type EveScope } from './scope'
import { withQuote, QUOTE_TEXT_MAX } from '../artifacts/quote'
import { withBrowserNotes, NOTE_MAX, NOTES_MAX } from '../browser/note'
import { isDeepStrictEqual } from 'node:util'
import { dispatchTaskIntent } from '../task-create-command'
import { taskDestinationSchema } from '../task-destination'
import { taskTitleInputSchema } from '../task-title-input'
import { agentProfileReferenceSchema } from '../factory/agent-profile-reference'
import { personalSubmissionInput, recordPersonalSubmission,personalSubmissionEventId,SubmissionConflictError } from '../coordinator-submission'

const quote = z.object({ artifactId:z.uuid(),version:z.number().int().positive(),kind:z.enum(['text','element']),text:z.string().min(1).max(QUOTE_TEXT_MAX),label:z.string().max(200).optional(),selector:z.string().max(1000).optional() })
const notes = z.array(z.object({n:z.number().int().positive(),kind:z.enum(['element','region']),url:z.url({protocol:/^https?$/}).max(2000),label:z.string().min(1).max(200),note:z.string().min(1).max(NOTE_MAX),selector:z.string().max(1000).optional(),rect:z.object({x:z.number(),y:z.number(),width:z.number().nonnegative(),height:z.number().nonnegative(),viewportWidth:z.number().nonnegative(),viewportHeight:z.number().nonnegative()}).optional()})).max(NOTES_MAX)
export const eveProductContext = z.object({
  taskCommand:dispatchTaskIntent.optional(),confirmTaskAccess:z.boolean().optional(),quote:quote.nullish(),notes:notes.nullish(),taskDestination:taskDestinationSchema.optional(),
  profileId:agentProfileReferenceSchema.optional(),taskTitle:taskTitleInputSchema.optional(),
  expectedOwnerId:z.string().min(1).max(256).optional(),expectedWorkspaceId:z.uuid().optional(),retryOf:z.number().int().positive().optional(),botId:z.uuid().nullish(),
}).strict()

const ingress = new WeakMap<Request, { scope:EveScope; eventId:string }>()
export async function acceptEveMessage(scope:EveScope,message:MessageContent,context:unknown,request:Request,turnPolicy?: 'steer') {
  await assertEveScope(scope)
  const product = eveProductContext.parse(context ?? {})
  const retry=product.retryOf?await (await import('./retry-source')).loadEveRetrySource(scope,product.retryOf):null
  if (product.expectedOwnerId && product.expectedOwnerId !== scope.ownerId || product.expectedWorkspaceId && product.expectedWorkspaceId !== scope.workspaceId || product.botId && product.botId !== scope.botId) throw new Error('workspaceAccessDenied')
  const rawText = typeof message === 'string' ? message : message.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n')
  const images = typeof message === 'string' ? [] : message.flatMap(part => part.type === 'file' && typeof part.data === 'string' && part.data.startsWith('data:image/') ? [{dataUrl:part.data}] : [])
  const input = personalSubmissionInput.parse({ text:rawText,images:images.length ? images : undefined,submissionId:request.headers.get('x-mikka-submission-id') ?? undefined })
  const withNotes = withBrowserNotes(input.text,product.notes)
  if (withNotes === null) throw new Error('messageTooLong')
  const text = withQuote(withNotes,product.quote)
  const { db, withDatabaseTransaction } = await import('../db')
  const { assertCredentialSafeChat } = await import('../credentials/chat-guard')
  await assertCredentialSafeChat(scope.ownerId,text)
  if (product.taskCommand && (!input.submissionId || !product.expectedWorkspaceId && !retry
    || !input.text.includes(product.taskCommand.description))) throw new Error('validationGeneric')
  if (product.taskCommand && retry && !isDeepStrictEqual(retry.payload.taskCommand, product.taskCommand)) throw new SubmissionConflictError()
  const isTask = Boolean(product.taskCommand || product.taskDestination || product.profileId || product.taskTitle)
  if (isTask && !(await import('../coordinator/issue-tools-enabled')).issueMutationsEnabled()) throw new Error('issueToolsDisabled')
  if (product.taskDestination?.kind === 'device') {
    const {pool} = await import('../db')
    const row = await pool.query('SELECT 1 FROM devices WHERE id=$1 AND "ownerId"=$2 AND kind=\'local\' AND enabled=true',[product.taskDestination.deviceId,scope.ownerId])
    if (!row.rowCount) throw new Error('deviceNotFound')
  }
  if (product.profileId && product.profileId !== (await import('../factory/agent-profile-reference')).BUILTIN_AGENT_PROFILE_ID) {
    const {pool} = await import('../db')
    const row = await (await import('../factory/agent-profile-store')).readProfileRow(pool,{ownerId:scope.ownerId,workspaceId:scope.workspaceId},product.profileId)
    if (row.archivedAt || !row.definition.enabled) throw new Error('runInvalid')
  }
  let humanSessionId:string|undefined
  if (request.headers.has('authorization') || request.headers.has('cookie')) {
    const {auth} = await import('../api-auth')
    const headers=new Headers(request.headers)
    if(headers.has('authorization'))headers.delete('cookie')
    const session = await auth.api.getSession({headers,query:{disableCookieCache:true}})
    if (session?.user.id === scope.ownerId && !session.tokenWorkspaceId) humanSessionId = session.session.id
  }
  if ((product.taskCommand?.teamId || product.taskCommand?.projectId) && !humanSessionId) throw new Error('teamIssueAccessDenied')
  const options={turnPolicy,botId:scope.botId,submissionId:input.submissionId,images:input.images,taskDestination:product.taskDestination,profileId:product.profileId,taskTitle:product.taskTitle,taskCommand:product.taskCommand,...(product.retryOf?{retryOf:product.retryOf}:{}),...(retry?{taskRequestSourceEventId:retry.taskRequestSourceEventId}:{}),...(humanSessionId ? {humanSessionId} : {})}
  const record=(executor:Parameters<typeof recordPersonalSubmission>[0])=>recordPersonalSubmission(executor,scope.ownerId,text,options)
  async function recordMessage() {
    if (!product.retryOf) return record(db)
    const { sendRetryOf } = await import('../coordinator/store')
    const retried = await sendRetryOf(scope.ownerId, scope.botId, product.retryOf, record)
    if (retried) return retried
    if (!input.submissionId || !await personalSubmissionEventId(db, scope.ownerId, scope.botId, input.submissionId)) throw new SubmissionConflictError()
    return record(db)
  }
  async function accept() {
    const { eventId } = await recordMessage()
    if (!product.taskCommand) return { eventId, createdTaskId: undefined }
    const { createIssueFromRequest } = await import('../coordinator/issue-create')
    const title = product.taskTitle ?? product.taskCommand.description.split(/\r?\n/, 1)[0]!.slice(0, 200)
    const created = await createIssueFromRequest(scope.ownerId, {
      sourceEventId: retry?.taskRequestSourceEventId ?? eventId, title, confirmAccess: product.confirmTaskAccess,
    })
    return { eventId, createdTaskId: created.issueId }
  }
  // A rejected destination or audience must not leave a pending dispatch event.
  const { eventId, createdTaskId } = product.taskCommand
    ? await db.transaction(tx => withDatabaseTransaction(tx, accept))
    : await accept()
  ingress.set(request,{scope,eventId})
  const contextual = text === input.text ? [] : [withQuote(withBrowserNotes('',product.notes) ?? '',product.quote)]
  if (createdTaskId) contextual.push(`The person selected Create and dispatch. The host has created Task ${createdTaskId} for this request. Dispatch that Task with the existing Machine, Profile, approval and resource checks. Reuse any execution receipt for this request.`)
  if(retry)contextual.push('The person explicitly retried this failed request. Continue from the conversation and its completed tool receipts. Do not repeat actions that already succeeded. Keep the original task identity and selected destination, profile and title.')
  return {eventId,context:contextual}
}

/** A relational compatibility row is a projection, written once after eve accepted input. */
export async function markEventAccepted(scope:EveScope,eventId:string) {
  const [{ db },{ sql },{ botChatChanged },{ coordinatorSessionChanged },{ sourcedEventMessage },{ eventPrompt },{ maskDeep,credentialMasker }] = await Promise.all([
    import('../db'),import('drizzle-orm'),import('../live/chats'),import('../live/coordinator-session'),import('../coordinator/message-safety'),import('../coordinator/context'),import('../secrets/mask'),
  ])
  await db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`bot-chat:${scope.ownerId}:${scope.botId}`},0))`)
    const event = (await tx.execute(sql`SELECT * FROM coordinator_events WHERE id=${eventId}::uuid AND "userId"=${scope.ownerId} AND "botId"=${scope.botId}::uuid FOR UPDATE`)).rows[0] as any
    if (!event || event.deliveredAt) return
    const message = maskDeep({...sourcedEventMessage({...event,createdAt:new Date(event.createdAt),deliveredAt:new Date()},eventPrompt(event)),mikkaEveAccepted:true},credentialMasker)
    await tx.execute(sql`INSERT INTO coordinator_messages(id,"userId","botId",position,message) SELECT ${crypto.randomUUID()}::uuid,${scope.ownerId},${scope.botId}::uuid,coalesce(max(position),0)+1,${JSON.stringify(message)}::jsonb FROM coordinator_messages WHERE "userId"=${scope.ownerId} AND "botId"=${scope.botId}::uuid`)
    await tx.execute(sql`UPDATE coordinator_events SET "deliveredAt"=now() WHERE id=${eventId}::uuid`)
    await botChatChanged(tx,scope.ownerId,scope.botId)
    await coordinatorSessionChanged(tx,scope.ownerId,scope.botId)
  })
}
export async function commitEveIngress(request:Request) {
  const accepted = ingress.get(request)
  if (accepted) await markEventAccepted(accepted.scope,accepted.eventId)
}

export async function deliverEveEvent(scope:EveScope,session:Session,eventId:string) {
  await assertEveScope(scope)
  const { pool } = await import('../db')
  const event = (await pool.query('SELECT * FROM coordinator_events WHERE id=$1 AND "userId"=$2 AND "botId"=$3',[eventId,scope.ownerId,scope.botId])).rows[0]
  if (!event) throw new Error('notFound')
  const { eventPrompt } = await import('../coordinator/context')
  const delivery = await session.send(eventPrompt(event),{
    auth:{...scopeAuth(scope),attributes:{...scopeAuth(scope).attributes,sourceEventId:event.id}},
    idempotencyKey:'mikka-event:'+event.id,turnPolicy:'queue',
  })
  await markEventAccepted(scope,eventId)
  return delivery
}
