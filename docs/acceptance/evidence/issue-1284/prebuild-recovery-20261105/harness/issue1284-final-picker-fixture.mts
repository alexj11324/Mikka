import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Isolated display data only. No credential material, provider call, binding to
// an executing Agent, daemon presence, dispatcher or authentication override.
const config=JSON.parse(await readFile(process.env.MIKKA_FINAL_CONFIG!, 'utf8'));
const root=config.root,prefix=config.prefix;
assert.match(prefix,/^\/tmp\/issue1284-[a-z0-9-]+$/);
process.chdir(root);
const git=(...args:string[])=>execFileSync('git',args,{encoding:'utf8'}).trim();
assert.equal(git('rev-parse','HEAD'),config.sourceCommit);
assert.equal(git('rev-parse','HEAD^{tree}'),config.sourceTree);
assert.equal(git('status','--porcelain','--untracked-files=no'),'');
const imp=(f:string)=>import(pathToFileURL(resolve(root,f)).href);
const {loadEnvironment,assertDatabaseIdentity}=await imp('scripts/test-accounts/environment.mjs');
const environment=await loadEnvironment();
const {pool}=await imp('lib/db/index.ts');
const {workspacePool}=await imp('lib/workspace-db.ts');
const [mode,ownerId,workspaceId]=process.argv.slice(2);
assert.ok(['seed','inspect','cleanup'].includes(mode));assert.ok(ownerId);
const statePath=prefix+'-picker-fixture.json';
let fixture:any;
const save=()=>writeFile(statePath,JSON.stringify(fixture,null,2)+'\n',{mode:0o600});
try {
 await assertDatabaseIdentity(pool,environment);
 if(mode==='seed') {
  assert.match(workspaceId,/^[a-f0-9-]{36}$/);
  const member=(await workspacePool.query(`SELECT w.id FROM mikka_workspaces w JOIN mikka_workspace_members m ON m."workspaceId"=w.id WHERE w.id=$1 AND m."userId"=$2 AND m.status='active'`,[workspaceId,ownerId])).rows;
  assert.equal(member.length,1,'normal account must own an active scope');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM byos_connections WHERE "ownerId"=$1',[ownerId])).rows[0].n,0,'fresh isolated owner only');
  const model='claude-haiku-5-5',connectionId=randomUUID();
  const hash=createHash('sha256').update(JSON.stringify([ownerId,connectionId,1,model])).digest('hex');
  const bindingId=`${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-8${hash.slice(17,20)}-${hash.slice(20,32)}`;
  fixture={synthetic:true,ownerId,workspaceId,sourceCommit:config.sourceCommit,sourceTree:config.sourceTree,connectionId,bindingId,deviceIds:[],model,
    purpose:'Display-only catalogue metadata for a normal read. Missing allowance is checking; no authenticated subscription or native runtime is claimed.',
    beforeRunCount:(await pool.query('SELECT count(*)::int AS n FROM agent_runs WHERE "userId"=$1',[ownerId])).rows[0].n};
  await save();
  const tx=await pool.connect();
  try {
   await tx.query('BEGIN');
   await tx.query(`INSERT INTO byos_connections(id,"ownerId","workspaceId",provider,state,paused,epoch,"secretName","secretDigest","providerSubject","modelCatalog",quota)
     VALUES($1,$2,$3,'claude','connected',false,1,$4,$5,'isolated-display-fixture',$6::jsonb,NULL)`,
     [connectionId,ownerId,workspaceId,'synthetic-display-only-'+connectionId,'a'.repeat(64),JSON.stringify({revision:'1',models:[model]})]);
   // This is the production account catalogue schema (ExecutionSettings.refreshBotModels).
   // An execution binding would be created separately as claude_code_cli; none is made here.
   await tx.query(`INSERT INTO byos_bindings(id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId") VALUES($1,$2,$3,$4,$5,1,'claude_cpa',$6)`,
     [bindingId,ownerId,workspaceId,bindingId,connectionId,model]);
   await tx.query('COMMIT');
  } catch(error){await tx.query('ROLLBACK');throw error;}finally{tx.release();}
  fixture.seededAt=new Date().toISOString();await save();
 } else {
  fixture=JSON.parse(await readFile(statePath,'utf8'));
  assert.equal(fixture.ownerId,ownerId);assert.equal(fixture.sourceCommit,config.sourceCommit);assert.equal(fixture.sourceTree,config.sourceTree);
  if(mode==='cleanup') {
   const tx=await pool.connect();
   try {
    await tx.query('BEGIN');
    await tx.query('DELETE FROM byos_bindings WHERE id=$1 AND "ownerId"=$2 AND "connectionId"=$3',[fixture.bindingId,ownerId,fixture.connectionId]);
    await tx.query('DELETE FROM byos_connections WHERE id=$1 AND "ownerId"=$2',[fixture.connectionId,ownerId]);
    await tx.query('COMMIT');
   }catch(error){await tx.query('ROLLBACK');throw error;}finally{tx.release();}
   fixture.remainingConnections=(await pool.query('SELECT count(*)::int AS n FROM byos_connections WHERE id=$1',[fixture.connectionId])).rows[0].n;
   fixture.remainingBindings=(await pool.query('SELECT count(*)::int AS n FROM byos_bindings WHERE "connectionId"=$1',[fixture.connectionId])).rows[0].n;
   fixture.remainingDevices=0;
   fixture.cleanedAt=new Date().toISOString();await save();
  }
 }
 if(mode!=='cleanup') {
  fixture.runCount=(await pool.query('SELECT count(*)::int AS n FROM agent_runs WHERE "userId"=$1',[ownerId])).rows[0].n;
  fixture.activeRunCount=(await pool.query(`SELECT count(*)::int AS n FROM agent_runs WHERE "userId"=$1 AND status IN ('queued','preparing','running','waiting_input','paused','finishing')`,[ownerId])).rows[0].n;
  assert.equal(fixture.runCount,fixture.beforeRunCount);assert.equal(fixture.activeRunCount,0);await save();
 }
 console.log(JSON.stringify({mode,metadataPath:statePath,synthetic:true,createdDeviceCount:0,providerRequests:0}));
}finally{await Promise.allSettled([pool.end(),workspacePool===pool?Promise.resolve():workspacePool.end()]);}
