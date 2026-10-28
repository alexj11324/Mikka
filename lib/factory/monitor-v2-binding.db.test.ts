import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createVercelPublicationAdapter, MIKKA_VERCEL } from "./vercel-publication";
import { factory194Fixture } from "../../tests/helpers/factory194";
import { readFactoryPublicationReceiptV2 } from "./publication-receipt";
import { consumeMonitorObservation } from "./monitor-incidents";
import { validateMonitorV2Observation } from "./monitor-v2-binding";
const db = process.env.E2E_DATABASE_URL;
test("actual V2 reader and monitor consumer on ephemeral PG; synthetic upstream/provider", { skip: !db, timeout: 120000 }, async () => {
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  const u = new URL(db!); assert.equal(u.hostname, "127.0.0.1"); assert.equal(u.port, "5432"); assert.equal(u.pathname, "/mikka_e2e");
  const f = await factory194Fixture(db!);
  try {
    const x = await f.prepare();
    const adapter = createVercelPublicationAdapter({ ...MIKKA_VERCEL, environment: "production" }, f.provider.client);
    const service = f.service([adapter]);
    const approved = await service.approve(f.actor, { ...x.approval, action: "deploy_production", target: adapter.target, targetEnvironment: "production" });
    await service.publish(f.actor, { ...approved, eventId: randomUUID(), action: "deploy_production", target: adapter.target, targetEnvironment: "production" });
    const tx = await f.pool.connect();
    try {
      await tx.query("BEGIN");
      await tx.query('SELECT id FROM factory_tasks WHERE id=$1 AND "userId"=$2 FOR UPDATE', [x.task.id, f.actor.userId]);
      const read = () => readFactoryPublicationReceiptV2(tx, f.actor.userId, x.task.id, x.task.candidateId!);
      const r = await read();
      const at = new Date().toISOString();
      const o = { startedAt: at, finishedAt: at, target: { ...r.verifiedTarget, observedAt: at }, health: { immutableStatus: 200, immutableBodyValid: true, aliasStatus: 200, aliasBodyValid: true }, alias: { origin: "https://app.example.com", before: r.verifiedTarget.operationId, after: r.verifiedTarget.operationId } };
      assert.equal(validateMonitorV2Observation(r, o, "https://app.example.com"), "healthy");
      // Invokes the actual v2 ancestry predicate: an unbound monitor run must not
      // gain provenance from an otherwise valid publication and health result.
      await assert.rejects(() => consumeMonitorObservation(tx,
        { id: x.task.id, userId: f.actor.userId, issueId: r.issueId, sourceEventId: "synthetic-source", stage: "monitor", status: "running", attemptId: "unbound-attempt", candidateId: r.candidateId },
        { ownerId: f.actor.userId, workspaceKey: "synthetic-workspace", fingerprint: "f", checkKey: "c", issueId: r.issueId, eventId: "e", outcome: "healthy", publicationId: r.publicationId, candidateId: r.candidateId, runId: "unbound-run" }, o, "https://app.example.com"), /factoryMonitorIndependentRequired/);

      assert.equal(validateMonitorV2Observation(r, { ...o, startedAt: "2000-01-01T00:00:00Z" }, "https://app.example.com"), "blocked");
      const mutations = [
        `UPDATE factory_publications SET status='uncertain'`,
        `DELETE FROM factory_publications`,
        `UPDATE factory_approvals SET "revokedAt"=now()`,
        `UPDATE factory_tasks SET status='cancelled'`,
        `UPDATE factory_candidates SET sha=repeat('b',40)`,
        `UPDATE factory_publications SET receipt=jsonb_set(receipt,'{verifiedTarget,provider,bindingHash}',to_jsonb(repeat('0',64)))`,
        `UPDATE factory_publications SET receipt=jsonb_set(receipt,'{verifiedTarget,observedAt}','"2000-01-01T00:00:00.000Z"')`,
        `UPDATE factory_publications SET receipt=jsonb_set(receipt,'{verifiedTarget,observedAt}','"2999-01-01T00:00:00.000Z"')`,
      ];
      for (const sql of mutations) {
        await tx.query("SAVEPOINT negative_case");
        await tx.query(sql);
        await assert.rejects(read, /factoryPublicationReceipt/);
        await tx.query("ROLLBACK TO SAVEPOINT negative_case");
      }
      // Synthetic current monitor assignment; actual ancestry predicate and
      // publication reader are both executed. No #192 runtime is substituted.
      await tx.query(await readFile(new URL("../../docs/factory/schema-proposals/195-incidents.sql", import.meta.url), "utf8"));
      await tx.query('CREATE TABLE factory_questions ("continuationRunId" uuid)');
      const monitorRun = randomUUID(), monitorAttempt = randomUUID();
      await tx.query(`INSERT INTO agent_runs(id,"userId","issueId","sessionId",status) VALUES($1,$2,$3,$4,'succeeded')`, [monitorRun,f.actor.userId,r.issueId,"synthetic-monitor"]);
      await tx.query(`INSERT INTO factory_attempts(id,"taskId","candidateId",stage,position,"runId","sessionId",status) VALUES($1,$2,$3,'monitor',5,$4,$5,'running')`, [monitorAttempt,x.task.id,r.candidateId,monitorRun,"synthetic-monitor"]);
      const task = { id:x.task.id,userId:f.actor.userId,issueId:r.issueId,sourceEventId:"synthetic-source",stage:"monitor",status:"running",attemptId:monitorAttempt,candidateId:r.candidateId };
      const input = {ownerId:f.actor.userId,workspaceKey:"synthetic",fingerprint:"f",checkKey:"c",issueId:r.issueId,eventId:"failure",outcome:"unhealthy" as const,publicationId:r.publicationId,candidateId:r.candidateId,runId:monitorRun};
      const failed = await consumeMonitorObservation(tx,task,input,{...o,health:{...o.health,immutableStatus:503}},"https://app.example.com");
      const recovered = await consumeMonitorObservation(tx,task,{...input,eventId:"recovery-evidence",outcome:"healthy"},o,"https://app.example.com");
      assert.equal(failed.incidentId,recovered.incidentId);
      const audit = (await tx.query("SELECT identity FROM factory_monitor_observations WHERE event_id='recovery-evidence'")).rows[0].identity;
      assert.match(audit.evidenceDigest,/^[a-f0-9]{64}$/); assert.equal(audit.publicationId,r.publicationId); assert.equal(audit.runId,monitorRun); assert.equal(audit.candidateId,r.candidateId);
      await tx.query("ROLLBACK");
    } finally { tx.release(); }
  } finally { await f.close(); }
});
