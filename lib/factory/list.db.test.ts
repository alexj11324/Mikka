// BE-2 / #445: list carries the current candidate's sha and its newest publication.
// Real migrations and store over a disposable *_e2e PG.
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Pool, type PoolClient } from "pg";
import { orderMigrations } from "../../scripts/migration-order.mjs";
import { createFactoryStore } from "./store";

const url = process.env.E2E_DATABASE_URL;
if (url) {
  // Same rule as #448's tests/helpers/e2e-target.mjs (switch to it in the guard follow-up).
  const u = new URL(url);
  assert.ok(["postgres:", "postgresql:"].includes(u.protocol) && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) && /^\/[A-Za-z0-9_]+_e2e$/.test(u.pathname) && !u.search, "loopback *_e2e only");
}
else if (process.env.REQUIRE_DB === "1") assert.fail("REQUIRE_DB=1 needs E2E_DATABASE_URL");

test("list: candidate sha + newest publication of the current candidate only", { skip: !url, timeout: 180000 }, async () => {
  const admin = new Pool({ connectionString: url, max: 1 });
  const database = `fac_list_${randomUUID().replaceAll("-", "")}_e2e`;
  await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`);
  const target = new URL(url!);
  target.pathname = `/${database}`;
  const pool = new Pool({ connectionString: target.toString(), max: 4 });
  try {
    const dir = new URL("../../drizzle/", import.meta.url);
    for (const f of orderMigrations((await readdir(dir)).filter((f) => f.endsWith(".sql"))))
      await pool.query(await readFile(new URL(f, dir), "utf8"));
    await pool.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES ('owner','Fixture','list@example.invalid',true,now(),now())`);
    const authorize = async (user: string, issue: string, tx: PoolClient) =>
      (await tx.query('SELECT id FROM issues WHERE id=$1 AND "userId"=$2', [issue, user])).rowCount === 1;
    const store = createFactoryStore(pool, authorize);
    const issueId = randomUUID(), sourceEventId = randomUUID();
    await pool.query(`INSERT INTO issues(id,"userId",title,content,status,priority) VALUES ($1,'owner','Fixture','{"type":"doc","content":[]}','todo','normal')`, [issueId]);
    await pool.query(`INSERT INTO coordinator_events (id,"userId",kind,"dedupeKey",payload) VALUES ($1,'owner','user_message',$2,'{"text":"synthetic"}')`, [sourceEventId, sourceEventId]);
    const routed = await store.route("owner", { issueId, sourceEventId, eventId: randomUUID(), rationale: "Task requested", missingInformation: [], missingPermissions: [], needsSpec: false });
    const taskId = routed.task.id;

    const empty = (await store.listForIssue("owner", issueId)).tasks[0];
    assert.equal(empty.candidateSha, null);
    assert.equal(empty.publication, null);

    const shaOld = "a".repeat(40), shaCur = "c".repeat(40);
    const oldCand = randomUUID(), curCand = randomUUID(), attempt = randomUUID();
    const candidate = (id: string, sha: string) => pool.query(`INSERT INTO factory_candidates(id,"taskId",sha,repository,environment,scope,"runId") VALUES ($1,$2,$3,'o/r','preview','repo',$4)`, [id, taskId, sha, randomUUID()]);
    await candidate(oldCand, shaOld);
    await candidate(curCand, shaCur);
    await pool.query(`INSERT INTO factory_attempts(id,"taskId",stage,ordinal,position,status,"candidateId",reason) VALUES ($1,$2,'approval',1,100,'passed',$3,'fixture')`, [attempt, taskId, curCand]);
    let n = 0;
    const publish = async (candidateId: string, status: string, createdAt: string, finishedAt: string | null) => {
      const approvalId = randomUUID(), id = randomUUID();
      n++;
      await pool.query(`INSERT INTO factory_approvals(id,"taskId","candidateId","attemptId","userId","principalId","humanSessionId","eventId",request,candidate,action,target,"evidenceDigest",evidence,"approvedRevision","publishAttemptId","publishRevision","expiresAt") VALUES ($1,$2,$3,$4,'owner','owner','s',$5,'{}','{}','deploy_preview','t${n}','d','{}',1,$4,1,now()+interval '1 hour')`, [approvalId, taskId, candidateId, attempt, randomUUID()]);
      await pool.query(`INSERT INTO factory_publications(id,"approvalId","taskId","candidateId",action,target,"eventId",request,status,"createdAt","finishedAt") VALUES ($1,$2,$3,$4,'deploy_preview','t${n}',$5,'{}',$6,$7,$8)`, [id, approvalId, taskId, candidateId, randomUUID(), status, createdAt, finishedAt]);
      return { id, approvalId };
    };
    // Newest overall belongs to the OLD candidate: dropping the candidateId filter would pick it.
    await publish(oldCand, "succeeded", "2026-10-30T09:00:00+00", "2026-10-30T09:01:00+00");
    const older = await publish(curCand, "succeeded", "2026-10-30T05:00:00+00", "2026-10-30T05:02:00+00");
    const newest = await publish(curCand, "uncertain", "2026-10-30T05:00:00+00", null);
    // Make DESC unambiguous: newest strictly later than older.
    await pool.query(`UPDATE factory_publications SET "createdAt"='2026-10-30T06:30:00+00' WHERE id=$1`, [newest.id]);
    await pool.query(`UPDATE factory_tasks SET "candidateId"=$2,"attemptId"=$3,reason='blocked: Bearer abc.def.ghi' WHERE id=$1`, [taskId, curCand, attempt]);

    const [row] = (await store.listForIssue("owner", issueId)).tasks;
    assert.equal(row.candidateId, curCand);
    assert.equal(row.candidateSha, shaCur);
    assert.deepEqual(row.publication, {
      id: newest.id, approvalId: newest.approvalId, status: "uncertain", action: "deploy_preview", target: "t3",
      createdAt: "2026-10-30T06:30:00.000Z", finishedAt: null,
    });
    assert.notEqual(row.publication!.id, older.id);
    assert.match(row.reason, /\[REDACTED\]/);
    assert.doesNotMatch(row.reason, /abc\.def\.ghi/);

    // finishedAt is ISO Z too.
    await pool.query(`DELETE FROM factory_publications WHERE id=$1`, [newest.id]);
    const [after] = (await store.listForIssue("owner", issueId)).tasks;
    assert.equal(after.publication?.id, older.id);
    assert.equal(after.publication?.finishedAt, "2026-10-30T05:02:00.000Z");
    assert.equal(after.publication?.createdAt, "2026-10-30T05:00:00.000Z");
  } finally {
    await pool.end();
    await admin.end();
  }
});
