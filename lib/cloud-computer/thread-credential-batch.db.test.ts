import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { Pool, type PoolClient } from 'pg'
import { disposableDatabase } from '../../tests/helpers/e2e-target.mjs'
import { prepareThreadRegistration, type ThreadRegistrationPreparation } from './thread-registration'

const url = process.env.E2E_DATABASE_URL
const allowed = disposableDatabase(process.env, url)
if (process.env.REQUIRE_DB === '1' && !allowed) throw new Error('Isolated loopback test database required')

async function original(client: Pick<PoolClient, 'query'>, p: ThreadRegistrationPreparation): Promise<{ now: Date }> {
  await client.query('INSERT INTO devices (id,"ownerId",name,kind,"nameLocked") VALUES ($1,$2,$3,\'cloud\',true) ON CONFLICT(id) DO UPDATE SET "removedAt"=NULL', [p.deviceId,p.ownerId,'Thread computer'])
  await client.query('INSERT INTO device_repos (id,"deviceId","userId","repoPath","baseBranch","verifyCommand","remoteUrl") VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING', [p.repoId,p.deviceId,p.ownerId,p.repoPath,p.baseBranch,p.verifyCommand,p.remoteUrl])
  await client.query('UPDATE thread_machines SET "deviceId"=$2,"repoId"=$3 WHERE "runId"=$1', [p.runId,p.deviceId,p.repoId])
  await client.query('UPDATE device_tokens SET "revokedAt"=now() WHERE "boundDeviceId"=$1', [p.deviceId])
  return (await client.query<{ now: Date }>('INSERT INTO device_tokens (id,"userId",name,"tokenHash","boundDeviceId","boundWorkspaceId","expiresAt") VALUES ($1,$2,$3,$4,$5,$6,now()+interval \'24 hours\') RETURNING clock_timestamp() AS now', [p.tokenId,p.ownerId,'Thread worker',p.tokenSha256,p.deviceId,p.workspaceId])).rows[0]
}

const steps = ['devices:INSERT','device_repos:INSERT','thread_machines:UPDATE','device_tokens:UPDATE','device_tokens:INSERT']

test('credential preparation retains five PostgreSQL writes in one message when its byte budget allows', { skip: !allowed }, async t => {
  const admin = new Pool({ connectionString: url })
  const schema = 'credential_batch_' + randomUUID().replaceAll('-', '')
  await admin.query('CREATE SCHEMA ' + schema)
  const pool = new Pool({ connectionString: url, options: '-c search_path=' + schema, max: 5 })
  const input: ThreadRegistrationPreparation = {
    runId:randomUUID(),deviceId:randomUUID(),repoId:randomUUID(),ownerId:'fixture-owner',workspaceId:randomUUID(),
    repoPath:'v2/github.com/fixture/repository',baseBranch:'main',verifyCommand:'pnpm test',remoteUrl:'https://github.com/fixture/repository',
    tokenId:randomUUID(),tokenSha256:'a'.repeat(64),
  }
  const oldToken = randomUUID()
  let role: string | undefined
  try {
    await pool.query(`CREATE TABLE devices(id uuid PRIMARY KEY,"ownerId" text NOT NULL,name text NOT NULL,kind text NOT NULL DEFAULT 'local',"nameLocked" boolean DEFAULT false,"removedAt" timestamptz,"createdAt" timestamptz DEFAULT now());
      CREATE TABLE device_repos(id uuid PRIMARY KEY,"deviceId" uuid NOT NULL REFERENCES devices(id),"userId" text NOT NULL,"repoPath" text NOT NULL,"baseBranch" text DEFAULT 'main',"verifyCommand" text,"remoteUrl" text,UNIQUE("deviceId","repoPath"));
      CREATE TABLE thread_machines("runId" uuid PRIMARY KEY,"ownerId" text NOT NULL,"deviceId" uuid,"repoId" uuid);
      CREATE TABLE device_tokens(id uuid PRIMARY KEY,"userId" text NOT NULL,name text NOT NULL,"tokenHash" text NOT NULL UNIQUE,"boundDeviceId" uuid REFERENCES devices(id),"boundWorkspaceId" uuid,"expiresAt" timestamptz,"revokedAt" timestamptz,"lastUsedAt" timestamptz);
      CREATE SEQUENCE step_sequence;
      CREATE TABLE statement_log(n bigint,step text);
      CREATE FUNCTION record_step() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO statement_log VALUES(nextval('step_sequence'),TG_TABLE_NAME||':'||TG_OP);
        IF current_setting('test.fail_step',true)=TG_TABLE_NAME||':'||TG_OP THEN
          RAISE EXCEPTION 'fixture statement failure' USING ERRCODE='P0001';
        END IF;
        RETURN NULL;
      END $$;
      CREATE TRIGGER log_device AFTER INSERT ON devices FOR EACH STATEMENT EXECUTE FUNCTION record_step();
      CREATE TRIGGER log_repo AFTER INSERT ON device_repos FOR EACH STATEMENT EXECUTE FUNCTION record_step();
      CREATE TRIGGER log_machine AFTER UPDATE ON thread_machines FOR EACH STATEMENT EXECUTE FUNCTION record_step();
      CREATE TRIGGER log_revoke AFTER UPDATE ON device_tokens FOR EACH STATEMENT EXECUTE FUNCTION record_step();
      CREATE TRIGGER log_token AFTER INSERT ON device_tokens FOR EACH STATEMENT EXECUTE FUNCTION record_step();`)
    await pool.query(readFileSync(new URL('../../drizzle/20261031050731_account_deletion_jobs.sql',import.meta.url),'utf8'))
    const reset = async (p = input) => {
      await pool.query('TRUNCATE statement_log,device_tokens,device_repos,thread_machines,devices')
      await pool.query(`INSERT INTO devices(id,"ownerId",name,kind,"nameLocked","removedAt")VALUES($1,$2,'existing name','cloud',true,'2026-11-06T00:00:00Z')`, [p.deviceId,p.ownerId])
      await pool.query('INSERT INTO thread_machines("runId","ownerId")VALUES($1,$2)', [p.runId,p.ownerId])
      await pool.query(`INSERT INTO device_tokens(id,"userId",name,"tokenHash","boundDeviceId","expiresAt")VALUES($1,$2,'old','old-hash',$3,'2026-11-08T00:00:00Z')`, [oldToken,p.ownerId,p.deviceId])
      await pool.query('TRUNCATE statement_log')
      await pool.query("SELECT setval('step_sequence',1,false)")
    }
    const state = async (client: Pick<PoolClient,'query'>) => {
      const result = await client.query(`SELECT * FROM (SELECT 'device' AS kind,row_to_json(d) AS row FROM devices d
        UNION ALL SELECT 'repo',row_to_json(r) FROM device_repos r
        UNION ALL SELECT 'machine',row_to_json(m) FROM thread_machines m
        UNION ALL SELECT 'token',row_to_json(k) FROM device_tokens k) state ORDER BY kind,row::text`)
      return result.rows
    }
    const proxy = (client: PoolClient) => {
      const calls: { text:string;values:unknown[]|undefined }[] = []
      const wrapped = { query(text:string, values?:unknown[]) { calls.push({text,values}); return client.query(text,values) } } as Pick<PoolClient,'query'>
      return {client:wrapped,calls}
    }
    await t.test('normal path sends one simple-query message with five native result sets', async () => {
      await reset()
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const seen = proxy(client)
        const result = await prepareThreadRegistration(seen.client,input)
        assert.equal(seen.calls.length,1)
        assert.equal(seen.calls[0].values,undefined)
        assert(result.now instanceof Date && Number.isFinite(result.now.getTime()))
        assert.deepEqual((await client.query('SELECT step FROM statement_log ORDER BY n')).rows.map(r=>r.step),steps)
        assert.equal((await client.query('SELECT "lastUsedAt" FROM device_tokens WHERE id=$1',[input.tokenId])).rows[0].lastUsedAt,null)
      } finally { await client.query('ROLLBACK'); client.release() }
    })
    for (const [name, changes] of [
      ['normal',{}],
      ['null repository fields',{baseBranch:null,verifyCommand:null,remoteUrl:null}],
      ['undefined matches null',{baseBranch:undefined,verifyCommand:undefined,remoteUrl:undefined}],
      ['quotes, backslashes, Unicode and SQL-shaped text',{repoPath:"repo/'\\'; DROP TABLE devices; --",baseBranch:"b'\\x",verifyCommand:"printf '秘密\\n'; true",remoteUrl:"https://github.com/a/b'\\q"}],
    ] satisfies [string,Partial<ThreadRegistrationPreparation>][]) await t.test('matches original values, conflicts and clock: '+name,async()=>{
      const p={...input,...changes};await reset(p)
      const client=await pool.connect()
      try{
        await client.query('BEGIN');await client.query('SAVEPOINT before_write')
        const before=(await client.query('SELECT clock_timestamp() AS now')).rows[0].now as Date
        const expected=await original(client,p);const expectedState=await state(client)
        const expectedSteps=(await client.query('SELECT step FROM statement_log ORDER BY n')).rows
        await client.query('ROLLBACK TO SAVEPOINT before_write')
        const actual=await prepareThreadRegistration(client,p)
        assert.deepEqual(await state(client),expectedState)
        assert.deepEqual((await client.query('SELECT step FROM statement_log ORDER BY n')).rows,expectedSteps)
        assert(actual.now instanceof Date && actual.now>=expected.now && expected.now>=before)
      }finally{await client.query('ROLLBACK');client.release()}
    })
    for(const step of steps)await t.test('first error cuts off later statements and full rollback: '+step,async()=>{
      for(const write of [original,prepareThreadRegistration]){
        await reset();const before=await state(pool);const client=await pool.connect()
        try{
          await client.query('BEGIN');await client.query("SELECT set_config('test.fail_step',$1,true)",[step])
          await assert.rejects(write(client,input),(e:unknown)=>Boolean(e&&typeof e==='object'&&'code'in e&&e.code==='P0001'))
          await client.query('ROLLBACK')
          assert.deepEqual(await state(pool),before)
          assert.equal(Number((await pool.query('SELECT last_value FROM step_sequence')).rows[0].last_value),steps.indexOf(step)+1)
        }finally{await client.query('ROLLBACK');client.release()}
      }
    })
    await t.test('a delayed third write gives the fourth write a fresh committed token snapshot',async()=>{
      await pool.query(`CREATE FUNCTION wait_before_machine() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_advisory_xact_lock(8820715); RETURN NEW; END $$;
      CREATE TRIGGER wait_machine BEFORE UPDATE ON thread_machines FOR EACH ROW EXECUTE FUNCTION wait_before_machine();`)
      try {
        for(const write of [original,prepareThreadRegistration]){
          await reset();const writer=await pool.connect(),blocker=await pool.connect()
          const lateToken=randomUUID()
          let pending: Promise<{now:Date}>|undefined
          try{
            await blocker.query('SELECT pg_advisory_lock(8820715)')
            await writer.query('BEGIN')
            const writerPid=(await writer.query('SELECT pg_backend_pid() AS id')).rows[0].id
            pending=write(writer,input)
            let waiting=false
            for(let i=0;i<200;i++){
              const row=(await pool.query('SELECT wait_event FROM pg_stat_activity WHERE pid=$1',[writerPid])).rows[0]
              if(row?.wait_event==='advisory'){waiting=true;break}
              await new Promise(resolve=>setTimeout(resolve,5))
            }
            assert.equal(waiting,true,'the real writer must be waiting inside statement three')
            await blocker.query(`INSERT INTO device_tokens(id,"userId",name,"tokenHash","boundDeviceId")VALUES($1,$2,'late','late-hash',$3)`,[lateToken,input.ownerId,input.deviceId])
            const released=(await blocker.query('SELECT clock_timestamp() AS now')).rows[0].now as Date
            await blocker.query('SELECT pg_advisory_unlock(8820715)')
            const result=await pending;pending=undefined
            await writer.query('COMMIT')
            assert((await pool.query('SELECT "revokedAt" FROM device_tokens WHERE id=$1',[lateToken])).rows[0].revokedAt instanceof Date)
            assert.equal((await pool.query('SELECT "revokedAt" FROM device_tokens WHERE id=$1',[input.tokenId])).rows[0].revokedAt,null)
            assert(result.now>=released,'RETURNING clock must follow the real blocking interval')
          }finally{
            await blocker.query('SELECT pg_advisory_unlock_all()')
            if(pending)await pending.catch(()=>undefined)
            await writer.query('ROLLBACK');writer.release();blocker.release()
          }
        }
      }finally{await pool.query('DROP TRIGGER wait_machine ON thread_machines;DROP FUNCTION wait_before_machine()')}
    })
    await t.test('high escaping expansion and large text retain the original bound protocol',async()=>{
      for(const verifyCommand of ["'\\".repeat(2000),'x'.repeat(70000)]){
        const p={...input,verifyCommand};await reset(p)
        const client=await pool.connect()
        try{
          await client.query('BEGIN');const seen=proxy(client);await prepareThreadRegistration(seen.client,p)
          assert.equal(seen.calls.length,5)
          assert(seen.calls.every(c=>Array.isArray(c.values)))
          assert.equal((await client.query('SELECT "verifyCommand" FROM device_repos WHERE id=$1',[p.repoId])).rows[0].verifyCommand,verifyCommand)
        }finally{await client.query('ROLLBACK');client.release()}
      }
    })
    await t.test('native errors retain caller rollback and invalid UUID semantics',async()=>{
      for(const write of [original,prepareThreadRegistration]){
        await reset();const before=await state(pool);const client=await pool.connect()
        try{
          await client.query('BEGIN')
          await assert.rejects(write(client,{...input,tokenId:'invalid-uuid'}),(e:unknown)=>Boolean(e&&typeof e==='object'&&'code'in e&&e.code==='22P02'))
          await client.query('ROLLBACK');assert.deepEqual(await state(pool),before)
          assert.equal(Number((await pool.query('SELECT last_value FROM step_sequence')).rows[0].last_value),4)
        }finally{await client.query('ROLLBACK');client.release()}
      }
    })
    await t.test('records actual PostgreSQL wire bytes, result rows and failure prefixes',async()=>{
      type Wire = {sentBytes:number;receivedBytes:number}
      type Channel = {
        write:(chunk:Uint8Array|string,...args:unknown[])=>boolean
        on:(event:'data',listener:(chunk:Buffer)=>void)=>unknown
        off:(event:'data',listener:(chunk:Buffer)=>void)=>unknown
      }
      const client=await pool.connect()
      const channel=(client as unknown as {connection:{stream:Channel}}).connection.stream
      const nativeWrite=channel.write.bind(channel)
      let current: Wire|null=null
      const receive=(chunk:Buffer)=>{if(current)current.receivedBytes+=chunk.length}
      channel.write=(chunk,...args)=>{if(current)current.sentBytes+=typeof chunk==='string'?Buffer.byteLength(chunk):chunk.byteLength;return nativeWrite(chunk,...args)}
      channel.on('data',receive)
      try{
        for(const [scenario,change,failStep] of [
          ['normal',{},''],
          ['unicode_owner',{ownerId:'测试拥有者'},''],
          ['all_null',{baseBranch:null,verifyCommand:null,remoteUrl:null},''],
          ['owner_quote_expansion',{ownerId:"'\\".repeat(2000)},''],
          ['repository_quote_expansion',{verifyCommand:"'\\".repeat(2000)},''],
          ['large_bound_fallback',{verifyCommand:'x'.repeat(70000)},''],
          ...steps.map((step,i)=>['failure_'+(i+1),{},step] as const),
        ] satisfies (readonly [string,Partial<ThreadRegistrationPreparation>,string])[]){
          const p={...input,...change};await reset(p)
          const reports:{name:string;calls:number;sentBytes:number;receivedBytes:number;totalBytes:number;errorCode:string|null}[]=[]
          await client.query('BEGIN');await client.query("SELECT set_config('test.fail_step',$1,true)",[failStep]);await client.query('SAVEPOINT before_write')
          for(const [name,write] of [['original',original],['candidate',prepareThreadRegistration]] as const){
            const seen=proxy(client);let errorCode:string|null=null
            current={sentBytes:0,receivedBytes:0}
            try{await write(seen.client,p)}catch(e){errorCode=e&&typeof e==='object'&&'code'in e?String(e.code):'unknown'}
            const counts=current;current=null
            reports.push({name,calls:seen.calls.length,...counts,totalBytes:counts.sentBytes+counts.receivedBytes,errorCode})
            await client.query('ROLLBACK TO SAVEPOINT before_write')
          }
          await client.query('ROLLBACK')
          assert.equal(reports[0].errorCode,reports[1].errorCode)
          const fallback=reports[1].calls===5
          if(!failStep){
            assert(reports[1].sentBytes<=reports[0].sentBytes,'the pure byte selector must never enlarge a complete successful request')
            if(fallback)assert.equal(reports[1].sentBytes,reports[0].sentBytes)
            else assert(reports[1].totalBytes<reports[0].totalBytes)
          }
          t.diagnostic(JSON.stringify({metric:'credential_batch_wire',scenario,protocol:'PostgreSQL messages; excludes TCP/TLS/startup',statements:5,executedDml:failStep?steps.indexOf(failStep)+1:5,fallback,reports,sentDelta:reports[1].sentBytes-reports[0].sentBytes,totalDelta:reports[1].totalBytes-reports[0].totalBytes}))
        }
      }finally{current=null;channel.write=nativeWrite;channel.off('data',receive);await client.query('ROLLBACK');client.release()}
    })
    await t.test('existing account deletion guard waits and rejects both forms before any writes',async()=>{
      for(const write of [original,prepareThreadRegistration]){
        await reset();const before=await state(pool),writer=await pool.connect(),blocker=await pool.connect()
        let pending:Promise<{now:Date}>|undefined
        try{
          await blocker.query('BEGIN')
          await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['mikka-account-write:'+input.ownerId])
          await blocker.query('INSERT INTO account_deletion_guards("subjectId","jobId")VALUES($1,$2)',[input.ownerId,randomUUID()])
          await writer.query('BEGIN')
          const pid=(await writer.query('SELECT pg_backend_pid() AS id')).rows[0].id
          pending=write(writer,input);void pending.catch(()=>undefined)
          let waiting=false
          for(let i=0;i<200;i++){
            if((await pool.query('SELECT wait_event FROM pg_stat_activity WHERE pid=$1',[pid])).rows[0]?.wait_event==='advisory'){waiting=true;break}
            await new Promise(resolve=>setTimeout(resolve,5))
          }
          assert.equal(waiting,true)
          await blocker.query('COMMIT')
          await assert.rejects(pending,(e:unknown)=>Boolean(e&&typeof e==='object'&&'code'in e&&e.code==='55000'))
          pending=undefined
          await writer.query('ROLLBACK')
          assert.deepEqual(await state(pool),before)
          assert.equal((await pool.query('SELECT count(*)::int AS n FROM statement_log')).rows[0].n,0)
        }finally{
          await blocker.query('ROLLBACK');if(pending)await pending.catch(()=>undefined)
          await writer.query('ROLLBACK');writer.release();blocker.release()
          await pool.query('DELETE FROM account_deletion_guards WHERE "subjectId"=$1',[input.ownerId])
        }
      }
    })
    // A real non-owner role checks that batching does not acquire a function
    // owner's authority or bypass the same row-level INSERT policy.
    await t.test('keeps invoker permissions and row-level ownership policy',async()=>{
      role='credential_role_'+randomUUID().replaceAll('-','')
      await admin.query('CREATE ROLE '+role+' NOSUPERUSER NOBYPASSRLS')
      await admin.query('GRANT USAGE ON SCHEMA '+schema+' TO '+role)
      await admin.query('GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA '+schema+' TO '+role)
      await admin.query('GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA '+schema+' TO '+role)
      await pool.query(`ALTER TABLE devices ENABLE ROW LEVEL SECURITY;CREATE POLICY own_device ON devices USING("ownerId"=current_setting('test.owner')) WITH CHECK("ownerId"=current_setting('test.owner'))`)
      for(const write of [original,prepareThreadRegistration]){
        await reset();const before=await state(pool);const client=await pool.connect()
        try{
          await client.query('BEGIN');await client.query('SET LOCAL ROLE '+role)
          await client.query("SELECT set_config('test.owner',$1,true)",[input.ownerId])
          await assert.rejects(write(client,{...input,ownerId:'foreign'}),(e:unknown)=>Boolean(e&&typeof e==='object'&&'code'in e&&e.code==='42501'))
          await client.query('ROLLBACK');assert.deepEqual(await state(pool),before)
        }finally{await client.query('ROLLBACK');client.release()}
      }
    })
  }finally{
    await pool.end()
    await admin.query('DROP SCHEMA '+schema+' CASCADE')
    if(role)await admin.query('DROP ROLE '+role)
    await admin.end()
  }
})

test('credential batching rejects malformed multi-results without exposing input',async()=>{
  const input:ThreadRegistrationPreparation={runId:randomUUID(),deviceId:randomUUID(),repoId:randomUUID(),ownerId:'private-owner-marker',workspaceId:randomUUID(),repoPath:'private-path-marker',baseBranch:'main',verifyCommand:'private-command-marker',remoteUrl:null,tokenId:randomUUID(),tokenSha256:'e'.repeat(64)}
  const valid=()=>['INSERT','INSERT','UPDATE','UPDATE','INSERT'].map((command,i)=>({command,rowCount:1,rows:i===4?[{now:new Date()}]:[]}))
  const wrong=valid();wrong[2].command='SELECT'
  const badClock=valid();badClock[4].rows=[{now:new Date(NaN)}]
  for(const answer of [valid().slice(1),wrong,badClock,null]){
    let called=0
    const client={query:async()=>{called++;return answer}} as unknown as Pick<PoolClient,'query'>
    await assert.rejects(prepareThreadRegistration(client,input),(error:unknown)=>error instanceof TypeError&&!String(error).includes(input.ownerId)&&!String(error).includes(input.tokenSha256))
    assert.equal(called,1)
  }
})

test('existing SQL telemetry removes all batch values and counts its native results',async()=>{
  const {sanitizeAttributes}=await import('../tracing/sanitize')
  const {describeSample}=await import('../db/egress-sample')
  const input:ThreadRegistrationPreparation={runId:randomUUID(),deviceId:randomUUID(),repoId:randomUUID(),ownerId:"PRIVATE_OWNER_\\'xyz",workspaceId:randomUUID(),repoPath:"PRIVATE_PATH_\\'xyz",baseBranch:'PRIVATE_BRANCH_xyz',verifyCommand:"PRIVATE_COMMAND_\\'xyz",remoteUrl:'https://example.invalid/PRIVATE_REMOTE',tokenId:randomUUID(),tokenSha256:'e'.repeat(64)}
  let text=''
  const results=['INSERT','INSERT','UPDATE','UPDATE','INSERT'].map((command,i)=>({command,rowCount:1,rows:i===4?[{now:new Date()}]:[]}))
  const client={query:async(sql:string)=>{text=sql;return results}} as unknown as Pick<PoolClient,'query'>
  await prepareThreadRegistration(client,input)
  const output=JSON.stringify({attrs:sanitizeAttributes({'db.query.text':text}),sample:describeSample(text,results as never,null)})
  for(const marker of ['PRIVATE_OWNER','PRIVATE_PATH','PRIVATE_BRANCH','PRIVATE_COMMAND','PRIVATE_REMOTE',input.tokenSha256])assert.equal(output.includes(marker),false)
})
