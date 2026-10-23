import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { Pool } from 'pg'
import { handleGroup, type GroupRequest } from '../group-conversations-store'
import { processGroupTurn, runGroupRounds, type GroupAgent, type GroupRuntime } from './group-turns'
import { UnknownMentionError, routingInput } from './group-routing'

const a = randomUUID(), b = randomUUID(), outsider = randomUUID()
const members: GroupAgent[] = [a,b].map((id,i) => ({ id, name: `Agent ${i}`, description: `role ${i}`, instructions: '' }))
const message = { text: 'everyone', mentions: [] }
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
  const statuses: (string|null)[] = []
  await assert.rejects(runGroupRounds({ by: 'mention', responders: [a] }, message, {
    async eligible() { return members }, async status(id) { statuses.push(id) },
    async generate() { throw new Error('provider failed') }, async publish() { assert.fail('must not publish') },
  }), /provider failed/)
  assert.deepEqual(statuses, [a,null])
})

// Enforce the authorized ephemeral DB boundary, even if REQUIRE_DB is accidentally set locally.
const dbURL = process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true' ? process.env.E2E_DATABASE_URL : undefined
if (process.env.REQUIRE_DB === '1' && !dbURL) throw new Error('REQUIRE_DB=1 requires GitHub Actions ephemeral PG17')
if (dbURL) {
  const url = new URL(dbURL)
  if (url.hostname !== '127.0.0.1' || url.pathname !== '/mikka_e2e') throw new Error('Only CI temporary mikka_e2e is allowed')
}
test('PG17: API atomic queue, migration repeat/concurrency, group lock, FIFO, rounds, correction persistence and privacy', { skip: !dbURL }, async () => {
  const pool = new Pool({ connectionString: dbURL })
  const schema = `turns_${randomUUID().replaceAll('-','')}`
  await pool.query(`CREATE SCHEMA "${schema}"`)
  const scoped = new Pool({ connectionString: dbURL, max: 12, options: `-c search_path=${schema}` })
  try {
    await scoped.query(await readFile(new URL('../../drizzle/20261023213851_group_conversations.sql', import.meta.url),'utf8'))
    const migration = await readFile(new URL('../../drizzle/20261023222000_group_turns.sql', import.meta.url),'utf8')
    await Promise.all([scoped.query(migration),scoped.query(migration)]); await scoped.query(migration)
    const workspaceId = randomUUID()
    const base: GroupRequest = { userId: 'owner', method: 'POST', resource: 'conversations', origin: 'http://localhost:3100', host: 'localhost:3100' }
    const directory = async (w: string,u: string) => w === workspaceId && u === 'owner'
    const create = async () => {
      const response = await handleGroup(scoped,directory,{ ...base,body: JSON.stringify({ workspaceId,title:'Group',members: members.map(m => ({memberType:'agent',memberId:m.id})) }) },true)
      assert.equal(response.status,201); return (response.body as {id:string}).id
    }
    const id = await create(), other = await create()
    const send = async (group: string,text: string, mentions: string[] = []) => {
      const result = await handleGroup(scoped,directory,{...base,resource:'messages',id:group,body: JSON.stringify({body:text,mentions:mentions.map(memberId => ({memberType:'agent',memberId}))})},true)
      assert.equal(result.status,201); return (result.body as {id:string}).id
    }
    const routeCalls: string[] = [], generated: string[] = []
    const runtime: GroupRuntime = {
      async agents(_,ids) { return members.filter(a => ids.includes(a.id)) }, async authorized(w,u) { return directory(w,u) },
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
    const running = processGroupTurn(scoped,id,blocked); await waiting
    const laterRoot = await send(id,'not you',[b])
    assert.equal(await processGroupTurn(scoped,id,runtime),false) // same-conversation contender cannot generate
    const status = await handleGroup(scoped,directory,{...base,method:'GET',resource:'messages',id},true)
    assert.equal((status.body as {agentStatus:{agentId:string}}).agentStatus.agentId,a)
    assert.equal((await handleGroup(scoped,directory,{...base,userId:'outsider',method:'GET',resource:'messages',id},true)).status,404)
    await send(other,'independent',[a]); assert.equal(await processGroupTurn(scoped,other,runtime),true)
    unblock(); assert.equal(await running,true)
    assert.equal(await processGroupTurn(scoped,id,runtime),true)
    assert.deepEqual(routeCalls,['first']) // direct mention never routes
    await send(id,'later'); assert.equal(await processGroupTurn(scoped,id,{...runtime}),true) // new runtime loads persisted correction
    assert.equal((await scoped.query('SELECT count(*)::int n FROM group_routing_corrections WHERE "conversationId"=$1',[id])).rows[0].n,1)
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
    assert.ok(generated.includes('first')); assert.ok(laterRoot)
  } finally { await scoped.end(); await pool.query(`DROP SCHEMA "${schema}" CASCADE`); await pool.end() }
})
