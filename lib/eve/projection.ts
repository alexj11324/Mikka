import { parts, calls, type SessionView, type TurnOutcome } from 'eve/events'
import type { EveScope } from './scope'

export const eveStreamId = (sessionId:string,turnId:string) => `eve:${sessionId}:${turnId}`

/** Compatibility history is derived from the eve committed view, never used as eve model history. */
export function projectEveTurn(view:SessionView,sessionId:string,turnId:string,outcome:TurnOutcome) {
  const content = parts(view,{turnId}).flatMap(part => (part.kind === 'text' || part.kind === 'reasoning') && typeof part.value === 'string' ? [{type:part.kind,text:part.value}] : [])
  const toolCalls = calls(view,{turnId}).filter(call => call.kind === 'tool').map(call => ({ type:'tool-call',toolCallId:call.callId,toolName:call.name,input:call.input ?? {} }))
  const output = calls(view,{turnId}).filter(call => call.kind === 'tool' && ['completed','failed','cancelled','rejected'].includes(call.state)).map(call => ({type:'tool-result',toolCallId:call.callId,toolName:call.name,output:{type:'json',value:call.output ?? {error:call.error?.code ?? call.state}}}))
  return [
    {role:'assistant',content:[...content,...toolCalls],mikkaStreamId:eveStreamId(sessionId,turnId),...(outcome === 'cancelled' ? {mikkaStopped:true} : {}),...(outcome === 'failed' ? {mikkaFailure:'turn_failed'} : {})},
    ...(output.length ? [{role:'tool',content:output}] : []),
  ]
}

export async function projectTurnState(scope:EveScope,sessionId:string,turnId:string,working:boolean,messages?:unknown[]) {
  if (scope.surface !== 'web') return
  const [{db},{sql},{botChatChanged},{coordinatorSessionChanged},{maskDeep,credentialMasker},{assertCredentialSafeChat}] = await Promise.all([
    import('../db'),import('drizzle-orm'),import('../live/chats'),import('../live/coordinator-session'),import('../secrets/mask'),import('../credentials/chat-guard'),
  ])
  const safe = messages ? maskDeep(messages,credentialMasker) : undefined
  if (safe) await assertCredentialSafeChat(scope.ownerId,safe)
  await db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`bot-chat:${scope.ownerId}:${scope.botId}`},0))`)
    if (safe) {
      const inserted = await tx.execute(sql`INSERT INTO eve_projection_receipts(session_id,event_key) VALUES(${sessionId},${turnId}) ON CONFLICT DO NOTHING RETURNING event_key`)
      if (!inserted.rows.length) return
      const position = Number((await tx.execute(sql`SELECT coalesce(max(position),0) AS last FROM coordinator_messages WHERE "userId"=${scope.ownerId} AND "botId"=${scope.botId}::uuid`)).rows[0]?.last ?? 0)
      for (const [index,message] of safe.entries()) await tx.execute(sql`INSERT INTO coordinator_messages(id,"userId","botId",position,message) VALUES(${crypto.randomUUID()}::uuid,${scope.ownerId},${scope.botId}::uuid,${position+index+1},${JSON.stringify(message)}::jsonb)`)
    }
    const leaseUntil = working ? new Date(Date.now()+24*60*60*1000) : null
    if (working) await tx.execute(sql`INSERT INTO coordinator_sessions("userId","botId","leaseHolder","leaseUntil","updatedAt") VALUES(${scope.ownerId},${scope.botId}::uuid,${sessionId},${leaseUntil},now()) ON CONFLICT("userId","botId") DO UPDATE SET "leaseHolder"=excluded."leaseHolder","leaseUntil"=excluded."leaseUntil","updatedAt"=now()`)
    else await tx.execute(sql`UPDATE coordinator_sessions SET "leaseHolder"=null,"leaseUntil"=null,"updatedAt"=now() WHERE "userId"=${scope.ownerId} AND "botId"=${scope.botId}::uuid AND "leaseHolder"=${sessionId}`)
    await botChatChanged(tx,scope.ownerId,scope.botId)
    await coordinatorSessionChanged(tx,scope.ownerId,scope.botId)
  })
}
