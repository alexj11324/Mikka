import { tokenWorkspace } from '../lib/tokens/principal'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { validateTarget } from '../scripts/run-db-tests.mjs'
import { workspacePool } from '../lib/workspace-db'
import { db, pool } from '../lib/db'
import { issues } from '../lib/db/schema'
import { idempotentIssueMutation } from '../lib/mcp/issue-mutation'
import { actAs } from '../lib/acting-user'
import { createCoordinatorRegistry } from '../workflows/coordinator/tools'
import { takeInbox, failTurn, retryFailedTurn, releaseLease } from '@/tests/support/legacy-coordinator-store'
import { seedCoordinator } from './support/coordinator-bot'
import { overrideDeploymentSwitch } from '../lib/deployment-switches'
async function main() {
validateTarget(process.env)
overrideDeploymentSwitch('issueTools', true)
const owner = `pr358-${randomUUID()}`, other = `pr358-${randomUUID()}`
const event = randomUUID(), device = randomUUID(), issue = randomUUID(), failed = randomUUID(), partial = randomUUID()
await pool.query('insert into "user" (id,name,email,"emailVerified","createdAt","updatedAt") values ($1,$1,$2,false,now(),now()),($3,$3,$4,false,now(),now())',[owner,`${owner}@example.invalid`,other,`${other}@example.invalid`])
await pool.query('insert into devices (id,"ownerId",name,kind,enabled) values ($1,$2,$3,$4,true)',[device,owner,'fixture','local'])
// The person's Coordinator is an ordinary bot row: its chat's events carry that bot's id.
const { botId: coordinator, workspaceId } = await seedCoordinator(owner)
const principal = { id: owner, [tokenWorkspace]: workspaceId }
for (const id of [event, failed]) await pool.query('insert into coordinator_events (id,"userId","botId",kind,"dedupeKey",payload,"deliveredAt") values ($1,$2,$6,$3,$4,$5,now())',[id,owner,'user_message',`pr358-${id}`,JSON.stringify({text:'fixture',taskDestination:{kind:'device',deviceId:device}}),coordinator])
const input={title:'fixture'}, context={eventId:event,botId:coordinator}
const make = async () => { await db.insert(issues).values({id:issue,userId:owner,workspaceId,title:'fixture',content:{type:'doc'},status:'todo',priority:'normal'}); return {id:issue} }
const results = await actAs(principal, () => Promise.all([idempotentIssueMutation(owner,'create_issue','pr358-call',input,make,context),idempotentIssueMutation(owner,'create_issue','pr358-call',input,make,context)]))
assert.deepEqual(results,[{id:issue},{id:issue}])
assert.equal((await pool.query('select "issueId" from coordinator_events where id=$1',[event])).rows[0].issueId,issue)
await assert.rejects(idempotentIssueMutation(other,'create_issue','foreign',input,async()=>({id:randomUUID()}),context),/issueToolCallConflict/)
assert.deepEqual(await actAs(principal,()=>idempotentIssueMutation(owner,'create_issue','other-call',{...input,body:'Regenerated'},async()=>{throw new Error('must not duplicate')},context)),{id:issue})
await assert.rejects(actAs(principal, () => idempotentIssueMutation(owner,'create_issue','failed',input,async()=>{await db.insert(issues).values({id:partial,userId:owner,workspaceId,title:'partial',content:{type:'doc'},status:'todo',priority:'normal'}); throw new Error('synthetic failure')},{eventId:failed,botId:coordinator})),/synthetic failure/)
assert.equal((await pool.query('select "issueId" from coordinator_events where id=$1',[failed])).rows[0].issueId,null)
assert.equal((await pool.query('select count(*)::int as n from issues where id=$1',[partial])).rows[0].n,0)
await pool.query('update devices set enabled=false where id=$1',[device])
await assert.rejects(idempotentIssueMutation(owner,'create_issue','disabled',input,async()=>({id:randomUUID()}),{eventId:failed,botId:coordinator}),/issueToolCallConflict/)
// Exercise the actual registered tool, durable step, app action and issue writer.
// A fresh owner has no Linear team or outbox jobs; no model/provider is invoked.
const toolEvent=randomUUID()
await pool.query('insert into coordinator_events (id,"userId","botId",kind,"dedupeKey",payload,tier) values ($1,$2,$7,$3,$4,$5,$6)',[toolEvent,owner,'user_message',`pr358-${toolEvent}`,JSON.stringify({text:'real tool fixture',taskDestination:{kind:'cloud'}}),'attention',coordinator])
const inbox=await takeInbox(owner,`binding-${toolEvent}`,coordinator)
assert.equal(inbox.taskEventId,toolEvent)
assert.equal(inbox.added,1)
const tools=createCoordinatorRegistry(owner,coordinator,undefined,{coordinator:true,taskEventId:inbox.taskEventId})
const toolInput={title:'Real registered task binding'}
const toolContext={toolCallId:`registered-${toolEvent}`,messages:[],context:{}}
const created=await actAs(principal,async()=>await tools.create_issue!.execute!(toolInput,toolContext)) as {id?:string;error?:string}
assert.ok(created.id,JSON.stringify(created))
const repeated=await actAs(principal,async()=>await tools.create_issue!.execute!(toolInput,toolContext))
assert.deepEqual(repeated,created)
assert.equal((await pool.query('select "issueId" from coordinator_events where id=$1',[toolEvent])).rows[0].issueId,created.id)
assert.equal((await pool.query('select count(*)::int as n from issue_versions where "issueId"=$1',[created.id])).rows[0].n,1)
// A task-dialog retry restores its authenticated destination and creation.
await failTurn(owner,`binding-${toolEvent}`,'ServiceTooBusy',coordinator)
assert.equal(await retryFailedTurn(owner,coordinator),true)
const formRetry=await takeInbox(owner,'wrun_form-retry',coordinator)
assert.equal(formRetry.taskEventId,toolEvent)
const formTools=createCoordinatorRegistry(owner,coordinator,undefined,{coordinator:true,taskEventId:formRetry.taskEventId})
const formRepeated=await actAs(principal,async()=>await formTools.create_issue!.execute!({...toolInput,body:'New model wording'},{...toolContext,toolCallId:'new-form-call'}))
assert.deepEqual(formRepeated,created)
await releaseLease(owner,'wrun_form-retry',coordinator)
const nextEvent=randomUUID()
await pool.query('update devices set enabled=true where id=$1',[device])
await pool.query('insert into coordinator_events (id,"userId","botId",kind,"dedupeKey",payload,tier) values ($1,$2,$7,$3,$4,$5,$6)',[nextEvent,owner,'user_message',`pr358-${nextEvent}`,JSON.stringify({text:'second real request',taskDestination:{kind:'device',deviceId:device}}),'attention',coordinator])
const nextInbox=await takeInbox(owner,`binding-${toolEvent}`,coordinator)
assert.equal(nextInbox.taskEventId,nextEvent)
const nextTools=createCoordinatorRegistry(owner,coordinator,undefined,{coordinator:true,taskEventId:nextInbox.taskEventId})
const nextCreated=await actAs(principal,async()=>await nextTools.create_issue!.execute!({title:'Second machine-selected task'},{...toolContext,toolCallId:`registered-${nextEvent}`})) as {id?:string;error?:string}
assert.ok(nextCreated.id,JSON.stringify(nextCreated))
assert.notEqual(nextCreated.id,created.id)
const stored=(await pool.query('select id,"issueId",payload from coordinator_events where id=any($1::uuid[]) order by id',[[toolEvent,nextEvent]])).rows
assert.equal(stored.find(row=>row.id===toolEvent).issueId,created.id)
assert.equal(stored.find(row=>row.id===toolEvent).payload.taskDestination.kind,'cloud')
assert.equal(stored.find(row=>row.id===nextEvent).issueId,nextCreated.id)
assert.equal(stored.find(row=>row.id===nextEvent).payload.taskDestination.deviceId,device)
// A model can fail after create_issue committed but before dispatch/reply.
// Retrying the same human request gets a new SDK tool call and a rewritten body.
await releaseLease(owner,`binding-${toolEvent}`,coordinator)
const plainEvent=randomUUID()
await pool.query('insert into coordinator_events (id,"userId","botId",kind,"dedupeKey",payload,tier) values ($1,$2,$3,\'user_message\',$4,$5,\'attention\')',[plainEvent,owner,coordinator,`retry-source-${plainEvent}`,{text:'Create the named task'}])
const firstTake=await takeInbox(owner,'wrun_partial-create',coordinator)
const ordinaryTools=createCoordinatorRegistry(owner,coordinator,undefined,{coordinator:true,sourceEventId:firstTake.sourceEventId})
const firstTask=await actAs(principal,async()=>await ordinaryTools.create_issue!.execute!({title:'Same requested task',body:'First frozen description'},{...toolContext,toolCallId:'first-model-call'})) as {id:string}
assert.ok(firstTask.id)
await failTurn(owner,'wrun_partial-create','ServiceTooBusy',coordinator)
assert.equal(await retryFailedTurn(owner,coordinator),true)
const retryTake=await takeInbox(owner,'wrun_retry-create',coordinator)
assert.equal(retryTake.sourceEventId,firstTake.sourceEventId,'a retry retains the original authenticated person request')
const retryTools=createCoordinatorRegistry(owner,coordinator,undefined,{coordinator:true,sourceEventId:retryTake.sourceEventId})
const retryTask=await actAs(principal,async()=>await retryTools.create_issue!.execute!({title:'Same requested task',body:'Model rewrote this after retry'},{...toolContext,toolCallId:'different-model-call'})) as {id:string}
assert.equal(retryTask.id,firstTask.id,'new SDK call IDs cannot duplicate a committed task for the same request and title')
assert.equal((await pool.query('select count(*)::int as n from issue_versions where "issueId"=$1',[firstTask.id])).rows[0].n,1)
await assert.rejects(idempotentIssueMutation(other,'create_issue','foreign-chat',{title:'Same requested task'},async()=>{throw new Error('must not mutate')},undefined,{eventId:plainEvent,botId:coordinator,teamId:null}),/issueToolCallConflict/)
await assert.rejects(idempotentIssueMutation(owner,'create_issue','foreign-bot',{title:'Same requested task'},async()=>{throw new Error('must not mutate')},undefined,{eventId:plainEvent,botId:randomUUID(),teamId:null}),/issueToolCallConflict/)
await assert.rejects(idempotentIssueMutation(owner,'create_issue','no-destination-bypass',{title:'Same requested task'},async()=>{throw new Error('must not mutate')},undefined,{eventId:event,botId:coordinator,teamId:null}),/issueToolCallConflict/)
const differentTitle=await actAs(principal,async()=>await retryTools.create_issue!.execute!({title:'Another requested task'},{...toolContext,toolCallId:'another-title'})) as {id:string}
assert.notEqual(differentTitle.id,firstTask.id,'one request can still create differently named tasks')
await releaseLease(owner,'wrun_retry-create',coordinator)
const intentional=randomUUID()
await pool.query('insert into coordinator_events (id,"userId","botId",kind,"dedupeKey",payload,tier) values ($1,$2,$3,\'user_message\',$4,$5,\'attention\')',[intentional,owner,coordinator,`new-source-${intentional}`,{text:'Create another task with the same title'}])
const intentionalTake=await takeInbox(owner,'wrun_intentional-create',coordinator)
const intentionalTools=createCoordinatorRegistry(owner,coordinator,undefined,{coordinator:true,sourceEventId:intentionalTake.sourceEventId})
const intentionalTask=await actAs(principal,async()=>await intentionalTools.create_issue!.execute!({title:'Same requested task'},{...toolContext,toolCallId:'new-request'})) as {id:string}
assert.notEqual(intentionalTask.id,firstTask.id,'a new human request may intentionally create the same title again')
console.log(JSON.stringify({status:'passed',owner,event,issue,failed,toolEvent,toolIssue:created.id,checks:['concurrent replay','owner rejection','second call reuses frozen request','failure rollback','registered tool creates bound task','registered tool replay preserves one version']}))
}
test('real registered tasks retain owner, replay and inbox-event bindings', { timeout: 60000 }, async () => {
  try { await main() } finally {
    overrideDeploymentSwitch('issueTools', undefined)
    await Promise.all([pool.end(), workspacePool.end()])
  }
})
