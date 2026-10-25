import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

export class AuditError extends Error {
  constructor(
    readonly code: string,
    readonly status = 409,
  ) {
    super(code);
  }
}
export type AuditEvent = {
  actorId: string;
  actorType: "human" | "worker" | "system" | "anonymous";
  subjectId?: string;
  resourceId: string;
  action: string;
  outcome: "success" | "denied" | "failed" | "uncertain" | "pending";
  reason: string;
  requestId?: string;
  runId?: string;
  operationId?: string;
};
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export async function appendAudit(
  client: Pick<PoolClient, "query">,
  tenant: string,
  event: AuditEvent,
  id: string = randomUUID(),
) {
  await client.query("SELECT security_audit_append($1,$2,$3)", [
    tenant,
    id,
    event,
  ]);
}
export async function auditActor(
  tx: PoolClient,
  actorId: string,
  actorType: AuditEvent["actorType"],
  requestId: string,
) {
  await tx.query(
    "SELECT set_config('mikka.audit_actor',$1,true),set_config('mikka.audit_actor_type',$2,true),set_config('mikka.audit_request',$3,true)",
    [actorId, actorType, requestId],
  );
}
export async function transaction<T>(
  pool: Pool,
  work: (tx: PoolClient) => Promise<T>,
) {
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN");
    await tx.query(
      "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='20s'",
    );
    const result = await work(tx);
    await tx.query("COMMIT");
    return result;
  } catch (error) {
    await tx.query("ROLLBACK");
    throw error;
  } finally {
    tx.release();
  }
}
export async function head(tx: PoolClient, tenant: string) {
  await tx.query(
    "INSERT INTO security_audit_heads(tenant) VALUES($1) ON CONFLICT DO NOTHING",
    [tenant],
  );
  return (
    await tx.query(
      "SELECT * FROM security_audit_heads WHERE tenant=$1 FOR UPDATE",
      [tenant],
    )
  ).rows[0];
}
// Verifies the retained suffix against the recorded prefix checkpoint and current head.
// A privileged administrator can rewrite every checkpoint/head; this is not WORM storage.
export async function verifyAudit(tx: PoolClient, tenant: string) {
  const h = await head(tx, tenant);
  let seq = BigInt(h.floor),
    hash = h.floor_hash;
  const deadline = Date.now() + 15000;
  while (seq < BigInt(h.seq)) {
    if (Date.now() > deadline)
      throw new AuditError("auditVerificationTimeout", 503);
    const { rows } = await tx.query(
      "SELECT * FROM security_audit_events WHERE tenant=$1 AND seq>$2 ORDER BY seq LIMIT 1000",
      [tenant, seq.toString()],
    );
    if (!rows.length) throw new AuditError("auditIntegrityViolation");
    for (const row of rows) {
      seq++;
      let canonical: Record<string, unknown>;
      try {
        canonical = JSON.parse(row.canonical);
      } catch {
        throw new AuditError("auditIntegrityViolation");
      }
      if (
        BigInt(row.seq) !== seq ||
        row.prev_hash !== hash ||
        digest(`${hash}\n${row.canonical}`) !== row.hash ||
        canonical.version !== 1 ||
        new Date(canonical.occurredAt as string).getTime() !==
          row.occurred_at.getTime() ||
        canonical.tenant !== tenant ||
        canonical.seq !== row.seq ||
        canonical.id !== row.id ||
        JSON.stringify(canonical.data) !== JSON.stringify(row.event)
      )
        throw new AuditError("auditIntegrityViolation");
      hash = row.hash;
    }
  }
  // Detect surplus rows even when the recorded head was shortened.
  if (
    (
      await tx.query(
        "SELECT 1 FROM security_audit_events WHERE tenant=$1 AND (seq<=$2 OR seq>$3) LIMIT 1",
        [tenant, h.floor, h.seq],
      )
    ).rowCount
  )
    throw new AuditError("auditIntegrityViolation");
  if (seq !== BigInt(h.seq) || hash !== h.hash)
    throw new AuditError("auditIntegrityViolation");
  if (BigInt(h.floor) > BigInt(0)) {
    const checkpoint = (
      await tx.query(
        "SELECT hash FROM security_audit_checkpoints WHERE tenant=$1 AND through_seq=$2",
        [tenant, h.floor],
      )
    ).rows[0];
    if (checkpoint?.hash !== h.floor_hash)
      throw new AuditError("auditIntegrityViolation");
  }
  return h;
}
export async function createExport(
  tx: PoolClient,
  tenant: string,
  actor: string,
  id: string,
) {
  await head(tx, tenant);
  const existing = (
    await tx.query("SELECT * FROM security_audit_exports WHERE id=$1", [id])
  ).rows[0];
  if (existing) {
    if (existing.tenant !== tenant || existing.actor !== actor)
      throw new AuditError("auditExportConflict");
    if (existing.expires_at <= new Date())
      throw new AuditError("auditExportExpired", 410);
    return {
      ...existing,
      storeId: (await tx.query("SELECT id FROM security_audit_store")).rows[0]
        .id,
    };
  }
  await appendAudit(
    tx,
    tenant,
    {
      actorId: actor,
      actorType: "human",
      resourceId: id,
      action: "audit.export",
      outcome: "success",
      reason: "snapshot",
    },
    id,
  );
  const h = await verifyAudit(tx, tenant);
  const snapshot = (
    await tx.query(
      `INSERT INTO security_audit_exports(id,tenant,actor,lower_seq,upper_seq,count,start_hash,end_hash)
    VALUES($1,$2,$3,$4,$5,$5::bigint-$4::bigint,$6,$7) RETURNING *`,
      [id, tenant, actor, h.floor, h.seq, h.floor_hash, h.hash],
    )
  ).rows[0];
  return {
    ...snapshot,
    storeId: (await tx.query("SELECT id FROM security_audit_store")).rows[0].id,
  };
}
export async function exportPage(
  tx: PoolClient,
  tenant: string,
  actor: string,
  id: string,
  after: string,
  limit: number,
) {
  // Hold the head lock so retention cannot remove this page while it is read.
  await head(tx, tenant);
  const snapshot = (
    await tx.query(
      "SELECT * FROM security_audit_exports WHERE id=$1 AND tenant=$2 AND actor=$3 AND expires_at>clock_timestamp()",
      [id, tenant, actor],
    )
  ).rows[0];
  if (!snapshot) throw new AuditError("auditExportUnavailable", 410);
  if (
    BigInt(after) < BigInt(snapshot.lower_seq) ||
    BigInt(after) > BigInt(snapshot.upper_seq)
  )
    throw new AuditError("auditCursorInvalid", 422);
  const { rows } = await tx.query(
    "SELECT seq,canonical,prev_hash,hash FROM security_audit_events WHERE tenant=$1 AND seq>$2 AND seq<=$3 ORDER BY seq LIMIT $4",
    [tenant, after, snapshot.upper_seq, limit],
  );
  let expected = BigInt(after);
  let previous =
    after === snapshot.lower_seq
      ? snapshot.start_hash
      : (
          await tx.query(
            "SELECT hash FROM security_audit_events WHERE tenant=$1 AND seq=$2",
            [tenant, after],
          )
        ).rows[0]?.hash;
  for (const row of rows) {
    expected++;
    if (
      BigInt(row.seq) !== expected ||
      row.prev_hash !== previous ||
      digest(`${previous}\n${row.canonical}`) !== row.hash
    )
      throw new AuditError("auditIntegrityViolation");
    previous = row.hash;
  }
  if (!rows.length && BigInt(after) < BigInt(snapshot.upper_seq))
    throw new AuditError("auditIntegrityViolation");
  if (expected === BigInt(snapshot.upper_seq) && previous !== snapshot.end_hash)
    throw new AuditError("auditIntegrityViolation");
  snapshot.storeId = (
    await tx.query("SELECT id FROM security_audit_store")
  ).rows[0].id;
  return {
    snapshot,
    rows,
    next: expected < BigInt(snapshot.upper_seq) ? expected.toString() : null,
  };
}
export async function pruneAudit(
  tx: PoolClient,
  tenant: string,
  actor: string,
) {
  const h = await verifyAudit(tx, tenant);
  if (h.legal_hold) throw new AuditError("auditLegalHold");
  const active = (
    await tx.query(
      "SELECT min(lower_seq)::text AS floor FROM security_audit_exports WHERE tenant=$1 AND expires_at>clock_timestamp()",
      [tenant],
    )
  ).rows[0].floor;
  const row = (
    await tx.query(
      `SELECT seq,hash FROM security_audit_events WHERE tenant=$1 AND occurred_at<clock_timestamp()-make_interval(days=>$2)
    AND ($3::bigint IS NULL OR seq<=$3) ORDER BY seq DESC LIMIT 1`,
      [tenant, h.retention_days, active],
    )
  ).rows[0];
  if (!row) return { removed: 0 };
  // Only a contiguous prefix may expire, even if clocks move backwards.
  const blocked = (
    await tx.query(
      `SELECT min(seq)::text AS seq FROM security_audit_events WHERE tenant=$1 AND seq<=$2 AND occurred_at>=clock_timestamp()-make_interval(days=>$3)`,
      [tenant, row.seq, h.retention_days],
    )
  ).rows[0].seq;
  if (blocked) throw new AuditError("auditRetentionClockConflict");
  const count = (BigInt(row.seq) - BigInt(h.floor)).toString();
  await tx.query(
    "INSERT INTO security_audit_checkpoints(tenant,through_seq,hash,count) VALUES($1,$2,$3,$4)",
    [tenant, row.seq, row.hash, count],
  );
  await tx.query(
    "DELETE FROM security_audit_events WHERE tenant=$1 AND seq<=$2",
    [tenant, row.seq],
  );
  await tx.query(
    "UPDATE security_audit_heads SET floor=$2,floor_hash=$3 WHERE tenant=$1",
    [tenant, row.seq, row.hash],
  );
  await appendAudit(tx, tenant, {
    actorId: actor,
    actorType: "human",
    resourceId: tenant,
    action: "audit.prune",
    outcome: "success",
    reason: "retention_expired",
  });
  return { removed: count, through: row.seq, checkpoint: row.hash };
}
