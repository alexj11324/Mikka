// REQUIRE_DB: isolated synthetic catalog fixtures; SELECT inventory, no disposal.
import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {mkdtemp,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import pg from 'pg'
import {inventoryFactoryEffects} from './factory-effects.mjs'
import {inventoryByosOAuthAttempts} from './byos-inventory.mjs'
const raw=process.env.AUDIT_APP_TEST_URL
if(!raw)throw Error('Explicit isolated inventory fixture database required')
const url=new URL(raw);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.pathname,'/mikka_audit_app_e2e');assert.equal(url.search,'');assert.equal(url.hash,'')
test('retained PG inventory: actual catalog arrays, composite cascade, SET NULL and exact BYOS attempts',async t=>{
 const pool=new pg.Pool({connectionString:raw}),receipts=[],directory=await mkdtemp(join(tmpdir(),'r0-catalog-fixtures-'))
 try{
  for(const family of ['factory_192','monitor_195','questions'])await t.test(`real ${family} catalog inventories only registered fixture effects`,async()=>{
   const schema=family+'_'+randomUUID().replaceAll('-','');await pool.query(`CREATE SCHEMA "${schema}"`)
   const receipt={schema,executedDeletion:false};receipts.push(receipt)
   const a=randomUUID(),b=randomUUID(),c=randomUUID(),d=randomUUID();let roots,fixtureRows
   if(family==='factory_192'){
    await pool.query(`CREATE TABLE "${schema}".agents(id uuid PRIMARY KEY);CREATE TABLE "${schema}".agent_runs(id uuid PRIMARY KEY,"agentId" uuid REFERENCES "${schema}".agents(id) ON DELETE CASCADE);CREATE TABLE "${schema}".fixture_events("runId" uuid REFERENCES "${schema}".agent_runs(id) ON DELETE CASCADE,"eventId" uuid,PRIMARY KEY("runId","eventId"))`)
    await pool.query(`INSERT INTO "${schema}".agents VALUES($1)`,[a]);await pool.query(`INSERT INTO "${schema}".agent_runs VALUES($1,$2)`,[b,a]);await pool.query(`INSERT INTO "${schema}".fixture_events VALUES($1,$2)`,[b,c]);roots=[{table:'agents',id:a}];fixtureRows=[...roots,{table:'agent_runs',id:b},{table:'fixture_events',pk:{runId:b,eventId:c}}]
   }else if(family==='monitor_195'){
    await pool.query(`CREATE TABLE "${schema}".issues(id uuid PRIMARY KEY);CREATE TABLE "${schema}".agent_runs(id uuid PRIMARY KEY);CREATE TABLE "${schema}".fixture_incidents(id uuid PRIMARY KEY,"issueId" uuid REFERENCES "${schema}".issues(id) ON DELETE CASCADE);CREATE TABLE "${schema}".fixture_observations(id uuid PRIMARY KEY,"incidentId" uuid REFERENCES "${schema}".fixture_incidents(id) ON DELETE SET NULL)`)
    await pool.query(`INSERT INTO "${schema}".issues VALUES($1)`,[a]);await pool.query(`INSERT INTO "${schema}".agent_runs VALUES($1)`,[b]);await pool.query(`INSERT INTO "${schema}".fixture_incidents VALUES($1,$2)`,[c,a]);await pool.query(`INSERT INTO "${schema}".fixture_observations VALUES($1,$2)`,[d,c]);roots=[{table:'issues',id:a},{table:'agent_runs',id:b}];fixtureRows=[...roots,{table:'fixture_incidents',id:c},{table:'fixture_observations',id:d}]
   }else{
    await pool.query(`CREATE TABLE "${schema}".agent_runs(id uuid PRIMARY KEY);CREATE TABLE "${schema}".fixture_links(id uuid PRIMARY KEY,"runId" uuid REFERENCES "${schema}".agent_runs(id) ON DELETE SET NULL)`);await pool.query(`INSERT INTO "${schema}".agent_runs VALUES($1)`,[a]);await pool.query(`INSERT INTO "${schema}".fixture_links VALUES($1,$2)`,[b,a]);roots=[{table:'agent_runs',id:a}];fixtureRows=[...roots,{table:'fixture_links',id:b}]
   }
   receipt.fixtureRows=fixtureRows
   const tx=await pool.connect()
   try{await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const result=await inventoryFactoryEffects(tx,{schema,roots,fixtureRows,maxRows:fixtureRows.length});assert.equal(result.count,fixtureRows.length);assert.equal(result.executedDeletion,false);assert.equal(result.effects.filter(e=>e.effect==='set-null').length,family==='factory_192'?0:1);receipt.inventory=result;await assert.rejects(inventoryFactoryEffects(tx,{schema,roots,fixtureRows,maxRows:fixtureRows.length-1}),/budget/);await tx.query('COMMIT')}
   catch(e){await tx.query('ROLLBACK');throw e}finally{tx.release()}
  })
  await t.test('real BYOS join freezes the attempt PK and rejects a cross-scope alias',async()=>{
   const schema='byos_inventory_'+randomUUID().replaceAll('-',''),id=randomUUID(),operation=randomUUID(),name='mikka-byos-'+randomUUID();await pool.query(`CREATE SCHEMA "${schema}"`)
   const receipt={schema,executedDeletion:false};receipts.push(receipt)
   await pool.query(`CREATE TABLE "${schema}".byos_connections(id uuid PRIMARY KEY,"ownerId" text,"workspaceId" text,provider text);CREATE TABLE "${schema}".byos_oauth_attempts("stateHash" text PRIMARY KEY,"connectionId" uuid,"ownerId" text,"workspaceId" text,"operationId" uuid,"secretName" text);CREATE TABLE "${schema}".byos_secret_artifacts(name text PRIMARY KEY,"connectionId" uuid,"ownerId" text,"workspaceId" text,provider text,kind text,"operationId" uuid,"deletedAt" timestamptz)`)
   const scope={connectionId:id,ownerId:'fixture-'+randomUUID(),workspaceId:randomUUID(),provider:'codex'}
   await pool.query(`INSERT INTO "${schema}".byos_connections VALUES($1,$2,$3,$4)`,[id,scope.ownerId,scope.workspaceId,scope.provider]);await pool.query(`INSERT INTO "${schema}".byos_oauth_attempts VALUES($1,$2,$3,$4,$5,$6)`,['a'.repeat(64),id,scope.ownerId,scope.workspaceId,operation,name]);await pool.query(`INSERT INTO "${schema}".byos_secret_artifacts VALUES($1,$2,$3,$4,$5,'oauth',$6,clock_timestamp())`,[name,id,scope.ownerId,scope.workspaceId,scope.provider,operation])
   const tx=await pool.connect();try{await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await tx.query(`SET LOCAL search_path="${schema}"`);const result=await inventoryByosOAuthAttempts(tx,scope,1);assert.equal(result.count,1);assert.deepEqual(result.rows[0].primaryKey,{stateHash:'a'.repeat(64)});await assert.rejects(inventoryByosOAuthAttempts(tx,scope,0));receipt.inventory=result;await tx.query('COMMIT')}catch(e){await tx.query('ROLLBACK');throw e}finally{tx.release()}
   // Create a retained hostile alias; the inventory must expose and reject it.
   await pool.query(`INSERT INTO "${schema}".byos_oauth_attempts VALUES($1,$2,$3,$4,$5,$6)`,['b'.repeat(64),randomUUID(),'other-fixture',scope.workspaceId,operation,name])
   const check=await pool.connect();try{await check.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await check.query(`SET LOCAL search_path="${schema}"`);await assert.rejects(inventoryByosOAuthAttempts(check,scope,2));await check.query('COMMIT')}catch(e){await check.query('ROLLBACK');throw e}finally{check.release()}
  })
 }finally{await writeFile(join(directory,'retained-resources.json'),JSON.stringify({scope:'minimal synthetic FK/join fixtures; not original Factory/BYOS harness disposal',receipts},null,2),{mode:0o600});console.log('Catalog fixtures retained: '+JSON.stringify({directory,schemas:receipts.map(r=>r.schema)}));await pool.end()}
})
