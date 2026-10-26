import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { execFileSync,spawnSync } from 'node:child_process'
import { mkdirSync,mkdtempSync,writeFileSync,readFileSync,readdirSync,symlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { Pool } from 'pg'
import { currentMainMigrations,fullHash } from '../scripts/historical-migrations.mjs'
import { orderMigrations } from '../scripts/migration-order.mjs'
const enabled=process.env.GITHUB_ACTIONS==='true'||process.env.MIKKA_ISOLATED_HISTORY_TEST==='1'
if(process.env.REQUIRE_DB==='1'&&!enabled)throw Error('Explicit isolated migration acceptance required')
const git=(...args)=>execFileSync('git',args,{maxBuffer:64*1024*1024})
const run=(file,args,options={})=>execFileSync(file,args,{maxBuffer:64*1024*1024,timeout:120000,...options}).toString()

test('retained dual DB: fresh candidate equals current-main ledger upgrade; replay preserves history/data', {skip:!enabled,timeout:240000},async()=>{
 const target=new URL(process.env.E2E_DATABASE_URL)
 assert.ok(['127.0.0.1','localhost'].includes(target.hostname)&&target.pathname.endsWith('_e2e')&&!target.search&&!target.hash)
 const admin=new Pool({connectionString:target.toString(),max:1}),pools=[]
 const suffix=randomUUID().replaceAll('-','').slice(0,12),root=resolve('test-results/history-upgrade',suffix)
 mkdirSync(root,{recursive:true})
 const main=currentMainMigrations()
 const baseline=mkdtempSync(resolve(tmpdir(),'mikka-history-main-'))
 const archive=git('archive','--format=tar',main.sha,'scripts','drizzle')
 const extraction=spawnSync('tar',['-xf','-','-C',baseline],{input:archive});assert.equal(extraction.status,0)
 symlinkSync(resolve('node_modules'),resolve(baseline,'node_modules'),'dir')
 const evidence={sha:process.env.GITHUB_SHA??git('rev-parse','HEAD').toString().trim(),tree:git('rev-parse','HEAD^{tree}').toString().trim(),trackedChanges:git('diff','HEAD','--name-only').toString().trim().split('\n').filter(Boolean),main:main.sha,startedAt:new Date().toISOString(),databases:[],checks:[]}
 const make=async kind=>{
  const name=`history_${suffix}_${kind}_e2e`;assert.match(name,/^[a-z0-9_]+$/)
  await admin.query(`CREATE DATABASE "${name}"`)
  const u=new URL(target);u.pathname='/'+name;const pool=new Pool({connectionString:u.toString(),max:1});pools.push(pool)
  evidence.databases.push(name);return {url:u.toString(),pool,name}
 }
 const migrate=(dir,app,workspace)=>run(process.execPath,[resolve(dir,'scripts/migrate.mjs')],{cwd:dir,env:{...process.env,MIGRATE:'1',MIKKA_DATABASE_URL:app.url,DATABASE_URL:workspace.url}})
 const ledger=async db=>(await db.pool.query('select name,"appliedAt"::text as at from schema_migrations order by name')).rows
 const dump=db=>{
  // Keep all SQL, ACLs, constraints, RLS, functions and triggers. Only pg_dump's
  // random psql restrict token and nonsemantic comments/blank lines are removed.
  const container=process.env.HISTORY_PG_CONTAINER
  const sql=container?run('docker',['exec',container,'pg_dump','-U',target.username,'--schema-only',db.name]):run('pg_dump',['--schema-only',db.url])
  return sql.split('\n').filter(l=>!l.startsWith('--')&&!/^\\(?:un)?restrict /.test(l)&&l.trim()).join('\n')
 }
 const columns=async db=>(await db.pool.query("select table_schema,table_name,column_name,ordinal_position,data_type,is_nullable,column_default from information_schema.columns where table_schema not in ('pg_catalog','information_schema') order by table_schema,table_name,ordinal_position")).rows
 const validIndexes=async db=>{
  const rows=(await db.pool.query("select c.relname,i.indisvalid,i.indisready from pg_index i join pg_class c on c.oid=i.indexrelid where c.relname=any($1::text[]) order by c.relname",[['issues_title_search_trgm_idx','issues_owner_updated_id_idx','issues_owner_number_search_idx']])).rows
  assert.equal(rows.length,3);assert.ok(rows.every(r=>r.indisvalid&&r.indisready));return rows
 }
 try{
  const serverVersion=(await admin.query('show server_version_num')).rows[0].server_version_num
  const dumpContainer=process.env.HISTORY_PG_CONTAINER
  const dumpVersion=dumpContainer?run('docker',['exec',dumpContainer,'pg_dump','--version']):run('pg_dump',['--version'])
  assert.ok(serverVersion.startsWith('17'),'isolated PostgreSQL 17 server required')
  assert.match(dumpVersion,/\b17\.\d+/,'matching PostgreSQL 17 dump client required before acceptance')
  evidence.postgres={serverVersion,dumpVersion:dumpVersion.trim(),dumpContainer:dumpContainer??null}
  const freshApp=await make('fresh_app'),freshWs=await make('fresh_ws'),upApp=await make('upgrade_app'),upWs=await make('upgrade_ws')
  migrate(baseline,upApp,upWs)
  const beforeApp=await ledger(upApp),beforeWs=await ledger(upWs)
  const owner='history-'+suffix,issue=randomUUID(),workspace=randomUUID()
  await upApp.pool.query('insert into "user"(id,name,email,"emailVerified","createdAt","updatedAt") values($1,$1,$2,true,now(),now())',[owner,owner+'@example.invalid'])
  await upApp.pool.query(`insert into issues(id,"userId",title,content,status,priority) values($1,$2,'Retained historical fixture','{"type":"doc","content":[]}','todo','normal')`,[issue,owner])
  await upWs.pool.query(`insert into mikka_workspaces(id,"userId",name) values($1,$2,'Retained historical workspace')`,[workspace,owner])
  await upWs.pool.query(`insert into mikka_workspace_members("workspaceId","userId",name,email,role,status) values($1,$2,$2,$3,'admin','active')`,[workspace,owner,owner+'@example.invalid'])
  const business=async()=>({issue:(await upApp.pool.query('select * from issues where id=$1',[issue])).rows,user:(await upApp.pool.query('select * from "user" where id=$1',[owner])).rows,workspace:(await upWs.pool.query('select * from mikka_workspaces where id=$1',[workspace])).rows,member:(await upWs.pool.query('select * from mikka_workspace_members where "workspaceId"=$1',[workspace])).rows})
  const beforeData=await business()
  const upgradeOutput=migrate('.',upApp,upWs),freshOutput=migrate('.',freshApp,freshWs)
  for(const [db,before]of [[upApp,beforeApp],[upWs,beforeWs]]){
   const after=await ledger(db);for(const row of before)assert.deepEqual(after.find(r=>r.name===row.name),row,'old appliedAt must not change')
  }
  assert.deepEqual(await business(),beforeData,'synthetic business rows must survive upgrade unchanged')
  const expected=targetName=>orderMigrations(readdirSync('drizzle').filter(n=>n.endsWith('.sql'))).filter(n=>(/^--\s*target:\s*(\w+)/m.exec(readFileSync('drizzle/'+n,'utf8'))?.[1]??'MIKKA_DATABASE_URL')===targetName)
  for(const [db,fresh,targetName,before]of [[upApp,freshApp,'MIKKA_DATABASE_URL',beforeApp],[upWs,freshWs,'DATABASE_URL',beforeWs]]){
   const names=expected(targetName),old=new Set(before.map(r=>r.name))
   const applied=output=>[...output.matchAll(/migrate: applied (\S+) to (\S+)/g)].filter(m=>m[2]===targetName).map(m=>m[1])
   assert.deepEqual(applied(upgradeOutput),names.filter(n=>!old.has(n)))
   assert.deepEqual(applied(freshOutput),names)
   assert.deepEqual((await ledger(db)).map(r=>r.name),[...names].sort())
   assert.deepEqual((await ledger(fresh)).map(r=>r.name),[...names].sort())
   const freshSchema=dump(fresh),upSchema=dump(db);writeFileSync(resolve(root,`${targetName}-fresh.sql`),freshSchema);writeFileSync(resolve(root,`${targetName}-upgrade.sql`),upSchema)
   assert.equal(upSchema,freshSchema,'full schema including ACL/RLS/functions/triggers must match')
   assert.deepEqual(await columns(db),await columns(fresh),'column ordering/defaults must match')
   evidence.checks.push({target:targetName,ledgerEntries:names.length,pendingAppliedInDependencyOrder:names.filter(n=>!old.has(n)),schemaSha256:fullHash(upSchema),oldLedgerUnchanged:true,businessRowsRetained:true})
  }
  const snapshots=await Promise.all([freshApp,freshWs,upApp,upWs].map(ledger))
  assert.ok(!migrate('.',upApp,upWs).includes('migrate: applied'))
  assert.ok(!migrate('.',freshApp,freshWs).includes('migrate: applied'))
  assert.deepEqual(await Promise.all([freshApp,freshWs,upApp,upWs].map(ledger)),snapshots)
  assert.deepEqual(await business(),beforeData)
  evidence.concurrentIndexes=await validIndexes(upApp);await validIndexes(freshApp)
  evidence.finishedAt=new Date().toISOString();writeFileSync(resolve(root,'evidence.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence))
 }finally{await Promise.all(pools.map(p=>p.end()));await admin.end()}
})
