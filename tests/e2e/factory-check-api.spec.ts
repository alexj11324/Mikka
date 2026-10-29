import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { test, expect, app, register } from "./fixtures";
import { createFactoryStore, type FactoryTask } from "../../lib/factory/store";
import { createFactoryDispatch } from "../../lib/factory/dispatch";
import { createFactoryReconciler } from "../../lib/factory/reconcile";
import { factoryCheckGates } from "../../lib/factory/checks";
import { factoryDispatchDatabase } from "../../lib/factory/transaction";
import { insertRunOnce } from "../../lib/run-dispatch";
import { reconcileFactoryCheck } from "../../lib/factory/reconcile-check";
import { DAEMON_PROTOCOL_VERSION } from "@mikka/protocol/daemon";
import { REPO_ORIGIN_HEADER } from "@mikka/protocol/device";
import { remoteKey } from "@mikka/protocol/repository";

// Real HTTP + PG, explicit synthetic daemon reports. Not real Harness acceptance.
test("Factory check claim pins SHA/read-only/command and preserves trusted receipt through completion", async ({
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
  const { email } = await register(page);
  const pool = new Pool({ connectionString: target.toString(), max: 3 });
  const issueId = randomUUID(),
    agentId = randomUUID(),
    deviceId = randomUUID(),
    repoId = randomUUID(),
    sourceEventId = randomUUID(),
    tokenId = randomUUID();
  const token = `orv_${randomBytes(32).toString("base64url")}`;
  const remoteUrl = `https://github.com/mikka-ci/factory-check-${repoId}.git`;
  const client = await playwright.request.newContext({
    baseURL,
    extraHTTPHeaders: { authorization: `Bearer ${token}`, [REPO_ORIGIN_HEADER]: "1" },
  });
  const anonymous = await playwright.request.newContext({ baseURL });
  const bind = (t: FactoryTask) => ({
    taskId: t.id,
    issueId: t.issueId,
    attemptId: t.attemptId,
    revision: t.revision,
    candidateId: t.candidateId,
  });
  try {
    // Claim materializes the real owner's CLI policy. An invented user ID
    // fails its FK before any Factory check or token boundary is exercised.
    const owners = await pool.query<{ id: string }>('SELECT id FROM "user" WHERE email=$1', [email]);
    expect(owners.rows).toHaveLength(1);
    const userId = owners.rows[0].id;
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
    const store = createFactoryStore(
      pool,
      async (u, issue) => u === userId && issue === issueId,
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
      issueId,
      sourceEventId,
      eventId: randomUUID(),
      rationale: "Explicit CI fixture",
    });
    const implement = await dispatcher(userId, {
      binding: bind(initial.task),
      agentId,
      deviceRepoId: repoId,
    });
    const sha = "3".repeat(40);
    await pool.query(
      `UPDATE agent_runs SET status='succeeded',"stopReason"='submitted',"sessionId"=$2,report=$3,"finishedAt"=now() WHERE id=$1`,
      [
        implement.runId,
        `fixture-execute-${randomUUID()}`,
        JSON.stringify({
          verify: { status: "passed" },
          publish: { commit: sha },
        }),
      ],
    );
    const reconcile = createFactoryReconciler(pool, store, undefined, {
      review: reconcileFactoryCheck,
      verify: reconcileFactoryCheck,
    });
    await reconcile(userId);
    let state = await store.read(userId, initial.task.id);
    const review = await dispatcher(userId, {
      binding: bind(state.task),
      agentId,
      deviceRepoId: repoId,
    });
    const claimPath = app(`/v1/devices/${deviceId}/runs/${review.runId}/claim`);
    expect((await anonymous.post(claimPath)).status()).toBe(401);
    await pool.query(
      `UPDATE device_repos SET "verifyCommand"='changed after dispatch' WHERE id=$1`,
      [repoId],
    );
    const claim = await client.post(claimPath);
    const assignment = await claim.json();
    // Only reviewed constants may enter a failed assertion; a successful
    // response contains a real MCP token and must never be dumped wholesale.
    const denialCategories = new Map([
      ["daemonUpgradeRequired", "daemon_upgrade_required"],
      ["Agent policy unavailable.", "agent_policy_unavailable"],
      ["Repository or execution harness unavailable.", "execution_harness_unavailable"],
      ["Run approval capability unavailable.", "approval_capability_unavailable"],
      ["Run is no longer queued for this device.", "factory_claim_unavailable"],
      ["Frozen execution policy is no longer permitted.", "frozen_policy_unavailable"],
      ["Run access changed before claim response.", "response_access_changed"],
      ["issue_unavailable", "publication_issue_unavailable"],
      ["publication_mismatch", "publication_mismatch"],
      ["workerCapabilityRequired", "skill_capability_required"],
    ]);
    const denialCategory = claim.status() === 200 ? "none"
      : denialCategories.get(assignment?.code) ?? denialCategories.get(assignment?.error) ?? "other_claim_denial";
    expect(claim.status(), `Factory check claim: ${denialCategory}`).toBe(200);
    // A failed assertion must not print the real MCP credential in the response.
    expect({
      baseBranch: assignment.baseBranch,
      kind: assignment.kind,
      verifyCommand: assignment.verifyCommand,
      policy: { readOnly: assignment.policy?.readOnly },
    }).toEqual({
      baseBranch: sha,
      kind: "acceptance",
      verifyCommand: "node acceptance.mjs",
      policy: { readOnly: true },
    });
    expect(assignment.resumeSessionId).toBeUndefined();
    expect(assignment.continuesRunId).toBeUndefined();
    expect((await client.post(claimPath)).status()).toBe(409);
    const sessionId = `fixture-review-${randomUUID()}`;
    const runPath = app(`/v1/runs/${review.runId}`);
    expect(
      (
        await client.patch(runPath, { data: { state: "running", sessionId } })
      ).status(),
    ).toBe(204);
    const report = {
      summary: "Explicit CI fixture",
      filesChanged: [],
      openQuestions: [],
      nextStep: null,
      verify: {
        status: "passed",
        command: "node acceptance.mjs",
        output: "CI fixture",
        exitCode: 0,
        signal: null,
        timedOut: false,
      },
      check: { sha, readOnly: true },
      criteria: [
        {
          text: "Explicit fixture criterion",
          passed: true,
          evidence: "CI fixture evidence",
        },
      ],
    };
    expect(
      (
        await client.post(`${runPath}/complete`, {
          data: { stopReason: "submitted", report },
        })
      ).status(),
    ).toBe(204);
    // Terminal identity cannot be overwritten by an out-of-order live patch.
    expect(
      (
        await client.patch(runPath, {
          data: { state: "running", sessionId: "wrong-late-session" },
        })
      ).status(),
    ).toBe(204);
    const persisted = (
      await pool.query(`SELECT * FROM agent_runs WHERE id=$1`, [review.runId])
    ).rows[0];
    expect(persisted.sessionId).toBe(sessionId);
    expect(persisted.status).toBe("succeeded");
    expect(persisted.report.check).toEqual({ sha, readOnly: true });
    expect(persisted.report.verify.exitCode).toBe(0);
    await reconcile(userId);
    state = await store.read(userId, state.task.id);
    expect(state.task.stage).toBe("verify");
    // Historical lease retries must not turn a strict question continuation
    // into an ordinary claim that could start a fresh Harness session.
    const strictRun = randomUUID(),
      retryRun = randomUUID(),
      nestedRetry = randomUUID();
    await pool.query(
      `INSERT INTO agent_runs (id,"userId","issueId","agentId","deviceId","deviceRepoId",status,"questionContinuation") VALUES ($1,$2,$3,$4,$5,$6,'failed',$7)`,
      [
        strictRun,
        userId,
        issueId,
        agentId,
        deviceId,
        repoId,
        JSON.stringify({ originSessionId: "strict-fixture-session" }),
      ],
    );
    for (const [id, parent] of [
      [retryRun, strictRun],
      [nestedRetry, retryRun],
    ]) {
      await pool.query(
        `INSERT INTO agent_runs (id,"userId","issueId","agentId","deviceId","deviceRepoId",status,"retryOf") VALUES ($1,$2,$3,$4,$5,$6,'queued',$7)`,
        [id, userId, issueId, agentId, deviceId, repoId, parent],
      );
    }
    for (const id of [retryRun, nestedRetry]) {
      expect(
        (
          await client.post(app(`/v1/devices/${deviceId}/runs/${id}/claim`))
        ).status(),
      ).toBe(409);
      expect(
        (
          await pool.query(
            'SELECT count(*)::int AS n FROM run_tokens WHERE "runId"=$1',
            [id],
          )
        ).rows[0].n,
      ).toBe(0);
      expect(
        (
          await pool.query(
            'SELECT status,"stopReason" FROM agent_runs WHERE id=$1',
            [id],
          )
        ).rows[0],
      ).toMatchObject({ status: "failed", stopReason: "blocked" });
    }
    await testInfo.attach("factory-check-http-evidence.json", {
      body: JSON.stringify({
        layer: "CI HTTP/PG fixture, not CC/Codex acceptance",
        issueId,
        taskId: state.task.id,
        runId: review.runId,
        sessionId,
        candidateId: state.task.candidateId,
        sha,
        stage: state.task.stage,
      }),
      contentType: "application/json",
    });
  } finally {
    await client.dispose();
    await anonymous.dispose();
    await pool.query(`DELETE FROM issues WHERE id=$1`, [issueId]);
    await pool.query(`DELETE FROM agents WHERE id=$1`, [agentId]);
    await pool.query(`DELETE FROM device_tokens WHERE id=$1`, [tokenId]);
    await pool.query(`DELETE FROM devices WHERE id=$1`, [deviceId]);
    await pool.query(`DELETE FROM coordinator_events WHERE id=$1`, [
      sourceEventId,
    ]);
    await pool.end();
  }
});
