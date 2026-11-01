import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { Pool } from 'pg'
import { handleGroup, type GroupRequest } from '../group-conversations-store'
import { GroupJudgmentPendingError, processGroupTurn, runGroupRounds, untilStopped, type GroupAgent, type GroupRuntime } from './group-turns'
import { checkedCorrection, checkedRoute } from './group-correction'
import { createGroupJudgment } from './group-judgment'
import { DECISION_MODEL, type DecisionAnswer } from './decision'
import type { DecisionExecution } from './decide'
import { UnknownMentionError, routingInput } from './group-routing'
import { disposableDatabase } from '../../tests/helpers/e2e-target.mjs'

const a = randomUUID(), b = randomUUID(), outsider = randomUUID()
const members: GroupAgent[] = [a,b].map((id,i) => ({ id, name: `Agent ${i}`, description: `role ${i}` }))
const message = { text: 'everyone', mentions: [] }
const receipt: DecisionExecution = {executionId:'synthetic-execution',modelId:DECISION_MODEL,providerGenerationId:'synthetic-generation',startedAt:'2026-01-01T00:00:00.000Z',completedAt:'2026-01-01T00:00:01.000Z',requestDigest:'synthetic',imageDigests:[],vision:'no-image-input'}
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
    // Minimal real agent_runs columns used by the bridge; full tracked schema
    // bootstrap is an independent gate in the same ephemeral-PG17 CI job.
    await scoped.query(`CREATE TABLE agent_runs (id uuid PRIMARY KEY,"userId" text NOT NULL,"agentId" uuid NOT NULL,kind text NOT NULL,status text NOT NULL,"startedAt" timestamptz,"leaseExpiresAt" timestamptz,"finishedAt" timestamptz,"updatedAt" timestamptz DEFAULT now(), "createdAt" timestamptz DEFAULT now(), "issueId" uuid, "deviceId" uuid, "botId" uuid)`)
    await scoped.query(`CREATE TABLE agents (id uuid PRIMARY KEY, "userId" text NOT NULL, name text NOT NULL); CREATE TABLE devices (id uuid PRIMARY KEY, "ownerId" text, "lastSeenAt" timestamptz); CREATE TABLE coordinator_sessions ("userId" text, "botId" uuid, "leaseHolder" text, "leaseUntil" timestamptz, "updatedAt" timestamptz); CREATE TABLE coordinator_bots ("ownerId" text, "workspaceId" uuid, "botId" uuid)` )
    // The current active-agent reader resolves public Bot names before its
    // legacy execution-name fallback. Keep those real SQL dependencies present.
    await scoped.query(`CREATE TABLE bots (id uuid PRIMARY KEY,"ownerId" text NOT NULL,"workspaceId" uuid,name text NOT NULL,color text,shape text);
      CREATE TABLE computer_run_bindings ("runId" uuid PRIMARY KEY,"botId" uuid NOT NULL,"ownerId" text NOT NULL);
      CREATE TABLE bot_cloud_runtimes ("agentId" uuid,"botId" uuid,"ownerId" text)`)
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
    await send(other,'independent',[a]); assert.equal(await processGroupTurn(scoped,other,runtime),true)
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
      assert.equal(stop.status,200); assert.deepEqual(stop.body,{stopped:1})
      await new Promise<void>(resolve => input.signal?.addEventListener('abort',() => { aborted = true; resolve() },{once:true}))
      throw input.signal?.reason
    }}),true)
    assert.ok(aborted,'the reply in flight is aborted')
    assert.deepEqual((await scoped.query('SELECT status,error,"agentId" FROM group_turns WHERE "messageId"=$1',[stoppedRoot])).rows[0],{status:'failed',error:'stopped',agentId:null})
    assert.equal((await scoped.query('SELECT count(*)::int n FROM conversation_messages WHERE "replyToId"=$1',[stoppedRoot])).rows[0].n,0)
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


test('decision adapter retains host receipt and refuses missing, inconsistent or invalid answers', async () => {
  const seen: { purpose: string; text: string; names: string[] }[] = []
  const judge = createGroupJudgment(async (purpose, input, questions) => {
    seen.push({purpose,text:typeof input === 'string' ? input : input.text,names:questions.map(q=>q.name)})
    const entries: [string, Exclude<DecisionAnswer,{type:'refusal'}>][] = purpose === 'group-routing'
      ? [['responder_0',{type:'choice',name:'responder_0',choice:b}],['responder_1',{type:'choice',name:'responder_1',choice:'end'}]]
      : [['correction',{type:'choice',name:'correction',choice:'yes'}],['target',{type:'choice',name:'target',choice:b}]]
    return {answers:new Map(entries),execution:receipt}
  })
  assert.deepEqual(await judge.route(message,members,a,[]), {by:'model',responders:[b],execution:receipt})
  const input = {previous:{message:'earlier',responderId:a},current:message,members}
  assert.deepEqual(await judge.correction(input), {kind:'correction',rightId:b,execution:receipt})
  assert.match(seen[1].text, /untrusted data/); assert.deepEqual(seen[1].names,['correction','target'])
  const invalid = createGroupJudgment(async () => ({answers:new Map([['responder_0',{type:'choice',name:'responder_0',choice:outsider}]]),execution:receipt}))
  await assert.rejects(invalid.route(message,members,a,[]),GroupJudgmentPendingError)
  assert.deepEqual(await invalid.correction(input), {kind:'uncertain'})
  // An uncertain later slot cannot silently become a completed partial route.
  const uncertain = createGroupJudgment(async () => ({answers:new Map<string, Exclude<DecisionAnswer,{type:'refusal'}>>([
    ['responder_0',{type:'choice',name:'responder_0',choice:b}],
    ['responder_1',{type:'choice',name:'responder_1',choice:'uncertain'}],
  ]),execution:receipt}))
  await assert.rejects(uncertain.route(message,members,a,[]),GroupJudgmentPendingError)
  const unavailable = createGroupJudgment(async () => null)
  await assert.rejects(unavailable.route(message,members,a,[]),GroupJudgmentPendingError)
  assert.deepEqual(await unavailable.correction(input), {kind:'uncertain'})
})
