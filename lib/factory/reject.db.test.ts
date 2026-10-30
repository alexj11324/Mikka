import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { factory194Fixture } from "../../tests/helpers/factory194";
import { factory194Target } from "../../tests/helpers/factory194-target";
import { FactoryError } from "./approval-contract";
import { handleFactoryApproval } from "./approval-http";

const ci = process.env.CI === "true" && process.env.GITHUB_ACTIONS === "true";
const db =
  process.env.FACTORY194_TEST_URL ??
  (ci ? process.env.E2E_DATABASE_URL : undefined);
if (process.env.REQUIRE_DB === "1" && !db)
  throw new Error("Factory reject DB test requires an explicit disposable database");
if (db) factory194Target(db, ci);
const rejects = (fn: () => Promise<unknown>, code: string) =>
  assert.rejects(fn, (e) => e instanceof FactoryError && e.code === code);

test("human reject sends the candidate back to execute", { skip: !db, timeout: 120000 }, async (t) => {
  const f = await factory194Fixture(db!);
  try {
    const { actor, pool } = f;
    const service = f.service([f.adapter], null);
    await pool.query('INSERT INTO "user" (id,name) VALUES ($1,$2) ON CONFLICT DO NOTHING', [actor.userId, "Alex"]);

    await t.test("reject revokes open grants, repairs to execute and is idempotent", async () => {
      // Once a grant moved the task past approval, reject is no longer allowed.
      const granted = await f.prepare();
      const human = { ...granted.approval } as Record<string, unknown>;
      delete human.decisionCredentialId;
      const approved = await service.approve(actor, human);
      await rejects(
        () => service.reject(actor, { binding: approved.binding, eventId: randomUUID(), candidateId: granted.approval.binding.candidateId! }),
        "factoryTransition",
      );
      const x = await f.prepare();
      const binding = x.approval.binding;
      // An open (not yet consumed) grant on the candidate must be revoked by reject.
      await pool.query(
        `INSERT INTO factory_approvals SELECT gen_random_uuid(),$1,$2,$4,"userId","principalId","humanSessionId","decisionCredentialId","decisionScope","decisionEvidence",gen_random_uuid(),request,candidate,action,target,"evidenceDigest",evidence,"approvedRevision",$4,"publishRevision","expiresAt",NULL,"createdAt" FROM factory_approvals WHERE id=$3`,
        [binding.taskId, binding.candidateId, approved.approvalId, binding.attemptId],
      );
      const req = {
        binding,
        eventId: randomUUID(),
        candidateId: binding.candidateId!,
        note: "  按钮颜色不对  ",
        failedEvidence: [] as string[],
      };
      const out = await service.reject(actor, req);
      assert.equal(out.rejectionId, req.eventId);
      assert.equal(out.binding.candidateId, null);
      assert.deepEqual(await service.reject(actor, req), out);
      await rejects(() => service.reject(actor, { ...req, note: "x" }), "factoryReplayMismatch");
      const { rows: [after] } = await pool.query("SELECT stage,status FROM factory_tasks WHERE id=$1", [binding.taskId]);
      assert.deepEqual(after, { stage: "execute", status: "pending" });
      const { rows: open } = await pool.query('SELECT id FROM factory_approvals WHERE "taskId"=$1 AND "revokedAt" IS NULL', [binding.taskId]);
      assert.equal(open.length, 0);
      const ledger = await service.ledger(actor, binding.taskId);
      assert.equal(ledger.rejections.length, 1);
      assert.equal(ledger.rejections[0].note, "按钮颜色不对");
      assert.equal(ledger.rejections[0].actor.name, "Alex");
      assert.equal(ledger.rejections[0].failedEvidenceCount, 0);
    });

    await t.test("reject on a pending approval task, with evidence validation", async () => {
      const x = await f.prepare();
      const binding = x.approval.binding;
      const base = { binding, candidateId: binding.candidateId! };
      await rejects(() => service.reject(actor, { ...base, eventId: randomUUID(), candidateId: randomUUID() }), "factoryTransition");
      await rejects(() => service.reject(actor, { ...base, eventId: randomUUID(), failedEvidence: ["nope"] }), "factoryEvidenceMismatch");
      await rejects(() => service.reject(actor, { ...base, eventId: randomUUID(), note: "x".repeat(2001) }), "factoryInvalid");
      await rejects(() => service.reject({ userId: actor.userId }, { ...base, eventId: randomUUID() }), "factoryHumanRequired");
      const ev = await service.evidence(actor, binding.taskId).catch(() => null);
      const refs = (ev?.manifest?.artifacts ?? []).slice(0, 1).map((a: { artifact: string }) => a.artifact);
      const res = await handleFactoryApproval(service, {
        actor,
        authorization: null,
        method: "POST",
        taskId: binding.taskId,
        origin: "http://x",
        url: "http://x/api/factory/approval",
        body: { operation: "reject", input: { ...base, eventId: randomUUID(), note: "重做", failedEvidence: refs } },
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const ledger = await service.ledger(actor, binding.taskId);
      assert.equal(ledger.rejections.at(-1)!.failedEvidenceCount, refs.length);
      await rejects(() => service.reject(actor, { binding, eventId: randomUUID(), candidateId: binding.candidateId! }), "factoryStale");
    });
  } finally {
    await f.close();
  }
});
