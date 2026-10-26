import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { Pool } from 'pg'
import { handleGroup, type GroupRequest } from './group-conversations-store'
import { groupDirectory } from './group-conversations-directory'
import { reviewArtifact, contentHash } from './artifact-review-store'
import { groupReviewCommand } from './group-review-commands'
import { completeReviewWork, dispatchReviewWork, runMessagesAdapter } from './group-review-runtime'
import { artifactAnchor, anchorStatus, ARTIFACT_HTML_POLICY } from './artifact-anchors'

const dbURL = process.env.MIKKA_DISPOSABLE_POSTGRES_URL ?? (process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true' ? process.env.E2E_DATABASE_URL : undefined)
if (dbURL) {
  const url = new URL(dbURL)
  if (url.hostname !== '127.0.0.1' || !['/mikka_review','/mikka_e2e'].includes(url.pathname)) throw new Error('Only disposable loopback review/e2e Postgres is allowed')
}
const migration = (file: string) => readFile(new URL(`../drizzle/${file}`, import.meta.url), 'utf8')
const failure = (code: string) => (error: unknown) => error instanceof Error && error.message === code

test('source anchors never migrate to another version; HTML identity fails closed', () => {
  const a = artifactAnchor.parse({ kind: 'source-range', start: 6, end: 11, quote: 'world', prefix: 'hello ', suffix: '!' })
  assert.equal(anchorStatus(a, 'hello world!', 'text/markdown', 'v1','v1'), 'attached')
  assert.equal(anchorStatus(a, 'hello world!', 'text/markdown', 'v1','v2'), 'outdated')
  assert.equal(anchorStatus(a, 'hello other world!', 'text/markdown', 'v1','v1'), 'orphaned')
  assert.equal(anchorStatus({ ...a, kind: 'html-element', elementId: 'x' }, 'hello world!', 'text/html','v1','v1'), 'orphaned')
  assert.equal(ARTIFACT_HTML_POLICY.sandbox, '')
  assert.match(ARTIFACT_HTML_POLICY.csp, /script-src 'none'/)
  assert.equal(ARTIFACT_HTML_POLICY.allowPrivilegedPostMessage, false)
})

test('disposable Postgres: mixed groups → durable isolated runtime → Artifact revision → human acceptance', { skip: !dbURL }, async t => {
  const root = new Pool({ connectionString: dbURL })
  const schema = `review_${randomUUID().replaceAll('-','')}`
  await root.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: dbURL, options: `-c search_path=${schema}`, max: 20 })
  const workspaceId = randomUUID(), otherWorkspace = randomUUID(), agentId = randomUUID(), memberAgent = randomUUID(), privateAgent = randomUUID()
  const active = new Set(['owner','member','outsider','other-owner'])
  const owners = new Map<string,string>([[agentId,'owner'], [memberAgent,'member'], [privateAgent,'other-owner']])
  const directory = groupDirectory({
    async activeUsers(w, ids) { return w === workspaceId ? ids.filter(id => active.has(id)) : [] },
    async ownedAgents(user, ids) { return ids.filter(id => owners.get(id) === user) },
  })
  const req: GroupRequest = { userId: 'owner', method: 'POST', resource: 'conversations', origin: null, host: 'localhost' }
  const group = async (changes: Partial<GroupRequest>) => handleGroup(pool, directory, { ...req, ...changes })
  const createGroup = async () => {
    const result = await group({ body: JSON.stringify({ workspaceId, title: 'Review', members: [{ memberType: 'user', memberId: 'member' }, { memberType: 'agent', memberId: agentId }] }) })
    assert.equal(result.status, 201)
    return (result.body as { id: string }).id
  }
  let conversationId = ''
  const command = (input: unknown, userId = 'owner', id = conversationId) => groupReviewCommand(pool, directory, id, userId, input)
  const artifact = (input: unknown, userId = 'owner', id = conversationId) => reviewArtifact(pool, directory, id, userId, input)
  const send = async (body = 'Please answer', target = agentId, userId = 'member', extra = {}) => {
    const result = await group({ id: conversationId, userId, resource: 'messages', body: JSON.stringify({ body, mentions: [{ memberType: 'agent', memberId: target }], ...extra }) })
    assert.equal(result.status, 201)
    const message = result.body as { id: string }
    return (await pool.query('SELECT * FROM conversation_work WHERE "triggerMessageId"=$1', [message.id])).rows[0]
  }
  const prepared: string[] = []
  const adapter = runMessagesAdapter(async (client, input) => {
    prepared.push(input.workId)
    await client.query(`INSERT INTO agent_runs (id,"agentId","userId",kind,status) VALUES ($1,$2,$3,'group_review','queued')`, [input.runId,input.agentId,input.ownerId])
  })
  const dispatch = (id: string) => dispatchReviewWork(pool,directory,adapter,id)
  const reply = (work: Record<string,string>, extra = {}) => completeReviewWork(pool,directory,adapter,work.id,{ workId:work.id,triggerMessageId:work.triggerMessageId,body:'Mock Agent reply',...extra })
  let artifactId = '', version: {id:string;hash:string}, threadId = ''
  let requestWork: Record<string,string>
  try {
    await pool.query(await migration('20261023221259_application_baseline.sql'))
    await pool.query(await migration('0001_agents_devices.sql'))
    await pool.query(await migration('20261023213851_group_conversations.sql'))
    for (const [id,owner] of owners) await pool.query(`INSERT INTO agents (id,"userId",name,harness,instructions) VALUES ($1,$2,'Agent','codex','PRIVATE_ROLE_SENTINEL')`, [id,owner])
    await t.test('migration replay/concurrency preserves existing history and does not retroactively share Agents', async () => {
      const oldGroup = randomUUID()
      await pool.query(`INSERT INTO conversations (id,"workspaceId",title,kind,"createdBy") VALUES ($1,$2,'legacy','group','owner')`, [oldGroup,workspaceId])
      await pool.query(`INSERT INTO conversation_members ("conversationId","memberType","memberId",role) VALUES ($1,'agent',$2,'member')`, [oldGroup,agentId])
      const legacyMessage = randomUUID()
      await pool.query(`INSERT INTO conversation_messages (id,"conversationId",position,"authorType","authorId",body) VALUES ($1,$2,1,'user','owner','legacy history')`,[legacyMessage,oldGroup])
      const sql = await migration('20261026002507_group_artifact_review.sql')
      await Promise.all([pool.query(sql),pool.query(sql)])
      await pool.query(sql)
      assert.equal((await pool.query('SELECT count(*) FROM conversation_agent_grants WHERE "conversationId"=$1',[oldGroup])).rows[0].count,'0')
      assert.equal((await pool.query('SELECT title FROM conversations WHERE id=$1',[oldGroup])).rows[0].title,'legacy')
      assert.equal((await pool.query('SELECT body FROM conversation_messages WHERE id=$1',[legacyMessage])).rows[0].body,'legacy history')
      await pool.query(await migration('20261026002515_group_turn_mailbox_policy.sql'))
      conversationId = await createGroup()
    })
    await t.test('ownership checks reuse transaction clients under a two-connection application pool', async () => {
      const small = new Pool({ connectionString: dbURL, max: 2, connectionTimeoutMillis: 1000, options: `-c search_path=${schema}` })
      const scopedDirectory = groupDirectory({
        async activeUsers(w, ids) { return w === workspaceId ? ids.filter(id => active.has(id)) : [] },
        async ownedAgents(userId, ids, client) {
          assert.ok(client, 'transactional ownership checks must not acquire another pool connection')
          return (await client.query('SELECT id FROM agents WHERE "userId"=$1 AND id=ANY($2::uuid[])', [userId, ids])).rows.map(row => row.id)
        },
      })
      try {
        const created = await handleGroup(small,scopedDirectory,{...req,body:JSON.stringify({workspaceId,title:'Small pool',members:[{memberType:'agent',memberId:agentId}]})})
        assert.equal(created.status,201)
        const id=(created.body as {id:string}).id
        const replies=await Promise.all(Array.from({length:8},(_,i)=>handleGroup(small,scopedDirectory,{...req,id,resource:'messages',body:JSON.stringify({body:`concurrent ${i}`,mentions:[{memberType:'agent',memberId:agentId}]})})))
        assert.ok(replies.every(response=>response.status===201))
        const members=await handleGroup(small,scopedDirectory,{...req,id,resource:'members',method:'GET'})
        assert.equal(members.status,200)
        assert.ok(!JSON.stringify(members.body).includes('PRIVATE_ROLE_SENTINEL'))
      } finally { await small.end() }
    })
    await t.test('member may address shared Agent, but cannot enumerate or grant another owner’s private Agent', async () => {
      assert.equal(await directory(workspaceId,'member',[{memberType:'agent',memberId:agentId}]),false)
      await assert.rejects(command({action:'grant',agentId:privateAgent},'member'),failure('not_found'))
      await command({action:'grant',agentId:memberAgent},'member')
      const work = await send('hello shared owner Agent')
      await dispatch(work.id)
      assert.equal((await reply(work)).status,'completed')
      const memberWork = await send('hello member Agent',memberAgent,'owner')
      await dispatch(memberWork.id)
      assert.equal((await reply(memberWork)).status,'completed')
    })
    await t.test('cross-group, workspace, private Artifact and forged authors are rejected', async () => {
      const other = await createGroup()
      await assert.rejects(artifact({action:'create',title:'unshared',mediaType:'text/plain',currentAgentId:memberAgent,content:'x'},'owner',other),failure('agent_grant_required'))
      assert.equal((await group({id:other,resource:'messages',body:JSON.stringify({body:'cross-group mention',mentions:[{memberType:'agent',memberId:memberAgent}]})})).status,422)
      await assert.rejects(command({action:'revoke',agentId},'member'),failure('forbidden'))
      assert.equal((await group({ id:conversationId,resource:'messages',userId:'outsider',body:'{"body":"x"}' })).status,404)
      assert.equal((await group({ id:conversationId,resource:'messages',body:JSON.stringify({body:'x',authorType:'agent',authorId:agentId}) })).status,422)
      assert.equal((await group({ body:JSON.stringify({workspaceId:otherWorkspace,title:'foreign'}) })).status,404)
      const msg = await group({id:other,resource:'messages',body:'{"body":"other group"}'})
      assert.equal((await group({id:conversationId,resource:'messages',body:JSON.stringify({body:'x',replyToId:(msg.body as {id:string}).id})})).status,422)
      assert.equal((await group({id:conversationId,resource:'messages',body:JSON.stringify({body:'x',mentions:[{memberType:'agent',memberId:privateAgent}]})})).status,422)
      const made = await artifact({action:'create',title:'Plan',mediaType:'text/markdown',currentAgentId:agentId,content:'hello world!'}) as {artifactId:string;version:{id:string;hash:string}}
      artifactId=made.artifactId;version=made.version
      await assert.rejects(artifact({action:'read',artifactId},'outsider'),failure('not_found'))
      await assert.rejects(artifact({action:'read',artifactId},'owner',other),failure('not_found'))
      await assert.rejects(artifact({action:'create',title:'x',mediaType:'text/html',currentAgentId:privateAgent,content:'x'}),failure('agent_grant_required'))
    })
    await t.test('client retry and concurrent dispatch create one work intent and one transport input', async () => {
      const key=randomUUID(),body={body:'retry me',clientMessageId:key,mentions:[{memberType:'agent',memberId:agentId},{memberType:'agent',memberId:agentId}]}
      const results=await Promise.all(Array.from({length:10},()=>group({id:conversationId,resource:'messages',body:JSON.stringify(body)})))
      assert.equal(results.filter(r=>r.status===201).length,1)
      assert.equal(new Set(results.map(r=>(r.body as {id:string}).id)).size,1)
      const messageId=(results[0].body as {id:string}).id
      const works=(await pool.query('SELECT * FROM conversation_work WHERE "triggerMessageId"=$1',[messageId])).rows
      assert.equal(works.length,1)
      await Promise.all(Array.from({length:10},()=>dispatch(works[0].id)))
      assert.equal(prepared.filter(id=>id===works[0].id).length,1)
      assert.equal((await pool.query('SELECT count(*) FROM run_messages WHERE "runId"=$1',[works[0].id])).rows[0].count,'1')
      assert.equal((await group({id:conversationId,resource:'messages',body:JSON.stringify({...body,body:'changed'})})).status,409)
      await assert.rejects(completeReviewWork(pool,directory,adapter,randomUUID(),{workId:works[0].id,triggerMessageId:messageId,body:'spoof'}),failure('runtime_binding_mismatch'))
      await assert.rejects(reply(works[0],{triggerMessageId:randomUUID()}),failure('runtime_binding_mismatch'))
      await reply(works[0]);await reply(works[0])
      assert.equal((await pool.query('SELECT count(*) FROM conversation_messages WHERE "replyToId"=$1',[messageId])).rows[0].count,'1')
      assert.equal((await pool.query('SELECT count(*) FROM conversation_work WHERE "triggerMessageId" IN (SELECT id FROM conversation_messages WHERE "authorType"=\'agent\')')).rows[0].count,'0')
      const data=(await pool.query('SELECT text FROM run_messages WHERE "runId"=$1',[works[0].id])).rows[0].text
      assert.ok(!data.includes('PRIVATE_ROLE_SENTINEL'))
      assert.ok(!data.includes('other group'))
    })
    await t.test('save comment does not dispatch; explicit send snapshots exact version and thread', async () => {
      const before=(await pool.query('SELECT count(*) FROM conversation_work')).rows[0].count
      const created=await artifact({action:'thread',artifactId,baseVersionId:version.id,baseHash:version.hash,body:'Change this word',anchor:{kind:'source-range',start:6,end:11,quote:'world',prefix:'hello ',suffix:'!'}}) as {threadId:string}
      threadId=created.threadId
      await artifact({action:'comment',artifactId,threadId,body:'Please explain first'},'member')
      assert.equal((await pool.query('SELECT count(*) FROM conversation_work')).rows[0].count,before)
      const requestId=randomUUID(),input={action:'send',artifactId,threadId,baseVersionId:version.id,baseHash:version.hash,requestId}
      const sends=await Promise.all([artifact(input),artifact(input)]) as {workId:string}[]
      assert.equal(sends[0].workId,sends[1].workId)
      requestWork=(await pool.query('SELECT * FROM conversation_work WHERE id=$1',[sends[0].workId])).rows[0]
      await dispatch(requestWork.id)
      const data=JSON.parse((await pool.query('SELECT text FROM run_messages WHERE "runId"=$1',[requestWork.id])).rows[0].text)
      assert.equal(data.untrustedData.artifact.content,'hello world!')
      assert.equal(data.untrustedData.artifact.hash,version.hash)
      await assert.rejects(reply(requestWork,{proposal:{artifactId:randomUUID(),baseVersionId:version.id,baseHash:version.hash,content:'x'}}),failure('proposal_binding_mismatch'))
    })
    await t.test('Agent proposal persists immutable version; completion is not human acceptance', async () => {
      const result=await reply(requestWork,{proposal:{artifactId,baseVersionId:version.id,baseHash:version.hash,content:'hello humans!'}})
      assert.equal(result.status,'completed')
      const read=await artifact({action:'read',artifactId}) as {artifact:{headVersionId:string;acceptedVersionId:null};versions:{id:string;hash:string}[];threads:{anchorStatus:string}[]}
      assert.equal(read.artifact.acceptedVersionId,null)
      assert.equal(read.threads[0].anchorStatus,'outdated')
      assert.equal(read.versions.length,2)
      const next=read.versions.find(v=>v.id===read.artifact.headVersionId)!
      await assert.rejects(artifact({action:'accept',artifactId,baseVersionId:next.id,baseHash:version.hash}),failure('version_hash_conflict'))
      await assert.rejects(artifact({action:'accept',artifactId,baseVersionId:version.id,baseHash:version.hash}),failure('version_conflict'))
      await artifact({action:'accept',artifactId,baseVersionId:next.id,baseHash:next.hash},'member')
      assert.equal((await pool.query('SELECT "acceptedVersionId" FROM artifacts WHERE id=$1',[artifactId])).rows[0].acceptedVersionId,next.id)
      assert.equal((await pool.query('SELECT "userId" FROM artifact_acceptances WHERE "artifactId"=$1',[artifactId])).rows[0].userId,'member')
      await assert.rejects(pool.query('UPDATE artifact_versions SET content=\'mutated\' WHERE id=$1',[version.id]),/immutable/)
      await assert.rejects(pool.query('DELETE FROM artifact_versions WHERE id=$1',[next.id]),/immutable/)
      version=next
    })
    await t.test('stale/orphaned anchors never silently move or become sendable', async () => {
      await assert.rejects(artifact({action:'send',artifactId,threadId,baseVersionId:version.id,baseHash:version.hash,requestId:randomUUID()}),failure('anchor_outdated_or_orphaned'))
      const bad=await artifact({action:'thread',artifactId,baseVersionId:version.id,baseHash:version.hash,body:'orphan',anchor:{kind:'source-range',start:0,end:5,quote:'WRONG',prefix:'',suffix:''}}) as {threadId:string;anchorStatus:string}
      assert.equal(bad.anchorStatus,'orphaned')
      await assert.rejects(artifact({action:'send',artifactId,threadId:bad.threadId,baseVersionId:version.id,baseHash:version.hash,requestId:randomUUID()}),failure('anchor_outdated_or_orphaned'))
    })
    await t.test('concurrent proposals preserve loser as visible conflict without overwriting head', async () => {
      const thread=await artifact({action:'thread',artifactId,baseVersionId:version.id,baseHash:version.hash,body:'change',anchor:{kind:'source-range',start:0,end:5,quote:'hello',prefix:'',suffix:' humans!'}}) as {threadId:string}
      const works=[]
      for(let i=0;i<2;i++) {
        const sent=await artifact({action:'send',artifactId,threadId:thread.threadId,baseVersionId:version.id,baseHash:version.hash,requestId:randomUUID()}) as {workId:string}
        works.push((await pool.query('SELECT * FROM conversation_work WHERE id=$1',[sent.workId])).rows[0]);await dispatch(sent.workId)
      }
      const results=await Promise.all(works.map((w,i)=>reply(w,{proposal:{artifactId,baseVersionId:version.id,baseHash:version.hash,content:`candidate ${i}`}})))
      assert.deepEqual(results.map(r=>r.status).sort(),['completed','conflict'])
      const winner=results.find(r=>r.status==='completed')! as {version:{id:string;hash:string}}
      assert.equal((await pool.query('SELECT "headVersionId" FROM artifacts WHERE id=$1',[artifactId])).rows[0].headVersionId,winner.version!.id)
      const loser=results.find(r=>r.status==='conflict')! as {version:{id:string;hash:string}}
      assert.equal((await pool.query('SELECT hash FROM artifact_versions WHERE id=$1',[loser.version!.id])).rows[0].hash,loser.version!.hash)
      assert.equal((await pool.query('SELECT "acceptedVersionId" FROM artifacts WHERE id=$1',[artifactId])).rows[0].acceptedVersionId,version.id)
    })
    await t.test('runtime enqueue rolls back completely on failure, then safely replays', async () => {
      const work=await send('transaction rollback')
      const broken=runMessagesAdapter(async(client,input)=>{
        await client.query(`INSERT INTO agent_runs (id,"agentId","userId",kind) VALUES ($1,$2,$3,'group_review')`,[input.runId,input.agentId,input.ownerId]);throw new Error('simulated crash')
      })
      await assert.rejects(dispatchReviewWork(pool,directory,broken,work.id),/simulated crash/)
      assert.equal((await pool.query('SELECT status FROM conversation_work WHERE id=$1',[work.id])).rows[0].status,'pending')
      assert.equal((await pool.query('SELECT 1 FROM agent_runs WHERE id=$1',[work.id])).rowCount,0)
      const privateContext=runMessagesAdapter(async(client,input)=>{
        await client.query(`INSERT INTO agent_runs (id,"agentId","userId",kind,prompt) VALUES ($1,$2,$3,'implement','PRIVATE_HISTORY')`,[input.runId,input.agentId,input.ownerId])
      })
      await assert.rejects(dispatchReviewWork(pool,directory,privateContext,work.id),failure('isolated_runtime_required'))
      assert.equal((await pool.query('SELECT 1 FROM agent_runs WHERE id=$1',[work.id])).rowCount,0)
      await dispatch(work.id);assert.equal((await reply(work)).status,'completed')
    })
    await t.test('cancellation, stop, grant revocation/regrant and member suspension reject late writes', async () => {
      const cancelled=await send('cancel');await dispatch(cancelled.id)
      await command({action:'cancel',workId:cancelled.id},'member')
      await assert.rejects(reply(cancelled),failure('work_not_live'))
      assert.equal((await pool.query('SELECT 1 FROM run_messages WHERE "runId"=$1',[cancelled.id])).rowCount,0)
      assert.ok((await pool.query('SELECT "stopRequestedAt" FROM agent_runs WHERE id=$1',[cancelled.id])).rows[0].stopRequestedAt)
      const stopped=await send('stop');await dispatch(stopped.id)
      await pool.query('UPDATE agent_runs SET "stopRequestedAt"=now() WHERE id=$1',[stopped.id])
      assert.equal((await reply(stopped)).status,'cancelled')
      const revoked=await send('revoke');await dispatch(revoked.id)
      await command({action:'revoke',agentId});await command({action:'grant',agentId})
      await assert.rejects(reply(revoked),failure('work_not_live'))
      const suspended=await send('suspend');await dispatch(suspended.id)
      active.delete('member')
      assert.equal((await reply(suspended)).status,'cancelled')
      await assert.rejects(artifact({action:'read',artifactId},'member'),failure('not_found'))
      active.add('member')
      const ownerSuspended=await send('owner suspension');await dispatch(ownerSuspended.id)
      active.delete('owner');assert.equal((await reply(ownerSuspended)).status,'cancelled');active.add('owner')
      const removed=await send('removed');await dispatch(removed.id)
      const ownerDeparture=await send('Agent owner removed',memberAgent,'owner');await dispatch(ownerDeparture.id)
      assert.equal((await group({id:conversationId,resource:'members',method:'DELETE',body:'{"memberType":"user","memberId":"member"}'})).status,200)
      await assert.rejects(reply(removed),failure('work_not_live'))
      await assert.rejects(reply(ownerDeparture),failure('runtime_binding_mismatch'))
      assert.equal((await pool.query('SELECT 1 FROM agent_runs WHERE id=$1',[ownerDeparture.id])).rowCount,0)
      assert.equal((await pool.query('SELECT 1 FROM run_messages WHERE "runId"=$1',[ownerDeparture.id])).rowCount,0)
      assert.equal((await group({id:conversationId,resource:'members',method:'POST',body:'{"memberType":"user","memberId":"member"}'})).status,200)
      await assert.rejects(reply(removed),failure('work_not_live'))
    })
    await t.test('revocation and removal commit while dispatch/reply wait on the group lock', async () => {
      const waitForGroupLock = async () => {
        for(let i=0;i<100;i++) {
          const wait = await pool.query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM conversations WHERE id=%'`)
          if(wait.rowCount) return true
          await new Promise(resolve=>setTimeout(resolve,10))
        }
        return false
      }
      const pending=await send('race revoke')
      const revocation=await pool.connect()
      await revocation.query('BEGIN')
      await revocation.query('SELECT id FROM conversations WHERE id=$1 FOR UPDATE',[conversationId])
      await revocation.query('UPDATE conversation_agent_grants SET "revokedAt"=now() WHERE "conversationId"=$1 AND "agentId"=$2 AND "revokedAt" IS NULL',[conversationId,agentId])
      const waitingDispatch=dispatch(pending.id)
      let waited=false
      try { waited=await waitForGroupLock() } finally { await revocation.query('COMMIT');revocation.release() }
      assert.equal(waited,true)
      assert.equal((await waitingDispatch).status,'cancelled')
      assert.equal(prepared.includes(pending.id),false)
      await command({action:'grant',agentId})
      const work=await send('race removal');await dispatch(work.id)
      const removal=await pool.connect()
      await removal.query('BEGIN')
      await removal.query('SELECT id FROM conversations WHERE id=$1 FOR UPDATE',[conversationId])
      await removal.query(`UPDATE conversation_members SET "leftAt"=now() WHERE "conversationId"=$1 AND "memberType"='user' AND "memberId"='member'`,[conversationId])
      const waitingReply=reply(work)
      try { waited=await waitForGroupLock() } finally { await removal.query('COMMIT');removal.release() }
      assert.equal(waited,true)
      assert.equal((await waitingReply).status,'cancelled')
      assert.equal((await pool.query('SELECT 1 FROM conversation_messages WHERE "replyToId"=$1',[work.triggerMessageId])).rowCount,0)
      await group({id:conversationId,resource:'members',method:'POST',body:'{"memberType":"user","memberId":"member"}'})
      // Even a stale dispatcher that missed cancellation cannot revive a run
      // after an agent membership was replaced under an unchanged grant.
      const epoch=await send('epoch changed');await dispatch(epoch.id)
      await pool.query(`UPDATE conversation_members SET "joinedAt"="joinedAt"+interval '1 second' WHERE "conversationId"=$1 AND "memberType"='agent' AND "memberId"=$2`,[conversationId,agentId])
      assert.equal((await reply(epoch)).status,'cancelled')
    })
    await t.test('a stop committed while reply validation waits prevents the late write', async () => {
      const work=await send('concurrent stop');await dispatch(work.id)
      const stop=await pool.connect()
      await stop.query('BEGIN')
      await stop.query('UPDATE agent_runs SET "stopRequestedAt"=now() WHERE id=$1',[work.id])
      const waitingReply=reply(work)
      let waited=false
      try {
        for(let i=0;i<100&&!waited;i++) {
          const blocked=await pool.query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT 1 FROM agent_runs WHERE id=%'`)
          waited=Boolean(blocked.rowCount)
          if(!waited) await new Promise(resolve=>setTimeout(resolve,10))
        }
      } finally { await stop.query('COMMIT');stop.release() }
      assert.equal(waited,true,'runtime validation actually waited for the stop transaction')
      assert.equal((await waitingReply).status,'cancelled')
      assert.equal((await pool.query('SELECT 1 FROM conversation_messages WHERE "replyToId"=$1',[work.triggerMessageId])).rowCount,0)
    })
    await t.test('pending work revoked before dispatch never wakes runtime; Agent replies cannot forge browser approval', async () => {
      const work=await send('pending revoke')
      await command({action:'revoke',agentId})
      assert.equal((await dispatch(work.id)).status,'cancelled')
      assert.equal(prepared.includes(work.id),false)
      await assert.rejects(artifact({action:'accept',artifactId,baseVersionId:version.id,baseHash:version.hash,authorType:'agent'}),failure('invalid_input'))
      assert.equal(contentHash('hello world!').length,64)
    })
  } finally {
    await pool.end();if(!process.env.KEEP_GROUP_TEST_FIXTURES)await root.query(`DROP SCHEMA "${schema}" CASCADE`);await root.end()
  }
})
