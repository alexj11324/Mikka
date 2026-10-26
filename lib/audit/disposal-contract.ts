import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const hash = (text: string) => createHash('sha256').update(text).digest('hex');
export type DisposalPlan = { runId: string; tenant: string; agedTenant: string; eventId: string; agedEventId: string; exportId: string; owner: string };
export function validatePlan(p: DisposalPlan) {
  assert.match(p.runId, /^r0-disposal-[a-f0-9-]{36}$/);
  for (const id of [p.tenant,p.agedTenant,p.eventId,p.agedEventId,p.exportId]) assert.match(id,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal(new Set([p.tenant,p.agedTenant,p.eventId,p.agedEventId,p.exportId]).size,5);
  assert.equal(p.owner,`audit_pending_${p.runId}`);
}
export function validateTarget(raw: string, p: DisposalPlan) {
  validatePlan(p);
  const u=new URL(raw);
  assert.ok(['postgres:','postgresql:'].includes(u.protocol));
  assert.equal(u.hostname,'127.0.0.1'); assert.equal(u.search,''); assert.equal(u.hash,'');
  assert.equal(u.pathname,`/mikka_audit_disposal_${p.runId.slice(12).replaceAll('-','')}_e2e`);
  return {host:u.hostname,port:u.port||'5432',database:u.pathname.slice(1)};
}
export type Approval = { manifestHash: string; sourceHash: string; runId: string; decision: string; expiresAt: string; authorizationReference: string; maxPersistentDeletedEvents: number };
export function validateApproval(a: Approval, manifestText: string, sourceHash: string, runId: string, now=Date.now()) {
  assert.equal(a.manifestHash,hash(manifestText)); assert.equal(a.sourceHash,sourceHash); assert.equal(a.runId,runId);
  assert.equal(a.decision,'approve-one-audit-disposal-run');
  assert.equal(a.maxPersistentDeletedEvents,1);
  assert.ok(typeof a.authorizationReference==='string' && a.authorizationReference.trim().length>0);
  const expiry=Date.parse(a.expiresAt); assert.ok(Number.isFinite(expiry)&&expiry>now&&expiry<=now+3600000);
}

// Even an unexpected success must never persist the destructive probe.
export async function rollbackProbe<T>(db: { query: (sql: string) => Promise<unknown> }, work: () => Promise<T>): Promise<T> {
  await db.query('BEGIN');
  try { return await work(); } finally { await db.query('ROLLBACK'); }
}

export function validatePruneRows(rows: unknown, p: DisposalPlan) {
  assert.deepEqual(rows,[
    {id:p.agedEventId,seq:'1',floor:'0',retention:90,expired:true,event:{actorId:p.owner,actorType:'human',resourceId:p.eventId,action:'credential.revoked',outcome:'success',reason:'revoked'}},
    {id:p.exportId,seq:'2',floor:'0',retention:90,expired:false,event:{actorId:p.owner,actorType:'human',resourceId:p.exportId,action:'audit.export',outcome:'success',reason:'snapshot'}}
  ],'exact prepared event plus approved export record required; only aged event may expire');
}

export function validateDeletedEvents(removed: unknown, before: {tenant:string;id:string}[], after: {tenant:string;id:string}[], tenant: string, id: string) {
  assert.equal(removed,'1','disposal budget must pass before commit');
  const missing=before.filter(row=>!after.some(other=>other.tenant===row.tenant&&other.id===row.id));
  assert.deepEqual(missing,[{tenant,id}],'only exact approved event may disappear before commit');
}
