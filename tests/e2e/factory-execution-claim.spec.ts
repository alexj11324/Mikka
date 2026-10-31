import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { test, expect, register, app } from "./fixtures";
import { createFactoryStore, type FactoryTask } from "../../lib/factory/store";
import { createFactoryDispatch } from "../../lib/factory/dispatch";
import { factoryCheckGates } from "../../lib/factory/checks";
import { factoryDispatchDatabase } from "../../lib/factory/transaction";
import { insertRunOnce } from "../../lib/run-dispatch";
import { createSkillAssignments } from "../../lib/self-improvement/assignments";
import { BASELINE_ARTIFACT } from "../../lib/self-improvement/builtin-skill";
import { SKILL_ARTIFACT_HEADER, skillAssignmentReceiptSchema } from "@mikka/protocol/skill";
import { DAEMON_PROTOCOL_VERSION } from "@mikka/protocol/daemon";
import { REPO_ORIGIN_HEADER, RECOVERY_WORKTREE_HEADER } from "@mikka/protocol/device";
import { remoteKey } from "@mikka/protocol/repository";

// Real HTTP + PG, explicit synthetic daemon reports. Not real Harness acceptance.
test("Factory execution claims reject stopped tasks and unadopted retry children before token issuance", async ({
  page,
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
  expect(process.env.MIKKA_FACTORY_ROUTING_ENABLED).toBe("1");
  expect(process.env.MIKKA_FACTORY_LIFECYCLE_ENABLED).toBe("1");
  // Claim policy materialization requires the real account's owner FK before
  // the request can reach the Factory task lock exercised below.
  const { email } = await register(page);
  const pool = new Pool({ connectionString: target.toString(), max: 3 });
  const issueId = randomUUID(),
    agentId = randomUUID(),
    deviceId = randomUUID(),
    repoId = randomUUID(),
    sourceEventId = randomUUID(),
    tokenId = randomUUID();
  const token = `orv_${randomBytes(32).toString("base64url")}`;
  const remoteUrl = `https://github.com/mikka-ci/factory-claim-${repoId}.git`;
  const client = await playwright.request.newContext({
    baseURL,
    extraHTTPHeaders: { authorization: `Bearer ${token}`, [REPO_ORIGIN_HEADER]: "1" },
  });
  const bind = (t: FactoryTask) => ({
    taskId: t.id,
    issueId: t.issueId,
    attemptId: t.attemptId,
    revision: t.revision,
    candidateId: t.candidateId,
  });
  const fixtureIssues = [issueId];
  const fixtureEvents = [sourceEventId];
  try {
    const userId = (await pool.query<{ id: string }>('SELECT id FROM "user" WHERE email=$1', [email])).rows[0].id;
    await pool.query(
      `INSERT INTO issues (id,"userId",title,content,status,priority) VALUES ($1,$2,'Check HTTP fixture','{}','todo','normal')`,
      [issueId, userId],
    );
    await pool.query(
      `INSERT INTO coordinator_events (id,"userId",kind,"dedupeKey",payload) VALUES ($1,$2,'user_message',$3,'{}')`,
      [sourceEventId, userId, `check-ci:${sourceEventId}`],
    );
    await pool.query(
      `INSERT INTO devices (id,"ownerId",name,kind,enabled,"lastSeenAt","protocolVersion",harnesses) VALUES ($1,$2,'Check HTTP fixture','local',true,now(),$3,'[{"harness":"codex","installed":true,"version":"fixture","toolApproval":true}]')`,
      [deviceId, userId, DAEMON_PROTOCOL_VERSION],
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
      `INSERT INTO device_repos (id,"deviceId","userId","repoPath","remoteUrl","verifyCommand") VALUES ($1,$2,$3,$4,$5,'node acceptance.mjs')`,
      [repoId, deviceId, userId, remoteKey(remoteUrl), remoteUrl],
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
      "access-revoked",
      "selected-allowed",
      "selected-cancel",
    ]) {
      const fixtureIssue = randomUUID(),
        event = randomUUID();
      fixtureIssues.push(fixtureIssue);
      fixtureEvents.push(event);
      await pool.query(
        `INSERT INTO issues (id,"userId",title,content,status,priority) VALUES ($1,$2,'Execution HTTP fixture','{}','todo','normal')`,
        [fixtureIssue, userId],
      );
      await pool.query(
        `INSERT INTO coordinator_events (id,"userId",kind,"dedupeKey",payload) VALUES ($1,$2,'user_message',$3,'{}')`,
        [event, userId, `execution-claim:${event}`],
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
        needsSpec: !["revoke", "selected-allowed", "selected-cancel"].includes(mode),
      });
      const queued = await dispatcher(userId, {
        binding: bind(initial.task),
        agentId,
        deviceRepoId: repoId,
      });
      const state = await store.read(userId, initial.task.id);
      if (mode.startsWith("selected-")) {
        const assignments = createSkillAssignments(pool, async (u, issue) => u === userId && issue === fixtureIssue);
        await assignments.selectBaseline(userId, queued.runId);
      }
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
      if (["cancel", "revoke", "selected-cancel"].includes(mode))
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
      if (mode === "access-revoked")
        await pool.query(`UPDATE issues SET "userId"=$2 WHERE id=$1`, [fixtureIssue, `removed-${randomUUID()}`]);
      if (mode === "ordinary-stop") {
        runId = randomUUID();
        await pool.query(
          `INSERT INTO agent_runs (id,"userId","issueId","agentId","deviceId","deviceRepoId",status,"stopRequestedAt") VALUES ($1,$2,$3,$4,$5,$6,'queued',now())`,
          [runId, userId, fixtureIssue, agentId, deviceId, repoId],
        );
      }
      if (mode === "retry") {
        const live = await store.read(userId, initial.task.id);
        expect(live.task.status).toBe("running");
        expect(live.task.attemptId).toBe(state.task.attemptId);
        expect(live.attempts.find(attempt => attempt.id === live.task.attemptId)?.runId).toBe(queued.runId);
      }
      const path = app(`/v1/devices/${deviceId}/runs/${runId}/claim`);
      // Reach the Factory fence using the current daemon's local recovery capability.
      const claimOptions = { headers: { [SKILL_ARTIFACT_HEADER]: "1", [RECOVERY_WORKTREE_HEADER]: "1" } };
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
          const pending = client.post(path, claimOptions);
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
      } else response = await client.post(path, claimOptions);
      const allowed = ["allowed", "selected-allowed"].includes(mode);
      expect(response.status()).toBe(allowed ? 200 : 409);
      const body = await response.json();
      const receipts = (await pool.query(`SELECT receipt FROM improvement_skill_receipts WHERE "runId"=$1`, [runId])).rows;
      const tokens = (
        await pool.query(
          `SELECT count(*)::int AS n FROM run_tokens WHERE "runId"=$1`,
          [runId],
        )
      ).rows[0].n;
      if (!allowed) {
        // A policy/FK failure must not satisfy a Factory rejection case.
        const error = mode === "access-revoked"
          ? "The task is no longer available to this thread."
          : ["cancel", "revoke", "ordinary-stop", "selected-cancel"].includes(mode)
            ? "Run is not queued for this device."
            : "Run is no longer queued for this device.";
        expect({ error: body.error, code: body.code }).toEqual({
          error,
          code: mode === "access-revoked" ? "issue_unavailable" : undefined,
        });
        expect(body.skillReceipt).toBeUndefined();
        expect(body.skills).toBeUndefined();
        expect(receipts).toHaveLength(0);
        expect(Object.hasOwn(body, "mcp")).toBe(false);
        expect(body.prompt).toBeUndefined();
        expect(tokens).toBe(0);
        expect(
          (
            await pool.query(`SELECT status FROM agent_runs WHERE id=$1`, [
              runId,
            ])
          ).rows[0].status,
        ).toBe("queued");
      } else {
        expect(tokens).toBe(1);
        if (mode === "selected-allowed") {
          const receipt = skillAssignmentReceiptSchema.parse(body.skillReceipt);
          expect(receipts).toHaveLength(1);
          expect(receipt).toEqual(receipts[0].receipt);
          expect(receipt).toMatchObject({ runId, issueId: fixtureIssue, agentId, repoId, deviceId, leaseExpiresAt: body.leaseExpiresAt, artifact: BASELINE_ARTIFACT });
          expect(body.skills).toHaveLength(1);
        } else {
          expect(receipts).toHaveLength(0);
          expect(body.skillReceipt).toBeUndefined();
        }
      }
      evidence.push({ mode, status: response.status(), tokens, receipts: receipts.length });
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
    await pool.query(`DELETE FROM issues WHERE id=ANY($1::uuid[])`, [fixtureIssues]);
    await pool.query(`DELETE FROM agents WHERE id=$1`, [agentId]);
    await pool.query(`DELETE FROM device_tokens WHERE id=$1`, [tokenId]);
    await pool.query(`DELETE FROM devices WHERE id=$1`, [deviceId]);
    await pool.query(`DELETE FROM coordinator_events WHERE id=ANY($1::uuid[])`, [fixtureEvents]);
    await pool.end();
  }
});
