import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { test, expect, app, browserClientHeaders } from "./fixtures";
import { createFactoryStore } from "../../lib/factory/store";

// Only disposable CI. This is real HTTP/session/PG coverage, not Preview OAuth
// or real Harness acceptance; do not run sign-up fixtures against cloud data.
test("Factory HTTP API isolates owners, requires sessions/origins and atomically cancels a bound run", async ({
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
  const origin = new URL(baseURL!).origin;
  const owner = await playwright.request.newContext({
    baseURL,
    extraHTTPHeaders: browserClientHeaders(),
  });
  const other = await playwright.request.newContext({
    baseURL,
    extraHTTPHeaders: browserClientHeaders(),
  });
  const anonymous = await playwright.request.newContext({ baseURL });
  const pool = new Pool({ connectionString: target.toString(), max: 3 });
  try {
    const register = async (client: typeof owner) => {
      const response = await client.post(app("/api/auth/sign-up/email"), {
        headers: { origin },
        data: {
          email: `factory-${randomUUID()}@example.invalid`,
          password: randomBytes(32).toString("base64url"),
          name: "Factory CI fixture",
        },
      });
      expect(response.ok()).toBeTruthy();
      return (await response.json()).user.id as string;
    };
    const userId = await register(owner);
    await register(other);
    const issueId = randomUUID(),
      sourceEventId = randomUUID(),
      agentId = randomUUID(),
      runId = randomUUID();
    await pool.query(
      "INSERT INTO issues (id,\"userId\",title,content,status,priority) VALUES ($1,$2,'Factory HTTP fixture','{}','todo','normal')",
      [issueId, userId],
    );
    await pool.query(
      'INSERT INTO coordinator_events (id,"userId",kind,"dedupeKey",payload) VALUES ($1,$2,\'user_message\',$3,\'{"text":"HTTP fixture request"}\')',
      [sourceEventId, userId, `factory-http:${sourceEventId}`],
    );
    await pool.query(
      "INSERT INTO agents (id,\"userId\",name,harness) VALUES ($1,$2,'HTTP fixture','codex')",
      [agentId, userId],
    );
    await pool.query(
      'INSERT INTO agent_runs (id,"userId","issueId","agentId",status) VALUES ($1,$2,$3,$4,\'running\')',
      [runId, userId, issueId, agentId],
    );
    const store = createFactoryStore(
      pool,
      async (user, issue, tx) =>
        (
          await tx.query('SELECT id FROM issues WHERE id=$1 AND "userId"=$2', [
            issue,
            user,
          ])
        ).rowCount === 1,
    );
    const routed = await store.route(userId, {
      issueId,
      sourceEventId,
      eventId: sourceEventId,
      rationale: "Authenticated fixture request",
    });
    const taskId = routed.task.id;
    const bind = (t: typeof routed.task) => ({
      taskId: t.id,
      issueId: t.issueId,
      attemptId: t.attemptId,
      revision: t.revision,
      candidateId: t.candidateId,
    });
    const state = await store.apply(userId, bind(routed.task), randomUUID(), {
      action: "bind_run",
      runId,
    });
    const path = app(`/api/factory/tasks/${taskId}`);
    expect((await anonymous.get(path)).status()).toBe(401);
    expect(
      (
        await anonymous.get(path, {
          headers: { authorization: "Bearer fixture-worker-token" },
        })
      ).status(),
    ).toBe(401);
    expect((await other.get(path)).status()).toBe(404);
    const read = await owner.get(path);
    expect(read.status()).toBe(200);
    expect(read.headers()["cache-control"]).toContain("no-store");
    expect((await read.json()).task.stage).toBe("execute");
    const recoverySource = randomUUID();
    await pool.query(
      'INSERT INTO coordinator_events (id,"userId",kind,"dedupeKey",payload) VALUES ($1,$2,\'user_message\',$3,\'{"text":"Separate recoverable fixture"}\')',
      [recoverySource, userId, `factory-recovery:${recoverySource}`],
    );
    const recovery = await store.route(userId, {
      issueId,
      sourceEventId: recoverySource,
      eventId: recoverySource,
      rationale: "Separate recovery fixture",
    });
    const blocked = await store.apply(
      userId,
      bind(recovery.task),
      randomUUID(),
      {
        action: "finish",
        status: "blocked",
        reason: "Fixture environment unavailable",
        evidence: [],
        output: {},
      },
    );
    const recovered = await owner.post(
      app(`/api/factory/tasks/${recovery.task.id}`),
      {
        headers: { origin },
        data: {
          binding: bind(blocked.task),
          eventId: randomUUID(),
          action: "retry",
          reason: "Owner requests recovery",
        },
      },
    );
    expect(recovered.status()).toBe(200);
    const recoveryState = await recovered.json();
    expect(recoveryState.task.status).toBe("pending");
    expect(recoveryState.attempts).toHaveLength(2);
    expect(recoveryState.attempts[0].reason).toBe(
      "Fixture environment unavailable",
    );
    const command = {
      binding: bind(state.task),
      eventId: randomUUID(),
      action: "cancel",
      reason: "Authenticated owner cancels fixture",
    };
    expect(
      (
        await owner.post(path, {
          headers: { origin: "https://foreign.invalid" },
          data: command,
        })
      ).status(),
    ).toBe(403);
    expect(
      (await other.post(path, { headers: { origin }, data: command })).status(),
    ).toBe(404);
    const cancelled = await owner.post(path, {
      headers: { origin },
      data: command,
    });
    expect(cancelled.status()).toBe(200);
    expect((await cancelled.json()).task.status).toBe("cancelled");
    expect(
      (
        await pool.query(
          'SELECT "stopRequestedAt" FROM agent_runs WHERE id=$1',
          [runId],
        )
      ).rows[0].stopRequestedAt,
    ).toBeTruthy();
    expect(
      (await owner.post(path, { headers: { origin }, data: command })).status(),
    ).toBe(409);
    expect(
      (
        await owner.post(path, {
          headers: { origin },
          data: { ...command, action: "finish", status: "passed" },
        })
      ).status(),
    ).toBe(422);
    expect(
      (
        await owner.post(app("/api/auth/sign-out"), {
          headers: { origin },
          data: {},
        })
      ).ok(),
    ).toBeTruthy();
    expect((await owner.get(path)).status()).toBe(401);
    await testInfo.attach("factory-http-evidence", {
      body: JSON.stringify(
        {
          environment: "GitHub CI disposable PG17 + built Next server",
          commit: process.env.GITHUB_SHA,
          issueId,
          sourceEventId,
          taskId,
          runId,
          checks: [
            "ownerRecovery200WithHistory",
            "session401",
            "worker401",
            "foreignOwner404",
            "origin403",
            "ownerRead200",
            "cancel200",
            "runStopPersisted",
            "replay409",
            "passTool422",
            "revokedSession401",
          ],
          limitation:
            "Seeded run; no real Harness, Preview OAuth or user acceptance",
        },
        null,
        2,
      ),
      contentType: "application/json",
    });
  } finally {
    await pool.end();
    await owner.dispose();
    await other.dispose();
    await anonymous.dispose();
  }
});
