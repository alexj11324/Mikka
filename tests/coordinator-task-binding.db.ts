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
import { takeInbox } from '../lib/coordinator/store'
import { seedCoordinator } from './support/coordinator-bot'
async function main() {
validateTarget(process.env)
process.env.MIKKA_ISSUE_TOOLS_ENABLED='1'
const owner = `pr358-${randomUUID()}`, other = `pr358-${randomUUID()}`
const event = randomUUID(), device = randomUUID(), issue = randomUUID(), failed = randomUUID(), partial = randomUUID()
await pool.query('insert into "user" (id,name,email,"emailVerified","createdAt","updatedAt") values ($1,$1,$2,false,now(),now()),($3,$3,$4,false,now(),now())',[owner,`${owner}@example.invalid`,other,`${other}@example.invalid`])
await pool.query('insert into devices (id,"ownerId",name,kind,enabled) values ($1,$2,$3,$4,true)',[device,owner,'fixture','local'])
// The person's Coordinator is an ordinary bot row: its chat's events carry that bot's id.
const coordinator=(await seedCoordinator(owner)).botId
for (const id of [event, failed]) await pool.query('insert into coordinator_events (id,"userId","botId",kind,"dedupeKey",payload,"deliveredAt") values ($1,$2,$6,$3,$4,$5,now())',[id,owner,'user_message',`pr358-${id}`,JSON.stringify({text:'fixture',taskDestination:{kind:'device',deviceId:device}}),coordinator])
const input={title:'fixture'}, context={eventId:event,botId:coordinator}
const make = async () => { await db.insert(issues).values({id:issue,userId:owner,title:'fixture',content:{type:'doc'},status:'todo',priority:'normal'}); return {id:issue} }
const results = await actAs(owner, () => Promise.all([idempotentIssueMutation(owner,'create_issue','pr358-call',input,make,context),idempotentIssueMutation(owner,'create_issue','pr358-call',input,make,context)]))
assert.deepEqual(results,[{id:issue},{id:issue}])
assert.equal((await pool.query('select "issueId" from coordinator_events where id=$1',[event])).rows[0].issueId,issue)
await assert.rejects(idempotentIssueMutation(other,'create_issue','foreign',input,async()=>({id:randomUUID()}),context),/issueToolCallConflict/)
await assert.rejects(idempotentIssueMutation(owner,'create_issue','other-call',input,async()=>({id:randomUUID()}),context),/issueToolCallConflict/)
await assert.rejects(idempotentIssueMutation(owner,'create_issue','failed',input,async()=>{await db.insert(issues).values({id:partial,userId:owner,title:'partial',content:{type:'doc'},status:'todo',priority:'normal'}); throw new Error('synthetic failure')},{eventId:failed,botId:coordinator}),/synthetic failure/)
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
const created=await actAs(owner,async()=>await tools.create_issue!.execute!(toolInput,toolContext)) as {id?:string;error?:string}
assert.ok(created.id,JSON.stringify(created))
const repeated=await actAs(owner,async()=>await tools.create_issue!.execute!(toolInput,toolContext))
assert.deepEqual(repeated,created)
assert.equal((await pool.query('select "issueId" from coordinator_events where id=$1',[toolEvent])).rows[0].issueId,created.id)
assert.equal((await pool.query('select count(*)::int as n from issue_versions where "issueId"=$1',[created.id])).rows[0].n,1)
const nextEvent=randomUUID()
await pool.query('update devices set enabled=true where id=$1',[device])
await pool.query('insert into coordinator_events (id,"userId","botId",kind,"dedupeKey",payload,tier) values ($1,$2,$7,$3,$4,$5,$6)',[nextEvent,owner,'user_message',`pr358-${nextEvent}`,JSON.stringify({text:'second real request',taskDestination:{kind:'device',deviceId:device}}),'attention',coordinator])
const nextInbox=await takeInbox(owner,`binding-${toolEvent}`,coordinator)
assert.equal(nextInbox.taskEventId,nextEvent)
const nextTools=createCoordinatorRegistry(owner,coordinator,undefined,{coordinator:true,taskEventId:nextInbox.taskEventId})
const nextCreated=await actAs(owner,async()=>await nextTools.create_issue!.execute!({title:'Second machine-selected task'},{...toolContext,toolCallId:`registered-${nextEvent}`})) as {id?:string;error?:string}
assert.ok(nextCreated.id,JSON.stringify(nextCreated))
assert.notEqual(nextCreated.id,created.id)
const stored=(await pool.query('select id,"issueId",payload from coordinator_events where id=any($1::uuid[]) order by id',[[toolEvent,nextEvent]])).rows
assert.equal(stored.find(row=>row.id===toolEvent).issueId,created.id)
assert.equal(stored.find(row=>row.id===toolEvent).payload.taskDestination.kind,'cloud')
assert.equal(stored.find(row=>row.id===nextEvent).issueId,nextCreated.id)
assert.equal(stored.find(row=>row.id===nextEvent).payload.taskDestination.deviceId,device)
console.log(JSON.stringify({status:'passed',owner,event,issue,failed,toolEvent,toolIssue:created.id,checks:['concurrent replay','owner rejection','second call rejection','failure rollback','registered tool creates bound task','registered tool replay preserves one version']}))
}
test('real registered tasks retain owner, replay and inbox-event bindings', { timeout: 60000 }, async () => {
  const original = process.env.MIKKA_ISSUE_TOOLS_ENABLED
  try { await main() } finally {
    if (original === undefined) delete process.env.MIKKA_ISSUE_TOOLS_ENABLED
    else process.env.MIKKA_ISSUE_TOOLS_ENABLED = original
    await Promise.all([pool.end(), workspacePool.end()])
  }
})
