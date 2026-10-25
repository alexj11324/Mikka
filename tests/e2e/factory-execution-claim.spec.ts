import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { test, expect, app } from "./fixtures";
import { createFactoryStore, type FactoryTask } from "../../lib/factory/store";
import { createFactoryDispatch } from "../../lib/factory/dispatch";
import { factoryCheckGates } from "../../lib/factory/checks";
import { factoryDispatchDatabase } from "../../lib/factory/transaction";
import { insertRunOnce } from "../../lib/run-dispatch";

// Real HTTP + PG, explicit synthetic daemon reports. Not real Harness acceptance.
test("Factory execution claims reject stopped tasks and unadopted retry children before token issuance", async ({
  playwright,
  baseURL,
}, testInfo) => {
  test.skip(
    process.env.CI !== "true" || process.env.GITHUB_ACTIONS !== "true",
    "Disposable CI service only",
  );
  const target = new URL(process.env.E2E_DATABASE_URL!);
  expect(target.hostname).toBe("127.0.0.1");
  expect(target.pathname).toBe("/mikka_e2e");
  const pool = new Pool({ connectionString: target.toString(), max: 3 });
  const userId = `factory-check-ci-${randomUUID()}`,
    issueId = randomUUID(),
    agentId = randomUUID(),
    deviceId = randomUUID(),
    repoId = randomUUID(),
    sourceEventId = randomUUID(),
    tokenId = randomUUID();
  const token = `orv_${randomBytes(32).toString("base64url")}`;
  const client = await playwright.request.newContext({
    baseURL,
    extraHTTPHeaders: { authorization: `Bearer ${token}` },
  });
  const bind = (t: FactoryTask) => ({
    taskId: t.id,
    issueId: t.issueId,
    attemptId: t.attemptId,
    revision: t.revision,
    candidateId: t.candidateId,
  });
  try {
    await pool.query(
      `INSERT INTO issues (id,"userId",title,content,status,priority) VALUES ($1,$2,'Check HTTP fixture','{}','todo','normal')`,
      [issueId, userId],
    );
    await pool.query(
      `INSERT INTO coordinator_events (id,"userId",kind,"dedupeKey",payload) VALUES ($1,$2,'user_message',$3,'{}')`,
      [sourceEventId, userId, `check-ci:${sourceEventId}`],
    );
    await pool.query(
      `INSERT INTO devices (id,"ownerId",name,enabled,"lastSeenAt",harnesses) VALUES ($1,$2,'Check HTTP fixture',true,now(),'[{"harness":"codex","installed":true,"version":"fixture"}]')`,
      [deviceId, userId],
    );
    await pool.query(
      `INSERT INTO device_tokens (id,"userId","tokenHash") VALUES ($1,$2,$3)`,
      [tokenId, userId, createHash("sha256").update(token).digest("hex")],
    );
    await pool.query(
      `INSERT INTO agents (id,"userId",name,harness,"deviceId") VALUES ($1,$2,'Check HTTP fixture','codex',$3)`,
      [agentId, userId, deviceId],
    );
    await pool.query(
      `INSERT INTO device_repos (id,"deviceId","userId","repoPath","verifyCommand") VALUES ($1,$2,$3,'/ci/check-http','node acceptance.mjs')`,
      [repoId, deviceId, userId],
    );
    const evidence = [];
    for (const mode of [
      "cancel",
      "revoke",
      "retry",
      "stale",
      "race",
      "allowed",
      "ordinary-stop",
    ]) {
      const fixtureIssue = randomUUID(),
        event = randomUUID();
      await pool.query(
        `INSERT INTO issues (id,"userId",title,content,status,priority) VALUES ($1,$2,'Execution HTTP fixture','{}','todo','normal')`,
        [fixtureIssue, userId],
      );
      await pool.query(
        `INSERT INTO coordinator_events (id,"userId",kind,"dedupeKey",payload) VALUES ($1,$2,'user_message',$1::text,'{}')`,
        [event, userId],
      );
      const store = createFactoryStore(
        pool,
        async (u, issue) => u === userId && issue === fixtureIssue,
        factoryCheckGates,
      );
      const dispatcher = createFactoryDispatch(pool, store, (tx, u, input) =>
        insertRunOnce(factoryDispatchDatabase(tx), u, input, {
          deviceId,
          baseBranch: "main",
          prompt: "Explicit fixture",
        }),
      );
      const initial = await store.route(userId, {
        issueId: fixtureIssue,
        sourceEventId: event,
        eventId: randomUUID(),
        rationale: "Claim regression",
        needsSpec: mode !== "revoke",
      });
      const queued = await dispatcher(userId, {
        binding: bind(initial.task),
        agentId,
        deviceRepoId: repoId,
      });
      const state = await store.read(userId, initial.task.id);
      let runId = queued.runId;
      if (mode === "retry") {
        runId = randomUUID();
        await pool.query(
          `UPDATE agent_runs SET status='failed',"stopReason"='device_lost' WHERE id=$1`,
          [queued.runId],
        );
        await pool.query(
          `INSERT INTO agent_runs (id,"userId","issueId","agentId","deviceId","deviceRepoId",status,"retryOf") VALUES ($1,$2,$3,$4,$5,$6,'queued',$7)`,
          [
            runId,
            userId,
            fixtureIssue,
            agentId,
            deviceId,
            repoId,
            queued.runId,
          ],
        );
      }
      if (["cancel", "revoke", "retry"].includes(mode))
        await store.apply(userId, bind(state.task), randomUUID(), {
          action: mode === "revoke" ? "revoke" : "cancel",
          reason: "Before claim",
        });
      if (mode === "stale")
        await store.apply(userId, bind(state.task), randomUUID(), {
          action: "finish",
          status: "blocked",
          reason: "Stale binding",
          evidence: [],
          output: {},
        });
      if (mode === "ordinary-stop") {
        runId = randomUUID();
        await pool.query(
          `INSERT INTO agent_runs (id,"userId","issueId","agentId","deviceId","deviceRepoId",status,"stopRequestedAt") VALUES ($1,$2,$3,$4,$5,$6,'queued',now())`,
          [runId, userId, fixtureIssue, agentId, deviceId, repoId],
        );
      }
      const path = app(`/v1/devices/${deviceId}/runs/${runId}/claim`);
      let response;
      if (mode === "race") {
        const tx = await pool.connect();
        try {
          await tx.query("BEGIN");
          await store.apply(
            userId,
            bind(state.task),
            randomUUID(),
            {
              action: "cancel",
              reason: "Task lock precedes concurrent HTTP claim",
            },
            tx,
          );
          const pending = client.post(path);
          const blocker = (await tx.query("SELECT pg_backend_pid() AS pid"))
            .rows[0].pid;
          let blocked = false;
          for (let poll = 0; poll < 100 && !blocked; poll++) {
            blocked = (
              await pool.query(
                "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))) AS blocked",
                [blocker],
              )
            ).rows[0].blocked;
            if (!blocked)
              await new Promise((resolve) => setTimeout(resolve, 20));
          }
          await tx.query("COMMIT");
          response = await pending;
          expect(blocked).toBe(true);
        } finally {
          tx.release();
        }
      } else response = await client.post(path);
      expect(response.status()).toBe(mode === "allowed" ? 200 : 409);
      const tokens = (
        await pool.query(
          `SELECT count(*)::int AS n FROM run_tokens WHERE "runId"=$1`,
          [runId],
        )
      ).rows[0].n;
      if (mode !== "allowed") {
        const body = await response.json();
        expect(body.mcp).toBeUndefined();
        expect(body.prompt).toBeUndefined();
        expect(tokens).toBe(0);
        expect(
          (
            await pool.query(`SELECT status FROM agent_runs WHERE id=$1`, [
              runId,
            ])
          ).rows[0].status,
        ).toBe("queued");
      } else expect(tokens).toBe(1);
      evidence.push({ mode, status: response.status(), tokens });
    }
    await testInfo.attach("factory-execution-claim-evidence.json", {
      body: JSON.stringify({
        layer:
          "real Next HTTP and isolated PG; no actual daemon/provider bootstrap",
        evidence,
      }),
      contentType: "application/json",
    });
  } finally {
    await client.dispose();
    await pool.query(`DELETE FROM issues WHERE "userId"=$1`, [userId]);
    await pool.query(`DELETE FROM agents WHERE id=$1`, [agentId]);
    await pool.query(`DELETE FROM device_tokens WHERE id=$1`, [tokenId]);
    await pool.query(`DELETE FROM devices WHERE id=$1`, [deviceId]);
    await pool.query(`DELETE FROM coordinator_events WHERE "userId"=$1`, [
      userId,
    ]);
    await pool.end();
  }
});
