import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { factory194Fixture } from "../../tests/helpers/factory194";
import { recordMonitorIncident } from "./monitor-incidents";
const db = process.env.E2E_DATABASE_URL;
test("atomic monitor incident concurrency/replay/recovery evidence on isolated PG", { timeout: 120000 }, async () => {
 assert.equal(process.env.CI,"true"); assert.equal(process.env.GITHUB_ACTIONS,"true"); assert.equal(process.env.REQUIRE_DB,"1");
 const u = new URL(db!); assert.equal(u.hostname,"127.0.0.1"); assert.equal(u.port,"5432"); assert.equal(u.pathname,"/mikka_e2e");
 const f = await factory194Fixture(db!);
 try {
  await f.pool.query(await readFile(new URL("../../docs/factory/schema-proposals/195-incidents.sql",import.meta.url),"utf8"));
  const base = { ownerId:"owner",workspaceKey:"workspace",fingerprint:"fingerprint",checkKey:"check",issueId:"original",eventId:"event",outcome:"unhealthy" as const,publicationId:"publication",candidateId:"candidate",runId:"run",evidenceDigest:"synthetic-proof" };
  const write = async (input: Parameters<typeof recordMonitorIncident>[1]) => {
   const tx = await f.pool.connect(); try { await tx.query("BEGIN"); const r=await recordMonitorIncident(tx,input); await tx.query("COMMIT"); return r; } catch(e) { await tx.query("ROLLBACK"); throw e; } finally { tx.release(); }
  };
  const repeated = await Promise.all(Array.from({length:10},()=>write(base)));
  assert.equal(new Set(repeated.map(r=>r.incidentId)).size,1); assert.equal(repeated.filter(r=>!r.replayed).length,1);
  await assert.rejects(()=>write({...base,issueId:"changed"}),/ReplayConflict/);
  await Promise.all(Array.from({length:10},(_,i)=>write({...base,eventId:`distinct-${i}`})));
  let row=(await f.pool.query("SELECT * FROM factory_monitor_incidents WHERE owner_id='owner'")).rows[0]; assert.equal(row.occurrences,11); assert.equal(row.issue_id,"original");
  await write({...base,eventId:"health",outcome:"healthy"});
  row=(await f.pool.query("SELECT * FROM factory_monitor_incidents WHERE id=$1",[row.id])).rows[0]; assert.equal(row.status,"recovery_observed"); assert.equal(row.occurrences,11);
  await write({...base,eventId:"regression"});
  assert.equal((await f.pool.query("SELECT status FROM factory_monitor_incidents WHERE id=$1",[row.id])).rows[0].status,"open");
  const foreign = await write({...base,ownerId:"other"}); assert.notEqual(foreign.incidentId,row.id);
  await assert.rejects(()=>write({...base,eventId:"unknown-health",fingerprint:"new",outcome:"healthy"}),/IncidentRequired/);
  const tx=await f.pool.connect(); try { await tx.query("BEGIN"); await recordMonitorIncident(tx,{...base,eventId:"rollback"}); await tx.query("ROLLBACK"); } finally {tx.release();}
  assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM factory_monitor_observations WHERE event_id='rollback'")).rows[0].n,0);
  assert.equal((await write({...base,eventId:"rollback"})).replayed,false);
 } finally { await f.close(); }
});
