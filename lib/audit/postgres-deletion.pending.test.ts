// Pending acceptance: this entry performs real synthetic row deletion.
// It is NOT part of test:audit. An execution flag records a separately reviewed
// authorization; fixture-retention flags alone never enable this entry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { appendAudit, createExport, transaction, verifyAudit, pruneAudit } from "./store";

if (process.env.AUDIT_DELETION_ACCEPTANCE_AUTHORIZED !== "1") {
  throw new Error("Pending audit deletion acceptance requires separate explicit authorization");
}
const target = new URL(process.env.AUDIT_APP_TEST_URL ?? "http://invalid");
assert.ok(["postgres:", "postgresql:"].includes(target.protocol));
assert.equal(target.hostname, "127.0.0.1");
assert.ok(target.pathname.endsWith("_e2e"));
assert.equal(target.search, "");
assert.equal(target.hash, "");

test("pending PostgreSQL audit: immutable deletion refusal, privileged deletion detection and retention prune", async t => {
  // The dedicated isolated database must already have the tracked audit schema.
  // Only UUID tenants created by this invocation are passed to the deletion cases.
  const app = new Pool({ connectionString: target.href });
  const tenant = randomUUID(), owner = `audit_pending_${randomUUID()}`;
  const event = { actorId: owner, actorType: "human" as const, resourceId: randomUUID(), action: "credential.revoked", outcome: "success" as const, reason: "revoked" };
  try {
    await appendAudit(app, tenant, event);
      await t.test(
        "unauthorised mutation blocked and controlled privileged corruption/deletion/reorder detected",
        async () => {
          await assert.rejects(
            app.query(
              "UPDATE security_audit_events SET hash='bad' WHERE tenant=$1",
              [tenant],
            ),
            /security_audit_immutable/,
          );
          await assert.rejects(
            app.query("DELETE FROM security_audit_events WHERE tenant=$1", [
              tenant,
            ]),
            /security_audit_immutable/,
          );
          for (const corruption of [
            "UPDATE security_audit_events SET hash='bad' WHERE tenant=$1 AND seq=1",
            "DELETE FROM security_audit_events WHERE tenant=$1 AND seq=1",
            "UPDATE security_audit_events SET seq=99999 WHERE tenant=$1 AND seq=1",
          ]) {
            await assert.rejects(
              transaction(app, async (tx) => {
                await tx.query(
                  "ALTER TABLE security_audit_events DISABLE TRIGGER security_audit_immutable",
                );
                await tx.query(corruption, [tenant]);
                await verifyAudit(tx, tenant);
              }),
              /auditIntegrityViolation/,
            );
          }
          await transaction(app, (tx) => verifyAudit(tx, tenant));
        },
      );
      await t.test(
        "legal hold, export lease, checkpoint prune and tombstone replay after expiry",
        async () => {
          const aged = randomUUID(),
            id = randomUUID();
          await appendAudit(app, aged, event, id);
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
            transaction(app, (tx) => pruneAudit(tx, aged, owner)),
            /auditLegalHold/,
          );
          await app.query(
            "UPDATE security_audit_heads SET legal_hold=false WHERE tenant=$1",
            [aged],
          );
          const snapshot = await transaction(app, (tx) =>
            createExport(tx, aged, owner, randomUUID()),
          );
          assert.equal(
            (await transaction(app, (tx) => pruneAudit(tx, aged, owner)))
              .removed,
            0,
          );
          await app.query(
            "UPDATE security_audit_exports SET expires_at=now()-interval '1 second' WHERE id=$1",
            [snapshot.id],
          );
          assert.equal(
            (await transaction(app, (tx) => pruneAudit(tx, aged, "system")))
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
