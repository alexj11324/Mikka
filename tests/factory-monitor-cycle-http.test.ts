import { factoryTestLifecycle } from "./helpers/factory-test-authority";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import test from "node:test";
import { Pool } from "pg";
import { createFactoryStore, type FactoryTask } from "../lib/factory/store";
import type { FactoryStage } from "../lib/factory/contract";

test(
  "real isolated HTTP: passed monitor retry, replay, owner/revision/stop/access boundaries",
  {
    skip: process.env.FACTORY_CYCLE_LOCAL_HTTP !== "1",
    timeout: 120000,
  },
  async () => {
    const origin = new URL(process.env.FACTORY_CYCLE_HTTP_ORIGIN!);
    const target = new URL(process.env.FACTORY_CYCLE_TEST_URL!);
    assert.equal(origin.protocol, "http:");
    assert.ok(["localhost", "127.0.0.1"].includes(origin.hostname));
    assert.equal(target.hostname, "127.0.0.1");
    assert.equal(target.pathname, "/mikka_e2e");
    if (process.env.CI === "true" && process.env.GITHUB_ACTIONS === "true") {
      assert.equal(target.toString(), process.env.E2E_DATABASE_URL);
      assert.equal(target.username, "e2e");
    } else assert.equal(target.username, "factorycycle192");
    const pool = new Pool({ connectionString: target.toString(), max: 4 });
    const requests: {
      method: string;
      path: string;
      status: number;
      at: string;
    }[] = [];
    function client() {
      const cookies = new Map<string, string>();
      const ip = `198.18.${randomBytes(1)[0]}.${1 + (randomBytes(1)[0] % 254)}`;
      return async (
        path: string,
        method = "GET",
        body?: unknown,
        extra: Record<string, string> = {},
      ) => {
        const headers: Record<string, string> = { "x-forwarded-for": ip, ...extra };
        if (cookies.size)
          headers.cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
        if (body !== undefined) {
          headers["content-type"] = "application/json";
          headers.origin = origin.origin;
        }
        const response = await fetch(new URL(`/mikka${path}`, origin), {
          method,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        for (const line of response.headers.getSetCookie()) {
          const pair = line.split(";", 1)[0],
            split = pair.indexOf("=");
          cookies.set(pair.slice(0, split), pair.slice(split + 1));
        }
        requests.push({
          method,
          path,
          status: response.status,
          at: new Date().toISOString(),
        });
        return { status: response.status, body: await response.json() };
      };
    }
    const owner = client(),
      other = client(),
      anonymous = client();
    const password = randomBytes(32).toString("base64url");
    const binding = (task: FactoryTask) => ({
      taskId: task.id,
      issueId: task.issueId,
      attemptId: task.attemptId,
      revision: task.revision,
      candidateId: task.candidateId,
    });
    const control = (
      task: FactoryTask,
      action = "retry",
      eventId = randomUUID(),
    ) => ({
      binding: binding(task),
      eventId,
      action,
      reason: "Isolated observation control fixture",
    });
    const path = (task: FactoryTask) => `/api/factory/tasks/${task.id}`;
    try {
      const signup = await owner("/api/auth/sign-up/email", "POST", {
        email: `cycle-${randomUUID()}@example.invalid`,
        password,
        name: "Cycle fixture",
      });
      assert.equal(signup.status, 200);
      const otherSignup = await other("/api/auth/sign-up/email", "POST", {
        email: `cycle-other-${randomUUID()}@example.invalid`,
        password,
        name: "Other fixture",
      });
      assert.equal(otherSignup.status, 200);
      const ownerId = signup.body.user.id as string;
      const agentId = randomUUID();
      await pool.query(
        `INSERT INTO agents (id,"userId",name,harness) VALUES ($1,$2,'HTTP cycle fixture','codex')`,
        [agentId, ownerId],
      );
      const store = createFactoryStore(
        pool,
        async (userId, issueId, tx) =>
          (
            await tx.query(
              `SELECT id FROM issues WHERE id=$1 AND "userId"=$2`,
              [issueId, userId],
            )
          ).rowCount === 1,
        null, factoryTestLifecycle,
      );
      // Seed the prior passed observation explicitly; no real monitoring is claimed.
      const fixture = async (stage: FactoryStage = "monitor") => {
        const issueId = randomUUID(),
          sourceId = randomUUID(),
          runId = randomUUID(),
          candidateId = randomUUID();
        await pool.query(
          `INSERT INTO issues (id,"userId",title,content,status,priority) VALUES ($1,$2,'HTTP cycle fixture','{}','todo','normal')`,
          [issueId, ownerId],
        );
        await pool.query(
          `INSERT INTO coordinator_events (id,"userId",kind,"dedupeKey",payload) VALUES ($1,$2,'user_message',$3,'{"text":"fixture"}')`,
          [sourceId, ownerId, sourceId],
        );
        const routed = await store.route(ownerId, {
          issueId,
          sourceEventId: sourceId,
          eventId: randomUUID(),
          rationale: "Explicit HTTP fixture",
        });
        await pool.query(
          `INSERT INTO agent_runs (id,"userId","issueId","agentId",status,"sessionId") VALUES ($1,$2,$3,$4,'succeeded','old-http-fixture')`,
          [runId, ownerId, issueId, agentId],
        );
        await pool.query(
          `INSERT INTO factory_candidates (id,"taskId",sha,repository,environment,scope,"runId") VALUES ($1,$2,$3,'alexj11324/Mikka','isolated-http-fixture','fixture only',$4)`,
          [candidateId, routed.task.id, "a".repeat(40), runId],
        );
        await pool.query(
          `UPDATE factory_attempts SET stage=$2,status='passed',"candidateId"=$3,"runId"=$4,"sessionId"='old-http-fixture',output='{"old":true}',evidence='[{"old":true}]',"finishedAt"=now() WHERE id=$1`,
          [routed.task.attemptId, stage, candidateId, runId],
        );
        await pool.query(
          `UPDATE factory_tasks SET stage=$2,status='passed',"candidateId"=$3 WHERE id=$1`,
          [routed.task.id, stage, candidateId],
        );
        return (await store.read(ownerId, routed.task.id)).task;
      };
      const task = await fixture(),
        request = control(task);
      const old = (
        await pool.query(
          `SELECT row_to_json(a) AS value FROM factory_attempts a WHERE id=$1`,
          [task.attemptId],
        )
      ).rows[0].value;
      assert.equal((await anonymous(path(task), "POST", request)).status, 401);
      assert.equal(
        (
          await anonymous(path(task), "POST", request, {
            authorization: "Bearer fixture-worker-token",
          })
        ).status,
        401,
      );
      assert.equal((await other(path(task), "POST", request)).status, 404);
      assert.equal(
        (
          await owner(path(task), "POST", {
            ...request,
            binding: { ...request.binding, revision: request.binding.revision + 1 },
          })
        ).status,
        409,
      );
      assert.equal(
        (await pool.query('SELECT revision FROM factory_tasks WHERE id=$1', [task.id])).rows[0].revision,
        task.revision,
        "a mismatched revision must leave the task unchanged",
      );
      const next = await owner(path(task), "POST", request);
      assert.equal(next.status, 200);
      assert.equal(next.body.task.status, "pending");
      assert.equal(next.body.task.candidateId, task.candidateId);
      const current = next.body.attempts.find(
        (attempt: { id: string }) => attempt.id === next.body.task.attemptId,
      );
      assert.equal(current.runId, null);
      assert.equal(current.sessionId, null);
      assert.deepEqual(current.output, {});
      assert.deepEqual(current.evidence, []);
      assert.equal(
        (await owner(path(task), "POST", request)).body.task.attemptId,
        next.body.task.attemptId,
      );
      assert.equal(
        (await owner(path(task), "POST", control(task))).status,
        409,
      );
      assert.deepEqual(
        (
          await pool.query(
            `SELECT row_to_json(a) AS value FROM factory_attempts a WHERE id=$1`,
            [task.attemptId],
          )
        ).rows[0].value,
        old,
      );
      assert.equal(
        (
          await owner(path(task), "POST", {
            ...control(next.body.task),
            action: "finish",
            status: "passed",
          })
        ).status,
        422,
      );
      for (const action of ["cancel", "revoke"]) {
        const fresh = await fixture(),
          cycle = control(fresh);
        const result = await owner(path(fresh), "POST", cycle);
        assert.equal(result.status, 200);
        assert.equal(
          (await owner(path(fresh), "POST", control(result.body.task, action)))
            .status,
          200,
        );
        const denied = await owner(path(fresh), "POST", cycle);
        assert.equal(denied.status, 409);
        assert.equal(denied.body.error, "factoryStopped");
      }
      const revoked = await fixture(),
        cycle = control(revoked);
      assert.equal((await owner(path(revoked), "POST", cycle)).status, 200);
      await pool.query(`UPDATE issues SET "userId"=$2 WHERE id=$1`, [
        revoked.issueId,
        otherSignup.body.user.id,
      ]);
      assert.equal((await owner(path(revoked), "POST", cycle)).status, 404);
      assert.equal((await other(path(revoked), "POST", cycle)).status, 404);
      const deleted = await fixture();
      await pool.query(
        `UPDATE issues SET content='{"attrs":{"mikka":{"deletedAt":"2026-10-25T00:00:00Z"}}}' WHERE id=$1`,
        [deleted.issueId],
      );
      assert.equal(
        (await owner(path(deleted), "POST", control(deleted))).status,
        404,
      );
      const passedVerify = await fixture("verify");
      assert.equal(
        (await owner(path(passedVerify), "POST", control(passedVerify))).status,
        409,
      );
      assert.equal((await owner(path(task))).status, 200);
      assert.equal((await owner("/api/auth/sign-out", "POST", {})).status, 200);
      assert.equal((await owner(path(task))).status, 401);
      const evidenceDir = process.env.FACTORY_CYCLE_EVIDENCE_DIR;
      if (evidenceDir) {
        await mkdir(evidenceDir, { recursive: true });
        await writeFile(
          `${evidenceDir}/http-evidence.json`,
          JSON.stringify(
            {
              fixture: true,
              environment: "local official Node24/Next16 + disposable PG17",
              requests,
              checked: [
                "candidate retained",
                "new evidence empty",
                "old passed unchanged",
                "idempotent replay",
                "stale binding",
                "owner",
                "no worker bearer bypass",
                "cancel",
                "revoke",
                "live access revoked",
                "deleted",
                "other passed stage",
                "signout",
              ],
            },
            null,
            2,
          ),
        );
      }
      console.log(
        `Passed ${requests.length} isolated HTTP requests; fixture state only, no Preview/Harness claim`,
      );
    } finally {
      await pool.end();
    }
  },
);
