import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile,readdir } from 'node:fs/promises'
import test from 'node:test'
import { Pool } from 'pg'
import { factory194Target } from '../../tests/helpers/factory194-target'

const connectionString=process.env.E2E_DATABASE_URL

test('tracked public consumer upgrade preserves historical grants and enforces new principal/credential constraints', {skip:!connectionString,timeout:120000},async()=>{
  assert.equal(process.env.CI,'true');assert.equal(process.env.GITHUB_ACTIONS,'true');assert.equal(process.env.REQUIRE_DB,'1')
  const config=factory194Target(connectionString!,true),admin=new Pool({...config,max:1})
  const schema=`factory_public_upgrade_${randomUUID().replaceAll('-','')}`
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool=new Pool({...config,max:2,options:`-c search_path=${schema}`})
  try {
    await pool.query('CREATE TABLE issues(id uuid PRIMARY KEY); CREATE TABLE coordinator_events(id uuid PRIMARY KEY); CREATE TABLE agent_runs(id uuid PRIMARY KEY)')
    const dir=new URL('../../drizzle/',import.meta.url), files=await readdir(dir)
    const sql=async(suffix:string)=>{
      const matches=files.filter(file=>file.endsWith(suffix)).sort()
      assert.ok(matches.length>0,`Missing tracked migration ${suffix}`)
      return readFile(new URL(matches.at(-1)!,dir),'utf8')
    }
    // Deliberately start with the original complete-stack schema, not the new
    // authority fixture. These statements are the unchanged tracked SQL.
    await pool.query(await sql('_factory_192_stages.sql'))
    await pool.query(await sql('_factory_192_questions.sql'))
    await pool.query(await sql('_factory_194_approvals.sql'))
    const task=randomUUID(),issue=randomUUID(),source=randomUUID(),attempt=randomUUID(),candidate=randomUUID(),grant=randomUUID(),event=randomUUID(),read=randomUUID()
    await pool.query('BEGIN')
    await pool.query('INSERT INTO issues VALUES($1)',[issue]);await pool.query('INSERT INTO coordinator_events VALUES($1)',[source])
    await pool.query(`INSERT INTO factory_tasks(id,"userId","issueId","sourceEventId",route,stage,status,"attemptId",reason) VALUES($1,'owner',$2,$3,'{}','approval','pending',$4,'Historical grant')`,[task,issue,source,attempt])
    await pool.query(`INSERT INTO factory_candidates(id,"taskId",sha,repository,environment,scope,"runId") VALUES($1,$2,repeat('a',40),'fixture/repo','fixture','legacy',$3)`,[candidate,task,randomUUID()])
    await pool.query(`INSERT INTO factory_attempts(id,"taskId",stage,ordinal,position,status,"candidateId",reason) VALUES($1,$2,'approval',1,1,'pending',$3,'Historical grant')`,[attempt,task,candidate])
    await pool.query('UPDATE factory_tasks SET "candidateId"=$2 WHERE id=$1',[task,candidate])
    await pool.query(`INSERT INTO factory_evidence_reads(id,"taskId","userId","humanSessionId",binding,"evidenceDigest") VALUES($1,$2,'owner','legacy-session','{}','historical-evidence')`,[read,task])
    await pool.query(`INSERT INTO factory_approvals(id,"taskId","candidateId","attemptId","userId","humanSessionId","eventId",request,candidate,action,target,"evidenceDigest",evidence,"approvedRevision","publishAttemptId","publishRevision","expiresAt")
      VALUES($1,$2,$3,$4,'owner','legacy-session',$5,'{"legacy":true}','{}','deploy_preview','fixture','historical-evidence','{"original":true}',1,$4,1,clock_timestamp()+interval '1 hour')`,[grant,task,candidate,attempt,event])
    await pool.query(`INSERT INTO factory_approval_controls("taskId","eventId","userId","humanSessionId",request,result) VALUES($1,$2,'owner','legacy-session','{}','{}')`,[task,randomUUID()])
    await pool.query('COMMIT')
    const migration=await sql('_factory_public_consumers.sql')
    await pool.query(migration);await pool.query(migration)
    const scopeMigration=await sql('_factory_scope_generation.sql')
    await pool.query(scopeMigration);await pool.query(scopeMigration)
    assert.equal((await pool.query('SELECT "scopeVersion" FROM factory_tasks WHERE id=$1',[task])).rows[0].scopeVersion,null)
    const scopeColumn=(await pool.query("SELECT column_default,is_nullable FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='factory_tasks' AND column_name='scopeVersion'")).rows[0]
    assert.deepEqual(scopeColumn,{column_default:null,is_nullable:'YES'})
    const historical=(await pool.query('SELECT * FROM factory_approvals WHERE id=$1',[grant])).rows[0]
    assert.equal(historical.principalId,'session:legacy-session');assert.equal(historical.humanSessionId,'legacy-session')
    assert.equal(historical.decisionCredentialId,null);assert.equal(historical.decisionScope,null);assert.equal(historical.decisionEvidence,null)
    assert.deepEqual(historical.request,{legacy:true});assert.deepEqual(historical.evidence,{original:true})
    assert.equal((await pool.query('SELECT "principalId" FROM factory_evidence_reads WHERE id=$1',[read])).rows[0].principalId,'session:legacy-session')
    assert.equal((await pool.query('SELECT "principalId" FROM factory_approval_controls')).rows[0].principalId,'session:legacy-session')
    await pool.query(`INSERT INTO factory_evidence_reads(id,"taskId","userId","principalId",binding,"evidenceDigest") VALUES($1,$2,'owner','owner:owner','{}','new-evidence')`,[randomUUID(),task])
    await pool.query(`INSERT INTO factory_approval_controls("taskId","eventId","userId","principalId",request,result) VALUES($1,$2,'owner','owner:owner','{}','{}')`,[task,randomUUID()])
    const insertPolicy=()=>pool.query(`INSERT INTO factory_approvals(id,"taskId","candidateId","attemptId","userId","principalId","decisionCredentialId","decisionScope","decisionEvidence","eventId",request,candidate,action,target,"evidenceDigest",evidence,"approvedRevision","publishAttemptId","publishRevision","expiresAt")
      SELECT $1,"taskId","candidateId","attemptId","userId",'owner:owner','fixed-disposable-credential','{}','{"issuer":"disposable-authority"}',$2,request,candidate,action,target,"evidenceDigest",evidence,"approvedRevision","publishAttemptId","publishRevision","expiresAt" FROM factory_approvals WHERE id=$3`,[randomUUID(),randomUUID(),grant])
    await insertPolicy();await assert.rejects(insertPolicy,(error:unknown)=>(error as {code?:string}).code==='23505')
    assert.equal((await pool.query('SELECT "botId" FROM factory_tasks WHERE id=$1',[task])).rows[0].botId,null)
    await pool.query('DELETE FROM coordinator_events WHERE id=$1',[source])
    assert.equal((await pool.query('SELECT "sourceEventId" FROM factory_tasks WHERE id=$1',[task])).rows[0].sourceEventId,source)
  } finally {await pool.end();console.info('Factory public upgrade retained schema',schema);await admin.end()}
})
