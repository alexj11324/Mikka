import assert from "node:assert/strict";
import test from "node:test";
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
      await tx.query("ROLLBACK");
    } finally { tx.release(); }
  } finally { await f.close(); }
});
