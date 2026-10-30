import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { factory194Fixture } from "../../tests/helpers/factory194";
import { factoryEventId } from "./event-id";
import { recordMonitorIncident } from "./monitor-incidents";
import { assertE2eTarget } from '../../tests/helpers/e2e-target.mjs'
const db = process.env.E2E_DATABASE_URL;
test("atomic monitor incident concurrency/replay/recovery on the tracked ledger", { skip: !db, timeout: 120000 }, async () => {
  assert.equal(process.env.REQUIRE_DB,"1");
  assertE2eTarget(db);
  const f = await factory194Fixture(db!);
  try {
    await f.pool.query(await readFile(new URL("../../drizzle/20261029044005_factory_195_monitor.sql",import.meta.url),"utf8"));
    const x = await f.prepare();
    const runId = (await f.pool.query('SELECT "runId" FROM factory_attempts WHERE "taskId"=$1 AND stage=\'execute\'',[x.task.id])).rows[0].runId;
    const base = {ownerId:f.actor.userId,workspaceKey:"workspace",fingerprint:"f".repeat(64),checkKey:"c".repeat(64),issueId:x.task.issueId,eventId:randomUUID(),outcome:"unhealthy" as const,publicationId:randomUUID(),candidateId:x.task.candidateId!,runId,evidenceDigest:"e".repeat(64)};
    const write = async (input: Parameters<typeof recordMonitorIncident>[1]) => {
      const tx = await f.pool.connect();
      try { await tx.query("BEGIN"); const r=await recordMonitorIncident(tx,input); await tx.query("COMMIT"); return r; }
      catch(e) { await tx.query("ROLLBACK"); throw e; } finally { tx.release(); }
    };
    const repeated = await Promise.all(Array.from({length:10},()=>write(base)));
    assert.equal(new Set(repeated.map(r=>r.incidentId)).size,1); assert.equal(repeated.filter(r=>!r.replayed).length,1);
    await assert.rejects(()=>write({...base,issueId:randomUUID()}),/ReplayConflict/);
    await Promise.all(Array.from({length:10},()=>write({...base,eventId:randomUUID()})));
    let row=(await f.pool.query('SELECT * FROM factory_monitor_incidents WHERE "userId"=$1',[f.actor.userId])).rows[0];
    assert.equal(row.occurrences,11); assert.equal(row.issueId,x.task.issueId);
    await write({...base,eventId:"health",outcome:"healthy"});
    row=(await f.pool.query("SELECT * FROM factory_monitor_incidents WHERE id=$1",[row.id])).rows[0]; assert.equal(row.status,"recovered"); assert.equal(row.occurrences,11);
    assert.equal((await f.pool.query('SELECT "userId" FROM issues WHERE id=$1',[x.task.issueId])).rows[0].userId,f.actor.userId);
    await write({...base,eventId:"regression"});
    assert.equal((await f.pool.query("SELECT status FROM factory_monitor_incidents WHERE id=$1",[row.id])).rows[0].status,"open");
    // A foreign owner cannot reuse another owner's candidate and run.
    await assert.rejects(()=>write({...base,eventId:"foreign",ownerId:"other"}),/IdentityRequired/);
    const other = await f.prepare(), otherRun = randomUUID();
    await f.pool.query('UPDATE factory_tasks SET "userId"=\'other\' WHERE id=$1',[other.task.id]);
    await f.pool.query('UPDATE issues SET "userId"=\'other\' WHERE id=$1',[other.task.issueId]);
    await f.pool.query('INSERT INTO agent_runs(id,"userId","issueId","sessionId",status) VALUES($1,\'other\',$2,\'other-monitor\',\'succeeded\')',[otherRun,other.task.issueId]);
    const foreign=await write({...base,ownerId:"other",issueId:other.task.issueId,candidateId:other.task.candidateId!,runId:otherRun}); assert.notEqual(foreign.incidentId,row.id);
    await assert.rejects(()=>write({...base,eventId:"unknown-health",fingerprint:"b".repeat(64),outcome:"healthy"}),/IncidentRequired/);
    const tx=await f.pool.connect(); try { await tx.query("BEGIN"); await recordMonitorIncident(tx,{...base,eventId:"rollback"}); await tx.query("ROLLBACK"); } finally {tx.release();}
    assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM factory_monitor_observations WHERE "sourceEventId"=$1',[factoryEventId("monitor-v2-observation","rollback")])).rows[0].n,0);
    assert.equal((await write({...base,eventId:"rollback"})).replayed,false);
  } finally { await f.close(); }
});
