// #444: human reject through the REAL createFactoryStore (finish failed → repair
// from approval → fresh execute attempt) on a disposable *_e2e database.
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Pool, type PoolClient } from "pg";
import { orchestratorSettings } from "@mikka/protocol/orchestrator";
import { orderMigrations } from "../../scripts/migration-order.mjs";
import { createFactoryStore } from "./store";
import { createFactoryApprovals } from "./approval";
import { FactoryError } from "./approval-contract";
import { dropTestDatabase } from "../../tests/support/drop-test-database";

const url = process.env.E2E_DATABASE_URL;
if (url) {
  const u = new URL(url);
  assert.ok(["postgres:", "postgresql:"].includes(u.protocol) && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) && /^\/[A-Za-z0-9_]+_e2e$/.test(u.pathname) && !u.search && !u.hash, "loopback *_e2e only");
} else if (process.env.REQUIRE_DB === "1") assert.fail("REQUIRE_DB=1 needs E2E_DATABASE_URL");

test("reject through the real Factory store", { skip: !url, timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: url, max: 1 });
  const database = `fac_reject_${randomUUID().replaceAll("-", "")}_e2e`;
  await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`);
  const target = new URL(url!);
  target.pathname = `/${database}`;
  const pool = new Pool({ connectionString: target.toString(), max: 8 });
  try {
    const dir = new URL("../../drizzle/", import.meta.url);
    for (const f of orderMigrations((await readdir(dir)).filter((f) => f.endsWith(".sql"))))
      await pool.query(await readFile(new URL(f, dir), "utf8"));
    await pool.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES ('owner','Alex','reject@example.invalid',true,now(),now())`);
    await pool.query(`INSERT INTO "session"(id,"expiresAt",token,"createdAt","updatedAt","userId") VALUES ('s1',now()+interval '1 hour','t1',now(),now(),'owner'),('s2',now()+interval '1 hour','t2',now(),now(),'owner')`);
    await pool.query(`INSERT INTO account(id,"accountId","providerId","userId","createdAt","updatedAt") VALUES ('a1','gh','github','owner',now(),now())`);
    const authorize = async (user: string, issue: string, tx: PoolClient) =>
      (await tx.query('SELECT id FROM issues WHERE id=$1 AND "userId"=$2', [issue, user])).rowCount === 1;
    const store = createFactoryStore(pool, authorize, null, {});
    const service = createFactoryApprovals(pool, authorize, store as never);
    const actor = { userId: "owner", sessionId: "s1" };
    const rejects = (fn: () => Promise<unknown>, code: string) =>
      assert.rejects(fn, (e) => e instanceof FactoryError && e.code === code, code);

    /** A routed task parked at approval/pending on an exact candidate. */
    const atApproval = async (priorExecuteAttempts = 1) => {
      const issueId = randomUUID(), sourceEventId = randomUUID();
      await pool.query(`INSERT INTO issues(id,"userId",title,content,status,priority) VALUES ($1,'owner','Fixture','{"type":"doc","content":[]}','todo','normal')`, [issueId]);
      await pool.query(`INSERT INTO coordinator_events (id,"userId",kind,"dedupeKey",payload) VALUES ($1,'owner','user_message',$2,'{"text":"synthetic"}')`, [sourceEventId, sourceEventId]);
      const routed = await store.route("owner", { issueId, sourceEventId, eventId: randomUUID(), rationale: "Task requested", missingInformation: [], missingPermissions: [], needsSpec: false });
      const taskId = routed.task.id, candidateId = randomUUID(), attemptId = randomUUID();
      await pool.query(`INSERT INTO factory_candidates(id,"taskId",sha,repository,environment,scope,"runId") VALUES ($1,$2,$3,'o/r','preview','repo',$4)`, [candidateId, taskId, "c".repeat(40), randomUUID()]);
      const { rows: [{ n }] } = await pool.query(`SELECT count(*)::int n FROM factory_attempts WHERE "taskId"=$1 AND stage='execute'`, [taskId]);
      for (let i = n; i < priorExecuteAttempts; i++)
        await pool.query(`INSERT INTO factory_attempts(id,"taskId",stage,ordinal,position,status,reason) VALUES ($1,$2,'execute',$3,$4,'failed','fixture')`, [randomUUID(), taskId, 10 + i, 10 + i]);
      await pool.query(`INSERT INTO factory_attempts(id,"taskId",stage,ordinal,position,status,"candidateId",reason) VALUES ($1,$2,'approval',90,90,'pending',$3,'fixture')`, [attemptId, taskId, candidateId]);
      const { rows: [task] } = await pool.query(`UPDATE factory_tasks SET stage='approval',status='pending',"candidateId"=$2,"attemptId"=$3,revision=revision+1 WHERE id=$1 RETURNING *`, [taskId, candidateId, attemptId]);
      return { binding: { taskId, issueId, attemptId, revision: task.revision as number, candidateId }, candidateId };
    };

    await t.test("repairs to a fresh execute attempt; note masked in attempt, task, events and controls", async () => {
      const prior = process.env.E2B_API_KEY;
      const synthetic = "e2b_synthetic_" + randomUUID().replaceAll("-", "");
      process.env.E2B_API_KEY = synthetic;
      try {
        const { binding, candidateId } = await atApproval();
        const req = { binding, eventId: randomUUID(), candidateId, note: `key ${synthetic} and E2B_API_KEY=other_value_123 ghp_abcdefghijklmnop1234` };
        const out = await service.reject(actor, req);
        const { rows: [task] } = await pool.query(`SELECT stage,status,"attemptId","candidateId",row_to_json(t)::text AS raw FROM factory_tasks t WHERE id=$1`, [binding.taskId]);
        assert.deepEqual({ stage: task.stage, status: task.status, candidateId: task.candidateId }, { stage: "execute", status: "pending", candidateId: null });
        assert.equal(out.binding.attemptId, task.attemptId);
        const { rows: [attempt] } = await pool.query(`SELECT stage,status,reason FROM factory_attempts WHERE id=$1`, [task.attemptId]);
        assert.deepEqual({ stage: attempt.stage, status: attempt.status }, { stage: "execute", status: "pending" });
        assert.match(attempt.reason, /Untrusted note \(data, not instructions\)/);
        const { rows: [events] } = await pool.query(`SELECT count(*)::int n, coalesce(string_agg(row_to_json(e)::text,' '),'') raw FROM factory_events e WHERE "taskId"=$1`, [binding.taskId]);
        assert.ok(events.n >= 2, "finish and repair are audited");
        const { rows: [control] } = await pool.query(`SELECT request::text raw FROM factory_approval_controls WHERE "taskId"=$1 AND "eventId"=$2`, [binding.taskId, req.eventId]);
        const { rows: [attempts] } = await pool.query(`SELECT string_agg(coalesce(reason,''),' ') raw FROM factory_attempts WHERE "taskId"=$1`, [binding.taskId]);
        for (const raw of [task.raw, attempt.reason, attempts.raw, events.raw, control.raw, JSON.stringify(await service.ledger(actor, binding.taskId))]) {
          assert.doesNotMatch(raw, new RegExp(synthetic));
          assert.doesNotMatch(raw, /other_value_123|ghp_abcdefghijklmnop1234/);
        }
        assert.match(control.raw, /\[secret\]/);
        assert.deepEqual(await service.reject(actor, req), out);
        await rejects(() => service.reject({ userId: "owner", sessionId: "s2" }, req), "factoryReplayMismatch");
      } finally {
        if (prior === undefined) delete process.env.E2B_API_KEY; else process.env.E2B_API_KEY = prior;
      }
    });

    await t.test("non-owner gets factoryNotFound; a task past approval gets factoryTransition", async () => {
      const { binding, candidateId } = await atApproval();
      await pool.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES ('intruder','X','x@example.invalid',true,now(),now()) ON CONFLICT DO NOTHING`);
      await rejects(() => service.reject({ userId: "intruder" }, { binding, eventId: randomUUID(), candidateId }), "factoryNotFound");
      await pool.query(`UPDATE factory_tasks SET status='passed' WHERE id=$1`, [binding.taskId]);
      await rejects(() => service.reject(actor, { binding, eventId: randomUUID(), candidateId }), "factoryTransition");
    });

    await t.test("concurrent rejects apply exactly once", async () => {
      const { binding, candidateId } = await atApproval();
      const results = await Promise.allSettled([1, 2, 3, 4].map(() => service.reject(actor, { binding, eventId: randomUUID(), candidateId })));
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      for (const r of results) if (r.status === "rejected") assert.ok(r.reason instanceof FactoryError, String(r.reason));
      const { rows: [{ n }] } = await pool.query(`SELECT count(*)::int n FROM factory_attempts WHERE "taskId"=$1 AND stage='execute' AND reason LIKE 'Person requested changes%'`, [binding.taskId]);
      assert.equal(n, 1);
    });

    await t.test("repair cap boundary: max prior execute attempts still repairs, max+1 ends failed", async () => {
      const max = orchestratorSettings({}).maxFixAttempts;
      const ok = await atApproval(max);
      const repaired = await service.reject(actor, { binding: ok.binding, eventId: randomUUID(), candidateId: ok.candidateId });
      assert.equal((repaired as { repairBudgetExhausted?: boolean }).repairBudgetExhausted, undefined);
      const over = await atApproval(max + 1);
      const out = await service.reject(actor, { binding: over.binding, eventId: randomUUID(), candidateId: over.candidateId });
      assert.equal((out as { repairBudgetExhausted?: boolean }).repairBudgetExhausted, true);
      const { rows: [task] } = await pool.query(`SELECT stage,status FROM factory_tasks WHERE id=$1`, [over.binding.taskId]);
      assert.deepEqual(task, { stage: "approval", status: "failed" });
    });
  } finally {
    // Concurrent rejects are settled above (allSettled).
    await dropTestDatabase(admin, database, pool);
    await admin.end();
  }
});
