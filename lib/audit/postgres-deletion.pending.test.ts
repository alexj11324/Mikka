// Pending acceptance: this entry performs real synthetic row deletion.
// It is NOT part of test:audit. An execution flag records a separately reviewed
// authorization; fixture-retention flags alone never enable this entry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rollbackProbe, validatePruneRows } from "./disposal-contract";
import { claimAuditDisposal } from "./disposal-session";
import { appendAudit, createExport, transaction, verifyAudit, pruneAudit } from "./store";

const manifestPath=process.env.AUDIT_DISPOSAL_MANIFEST;
const approvalPath=process.env.AUDIT_DISPOSAL_APPROVAL;
if(!manifestPath||!approvalPath||!process.env.AUDIT_APP_TEST_URL) throw new Error("Pending exact manifest and separately approved one-run audit disposal");

test("pending PostgreSQL audit: immutable deletion refusal, privileged deletion detection and retention prune", async t => {
  const {pool:app,plan}=await claimAuditDisposal(manifestPath,approvalPath,process.env.AUDIT_APP_TEST_URL!);
  const tenant=plan.tenant, owner=plan.owner;
  const event = { actorId: owner, actorType: "human" as const, resourceId: plan.eventId, action: "credential.revoked", outcome: "success" as const, reason: "revoked" };
  try {
      let probesPassed=false;
      await t.test(
        "unauthorised mutation blocked and controlled privileged corruption/deletion/reorder detected",
        async () => {
          await assert.rejects(
            rollbackProbe(app,()=>app.query(
              "UPDATE security_audit_events SET hash='bad' WHERE tenant=$1",
              [tenant],
            )),
            /security_audit_immutable/,
          );
          await assert.rejects(
            rollbackProbe(app,()=>app.query("DELETE FROM security_audit_events WHERE tenant=$1", [
              tenant,
            ])),
            /security_audit_immutable/,
          );
          for (const corruption of [
            "UPDATE security_audit_events SET hash='bad' WHERE tenant=$1 AND seq=1",
            "DELETE FROM security_audit_events WHERE tenant=$1 AND seq=1",
            "UPDATE security_audit_events SET seq=99999 WHERE tenant=$1 AND seq=1",
          ]) {
            await assert.rejects(
              rollbackProbe(app, async () => {
                const tx=await app.connect();
                try { await tx.query(
                  "ALTER TABLE security_audit_events DISABLE TRIGGER security_audit_immutable",
                );
                await tx.query(corruption, [tenant]);
                await verifyAudit(tx, tenant);
                } finally { tx.release(); }
              }),
              /auditIntegrityViolation/,
            );
          }
          await transaction(app, (tx) => verifyAudit(tx, tenant));
          probesPassed=true;
        },
      );
      if(!probesPassed) throw new Error("Audit probes failed; prune forbidden");
      await t.test(
        "legal hold, export lease, checkpoint prune and tombstone replay after expiry",
        async () => {
          const aged = plan.agedTenant, id = plan.agedEventId;
          // Test-only age injection requires owner override; never expose this in an API.
          await transaction(app, async (tx) => {
            await tx.query(
              "ALTER TABLE security_audit_events DISABLE TRIGGER security_audit_immutable",
            );
            await tx.query(
              `UPDATE security_audit_events SET occurred_at=now()-interval '100 days', canonical=jsonb_set(canonical::jsonb,'{occurredAt}',to_jsonb(to_char((now()-interval '100 days') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')))::text WHERE tenant=$1`,
              [aged],
            );
            await tx.query(
              "UPDATE security_audit_events SET hash=encode(sha256(convert_to(prev_hash||E'\\n'||canonical,'UTF8')),'hex') WHERE tenant=$1",
              [aged],
            );
            await tx.query(
              "UPDATE security_audit_heads SET hash=(SELECT hash FROM security_audit_events WHERE tenant=$1) WHERE tenant=$1",
              [aged],
            );
            await tx.query(
              "ALTER TABLE security_audit_events ENABLE TRIGGER security_audit_immutable",
            );
            await tx.query(
              "UPDATE security_audit_heads SET legal_hold=true WHERE tenant=$1",
              [aged],
            );
          });
          await assert.rejects(
            rollbackProbe(app,async()=>{const tx=await app.connect();try{return await pruneAudit(tx,aged,owner);}finally{tx.release();}}),
            /auditLegalHold/,
          );
          await app.query(
            "UPDATE security_audit_heads SET legal_hold=false WHERE tenant=$1",
            [aged],
          );
          const snapshot = await transaction(app, (tx) =>
            createExport(tx, aged, owner, plan.exportId),
          );
          assert.equal(
            (await rollbackProbe(app,async()=>{const tx=await app.connect();try{return await pruneAudit(tx,aged,owner);}finally{tx.release();}}))
              .removed,
            0,
          );
          await app.query(
            "UPDATE security_audit_exports SET expires_at=now()-interval '1 second' WHERE id=$1",
            [snapshot.id],
          );
          assert.equal(
            (await transaction(app, async (tx) => {
                await tx.query("LOCK TABLE security_audit_events IN EXCLUSIVE MODE");
                const targets=(await tx.query(`SELECT e.id::text,e.seq::text,h.floor::text,h.retention_days AS retention,e.event,
                  e.occurred_at<clock_timestamp()-make_interval(days=>h.retention_days) AS expired
                  FROM security_audit_events e JOIN security_audit_heads h ON h.tenant=e.tenant
                  WHERE e.tenant=$1 ORDER BY e.seq`,[aged])).rows;
                validatePruneRows(targets,plan);
                const before=(await tx.query("SELECT tenant,id::text FROM security_audit_events ORDER BY tenant,id")).rows;
                const result=await pruneAudit(tx, aged, "system");
                assert.equal(result.removed,"1","disposal budget must pass before commit");
                const after=(await tx.query("SELECT tenant,id::text FROM security_audit_events ORDER BY tenant,id")).rows;
                const removed=before.filter(row=>!after.some(other=>other.tenant===row.tenant&&other.id===row.id));
                assert.deepEqual(removed,[{tenant:aged,id}],"only exact approved event may disappear before commit");
                return result;
              }))
              .removed,
            "1",
          );
          assert.equal(
            (
              await app.query(
                "SELECT event->>'actorType' AS type FROM security_audit_events WHERE tenant=$1 AND event->>'action'='audit.prune'",
                [aged],
              )
            ).rows[0].type,
            "system",
          );
          await appendAudit(app, aged, event, id);
          assert.equal(
            (
              await app.query(
                "SELECT count(*) FROM security_audit_events WHERE tenant=$1 AND id=$2",
                [aged, id],
              )
            ).rows[0].count,
            "0",
          );
          await transaction(app, (tx) => verifyAudit(tx, aged));
        },
      );
  } finally {
    // Retain all surviving fixtures and tombstones; never clean up this database.
    await app.end();
  }
});
