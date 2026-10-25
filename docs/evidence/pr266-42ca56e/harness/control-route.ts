// Local acceptance instrumentation only: not a candidate feature or deployable endpoint.
import { NextResponse } from 'next/server'
import { randomUUID, createHash } from 'node:crypto'
import { auth } from '@/lib/auth'
import { pool } from '@/lib/db'
import { recordUserSubmission } from '@/lib/coordinator-event-store'
import * as store from '@/lib/coordinator/store'
import { ruleTier } from '@/lib/coordinator/triage'
import { proposeCalendarBatch } from '@/lib/operations/action-intent-runtime'
import { createOperationLedger, OperationError } from '@/lib/operations/ledger'
import { withOperationSession } from '@/lib/operations/session-authorization'
export const dynamic = 'force-dynamic'
export async function POST(request: Request) {
  if (process.env.ACCEPTANCE_LOCAL_ONLY !== '1' || process.env.AI_GATEWAY_API_KEY || process.env.VERCEL) return new Response(null,{status:404})
  const origin = new URL(request.url).origin
  if (!['http://localhost:3128','http://127.0.0.1:3128'].includes(origin) || request.headers.get('origin') !== origin) return new Response(null,{status:403})
  const session = await auth.api.getSession({headers:request.headers,query:{disableCookieCache:true}})
  if (!session) return new Response(null,{status:401})
  const owner=session.user.id, actor={userId:owner,sessionId:session.session.id}, body=await request.json()
  if(body.op==='propose') {
    const holder=randomUUID()
    const submitted=await recordUserSubmission(owner,'Synthetic calendar request',randomUUID())
    const inbox=await store.takeInbox(owner,holder)
    if(inbox.actionContext?.sourceEventId!==submitted.sourceEventId) throw new Error('fixture inbox not empty')
    if(!['send_email','update_calendar_event'].includes(body.action))return new Response(null,{status:400});
    const input=body.action==='send_email'?{to:['synthetic@example.invalid'],subject:`Synthetic unknown ${body.mode}`,body:'Local fixture only'}:{event_id:'synthetic-existing-'+body.mode,summary:`Synthetic unknown ${body.mode}`,start:'2027-01-02T10:00:00Z',end:'2027-01-02T10:30:00Z',notify_attendees:false}
    const result=await proposeCalendarBatch(owner,inbox.actionContext,{toolCallId:'fixture-call',messages:[{role:'assistant',content:[{type:'tool-call',toolCallId:'fixture-call',toolName:body.action,input}]}]})
    await store.appendMessages(owner,holder,[],null,inbox.actionContext);await store.releaseLease(owner,holder)
    return NextResponse.json(result)
  }
  if(body.op==='historical') {
    if(!['missing','null'].includes(body.mode))return new Response(null,{status:400})
    const query=body.mode==='missing'?`UPDATE coordinator_events SET payload=payload-'input' WHERE "userId"=$1 AND "dedupeKey"=$2`:`UPDATE coordinator_events SET payload=jsonb_set(payload,'{input}','null'::jsonb) WHERE "userId"=$1 AND "dedupeKey"=$2`
    await pool.query(query,[owner,`action_uncertain:${body.id}`]);return NextResponse.json({ok:true})
  }
  if(body.op==='expire') {
    await pool.query('UPDATE "session" SET "expiresAt"=clock_timestamp()-interval \'1 second\' WHERE id=$1 AND "userId"=$2',[session.session.id,owner])
    return NextResponse.json({expired:true})
  }
  if(body.op==='consume') {
    const holder=randomUUID(), result=await store.takeInbox(owner,holder)
    if(result.held){await store.appendMessages(owner,holder,[],null,result.actionContext);await store.releaseLease(owner,holder)}
    return NextResponse.json(result)
  }
  if(body.op==='receipt') {
    // Explicit synthetic receipt import through the real ledger; native Composio lookup is unsupported.
    const row=(await pool.query('SELECT * FROM pending_actions WHERE id=$1 AND "userId"=$2',[body.id,owner])).rows[0]
    if(!row)return new Response(null,{status:404})
    const response=await fetch('http://127.0.0.1:3129/receipt?key='+encodeURIComponent(JSON.stringify([owner,row.action,row.input.summary??row.input.subject])),{cache:'no-store'})
    if(!response.ok)return new Response(null,{status:409})
    const {id}=await response.json()
    const ledger=createOperationLedger(pool,withOperationSession(actor,async(tx,binding)=>{
      const p=(await tx.query('SELECT * FROM pending_actions WHERE id=$1 AND "userId"=$2 FOR SHARE',[binding.approvalId,owner])).rows[0]
      if(!p||p.id!==binding.operationId||p.operationBinding.provider!==binding.provider||p.operationBinding.payloadDigest!==binding.payloadDigest)throw new OperationError('fixture binding mismatch')
    }))
    const result=await ledger.reconcile({operationId:row.id,ownerId:owner,workspaceId:`personal:${owner}`},async()=>({providerObjectId:id,evidenceDigest:createHash('sha256').update(JSON.stringify([row.operationBinding.accountId,id])).digest('hex')}))
    return NextResponse.json({status:result.status})
  }
  if(body.op==='snapshot')return NextResponse.json({
    events:(await pool.query('SELECT id,"dedupeKey",tier,payload,"deliveredAt" FROM coordinator_events WHERE "userId"=$1 ORDER BY "createdAt"',[owner])).rows,
    messages:(await pool.query('SELECT position,message FROM coordinator_messages WHERE "userId"=$1 ORDER BY position',[owner])).rows,
    ledger:(await pool.query('SELECT "operationId",status FROM operation_ledger WHERE "ownerId"=$1',[owner])).rows,
    uncertainTier:ruleTier({kind:'action_decided',payload:{status:'uncertain'}}),
  })
  return new Response(null,{status:400})
}
