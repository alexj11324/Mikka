// Full application migrations on a disposable PostgreSQL database. GitHub is
// the external boundary; share ownership, receipts and report writes are real.
import 'next/dist/server/node-environment-baseline'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import test from 'node:test'
import { Pool, type PoolClient } from 'pg'
import { orderMigrations } from '../../scripts/migration-order.mjs'
import { dropTestDatabase } from '../../tests/support/drop-test-database'
import { factoryEventId } from '../factory/event-id'
import { syncFactoryPresentation } from '../factory/stage-progress'
import { readFactoryFlow } from '../factory/public-flow'
import type { FactoryTask } from '../factory/store'
import { loadIssueDocument, readIssueThreads } from '../linear-sync/document'
import { openRunPullRequest } from '../github/run-pull-request'
import { PublicationError } from '../run-publication-result'
import { observePoolCommits } from '../db/commit-effects'
import { coordinatorWakeTransport } from '../coordinator/wake-after-commit'
import { assertFactoryPublicationEvidence, factoryPublicationEvidenceReady, prepareFactoryPublicationEvidence, withFactoryPublicationEvidence } from './publication'
import { publicCaptureToken } from './publication-contract'
import { seedWorkspace } from '../../tests/support/workspace-admin-db'

const connection = process.env.E2E_DATABASE_URL
if (connection) {
  const target = new URL(connection)
  assert.ok(['127.0.0.1','localhost','[::1]'].includes(target.hostname), 'loopback only')
  assert.match(target.pathname, /^\/[a-z0-9_]+_e2e$/, 'database name must end in _e2e')
} else if (process.env.REQUIRE_DB === '1') assert.fail('REQUIRE_DB=1 needs E2E_DATABASE_URL')

const origin = 'https://evidence.example.invalid'
const sha = 'a'.repeat(40)
const refusal = (error: unknown) => error instanceof PublicationError && error.code === 'factory_public_evidence_required'
type Fixture = { taskId: string; candidateId: string; attemptId: string; issueId: string; runId: string; captureId: string; sourceEventId: string; userId: string; sha: string }

test('Factory public capture receipts bind the current producer and the acknowledged PR body', { skip: !connection, timeout: 120_000 }, async t => {
  const admin = new Pool({ connectionString: connection, max: 1 })
  const database = `capture_publish_${randomUUID().replaceAll('-','')}_e2e`
  await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`)
  const target = new URL(connection!)
  target.pathname = `/${database}`
  const pool = new Pool({ connectionString: target.href, max: 8 })
  observePoolCommits(pool)
  const savedOrigin = process.env.BETTER_AUTH_URL
  const savedWake = coordinatorWakeTransport.wake
  coordinatorWakeTransport.wake = async () => undefined
  process.env.BETTER_AUTH_URL = origin
  const inTransaction = async <T>(write: (tx: PoolClient) => Promise<T>): Promise<T> => {
    const tx = await pool.connect()
    try { await tx.query('BEGIN'); const result = await write(tx); await tx.query('COMMIT'); return result }
    catch (error) { await tx.query('ROLLBACK'); throw error }
    finally { tx.release() }
  }
  try {
    const dir = new URL('../../drizzle/', import.meta.url)
    for (const file of orderMigrations((await readdir(dir)).filter(file => file.endsWith('.sql'))))
      await pool.query(await readFile(new URL(file, dir), 'utf8'))
    const userId = 'capture-publication-owner', deviceId = randomUUID(), agentId = randomUUID(), botId = randomUUID()
    await pool.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,'Fixture','capture-publication@example.invalid',true,now(),now())`, [userId])
    await pool.query(`INSERT INTO devices(id,"ownerId",name) VALUES($1,$2,'Fixture computer')`, [deviceId,userId])
    await pool.query(`INSERT INTO agents(id,"userId","deviceId",name,harness) VALUES($1,$2,$3,'Fixture agent','codex')`, [agentId,userId,deviceId])
    const workspace = await seedWorkspace(pool,userId,[{userId,role:'admin'}])
    await pool.query(`INSERT INTO bots(id,"ownerId","workspaceId",name) VALUES($1,$2,$3,'Factory')`, [botId,userId,workspace.id])
    const videoBytes = await readFile(new URL('../../tests/fixtures/factory-visual-evidence.mp4', import.meta.url))
    const fixture = async (declaration: 'safe' | 'missing' | 'false' = 'safe'): Promise<Fixture> => {
      const f: Fixture = { taskId:randomUUID(),candidateId:randomUUID(),attemptId:randomUUID(),issueId:randomUUID(),runId:randomUUID(),captureId:randomUUID(),sourceEventId:randomUUID(),userId,sha }
      // Playable synthetic media; this fixture proves provenance and delivery,
      // not a claim that its pixels were recorded from a live user application.
      const bytes = videoBytes
      const report = { summary:'Verified the backend response in the running terminal', filesChanged:['lib/backend.ts'],
        verify:{status:'passed',command:'node --test',output:'1 test passed'},
        criteria:[{text:'The real request succeeds',passed:true,evidence:`run-capture:${f.captureId}`}],
        ...(declaration === 'missing' ? {} : {visualEvidence:[{captureId:f.captureId,publicSafe:declaration === 'safe'}]}) }
      await inTransaction(async tx => {
        await tx.query(`INSERT INTO issues(id,"userId",title,content,status,priority,"workspaceId") VALUES($1,$2,'Backend evidence','{"type":"doc","content":[]}','todo','normal',$3)`, [f.issueId,userId,workspace.id])
        await tx.query(`INSERT INTO agent_runs(id,"userId","issueId","agentId","deviceId",status,"stopReason","sessionId",prompt,report,"startedAt","finishedAt")
          VALUES($1,$2,$3,$4,$5,'succeeded','submitted','fixture-session','Verify backend',$6,now()-interval '1 minute',now())`, [f.runId,userId,f.issueId,agentId,deviceId,JSON.stringify(report)])
        await tx.query(`INSERT INTO factory_tasks(id,"userId","issueId","sourceEventId","botId",route,stage,status,"attemptId",reason)
          VALUES($1,$2,$3,$4,$5,'{"flowVersion":2}','execute','passed',$6,'Implementation completed')`, [f.taskId,userId,f.issueId,f.sourceEventId,botId,f.attemptId])
        await tx.query(`INSERT INTO factory_candidates(id,"taskId",sha,repository,environment,scope,"runId") VALUES($1,$2,$3,'v2/github.com/owner/repo','fixture','fixture',$4)`, [f.candidateId,f.taskId,sha,f.runId])
        await tx.query(`INSERT INTO factory_attempts(id,"taskId",stage,ordinal,position,status,"candidateId","runId","sessionId",reason,"finishedAt")
          VALUES($1,$2,'execute',1,1,'passed',$3,$4,'fixture-session','Implementation completed',now())`, [f.attemptId,f.taskId,f.candidateId,f.runId])
        await tx.query('UPDATE factory_tasks SET "candidateId"=$2 WHERE id=$1', [f.taskId,f.candidateId])
        await tx.query(`INSERT INTO run_captures(id,"userId","issueId","runId",kind,"contentType",source,status,title,"storageKey","inlineContent",size,sha256,"durationMs")
          VALUES($1,$2,$3,$4,'video','video/mp4','local','ready','Backend request recording',$5,$6,$7,$8,200)`,
        [f.captureId,userId,f.issueId,f.runId,`fixture/${f.captureId}.mp4`,bytes,bytes.length,createHash('sha256').update(bytes).digest('hex')])
        await tx.query(`INSERT INTO run_publications("runId","userId","issueId","remoteUrl","remoteKey",branch,status) VALUES($1,$2,$3,'https://github.com/owner/repo.git','v2/github.com/owner/repo','mikka/mik-42','pending')`, [f.runId,userId,f.issueId])
      })
      return f
    }
    const task = async (f: Fixture) => (await pool.query<FactoryTask>('SELECT * FROM factory_tasks WHERE id=$1', [f.taskId])).rows[0]
    const shareCount = async (f: Fixture) => Number((await pool.query('SELECT count(*) FROM run_capture_shares WHERE "captureId"=$1', [f.captureId])).rows[0].count)
    const prepare = (f: Fixture) => prepareFactoryPublicationEvidence(pool, f, origin)

    await t.test('a ready private capture requires an explicit safe-to-share declaration', async () => {
      for (const declaration of ['missing','false'] as const) {
        const f = await fixture(declaration)
        await assert.rejects(prepare(f), refusal)
        assert.equal(await shareCount(f), 0)
        assert.equal((await pool.query('SELECT count(*) FROM factory_events WHERE "taskId"=$1', [f.taskId])).rows[0].count, '0')
        await assert.rejects(assertFactoryPublicationEvidence(pool, await task(f)), refusal)
      }
    })

    await t.test('simultaneous preparation and ambiguous retries reuse one existing share receipt', async () => {
      const f = await fixture()
      const [first, second] = await Promise.all([prepare(f),prepare(f)])
      assert.deepEqual(second, first)
      assert.deepEqual(await prepare(f), first)
      assert.equal(await shareCount(f), 1)
      const share = (await pool.query('SELECT * FROM run_capture_shares WHERE "captureId"=$1', [f.captureId])).rows[0]
      assert.equal(share.tokenHash, createHash('sha256').update(publicCaptureToken(first.captures[0].url)!).digest('hex'))
      assert.equal(Object.hasOwn(share, 'token'), false, 'existing share storage still contains only a hash')
      assert.equal(share.createdBy, f.userId)
      assert.equal(await factoryPublicationEvidenceReady(pool, await task(f)), false, 'a prepared share is not an acknowledged PR')
      assert.equal((await pool.query(`SELECT count(*) FROM factory_events WHERE "taskId"=$1 AND request->>'kind'='pr_visual_evidence'`, [f.taskId])).rows[0].count, '1')
    })

    await t.test('wrong owner, run, candidate, commit, missing capture and arbitrary declarations fail closed', async () => {
      const current = await fixture(), foreign = await fixture()
      await assert.rejects(prepare({...current,userId:'different-owner'}), refusal)
      await assert.rejects(prepare({...current,runId:foreign.runId}), refusal)
      await assert.rejects(prepare({...current,sha:'b'.repeat(40)}), refusal)
      for (const declaration of [
        [{captureId:foreign.captureId,publicSafe:true}], [{captureId:randomUUID(),publicSafe:true}],
        [{captureId:current.captureId,publicSafe:true,url:'https://external.invalid/unrelated.mp4'}],
        [{captureId:current.captureId,publicSafe:true},{captureId:current.captureId,publicSafe:true}],
      ]) {
        await pool.query(`UPDATE agent_runs SET report=jsonb_set(report,'{visualEvidence}',$2::jsonb) WHERE id=$1`, [current.runId,JSON.stringify(declaration)])
        await assert.rejects(prepare(current), refusal)
      }
      assert.equal(await shareCount(current), 0)
      assert.equal(await shareCount(foreign), 0, 'another run remains private')
      await pool.query(`UPDATE agent_runs SET report=jsonb_set(report,'{visualEvidence}',$2::jsonb) WHERE id=$1`, [current.runId,JSON.stringify([{captureId:current.captureId,publicSafe:true}])])
      await pool.query(`UPDATE run_captures SET status='failed' WHERE id=$1`, [current.captureId])
      await assert.rejects(prepare(current), refusal)
    })

    await t.test('a conflicting capture issue blocks preparation, saved receipt replay and the GitHub write', async () => {
      const current = await fixture(), foreign = await fixture()
      await pool.query('UPDATE run_captures SET "issueId"=$2 WHERE id=$1',[current.captureId,foreign.issueId])
      await assert.rejects(prepare(current),refusal)
      assert.equal(await shareCount(current),0,'preparation cannot share a capture naming another issue')
      assert.equal((await pool.query('SELECT count(*) FROM factory_events WHERE "taskId"=$1',[current.taskId])).rows[0].count,'0')
      await pool.query('UPDATE run_captures SET "issueId"=$2 WHERE id=$1',[current.captureId,current.issueId])
      const receipt = await prepare(current)
      await pool.query(`UPDATE run_publications SET status='published',"pullRequest"=$2 WHERE "runId"=$1`,
        [current.runId,JSON.stringify({url:'https://github.com/owner/repo/pull/77',evidenceDigest:receipt.digest})])
      assert.equal(await factoryPublicationEvidenceReady(pool,await task(current)),true)
      await pool.query('UPDATE run_captures SET "issueId"=$2 WHERE id=$1',[current.captureId,foreign.issueId])
      await assert.rejects(prepare(current),refusal,'a saved receipt does not waive the current capture issue check')
      let written = false
      await assert.rejects(withFactoryPublicationEvidence(pool,receipt,async()=>{written=true}),refusal)
      assert.equal(written,false)
      assert.equal(await factoryPublicationEvidenceReady(pool,await task(current)),false)
      assert.equal(await shareCount(current),1,'refusal neither issues another share nor rewrites the old receipt')
      // NULL is the existing legacy representation: the authenticated producer
      // run still supplies its issue. A conflicting explicit binding is denied.
      await pool.query('UPDATE run_captures SET "issueId"=NULL WHERE id=$1',[current.captureId])
      assert.deepEqual(await prepare(current),receipt)
      assert.equal(await factoryPublicationEvidenceReady(pool,await task(current)),true)
    })

    await t.test('revocation is serialized with GitHub writes and is never silently reissued', async () => {
      const f = await fixture(), receipt = await prepare(f)
      let enter!: () => void, release!: () => void
      const entered = new Promise<void>(resolve => { enter=resolve })
      const released = new Promise<void>(resolve => { release=resolve })
      const write = withFactoryPublicationEvidence(pool,receipt,async () => { enter(); await released; return 'written' })
      await entered
      try {
        await assert.rejects(inTransaction(async tx => {
          await tx.query("SET LOCAL lock_timeout='50ms'")
          await tx.query('UPDATE run_capture_shares SET "revokedAt"=now() WHERE "captureId"=$1', [f.captureId])
        }), {code:'55P03'})
      } finally { release() }
      assert.equal(await write, 'written')
      await pool.query('UPDATE run_capture_shares SET "revokedAt"=now() WHERE "captureId"=$1', [f.captureId])
      await assert.rejects(prepare(f), refusal)
      let called = false
      await assert.rejects(withFactoryPublicationEvidence(pool,receipt,async () => { called=true }), refusal)
      assert.equal(called, false)
      assert.equal(await shareCount(f), 1)
      assert.equal(await factoryPublicationEvidenceReady(pool, await task(f)), false)
    })

    await t.test('watchdog recovery requires the exact existing owner completion receipt', async () => {
      const f = await fixture()
      await pool.query(`UPDATE factory_attempts SET status='blocked',"candidateId"=null,output=$2 WHERE id=$1`, [f.attemptId,JSON.stringify({requestEpoch:f.sourceEventId,watchdog:{reasonCode:'recovery_exhausted',requestEpoch:f.sourceEventId}})])
      await assert.rejects(prepare(f), refusal)
      const completedTask = {id:f.taskId,userId:f.userId,issueId:f.issueId,sourceEventId:f.sourceEventId,candidateId:f.candidateId,attemptId:f.attemptId,stage:'execute',status:'passed'}
      await pool.query('INSERT INTO factory_events("taskId","eventId",request,result) VALUES($1,$2,$3,$4)', [f.taskId,randomUUID(),
        JSON.stringify({kind:'owner_completion_recovery',sourceEventId:f.sourceEventId,attemptId:f.attemptId,runId:f.runId,input:{binding:{taskId:f.taskId,revision:1},change:{action:'retry'}}}),
        JSON.stringify({task:{...completedTask,stage:'review',status:'pending'}})])
      await pool.query('INSERT INTO factory_events("taskId","eventId",request,result) VALUES($1,$2,$3,$4)', [f.taskId,factoryEventId('run-completion',f.runId),
        JSON.stringify({binding:{taskId:f.taskId,revision:2},change:{action:'finish',status:'passed',output:{runId:f.runId},evidence:[]}}),JSON.stringify({task:completedTask})])
      const receipt = await prepare(f)
      assert.equal(receipt.candidateId,f.candidateId)
      assert.equal(receipt.runId,f.runId)
      await pool.query(`UPDATE factory_events SET result=jsonb_set(result,'{task,candidateId}',$2::jsonb) WHERE "taskId"=$1 AND request->>'kind'='owner_completion_recovery'`, [f.taskId,JSON.stringify(randomUUID())])
      await assert.rejects(prepare(f), refusal)
      assert.equal(await shareCount(f), 1)
    })

    await t.test('a video appears in the acknowledged PR, the versioned Artifact and the same task conversation', async () => {
      const f = await fixture(), receipt = await prepare(f)
      let prBody = '', writes = 0
      const branch = 'mikka/mik-42', marker = `<!-- mikka-issue:${f.issueId} -->`
      const observedPr = () => ({number:77,html_url:'https://github.com/owner/repo/pull/77',state:'open',draft:false,merged_at:null,body:prBody,
        head:{ref:branch,sha,repo:{id:789}},base:{repo:{id:789}}})
      const github = (async (url: string | URL | Request, init?: RequestInit) => {
        const path = new URL(String(url)).pathname
        if (path === '/user') return Response.json({id:456,login:'owner'})
        if (path === '/repos/owner/repo') return Response.json({id:789,full_name:'owner/repo',default_branch:'main'})
        if (path.endsWith('/git/ref/heads/mikka/mik-42')) return Response.json({object:{sha}})
        if (path.endsWith('/pulls/77')) return Response.json(observedPr())
        if (path.endsWith('/pulls') && (!init?.method || init.method === 'GET')) return Response.json([])
        if (path.endsWith('/pulls') && init?.method === 'POST') {
          const body = JSON.parse(String(init.body)); prBody=body.body; writes++
          return Response.json(observedPr(),{status:201})
        }
        throw new Error(`Unexpected GitHub fixture request ${path}`)
      }) as typeof fetch
      const pr = await openRunPullRequest({remoteKey:'v2/github.com/owner/repo',githubAccountId:'456',token:'synthetic-fixture',issueId:f.issueId,
        identifier:'MIK-42',title:'Backend evidence',summary:'The terminal shows a real request.',branch,commit:sha,baseBranch:null,
        visualEvidence:receipt,fetcher:github,withWrite:write => withFactoryPublicationEvidence(pool,receipt,write)})
      assert.equal(writes,1)
      assert.equal(pr.evidenceDigest,receipt.digest)
      assert.ok(prBody.includes(receipt.captures[0].url))
      assert.ok(prBody.endsWith(marker))
      assert.ok(!prBody.includes(`/api/captures/${f.captureId}`), 'PR contains only the public share link')
      await pool.query(`UPDATE run_publications SET status='published',"pullRequest"=$2 WHERE "runId"=$1`, [f.runId,JSON.stringify(pr)])
      assert.equal(await factoryPublicationEvidenceReady(pool,await task(f)),true)
      const approvalId=randomUUID()
      await inTransaction(async tx => {
        await tx.query(`INSERT INTO factory_attempts(id,"taskId",stage,ordinal,position,status,"candidateId",reason) VALUES($1,$2,'approval',1,2,'pending',$3,'Human review')`, [approvalId,f.taskId,f.candidateId])
        await tx.query(`UPDATE factory_tasks SET stage='approval',status='pending',"attemptId"=$2 WHERE id=$1`, [f.taskId,approvalId])
        const saved=(await tx.query<FactoryTask>('SELECT * FROM factory_tasks WHERE id=$1',[f.taskId])).rows[0]
        await syncFactoryPresentation(tx,saved)
      })
      const flow = await readFactoryFlow(pool,await task(f))
      assert.equal(flow.stage,'handoff')
      assert.equal(flow.acceptance?.media.length,1)
      const media=flow.acceptance!.media[0]
      assert.deepEqual({...media,url:undefined,criterion:undefined}, {captureId:f.captureId,kind:'video',title:'Backend request recording',runId:f.runId,
        contentType:'video/mp4',size:videoBytes.length,durationMs:200,candidateId:f.candidateId,appliesToCurrentCandidate:true,url:undefined,criterion:undefined})
      assert.ok(media.url.endsWith(`/api/captures/${receipt.captures[0].captureId}`))
      const artifact=(await pool.query('SELECT "inlineContent" FROM artifact_versions WHERE "artifactId"=$1 AND version=$2',[flow.acceptance!.artifactId,flow.acceptance!.version])).rows[0]
      assert.ok(artifact.inlineContent.includes(media.url))
      assert.ok(artifact.inlineContent.includes(`${pr.url}/files`))
      const savedDocument=(await pool.query('SELECT state FROM issue_documents WHERE "issueId"=$1',[f.issueId])).rows[0]
      const doc=loadIssueDocument(savedDocument.state,{type:'doc',content:[]})
      try {
        const messages=readIssueThreads(doc).flatMap(thread=>thread.messages)
        assert.equal(messages.length,1)
        assert.ok(messages[0].body.includes(media.url))
        assert.ok(messages[0].body.includes(pr.url))
        assert.ok(!messages[0].body.includes('/api/captures/shared/'), 'private conversation uses the original capture')
      } finally { doc.destroy() }
      await inTransaction(async tx=>syncFactoryPresentation(tx,await task(f)))
      assert.equal((await pool.query('SELECT count(*) FROM artifact_versions WHERE "artifactId"=$1',[flow.acceptance!.artifactId])).rows[0].count,'1')
      await pool.query(`UPDATE run_publications SET "pullRequest"="pullRequest"-'evidenceDigest' WHERE "runId"=$1`,[f.runId])
      await assert.rejects(assertFactoryPublicationEvidence(pool,await task(f)),refusal)
    })
  } finally {
    if (savedOrigin===undefined) delete process.env.BETTER_AUTH_URL; else process.env.BETTER_AUTH_URL=savedOrigin
    coordinatorWakeTransport.wake=savedWake
    await dropTestDatabase(admin,database,pool)
    await admin.end()
  }
})
