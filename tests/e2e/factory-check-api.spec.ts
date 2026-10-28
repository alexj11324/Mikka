import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { test, expect, app } from "./fixtures";
import { createFactoryStore, type FactoryTask } from "../../lib/factory/store";
import { createFactoryDispatch } from "../../lib/factory/dispatch";
import { createFactoryReconciler } from "../../lib/factory/reconcile";
import { factoryCheckGates } from "../../lib/factory/checks";
import { factoryDispatchDatabase } from "../../lib/factory/transaction";
import { insertRunOnce } from "../../lib/run-dispatch";

// Real HTTP + PG, explicit synthetic daemon reports. Not real Harness acceptance.
test("Factory check claim pins SHA/read-only/command and preserves trusted receipt through completion", async ({
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
  const anonymous = await playwright.request.newContext({ baseURL });
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
    const reconcile = createFactoryReconciler(pool, store);
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
    expect(claim.status()).toBe(200);
    const assignment = await claim.json();
    expect(assignment).toMatchObject({
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
    // Retain synthetic issues, devices, tokens and events for audit.
    await pool.end();
  }
});
