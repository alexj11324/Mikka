import assert from 'node:assert/strict';
import { readFile, writeFile, lstat } from 'node:fs/promises';
import { Pool } from 'pg';
import { appendAudit } from './store';
import { hash, validatePlan, validateTarget, validateApproval, type DisposalPlan, type Approval } from './disposal-contract';

const sourceFiles=['lib/audit/disposal-contract.ts','lib/audit/disposal-session.ts','lib/audit/postgres-deletion.pending.test.ts','lib/audit/store.ts','drizzle/20261025170000_security_audit_application.sql','scripts/prepare-audit-disposal.ts','package.json','pnpm-lock.yaml','tsconfig.json'];
export async function auditSourceHash() { return hash(JSON.stringify({runtime:process.version,files:await Promise.all(sourceFiles.map(async p=>[p,hash(await readFile(new URL('../../'+p,import.meta.url),'utf8'))]))})); }
async function readPrivate(path: string) {
  const st=await lstat(path); assert.ok(st.isFile()&&!st.isSymbolicLink()); assert.equal(st.mode&0o077,0,'private manifest/approval file required');
  assert.equal(st.uid,process.getuid?.()); return readFile(path,'utf8');
}
async function pinnedPool(raw: string): Promise<Pool> {
  const backing=new Pool({connectionString:raw,max:1,options:'-c search_path=public -c statement_timeout=10000 -c lock_timeout=5000'});
  let client;
  try { client=await backing.connect(); } catch(e) { await backing.end(); throw e; }
  // Never reacquire after disconnect: all assertions and transactions use this client.
  client.on('error',()=>{});
  const view=Object.create(backing) as Pool;
  view.query=client.query.bind(client);
  const transactionClient=Object.create(client);
  transactionClient.query=client.query.bind(client); transactionClient.release=()=>{};
  view.connect=(async()=>transactionClient) as Pool['connect'];
  view.end=async()=>{client.release();await backing.end();};
  return view;
}
async function identity(pool: Pool) {
  return (await pool.query(`SELECT current_database() AS database, (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid, current_schema() AS schema, (SELECT system_identifier::text FROM pg_control_system()) AS system`)).rows[0];
}
async function snapshot(pool: Pool) {
  // Only known audit tables; no caller-controlled SQL identifiers.
  const rows=[];
  for(const table of ['security_audit_events','security_audit_heads','security_audit_keys','security_audit_exports','security_audit_checkpoints']) rows.push([table,(await pool.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows]);
  rows.push(['functions',(await pool.query("SELECT p.oid::text,pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'security_audit_%' ORDER BY p.oid")).rows]);
  rows.push(['triggers',(await pool.query("SELECT c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname LIKE 'security_audit_%' ORDER BY c.relname,t.tgname")).rows]);
  return rows;
}
export async function prepareAuditDisposal(planPath: string, output: string, raw: string) {
  const plan=JSON.parse(await readPrivate(planPath)) as DisposalPlan; validatePlan(plan);
  const target=validateTarget(raw,plan), source=await auditSourceHash();
  const pool=await pinnedPool(raw);
  try {
    const environment=await identity(pool); assert.equal(environment.schema,'public');
    // Caller must provision a new dedicated database with the audit schema first.
    // No migration replay, DROP, cleanup, or implicit database creation occurs here.
    for(const [,rows] of (await snapshot(pool)).slice(0,5)) assert.equal((rows as unknown[]).length,0,'new empty audit fixture database required');
    await pool.query('BEGIN');
    try {
      await pool.query('CREATE TABLE audit_disposal_owner (run_id text PRIMARY KEY, source_hash text NOT NULL, consumed boolean NOT NULL DEFAULT false)');
      await pool.query('INSERT INTO audit_disposal_owner(run_id,source_hash) VALUES($1,$2)',[plan.runId,source]);
      const event={actorId:plan.owner,actorType:'human' as const,resourceId:plan.eventId,action:'credential.revoked',outcome:'success' as const,reason:'revoked'};
      await appendAudit(pool,plan.tenant,event,plan.eventId);
      await appendAudit(pool,plan.agedTenant,event,plan.agedEventId);
      await pool.query('COMMIT');
    } catch(e) { await pool.query('ROLLBACK'); throw e; }
    const manifest={version:1,plan,target,environment,sourceHash:source,snapshot:await snapshot(pool),maxPersistentDeletedEvents:1};
    // Exclusive create: never overwrite evidence. A write failure leaves fixtures retained.
    await writeFile(output,JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});
  } finally { await pool.end(); }
}
export async function claimAuditDisposal(manifestPath: string, approvalPath: string, raw: string) {
  // No environment flag is approval; both exact files are mandatory before connecting.
  const text=await readPrivate(manifestPath), m=JSON.parse(text);
  assert.equal(m.version,1); assert.equal(m.maxPersistentDeletedEvents,1);
  const target=validateTarget(raw,m.plan); assert.deepEqual(target,m.target);
  const source=await auditSourceHash(); assert.equal(m.sourceHash,source);
  validateApproval(JSON.parse(await readPrivate(approvalPath)) as Approval,text,source,m.plan.runId);
  const pool=await pinnedPool(raw);
  try {
    assert.deepEqual(await identity(pool),m.environment);
    // Session lock stays held by the sole pool connection for the entire test.
    assert.equal((await pool.query("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked",[m.plan.runId])).rows[0].locked,true);
    await pool.query('BEGIN');
    try {
      const owner=(await pool.query('SELECT * FROM audit_disposal_owner FOR UPDATE')).rows;
      assert.equal(owner.length,1); assert.equal(owner[0].run_id,m.plan.runId); assert.equal(owner[0].source_hash,source); assert.equal(owner[0].consumed,false);
      assert.deepEqual(await snapshot(pool),m.snapshot,'fixture changed since preparation');
      await pool.query('UPDATE audit_disposal_owner SET consumed=true WHERE run_id=$1',[m.plan.runId]);
      await pool.query('COMMIT');
    } catch(e) { await pool.query('ROLLBACK'); throw e; }
    return {pool,plan:m.plan as DisposalPlan};
  } catch(e) {await pool.end();throw e;}
}
