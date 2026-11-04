import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { Pool } from 'pg'
import { handleGroup, type GroupRequest } from '../group-conversations-store'
import { groupGenerationFailure, GroupJudgmentPendingError, groupsWithPendingTurns, hasPendingGroupTurn, processGroupTurn, runGroupRounds, untilStopped, type GroupAgent, type GroupRuntime } from './group-turns'
import { checkedCorrection, checkedRoute } from './group-correction'
import { createGroupJudgment } from './group-judgment'
import { DECISION_MODEL, type DecisionAnswer } from './decision'
import type { DecisionExecution } from './decide'
import { UnknownMentionError, routingInput } from './group-routing'
import { disposableDatabase } from '../../tests/helpers/e2e-target.mjs'
import { groupTurnSessionOptions, openGroupTurnSession } from './group-turn-session'

const a = randomUUID(), b = randomUUID(), outsider = randomUUID()
const members: GroupAgent[] = [a,b].map((id,i) => ({ id, name: `Agent ${i}`, description: `role ${i}` }))
const message = { text: 'everyone', mentions: [] }
const receipt: DecisionExecution = {executionId:'synthetic-execution',modelId:DECISION_MODEL,providerGenerationId:'synthetic-generation',startedAt:'2026-01-01T00:00:00.000Z',completedAt:'2026-01-01T00:00:01.000Z',requestDigest:'a'.repeat(64),imageDigests:[],vision:'no-image-input'}
test('group session uses the same database/role/TLS and only bypasses the documented Neon transaction pooler',()=>{
  const source=new URL('postgresql://ep-group-pooler.c-7.us-east-2.aws.neon.tech/app?sslmode=require')
  source.username=randomUUID();source.password=randomUUID()
  const options=groupTurnSessionOptions({connectionString:source.href,options:'-c search_path=group_fixture',max:5})
  const target=new URL(options.connectionString!)
  assert.equal(target.hostname,'ep-group.c-7.us-east-2.aws.neon.tech')
  assert.equal(target.username,source.username);assert.equal(target.password,source.password)
  assert.equal(target.pathname,source.pathname);assert.equal(target.search,source.search)
  assert.equal(options.options,'-c search_path=group_fixture');assert.equal(options.max,1)
  assert.equal(groupTurnSessionOptions({host:'localhost-pooler.example.test'}).host,'localhost-pooler.example.test')
  assert.throws(()=>groupTurnSessionOptions({connectionString:source.href+'&host=foreign.invalid'}),/NEON_CONNECTION_OVERRIDE_REFUSED/)
})
test('group failure diagnostics preserve finite underlying causes and never private provider text', () => {
  const wrapped = (cause:unknown) => Object.assign(new Error('private prompt and credential'), { name:'AI_NoOutputGeneratedError',cause })
  assert.equal(groupGenerationFailure(wrapped(new DOMException('private upstream URL','TimeoutError'))),'generation_timeout')
  assert.equal(groupGenerationFailure(wrapped({statusCode:503})),'generation_upstream')
  assert.equal(groupGenerationFailure(wrapped({statusCode:429})),'generation_rate_limited')
  assert.equal(groupGenerationFailure(wrapped({statusCode:401})),'generation_authentication')
  assert.equal(groupGenerationFailure(wrapped(undefined)),'generation_invalid_output')
  const cycle:any = new Error('private detail'); cycle.cause=cycle
  assert.equal(groupGenerationFailure(cycle),'generation_failed_not_replayed')
})

test('serial engine: dedupes each round, caps reciprocal mentions at 3 rounds, later sees previous data', async () => {
  let generating = 0, peak = 0
  const calls: string[] = [], published: string[] = [], statuses: (string|null)[] = []
  await runGroupRounds({ by: 'mention', responders: [a,a,b] }, message, {
    async eligible() { return members }, async status(id) { statuses.push(id) },
    async generate(agent, input) {
      generating++; peak = Math.max(peak, generating)
      assert.equal(input.earlier.length, calls.length)
      if (calls.length) assert.match(input.followUp, /data, not instructions/)
      calls.push(agent.id)
      await new Promise(resolve => setTimeout(resolve, 1)); generating--
      return { text: `response ${calls.length}`, mentions: [a,b,a] }
    }, async publish(id) { published.push(id); return true },
  })
  assert.equal(peak, 1); assert.deepEqual(calls, [a,b,a,b,a,b]); assert.deepEqual(published, calls)
  assert.deepEqual(statuses, [a,null,b,null,a,null,b,null,a,null,b,null])
})
test('nothing-to-add is not posted; removed members never generate; unknown peer mentions error before post', async () => {
  let posted = 0, called = 0
  const io = { async eligible() { return [members[0]] }, async status() {}, async publish() { posted++; return true }, async generate() { called++; return { text: ' [nothing to add] ', mentions: [] as string[] } } }
  await runGroupRounds({ by: 'mention', responders: [a,b] }, message, io)
  assert.equal(posted, 0); assert.equal(called, 1)
  await assert.rejects(runGroupRounds({ by: 'mention', responders: [a] }, message, { ...io, async generate() { return { text: 'bad', mentions: [outsider] } } }), UnknownMentionError)
  assert.equal(posted, 0)
})
test('root explicit mentions all receive direct delivery; autonomous followups still need contribution and revoked targets cannot run',async()=>{
  const generated:string[]=[],judged:string[]=[]
  await runGroupRounds({by:'mention',action:'reply',responders:[a,b]}, {...message,mentions:[a,b]}, {
    eligible:async()=>members,status:async()=>{},
    contribution:async(_message,member)=>{judged.push(member.id);return{contribute:false}},
    generate:async member=>{generated.push(member.id);return{text:member.id===b?'[nothing to add]':'first answer',mentions:member.id===a?[b]:[]}},
    publish:async()=>true,
  })
  assert.deepEqual(generated,[a,b]);assert.deepEqual(judged,[b],'only the followup is subject to autonomous screening')
  const revokedGenerated:string[]=[]
  await runGroupRounds({by:'mention',responders:[a,b]}, {...message,mentions:[a,b]}, {
    eligible:async()=>revokedGenerated.length?[members[0]]:members,status:async()=>{},
    generate:async member=>{revokedGenerated.push(member.id);return{text:'answer',mentions:[]}},publish:async()=>true,
  })
  assert.deepEqual(revokedGenerated,[a],'membership removal still takes effect before direct generation')
})
test('failure clears generating status and does not synthesize a response', async () => {
  const statuses: (string|null)[] = [], outcomes: (string|undefined)[] = []
  await assert.rejects(runGroupRounds({ by: 'mention', responders: [a] }, message, {
    async eligible() { return members }, async status(id,outcome) { statuses.push(id); outcomes.push(outcome) },
    async generate() { throw new Error('provider failed') }, async publish() { assert.fail('must not publish') },
  }), /provider failed/)
  assert.deepEqual(statuses, [a,null]); assert.deepEqual(outcomes,[undefined,'failed'])
})

test('private peer rounds stay bounded and never become another public responder context', async () => {
  const publicReplies: string[] = [], privateReplies: string[] = [], calls: string[] = []
  const peers = [...members, { id: outsider, name: 'Third member', description: '' }]
  await runGroupRounds({ by: 'mention', responders: [a, outsider] }, message, {
    async eligible() { return peers }, async status() {},
    async generate(agent, input) {
      calls.push(agent.id)
      if (agent.id === outsider) {
        assert.deepEqual(input.earlier, [], 'a public responder cannot see peer-private replies')
        assert.equal(input.privatePeer, undefined)
        return { text: 'public only', mentions: [] }
      }
      if (!input.privatePeer) return { text: 'private question', mentions: [], privateTo: b }
      assert.equal(input.privatePeer.id, agent.id === a ? b : a)
      assert.equal(input.earlier.length, agent.id === b ? 1 : 2)
      return { text: 'private reply', mentions: [] }
    },
    async publish(_, reply) { publicReplies.push(reply.text); return true },
    async publishPrivate(_, __, reply) { privateReplies.push(reply.text); return true },
  })
  assert.deepEqual(calls, [a,b,a,outsider])
  assert.deepEqual(privateReplies, ['private question','private reply','private reply'])
  assert.deepEqual(publicReplies, ['public only'])
})

test('private routing rejects foreign/self/third peers and an unavailable writer before exposing text', async () => {
  const io = { async eligible() { return [...members, { id: outsider, name: 'Third member', description: '' }] }, async status() {},
    async publish() { assert.fail('private text must not become a public message') } }
  for (const peer of [a, randomUUID()]) await assert.rejects(runGroupRounds({ by: 'mention', responders: [a] }, message,
    { ...io, async generate() { return { text: 'private', mentions: [], privateTo: peer } } }), UnknownMentionError)
  await assert.rejects(runGroupRounds({ by: 'mention', responders: [a] }, message,
    { ...io, async generate() { return { text: 'private', mentions: [], privateTo: b } } }), /writer_unavailable/)
  let writes = 0
  await assert.rejects(runGroupRounds({ by: 'mention', responders: [a] }, message, { ...io,
    async generate(_, input) { return { text: 'private', mentions: [], privateTo: input.privatePeer ? outsider : b } },
    async publishPrivate() { writes++; return true },
  }), /peer_mismatch/)
  assert.equal(writes, 1, 'the first authorized exchange remains, the third-peer response is never stored')
})

// Only a disposable loopback *_e2e database, even if REQUIRE_DB is set.
const dbURL = disposableDatabase() ? process.env.E2E_DATABASE_URL : undefined
if (process.env.REQUIRE_DB === '1' && !dbURL) throw new Error('REQUIRE_DB=1 requires a loopback *_e2e database')
test('PG17: group sessions own different backends and close releases reentrant locks even after a socket loss',{skip:!dbURL},async t=>{
  const database=new Pool({connectionString:dbURL})
  t.after(()=>database.end())
  const first=await openGroupTurnSession(database),second=await openGroupTurnSession(database)
  const key=`group-session-fixture:${randomUUID()}`
  const lock=(session:typeof first)=>session.client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired',[key])
  const firstPid=(await first.client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
  try {
    assert.notEqual((await second.client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,firstPid)
    assert.equal((await lock(first)).rows[0].acquired,true)
    assert.equal((await lock(first)).rows[0].acquired,true,'PostgreSQL re-enters a lock on the same backend')
    assert.equal((await lock(second)).rows[0].acquired,false,'the other worker cannot re-enter that backend')
    await first.close()
    assert.equal((await lock(second)).rows[0].acquired,true,'physical close releases all nested acquisitions')
  } finally {await first.close();await second.close()}
  assert.equal((await database.query("SELECT count(*)::int n FROM pg_locks WHERE locktype='advisory' AND pid=$1",[firstPid])).rows[0].n,0)
  const lost=await openGroupTurnSession(database)
  try {
    await lock(lost)
    const pid=(await lost.client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
    const ended=new Promise<void>(resolve=>lost.client.once('end',()=>resolve()))
    assert.equal((await database.query('SELECT pg_terminate_backend($1) AS terminated',[pid])).rows[0].terminated,true)
    await ended
    assert.throws(()=>lost.assertHeld(),/group_turn_session_lost/)
    await assert.rejects(lost.client.query('SELECT 1'))
  } finally {await lost.close()}
  const recovered=await openGroupTurnSession(database)
  try {assert.equal((await lock(recovered)).rows[0].acquired,true)} finally {await recovered.close()}
})
test('PG17: API atomic queue, migration repeat/concurrency, group lock, FIFO, rounds, correction persistence and privacy', { skip: !dbURL }, async () => {
  const pool = new Pool({ connectionString: dbURL })
  const schema = `turns_${randomUUID().replaceAll('-','')}`
  await pool.query(`CREATE SCHEMA "${schema}"`)
  console.log(`Retaining synthetic group-turn test schema ${schema} at ${new Date().toISOString()}`)
  const scoped = new Pool({ connectionString: dbURL, max: 12, options: `-c search_path=${schema}` })
  let releasePending = () => {}
  try {
    await scoped.query(await readFile(new URL('../../drizzle/20261023213851_group_conversations.sql', import.meta.url),'utf8'))
    const migration = await readFile(new URL('../../drizzle/20261029043634_group_turns.sql', import.meta.url),'utf8')
    await Promise.all([scoped.query(migration),scoped.query(migration)]); await scoped.query(migration)
    await scoped.query(await readFile(new URL('../../drizzle/20261031153511_group_bot_members.sql', import.meta.url), 'utf8'))
    await scoped.query(await readFile(new URL('../../drizzle/20261103220300_group_decision_quality.sql', import.meta.url), 'utf8'))
    // Minimal real agent_runs columns used by the bridge; full tracked schema
    // bootstrap is an independent gate in the same ephemeral-PG17 CI job.
    await scoped.query(`CREATE TABLE agent_runs (id uuid PRIMARY KEY,"userId" text NOT NULL,"agentId" uuid NOT NULL,kind text NOT NULL,status text NOT NULL,"startedAt" timestamptz,"leaseExpiresAt" timestamptz,"finishedAt" timestamptz,"updatedAt" timestamptz DEFAULT now(), "createdAt" timestamptz DEFAULT now(), "issueId" uuid, "deviceId" uuid, "botId" uuid)`)
    await scoped.query(`CREATE TABLE agents (id uuid PRIMARY KEY, "userId" text NOT NULL, name text NOT NULL); CREATE TABLE devices (id uuid PRIMARY KEY, "ownerId" text, "lastSeenAt" timestamptz); CREATE TABLE coordinator_sessions ("userId" text, "botId" uuid, "leaseHolder" text, "leaseUntil" timestamptz, "updatedAt" timestamptz); CREATE TABLE coordinator_bots ("ownerId" text, "workspaceId" uuid, "botId" uuid)` )
    // The current active-agent reader resolves public Bot names before its
    // legacy execution-name fallback. Keep those real SQL dependencies present.
    await scoped.query(`CREATE TABLE bots (id uuid PRIMARY KEY,"ownerId" text NOT NULL,"workspaceId" uuid,name text NOT NULL,color text,shape text);
      CREATE TABLE computer_run_bindings ("runId" uuid PRIMARY KEY,"botId" uuid NOT NULL,"ownerId" text NOT NULL);
      CREATE TABLE bot_cloud_runtimes ("agentId" uuid,"botId" uuid,"ownerId" text)`)
    await scoped.query(await readFile(new URL('../../drizzle/20261103220201_group_factory.sql', import.meta.url), 'utf8'))
    for (const member of members) await scoped.query('INSERT INTO agents (id,"userId",name) VALUES ($1,$2,$3)', [member.id, 'owner', member.name])
    const workspaceId = randomUUID()
    const base: GroupRequest = { userId: 'owner', method: 'POST', resource: 'conversations', origin: 'http://localhost:3100', host: 'localhost:3100' }
    const directory = async (w: string,u: string, selected: { memberType: string; memberId: string }[] = []) => w === workspaceId && ['owner','member'].includes(u) && selected.every(m => m.memberType === 'user' ? ['owner','member'].includes(m.memberId) : u === 'owner' && members.some(a => a.id === m.memberId))
    const create = async () => {
      const response = await handleGroup(scoped,directory,{ ...base,body: JSON.stringify({ workspaceId,title:'Group',members: members.map(m => ({memberType:'agent',memberId:m.id})) }) },true)
      assert.equal(response.status,201); return (response.body as {id:string}).id
    }
    const id = await create(), other = await create()
    const send = async (group: string,text: string, mentions: string[] = []) => {
      const result = await handleGroup(scoped,directory,{...base,resource:'messages',id:group,body: JSON.stringify({body:text,mentions:mentions.map(memberId => ({memberType:'agent',memberId}))})},true)
      assert.equal(result.status,201); return (result.body as {id:string}).id
    }
    // Explicit owner designation; no schema/configuration in #155 designated a lead.
    const config = async (group: string, leadAgentId: string | null, userId = 'owner') => handleGroup(scoped,directory,{...base,resource:'conversations',method:'PATCH',id:group,userId,body:JSON.stringify({leadAgentId})},true)
    assert.equal((await scoped.query('SELECT "leadAgentId" FROM conversations WHERE id=$1',[id])).rows[0].leadAgentId,null)
    assert.equal((await config(id,outsider)).status,422) // foreign/private agent
    assert.equal((await config(id,a)).status,200)
    await scoped.query(`INSERT INTO conversation_members ("conversationId","memberType","memberId",role) VALUES ($1,'user','member','member')`,[id])
    assert.equal((await config(id,b,'member')).status,403)
    assert.equal((await scoped.query('SELECT "leadAgentId" FROM conversations WHERE id=$1',[id])).rows[0].leadAgentId,a)
    const badCreate = await handleGroup(scoped,directory,{...base,body:JSON.stringify({workspaceId,title:'invalid lead',members:[{memberType:'agent',memberId:a}],leadAgentId:b})},true)
    assert.equal(badCreate.status,422) // owned, but not in group
    const configured = await handleGroup(scoped,directory,{...base,body:JSON.stringify({workspaceId,title:'configured',members:[{memberType:'agent',memberId:b}],leadAgentId:b})},true)
    assert.equal(configured.status,201); assert.equal((configured.body as {leadAgentId:string}).leadAgentId,b)
    const routeCalls: string[] = [], generated: string[] = []
    const runtime: GroupRuntime = {
      async agents(_,ids,client) { assert.ok(client); await client.query('SELECT 1'); return members.filter(a => ids.includes(a.id)) }, async authorized(w,u) { return directory(w,u) },
      correction: createGroupJudgment(async (_purpose, input) => {
        const data = JSON.parse(typeof input === 'string' ? input : input.text)
        const entries: [string, Exclude<DecisionAnswer, {type:'refusal'}>][] = [
          ['correction',{type:'choice',name:'correction',choice:data.current.text === 'not you' ? 'yes' : 'no'}],
          ['target',{type:'choice',name:'target',choice:b}],
        ]
        return {answers:new Map(entries),execution:receipt}
      }).correction,
      async route(input,_,__,corrections) {
        routeCalls.push(input.text)
        if (input.text === 'later') {
          assert.equal(corrections.length,1); assert.equal(corrections[0].wrongId,a); assert.equal(corrections[0].rightId,b)
          assert.match(routingInput(input,members,corrections), /Past routing mistakes/)
        }
        return {by:'model',responders:[a],confidence:1}
      },
      async generate(agent,input) { generated.push(input.message.text); return {text:`${agent.id}: ${input.message.text}`,mentions:[]} },
    }
    const root = await send(id,'first')
    let unblock!: () => void, entered!: () => void
    const waiting = new Promise<void>(r => { entered=r }), release = new Promise<void>(r => { unblock=r })
    const blocked: GroupRuntime = {...runtime,async generate(agent,input) { entered(); await release; return runtime.generate(agent,input) }}
    releasePending = unblock
    const running = processGroupTurn(scoped,id,blocked); await waiting
    // Match #79 9760e912's existing owner + working + live lease predicate.
    const activeRuns = async (owner = 'owner', now = new Date()) => (await scoped.query(`SELECT id,"agentId","userId",kind FROM agent_runs WHERE "userId"=$1 AND status IN ('preparing','running','waiting_input','finishing') AND "leaseExpiresAt">$2`, [owner,now])).rows
    const active = await activeRuns()
    assert.equal(active.length,1); assert.equal(active[0].agentId,a); assert.equal(active[0].kind,'group_chat')
    // Exercise the current main reader and HTTP response against the actual bridge row.
    const [{ drizzle }, schema, { listActiveAgents, activeAgentsResponse }] = await Promise.all([import('drizzle-orm/node-postgres'), import('../db/schema'), import('../active-agents')])
    const db = drizzle(scoped, { schema })
    const request = new Request('http://local/api/agent/sessions/active')
    const copy = { pleaseSignIn: 'sign in', unavailable: 'unavailable', noParameters: 'no params' }
    const response = await activeAgentsResponse(request, 'owner', user => listActiveAgents(db, user), copy)
    assert.equal(response.status, 200)
    const body = await response.json() as { agents: { id: string; runId: string }[] }
    assert.equal(body.agents.length, 1); assert.equal(body.agents[0].id, a); assert.equal(body.agents[0].runId, active[0].id)
    const otherResponse = await activeAgentsResponse(request, 'member', user => listActiveAgents(db, user), copy)
    assert.deepEqual(await otherResponse.json(), { agents: [] })
    assert.equal((await activeRuns('member')).length,0); assert.equal((await activeRuns('outsider')).length,0)
    assert.equal((await activeRuns('owner',new Date(Date.now()+61000))).length,0) // crash cannot leave perpetual active status
    const laterRoot = await send(id,'not you',[b])
    assert.equal(await processGroupTurn(scoped,id,runtime),false) // same-conversation contender cannot generate
    const status = await handleGroup(scoped,directory,{...base,method:'GET',resource:'messages',id},true)
    assert.equal((status.body as {agentStatus:{agentId:string}}).agentStatus.agentId,a)
    assert.equal((await handleGroup(scoped,directory,{...base,userId:'outsider',method:'GET',resource:'messages',id},true)).status,404)
    // The minute sweep and a history read see a group's pending turn; once it ran, neither does.
    assert.equal(await hasPendingGroupTurn(scoped,other),false)
    await send(other,'independent',[a])
    assert.equal(await hasPendingGroupTurn(scoped,other),true)
    assert.ok((await groupsWithPendingTurns(scoped)).includes(other))
    assert.equal(await processGroupTurn(scoped,other,runtime),true)
    assert.equal(await hasPendingGroupTurn(scoped,other),false)
    assert.equal((await groupsWithPendingTurns(scoped)).includes(other),false)
    unblock(); assert.equal(await running,true)
    assert.equal((await activeRuns()).length,0)
    assert.equal((await scoped.query('SELECT status FROM agent_runs WHERE id=$1',[active[0].id])).rows[0].status,'succeeded')
    assert.equal(await processGroupTurn(scoped,id,runtime),true)
    assert.deepEqual(routeCalls,['first']) // direct mention never routes
    await send(id,'later'); assert.equal(await processGroupTurn(scoped,id,{...runtime}),true) // new runtime loads persisted correction
    assert.equal((await scoped.query('SELECT count(*)::int n FROM group_routing_corrections WHERE "conversationId"=$1',[id])).rows[0].n,1)
    assert.deepEqual((await scoped.query('SELECT "decisionExecution" FROM group_routing_corrections WHERE "conversationId"=$1',[id])).rows[0].decisionExecution,receipt)
    const revokedCorrection = await send(id, 'correction during removal', [b])
    await assert.rejects(processGroupTurn(scoped,id,{...runtime,async correction() {
      const removed = await handleGroup(scoped,directory,{...base,resource:'members',method:'DELETE',id,body:JSON.stringify({memberType:'agent',memberId:b})},true)
      assert.equal(removed.status,200)
      return {kind:'correction',rightId:b,execution:receipt}
    }}), GroupJudgmentPendingError)
    assert.equal((await scoped.query('SELECT count(*)::int n FROM group_routing_corrections WHERE "messageId"=$1',[revokedCorrection])).rows[0].n,0)
    await handleGroup(scoped,directory,{...base,resource:'members',method:'POST',id,body:JSON.stringify({memberType:'agent',memberId:b})},true)
    const awaitingJudgment = await send(id, 'quoted denial', [b])
    await assert.rejects(processGroupTurn(scoped, id, {...runtime, async correction() { return {kind:'uncertain'} }}), GroupJudgmentPendingError)
    assert.equal((await scoped.query('SELECT count(*)::int n FROM group_routing_corrections WHERE "conversationId"=$1', [id])).rows[0].n, 1)
    assert.equal((await scoped.query('SELECT error FROM group_turns WHERE "messageId"=$1', [awaitingJudgment])).rows[0].error, 'group_judgment_pending')
    // A different topic with a new @ is not a correction just because it mentions another agent.
    const unrelatedTopic = await send(id, 'new topic', [b])
    await processGroupTurn(scoped, id, runtime)
    assert.equal((await scoped.query('SELECT count(*)::int n FROM group_routing_corrections WHERE "conversationId"=$1', [id])).rows[0].n, 1)
    assert.equal((await scoped.query('SELECT status FROM group_turns WHERE "messageId"=$1', [unrelatedTopic])).rows[0].status, 'complete')
    assert.equal((await scoped.query('SELECT "replyToId" FROM conversation_messages WHERE "authorType"=\'agent\' AND "conversationId"=$1 ORDER BY position',[id])).rows[0].replyToId,root)
    const invalid = await handleGroup(scoped,directory,{...base,resource:'messages',id,body:JSON.stringify({body:'unknown',mentions:[{memberType:'agent',memberId:outsider}]})},true)
    assert.equal(invalid.status,422)
    // Removal after enqueue: mention raises rather than silently choosing a different agent.
    const stale = await send(id,'stale',[b])
    await scoped.query('UPDATE conversation_members SET "leftAt"=now() WHERE "conversationId"=$1 AND "memberId"=$2',[id,b])
    await assert.rejects(processGroupTurn(scoped,id,runtime),UnknownMentionError)
    assert.equal((await scoped.query('SELECT status,error FROM group_turns WHERE "messageId"=$1',[stale])).rows[0].error,'unknown_mention')
    assert.equal(await processGroupTurn(scoped,id,runtime),false) // failed root not replayed
    await scoped.query('UPDATE conversation_members SET "leftAt"=NULL WHERE "conversationId"=$1 AND "memberId"=$2',[id,b])
    const rounds = await send(id,'three rounds',[a,b])
    await processGroupTurn(scoped,id,{...runtime,async generate(agent) { return {text:`reply ${agent.id}`,mentions:[a,b,a]} }})
    assert.equal((await scoped.query('SELECT count(*)::int n FROM conversation_messages WHERE "replyToId"=$1',[rounds])).rows[0].n,6)
    const nothing = await send(id,'nothing',[a,b])
    await processGroupTurn(scoped,id,{...runtime,async generate() {return {text:'[nothing to add]',mentions:[]}}})
    assert.equal((await scoped.query('SELECT count(*)::int n FROM conversation_messages WHERE "replyToId"=$1',[nothing])).rows[0].n,0)
    const failed = await send(id,'provider failed',[a])
    await assert.rejects(processGroupTurn(scoped,id,{...runtime,async generate() {throw new Error('private provider detail must not persist')}}), /private provider detail/)
    const failure = (await scoped.query('SELECT status,error,"agentId" FROM group_turns WHERE "messageId"=$1',[failed])).rows[0]
    assert.deepEqual(failure,{status:'failed',error:'generation_failed_not_replayed',agentId:null})
    assert.equal((await activeRuns()).length,0)
    assert.equal((await scoped.query('SELECT status FROM agent_runs ORDER BY "startedAt" DESC LIMIT 1')).rows[0].status,'failed')
    const recovery = await send(id,'after error',[a])
    assert.equal(await processGroupTurn(scoped,id,runtime),true) // error released the session lock
    assert.equal((await scoped.query('SELECT status FROM group_turns WHERE "messageId"=$1',[recovery])).rows[0].status,'complete')
    const interrupted = await send(id,'interrupted',[a])
    const unrelated = randomUUID()
    await scoped.query(`INSERT INTO agent_runs (id,"userId","agentId",kind,status,"startedAt","leaseExpiresAt") VALUES ($1,'owner',$2,'implement','running',now(),now()-interval '1 second')`,[unrelated,a])
    const interruptedRun = randomUUID()
    await scoped.query(`INSERT INTO agent_runs (id,"userId","agentId",kind,status,"startedAt","leaseExpiresAt") VALUES ($1,'owner',$2,'group_chat','running',now(),now()+interval '60 seconds')`,[interruptedRun,a])
    await scoped.query(`UPDATE group_turns SET status='running',"agentId"=$2,"activeRunId"=$3 WHERE "messageId"=$1`,[interrupted,a,interruptedRun])
    assert.equal(await processGroupTurn(scoped,id,runtime),false)
    assert.equal((await activeRuns()).length,0)
    assert.equal((await scoped.query('SELECT status FROM agent_runs WHERE id=$1',[interruptedRun])).rows[0].status,'failed')
    assert.equal((await scoped.query('SELECT status FROM agent_runs WHERE id=$1',[unrelated])).rows[0].status,'running')
    assert.equal((await scoped.query('SELECT error,"agentId" FROM group_turns WHERE "messageId"=$1',[interrupted])).rows[0].error,'interrupted_generation_not_replayed')
    // An unavailable or uncertain route never silently selects a lead.
    const unavailableRuntime: GroupRuntime = {...runtime, async route() { throw new GroupJudgmentPendingError() }}
    const emptyGroup = await handleGroup(scoped,directory,{...base,body:JSON.stringify({workspaceId,title:'No available agents',members:[]})},true)
    assert.equal(emptyGroup.status,201)
    const emptyId = (emptyGroup.body as {id:string}).id
    const emptyRoot = await send(emptyId,'help')
    await assert.rejects(processGroupTurn(scoped,emptyId,unavailableRuntime),GroupJudgmentPendingError)
    assert.equal((await scoped.query('SELECT error FROM group_turns WHERE "messageId"=$1',[emptyRoot])).rows[0].error,'group_judgment_pending')
    // Old persisted failures must not instruct owners to configure an artificial fallback.
    await scoped.query('UPDATE group_turns SET error=$2 WHERE "messageId"=$1',[emptyRoot,'group_lead_required'])
    const emptyHistory = await handleGroup(scoped,directory,{...base,method:'GET',resource:'messages',id:emptyId},true)
    assert.deepEqual((emptyHistory.body as {routingError:unknown}).routingError,{code:'group_judgment_pending'})
    await config(id,null)
    const missing = await send(id,'ambiguous')
    await assert.rejects(processGroupTurn(scoped,id,unavailableRuntime),GroupJudgmentPendingError)
    assert.equal((await scoped.query('SELECT error FROM group_turns WHERE "messageId"=$1',[missing])).rows[0].error,'group_judgment_pending')
    const errorHistory = await handleGroup(scoped,directory,{...base,method:'GET',resource:'messages',id},true)
    assert.equal((errorHistory.body as {routingError:{code:string}}).routingError.code,'group_judgment_pending')
    await send(id,'direct without lead',[b]); await processGroupTurn(scoped,id,unavailableRuntime)
    await config(id,a)
    const removed = await handleGroup(scoped,directory,{...base,resource:'members',method:'DELETE',id,body:JSON.stringify({memberType:'agent',memberId:a})},true)
    assert.equal(removed.status,200)
    assert.equal((await scoped.query('SELECT "leadAgentId" FROM conversations WHERE id=$1',[id])).rows[0].leadAgentId,null)
    assert.equal((await config(id,a)).status,422)
    await handleGroup(scoped,directory,{...base,resource:'members',method:'POST',id,body:JSON.stringify({memberType:'agent',memberId:a})},true)
    await config(id,a)
    // A human group member can address an explicitly group-selected creator agent,
    // never an arbitrary private agent belonging to themselves or another owner.
    const memberSend = await handleGroup(scoped,directory,{...base,userId:'member',resource:'messages',id,body:JSON.stringify({body:'member asks selected agent',mentions:[{memberType:'agent',memberId:b}]})},true)
    assert.equal(memberSend.status,201); await processGroupTurn(scoped,id,runtime)
    const memberPrivate = await handleGroup(scoped,directory,{...base,userId:'member',resource:'messages',id,body:JSON.stringify({body:'private outsider',mentions:[{memberType:'agent',memberId:outsider}]})},true)
    assert.equal(memberPrivate.status,422)
    // Revocation while a fake provider is generating cannot publish afterwards.
    let live = true
    const revokedDuring = await send(id,'removed during generation',[a])
    await processGroupTurn(scoped,id,{...runtime,async authorized(w,u) {return live && runtime.authorized(w,u)},async generate() {live=false;return {text:'must not publish',mentions:[]}}})
    assert.equal((await scoped.query('SELECT count(*)::int n FROM conversation_messages WHERE "replyToId"=$1',[revokedDuring])).rows[0].n,0)
    // A peer removed during generation is not a valid mention at publication.
    const departedPeer = await send(id,'peer removed during generation',[a])
    await assert.rejects(processGroupTurn(scoped,id,{...runtime,async generate() {
      await handleGroup(scoped,directory,{...base,resource:'members',method:'DELETE',id,body:JSON.stringify({memberType:'agent',memberId:b})},true)
      return {text:'reply to departed peer',mentions:[b]}
    }}),UnknownMentionError)
    assert.equal((await scoped.query('SELECT count(*)::int n FROM conversation_messages WHERE "replyToId"=$1',[departedPeer])).rows[0].n,0)
    await handleGroup(scoped,directory,{...base,resource:'members',method:'POST',id,body:JSON.stringify({memberType:'agent',memberId:b})},true)
    // Provider cancellation clears status/releases session lock; a new root proceeds.
    const canceled = await send(id,'cancelled provider',[a])
    await assert.rejects(processGroupTurn(scoped,id,{...runtime,async generate() {throw new DOMException('cancelled','AbortError')}}),{name:'AbortError'})
    assert.deepEqual((await scoped.query('SELECT status,"agentId" FROM group_turns WHERE "messageId"=$1',[canceled])).rows[0],{status:'failed',agentId:null})
    await send(id,'after cancellation',[a]); assert.equal(await processGroupTurn(scoped,id,runtime),true)
    const revoked = await send(id,'revoked workspace',[a])
    await assert.rejects(processGroupTurn(scoped,id,{...runtime,async authorized() {return false},async generate() {assert.fail('revoked actor must not generate')}}),/no_longer_authorized/)
    assert.equal((await scoped.query('SELECT status FROM group_turns WHERE "messageId"=$1',[revoked])).rows[0].status,'failed')
    // 停止: a member stops while a reply generates; the reply in flight is aborted and nothing is posted, the turn reads stopped.
    const stoppedRoot = await send(id,'stopped mid reply',[a])
    let aborted = false
    assert.equal(await processGroupTurn(scoped,id,{...runtime,async generate(_agent,input) {
      const stop = await handleGroup(scoped,directory,{...base,userId:'member',resource:'stop',id},true)
      assert.equal(stop.status,200); assert.ok((stop.body as {stopped:number}).stopped>=1,'stop also cancels recoverable pending judgments')
      await new Promise<void>(resolve => input.signal?.addEventListener('abort',() => { aborted = true; resolve() },{once:true}))
      throw input.signal?.reason
    }}),true)
    assert.ok(aborted,'the reply in flight is aborted')
    assert.deepEqual((await scoped.query('SELECT status,error,"agentId" FROM group_turns WHERE "messageId"=$1',[stoppedRoot])).rows[0],{status:'failed',error:'stopped',agentId:null})
    assert.equal((await scoped.query('SELECT count(*)::int n FROM conversation_messages WHERE "replyToId"=$1',[stoppedRoot])).rows[0].n,0)
    assert.deepEqual((await scoped.query('SELECT source,kind FROM group_decision_feedback WHERE "messageId"=$1', [stoppedRoot])).rows, [{ source: 'human_cancellation', kind: 'cancelled_turn' }])
    assert.equal((await scoped.query(`SELECT status FROM agent_runs WHERE kind='group_chat' ORDER BY "createdAt" DESC LIMIT 1`)).rows[0].status,'stopped')
    const page = await handleGroup(scoped,directory,{...base,method:'GET',resource:'messages',id},true)
    assert.equal((page.body as {stopped:boolean;agentStatus:unknown}).stopped,true); assert.equal((page.body as {agentStatus:unknown}).agentStatus,null)
    // A reply that finishes as the stop lands is not posted either; the next message is answered as usual.
    const lateRoot = await send(id,'stopped as it finished',[a])
    assert.equal(await processGroupTurn(scoped,id,{...runtime,async generate() {
      await handleGroup(scoped,directory,{...base,resource:'stop',id},true)
      return {text:'too late',mentions:[]}
    }}),true)
    assert.equal((await scoped.query('SELECT count(*)::int n FROM conversation_messages WHERE "replyToId"=$1',[lateRoot])).rows[0].n,0)
    const afterStop = await send(id,'after stop',[a]); assert.equal(await processGroupTurn(scoped,id,runtime),true)
    assert.equal((await scoped.query('SELECT status FROM group_turns WHERE "messageId"=$1',[afterStop])).rows[0].status,'complete')
    // Only members stop: someone outside the group gets the same 404 as an unknown group.
    assert.equal((await handleGroup(scoped,directory,{...base,userId:'stranger',resource:'stop',id},true)).status,404)
    // Quiet routes are successful durable turns with no chat run and no public message.
    let newGenerations=0
    for (const action of ['ignore','observe'] as const) {
      const quiet=await send(id,action==='ignore'?'随便聊聊':'已经有人给了完整答案')
      const runsBefore=(await scoped.query('SELECT count(*)::int AS n FROM agent_runs')).rows[0].n
      await processGroupTurn(scoped,id,{...runtime,async route(){return{by:'model',action,reason:'already_answered',responders:[]}},async generate(){newGenerations++;throw Error('quiet turn generated')}})
      assert.equal((await scoped.query('SELECT status FROM group_turns WHERE "messageId"=$1',[quiet])).rows[0].status,'complete')
      assert.equal((await scoped.query('SELECT count(*)::int AS n FROM conversation_messages WHERE "replyToId"=$1',[quiet])).rows[0].n,0)
      assert.equal((await scoped.query('SELECT count(*)::int AS n FROM agent_runs')).rows[0].n,runsBefore)
      const quietTrace=(await scoped.query('SELECT trace FROM group_turns WHERE "messageId"=$1',[quiet])).rows[0].trace
      assert.equal(quietTrace.action,action);assert.equal(quietTrace.status,'complete');assert.deepEqual(quietTrace.events,[])
    }
    const useful=await send(id,'请分别给出实现与设计意见')
    await processGroupTurn(scoped,id,{...runtime,async route(){return{by:'model',action:'reply',responders:[a,b]}},async contribution(){return{contribute:false}},async generate(){newGenerations++;return{text:'两部分均已完整说明',mentions:[]}}})
    assert.equal(newGenerations,1)
    assert.equal((await scoped.query('SELECT count(*)::int AS n FROM conversation_messages WHERE "replyToId"=$1',[useful])).rows[0].n,1)
    const usefulEvents=(await scoped.query('SELECT trace FROM group_turns WHERE "messageId"=$1',[useful])).rows[0].trace.events as {type:string}[]
    for(const type of ['wake','generate','publish']) assert.equal(usefulEvents.filter(event=>event.type===type).length,1)
    // Only an unstarted judgment may retry; it stays visibly pending until then.
    const pending=await send(id,'需要暂时不可用的决策')
    await assert.rejects(processGroupTurn(scoped,id,{...runtime,async correction(){return{kind:'not_correction'}},async route(){throw new GroupJudgmentPendingError()}}),GroupJudgmentPendingError)
    const pendingState=(await scoped.query('SELECT status,error,"nextDecisionAt" FROM group_turns WHERE "messageId"=$1',[pending])).rows[0]
    assert.equal(pendingState.error,'group_judgment_pending');assert.ok(pendingState.nextDecisionAt)
    await scoped.query('UPDATE group_turns SET "nextDecisionAt"=now()-interval \'1 second\' WHERE "messageId"=$1',[pending])
    assert.ok((await groupsWithPendingTurns(scoped)).includes(id))
    await processGroupTurn(scoped,id,{...runtime,async correction(){return{kind:'not_correction'}},async route(){return{by:'model',action:'observe',responders:[]}}})
    assert.equal((await scoped.query('SELECT status FROM group_turns WHERE "messageId"=$1',[pending])).rows[0].status,'complete')
    // Real route consumer + real durable turn: a paid later-phase failure is
    // pending, and a successful retry keeps both attempts without waking a Bot.
    const sequential=await send(id,'sequential pending fixture')
    let decisionCalls=0,retrying=false
    const sequentialJudge=createGroupJudgment(async(_purpose,_input,questions)=>{
      decisionCalls++;assert.equal(questions.length,1)
      const name=questions[0].name,value=retrying?'observe_already_answered':name==='intent'?'reply_useful_answer':'uncertain'
      return {answers:new Map([[name,{type:'choice' as const,name,choice:value}]]),execution:{...receipt,executionId:`durable-${decisionCalls}`,providerGenerationId:`durable-generation-${decisionCalls}`}}
    })
    const sequentialRuntime:GroupRuntime={...runtime,route:sequentialJudge.route,correction:async()=>({kind:'not_correction'}),generate:async()=>assert.fail('invalid/quiet chain cannot generate')}
    await assert.rejects(processGroupTurn(scoped,id,sequentialRuntime),GroupJudgmentPendingError)
    const failedChain=(await scoped.query('SELECT trace,error FROM group_turns WHERE "messageId"=$1',[sequential])).rows[0]
    assert.equal(failedChain.error,'group_judgment_pending');assert.equal(failedChain.trace.decisionFailure,'uncertain')
    assert.equal(failedChain.trace.decisions.length,2);assert.equal(failedChain.trace.decisions[1].status,'invalid_decision')
    retrying=true
    await scoped.query('UPDATE group_turns SET "nextDecisionAt"=now()-interval \'1 second\' WHERE "messageId"=$1',[sequential])
    await processGroupTurn(scoped,id,sequentialRuntime)
    const recovered=(await scoped.query('SELECT status,trace FROM group_turns WHERE "messageId"=$1',[sequential])).rows[0]
    assert.equal(recovered.status,'complete');assert.equal(recovered.trace.action,'observe');assert.equal(decisionCalls,3)
    assert.equal(recovered.trace.decisions.length,3);assert.equal(recovered.trace.execution.providerGenerationId,'durable-generation-3')
    assert.equal(recovered.trace.decisions[1].status,'invalid_decision');assert.deepEqual(recovered.trace.events,[])
    const stoppedDecision=await send(id,'stop between routing phases')
    let stoppedDecisionCalls=0
    const stopJudge=createGroupJudgment(async(_purpose,_input,questions)=>{
      stoppedDecisionCalls++
      assert.equal(questions[0].name,'intent')
      assert.equal((await handleGroup(scoped,directory,{...base,resource:'stop',id},true)).status,200)
      return {answers:new Map([['intent',{type:'choice' as const,name:'intent',choice:'reply_useful_answer'}]]),execution:{...receipt,executionId:'stop-phase',providerGenerationId:'stop-phase-generation'}}
    })
    await processGroupTurn(scoped,id,{...sequentialRuntime,route:stopJudge.route})
    const stoppedChain=(await scoped.query('SELECT error,trace FROM group_turns WHERE "messageId"=$1',[stoppedDecision])).rows[0]
    assert.equal(stoppedDecisionCalls,1);assert.equal(stoppedChain.error,'stopped');assert.equal(stoppedChain.trace.decisions.length,1)

    // A transaction pooler can lend one physical backend to two logical
    // clients between statements. PostgreSQL's session lock then re-enters;
    // a history poll must not classify a still-live Decision as interrupted.
    const pooledGroup=await create(), pooledMessage=await send(pooledGroup,'quiet pooled fixture')
    const backend=await scoped.connect()
    const pooledClient=new Proxy(backend,{get(target,property){
      if(property==='release') return ()=>{}
      const value=Reflect.get(target,property,target)
      return typeof value==='function'?value.bind(target):value
    }})
    const transactionPool=new Proxy(scoped,{get(target,property){
      if(property==='connect') return async()=>pooledClient
      const value=Reflect.get(target,property,target)
      return typeof value==='function'?value.bind(target):value
    }})
    let completeDecision!:()=>void, decisionEntered!:()=>void, pooledCalls=0
    const decisionReady=new Promise<void>(resolve=>{decisionEntered=resolve})
    const decisionRelease=new Promise<void>(resolve=>{completeDecision=resolve})
    const pooledJudge=createGroupJudgment(async()=>{
      pooledCalls++;decisionEntered();await decisionRelease
      return {answers:new Map([['intent',{type:'choice' as const,name:'intent',choice:'observe_context'}]]),execution:{...receipt,executionId:'pooled-decision',providerGenerationId:'pooled-generation'}}
    })
    const pooledRuntime={...runtime,route:pooledJudge.route}
    const liveDecision=processGroupTurn(transactionPool,pooledGroup,pooledRuntime)
    try {
      await decisionReady
      assert.equal(await processGroupTurn(transactionPool,pooledGroup,pooledRuntime),false)
      const live=(await scoped.query('SELECT status,error,trace FROM group_turns WHERE "messageId"=$1',[pooledMessage])).rows[0]
      assert.equal(live.status,'running','a concurrent history poll must not interrupt the live worker')
      assert.equal(live.error,null);assert.equal(live.trace.status,'pending');assert.equal(pooledCalls,1)
    } finally {completeDecision();await liveDecision;backend.release()}
    const pooledFinished=(await scoped.query('SELECT status,error,trace FROM group_turns WHERE "messageId"=$1',[pooledMessage])).rows[0]
    assert.equal(pooledFinished.status,'complete');assert.equal(pooledFinished.error,null)
    assert.equal(pooledFinished.trace.decisions[0].receipt.providerGenerationId,'pooled-generation')
    assert.deepEqual(pooledFinished.trace.events,[],'quiet routing does not wake or generate')

    // Terminate only this fixture worker's owned backend while its Decision
    // is in flight. It cannot start the dependent responder request or post.
    const lostDecisionGroup=await create(),lostDecisionMessage=await send(lostDecisionGroup,'lost Decision fixture')
    let decisionPid=0, releaseLostDecision!:()=>void, enterLostDecision!:()=>void, lostCalls=0
    let decisionEnded:Promise<void>=Promise.resolve()
    const lostDecisionReady=new Promise<void>(resolve=>{enterLostDecision=resolve})
    const lostDecisionRelease=new Promise<void>(resolve=>{releaseLostDecision=resolve})
    const lostJudge=createGroupJudgment(async()=>{
      lostCalls++;enterLostDecision();await lostDecisionRelease
      return {answers:new Map([['intent',{type:'choice' as const,name:'intent',choice:'reply_useful_answer'}]]),execution:{...receipt,executionId:'lost-decision',providerGenerationId:'lost-generation'}}
    })
    const lostDecisionWork=processGroupTurn(scoped,lostDecisionGroup,{...runtime,route:lostJudge.route,
      async agents(owner,ids,client){
        decisionPid=(await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
        decisionEnded=new Promise<void>(resolve=>client.once('end',()=>resolve()))
        return runtime.agents(owner,ids,client)
      },async generate(){assert.fail('a lost Decision worker cannot generate')},
    })
    const lostDecisionRejected=assert.rejects(lostDecisionWork)
    try {
      await lostDecisionReady
      assert.equal((await scoped.query('SELECT pg_terminate_backend($1) AS terminated',[decisionPid])).rows[0].terminated,true)
      await decisionEnded
    } finally {releaseLostDecision();await lostDecisionRejected}
    assert.equal(lostCalls,1,'a lost session never starts the dependent paid phase')
    assert.equal(await processGroupTurn(scoped,lostDecisionGroup,runtime),false)
    const lostDecisionState=(await scoped.query('SELECT error,trace FROM group_turns WHERE "messageId"=$1',[lostDecisionMessage])).rows[0]
    assert.equal(lostDecisionState.error,'interrupted_generation_not_replayed')
    assert.deepEqual(lostDecisionState.trace.events,[])

    // A running generator receives cancellation after its physical session
    // disappears. This is worker loss, not a fabricated user stop/feedback.
    const lostGenerationGroup=await create(),lostGenerationMessage=await send(lostGenerationGroup,'lost generation fixture',[a])
    let generationPid=0, enterLostGeneration!:()=>void, releaseLostGeneration!:()=>void, generationAborted=false
    let generationEnded:Promise<void>=Promise.resolve()
    const lostGenerationReady=new Promise<void>(resolve=>{enterLostGeneration=resolve})
    const lostGenerationWork=processGroupTurn(scoped,lostGenerationGroup,{...runtime,
      async agents(owner,ids,client){
        generationPid=(await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
        generationEnded=new Promise<void>(resolve=>client.once('end',()=>resolve()))
        return runtime.agents(owner,ids,client)
      },async generate(_agent,input){
        enterLostGeneration()
        return new Promise((resolve,reject)=>{
          releaseLostGeneration=()=>resolve({text:'must not publish after session loss',mentions:[]})
          input.signal!.addEventListener('abort',()=>{generationAborted=true;reject(input.signal!.reason)},{once:true})
        })
      },
    })
    const lostGenerationRejected=assert.rejects(lostGenerationWork)
    try {
      await lostGenerationReady
      assert.equal((await scoped.query('SELECT pg_terminate_backend($1) AS terminated',[generationPid])).rows[0].terminated,true)
      await generationEnded
      const until=Date.now()+2500
      while(!generationAborted && Date.now()<until) await new Promise(resolve=>setTimeout(resolve,20))
      assert.equal(generationAborted,true,'physical session loss must abort the active generator')
    } finally {releaseLostGeneration();await lostGenerationRejected}
    assert.equal(await processGroupTurn(scoped,lostGenerationGroup,runtime),false)
    const lostGenerationState=(await scoped.query('SELECT error,trace FROM group_turns WHERE "messageId"=$1',[lostGenerationMessage])).rows[0]
    assert.equal(lostGenerationState.error,'interrupted_generation_not_replayed')
    assert.equal(lostGenerationState.trace.events.filter((event:{type:string})=>event.type==='publish').length,0)
    assert.equal((await scoped.query('SELECT count(*)::int n FROM conversation_messages WHERE "replyToId"=$1',[lostGenerationMessage])).rows[0].n,0)
    assert.ok(generated.includes('first')); assert.ok(laterRoot)
  } finally { releasePending(); await scoped.end(); await pool.end() }
})
test('停止 ends the rounds: no further reply is generated once the turn is stopped', async () => {
  const calls: string[] = []
  let stop = false
  await runGroupRounds({ by: 'mention', responders: [a,b] }, message, {
    async eligible() { return members }, async status() {}, async stopped() { return stop },
    async generate(agent) { calls.push(agent.id); stop = true; return { text: 'first reply', mentions: [b] } },
    async publish() { return true },
  })
  assert.deepEqual(calls, [a])
})
test('停止 aborts a reply in flight once the poll sees it, and leaves a finished one alone', async () => {
  let stop = false
  const pending = untilStopped(async () => stop, signal => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })), 5)
  stop = true
  await assert.rejects(pending, /stopped/)
  assert.equal(await untilStopped(async () => false, async () => 'done', 5), 'done')
})
test('expired execution budget cancels before generation/status publication', async () => {
  await assert.rejects(runGroupRounds({by:'mention',responders:[a]},message,{
    async eligible() {return members}, async generate() {assert.fail('expired')},async status() {assert.fail('expired')}, async publish() {assert.fail('expired')},
  },Date.now()-1),/budget_exceeded/)
})
test('production adapter does not select private standing instructions or sessions',async () => {
  const runtime = await readFile(new URL('./group-runtime.ts',import.meta.url),'utf8')
  assert.doesNotMatch(runtime,/agents\.instructions|agent_sessions|agent_turns|personalMemory|personal_memory/)
  assert.match(runtime,/await client\.query/)
  assert.doesNotMatch(runtime,/\bdb\./)
})

test('correction facts come from model judgment and reject uncertain or invalid members', () => {
  const prior = { message: 'previous', responderId: a }
  assert.equal(checkedCorrection({ kind: 'not_correction' }, prior, members), null)
  assert.equal(checkedCorrection({ kind: 'uncertain' }, prior, members), 'uncertain')
  assert.equal(checkedCorrection({ kind: 'correction', rightId: outsider }, prior, members), 'uncertain')
  assert.equal(checkedCorrection({ kind: 'correction', rightId: a }, prior, members), 'uncertain')
  assert.deepEqual(checkedCorrection({ kind: 'correction', rightId: b }, prior, members), { message: 'previous', wrongId: a, rightId: b })
})


test('model route preserves its choice and rejects uncertain or non-member output', () => {
  assert.deepEqual(checkedRoute({kind:'route',responders:[b,a],confidence:0.42},members), {by:'model',responders:[b,a],confidence:0.42})
  assert.throws(() => checkedRoute({kind:'uncertain',responders:[],confidence:0},members), GroupJudgmentPendingError)
  assert.throws(() => checkedRoute({kind:'route',responders:[outsider],confidence:1},members), GroupJudgmentPendingError)
  assert.throws(() => checkedRoute({kind:'route',responders:[a,a],confidence:1},members), GroupJudgmentPendingError)
})


test('decision adapter retains each sequential host receipt and refuses missing, inconsistent or invalid answers', async () => {
  const seen: { purpose: string; text: string; names: string[] }[] = []
  let calls=0
  const invoke=async (purpose:string,input:import('./decision').DecisionInput,questions:import('./decision').DecisionQuestion[]) => {
    seen.push({purpose,text:typeof input === 'string' ? input : input.text,names:questions.map(q=>q.name)})
    const values:Record<string,string>={responder_0:b,responder_1:'end',correction:'yes',target:b}
    const entries=questions.map(q=>[q.name,{type:'choice' as const,name:q.name,choice:values[q.name]}] as const)
    return {answers:new Map(entries),execution:{...receipt,executionId:`adapter-${++calls}`,providerGenerationId:`adapter-generation-${calls}`}}
  }
  const judge = createGroupJudgment(invoke,'group-route-v0')
  const route=await judge.route(message,members,a,[])
  assert.equal(route.action,'reply');assert.equal(route.policyVersion,'group-route-v0');assert.deepEqual(route.responders,[b])
  assert.equal(route.decisions?.length,2);assert.equal(route.execution?.executionId,'adapter-1')
  assert.deepEqual(seen.slice(0,2).map(call=>call.names),[['responder_0'],['responder_1']])
  const input = {previous:{message:'earlier',responderId:a},current:message,members}
  const correction=await judge.correction(input)
  assert.equal(correction.kind,'correction');if(correction.kind==='correction')assert.equal(correction.rightId,b)
  assert.match(seen[2].text, /untrusted data/); assert.deepEqual(seen[2].names,['correction','target'])
  const invalid = createGroupJudgment(async () => ({answers:new Map([['responder_0',{type:'choice',name:'responder_0',choice:outsider}]]),execution:receipt}),'group-route-v0')
  await assert.rejects(invalid.route(message,members,a,[]),GroupJudgmentPendingError)
  assert.deepEqual(await invalid.correction(input), {kind:'uncertain'})
  const uncertain = createGroupJudgment(async (_purpose,_input,questions) => ({answers:new Map(questions.map(q=>[q.name,{type:'choice' as const,name:q.name,choice:q.name==='responder_0'?b:'uncertain'}])),execution:{...receipt,executionId:`uncertain-${++calls}`,providerGenerationId:`uncertain-generation-${calls}`}}),'group-route-v0')
  await assert.rejects(uncertain.route(message,members,a,[]),(error:unknown)=>error instanceof GroupJudgmentPendingError && error.decisionFailure==='uncertain' && error.decisions.length===2)
  const unavailable = createGroupJudgment(async () => null)
  await assert.rejects(unavailable.route(message,members,a,[]),GroupJudgmentPendingError)
  assert.deepEqual(await unavailable.correction(input), {kind:'uncertain'})
})
