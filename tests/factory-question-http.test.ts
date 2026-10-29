import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import test from "node:test";
import { Pool, type PoolClient } from "pg";
import { createFactoryStore } from "../lib/factory/store";
import {
  createFactoryQuestions,
  questionReference,
} from "../lib/factory/questions/store";
test(
  "real local question HTTP: owner, origin, replay, cancellation and isolation",
  { skip: process.env.FACTORY_QUESTION_LOCAL_HTTP !== "1", timeout: 120000 },
  async () => {
    const origin = new URL(process.env.FACTORY_QUESTION_HTTP_ORIGIN!).origin;
    const target = new URL(process.env.FACTORY_QUESTION_DATABASE_URL!);
    assert.equal(new URL(origin).hostname, "localhost");
    assert.equal(new URL(origin).protocol, "http:");
    assert.equal(target.hostname, "127.0.0.1");
    if (process.env.CI === "true" && process.env.GITHUB_ACTIONS === "true") {
      assert.equal(target.toString(), process.env.E2E_DATABASE_URL);
      assert.equal(target.username, "e2e");
    } else assert.equal(target.username, "factoryquestions192");
    assert.equal(target.pathname, "/mikka_e2e");
    const events: unknown[] = [];
    function client() {
      const ip = `198.18.${randomBytes(1)[0]}.${1 + (randomBytes(1)[0] % 254)}`;
      let cookie = "";
      return async (
        path: string,
        method = "GET",
        body?: unknown,
        extra: Record<string, string> = {},
      ) => {
        const options: RequestInit = {
          method,
          headers: {
            "x-forwarded-for": ip,
            ...(cookie ? { cookie } : {}),
            ...(body ? { "content-type": "application/json", origin } : {}),
            ...extra,
          },
        };
        if (body !== undefined) options.body = JSON.stringify(body);
        const r = await fetch(origin + "/mikka" + path, options);
        const c = r.headers.getSetCookie();
        if (c.length) cookie = c.map((x) => x.split(";")[0]).join("; ");
        const text = await r.text();
        let data;
        try {
          data = JSON.parse(text);
        } catch {
          data = { nonJson: true };
        }
        events.push({ path, method, status: r.status });
        return { status: r.status, body: data };
      };
    }
    const owner = client(),
      other = client(),
      anon = client();
    const signup = async (c: ReturnType<typeof client>) => {
      const r = await c("/api/auth/sign-up/email", "POST", {
        email: `question-${randomUUID()}@example.invalid`,
        password: randomBytes(32).toString("hex"),
        name: "HTTP fixture",
      });
      assert.equal(r.status, 200);
      return r.body.user.id;
    };
    const userId = await signup(owner);
    await signup(other);
    const pool = new Pool({
      connectionString: target.toString(),
      max: 1,
      options: `-c factory.test_owner=${userId}`,
    });
    const deviceId = randomUUID(),
      repoId = randomUUID(),
      agentId = randomUUID();
    const authorize = async (u: string, i: string, tx: PoolClient) =>
      (
        await tx.query('SELECT id FROM issues WHERE id=$1 AND "userId"=$2', [
          i,
          u,
        ])
      ).rowCount === 1;
    const store = createFactoryStore(pool, authorize);
    const questions = createFactoryQuestions(
      pool,
      authorize,
      store,
      async () => {
        throw new Error("fixture cannot dispatch; HTTP server must dispatch");
      },
    );
    try {
      await pool.query(
        `INSERT INTO devices (id,"ownerId",name,enabled,"lastSeenAt",harnesses) VALUES ($1,$2,'HTTP device',true,now(),'[{"harness":"codex","installed":true}]')`,
        [deviceId, userId],
      );
      await pool.query(
        `INSERT INTO device_repos (id,"deviceId","userId","repoPath","remoteUrl") VALUES ($1,$2,$3,'/isolated','fixture/repo')`,
        [repoId, deviceId, userId],
      );
      await pool.query(
        `INSERT INTO agents (id,"userId",name,harness,"deviceId") VALUES ($1,$2,'HTTP agent','codex',$3)`,
        [agentId, userId, deviceId],
      );
      const fixture = async (
        kind: "context" | "decision" | "permission" | "external" = "context",
        record = true,
      ) => {
        const issueId = randomUUID(),
          eventId = randomUUID(),
          runId = randomUUID(),
          questionId = randomUUID();
        await pool.query(
          `INSERT INTO issues (id,"userId",title,content,status,priority) VALUES ($1,current_setting('factory.test_owner'),'Use existing HTTP API','{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Keep the existing public API"}]}]}','todo','normal')`,
          [issueId],
        );
        await pool.query(
          `INSERT INTO coordinator_events (id,"userId",kind,"dedupeKey","issueId",payload) VALUES ($1,current_setting('factory.test_owner'),'user_message',$2,$3,'{"text":"Keep the existing public API"}')`,
          [eventId, eventId, issueId],
        );
        let state = await store.route(userId, {
          issueId,
          eventId: randomUUID(),
          sourceEventId: eventId,
          rationale: "Explicit fixture",
        });
        await pool.query(
          `INSERT INTO agent_runs (id,"userId","issueId","agentId","deviceId","deviceRepoId",status,"sessionId") VALUES ($1,current_setting('factory.test_owner'),$2,$3,$4,$5,'running',$6)`,
          [runId, issueId, agentId, deviceId, repoId, `session:${runId}`],
        );
        const b = {
          taskId: state.task.id,
          issueId,
          attemptId: state.task.attemptId,
          revision: state.task.revision,
          candidateId: state.task.candidateId,
        };
        state = await store.apply(userId, b, randomUUID(), {
          action: "bind_run",
          runId,
        });
        await pool.query(
          `UPDATE agent_runs SET status='stopped',"stopReason"=$2,report=$3,"finishedAt"=now() WHERE id=$1`,
          [
            runId,
            kind === "external" ? "blocked" : "asked_human",
            JSON.stringify({
              summary: "Synthetic run hand-in",
              openQuestions: ["Which API?"],
              question: {
                questionId,
                kind,
                question: "Which API?",
                options: [],
              },
            }),
          ],
        );
        const q = record ? await questions.record(userId, runId) : null;
        return { task: state.task, issueId, eventId, runId, questionId, q: q! };
      };

      const f = await fixture("decision");
      const message = {
        text: `Question origin fixture ${randomUUID()}`,
        questionId: f.questionId,
        humanSessionId: "model-forged-session",
      };
      // The existing Coordinator contract accepts only text/submissionId. Reject
      // injected question/provenance fields before they can become a user event;
      // the Factory answer endpoint below separately enforces same-origin 403.
      for (const requestOrigin of ["https://untrusted.example", "", origin]) {
        assert.equal(
          (
            await owner("/api/coordinator/messages", "POST", message, {
              origin: requestOrigin,
            })
          ).status,
          400,
        );
      }
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM coordinator_events WHERE payload->>'text'=$1",
            [message.text],
          )
        ).rows[0].n,
        0,
      );
      assert.equal(
        (await owner("/api/coordinator/messages", "POST", {text: message.text})).status,
        202,
      );
      const attested = (
        await pool.query(
          "SELECT payload FROM coordinator_events WHERE payload->>'text'=$1",
          [message.text],
        )
      ).rows[0].payload;
      assert.notEqual(attested.humanSessionId, message.humanSessionId);
      assert.equal(
        (
          await pool.query('SELECT "userId" FROM "session" WHERE id=$1', [
            attested.humanSessionId,
          ])
        ).rows[0].userId,
        userId,
      );
      const path = `/api/factory/questions/${f.questionId}`;
      assert.equal((await anon(path)).status, 401);
      assert.equal((await other(path)).status, 404);
      assert.equal(
        (await owner(`/api/factory/questions/${randomUUID()}`)).status,
        404,
      );
      assert.equal(
        (
          await owner(path, "GET", undefined, {
            authorization: "Bearer fixture",
          })
        ).status,
        401,
      );
      assert.equal((await owner(path)).body.status, "open");
      const answer = {
        reference: questionReference(f.q),
        answerId: randomUUID(),
        text: "Keep the existing HTTP API",
      };
      assert.equal(
        (
          await owner(path, "POST", answer, {
            origin: "https://untrusted.example",
          })
        ).status,
        403,
      );
      assert.equal(
        (await owner(path, "POST", { ...answer, source: "human" })).status,
        422,
      );
      const replies = await Promise.all(
        Array.from({ length: 5 }, () => owner(path, "POST", answer)),
      );
      assert.deepEqual(
        replies.map((r) => r.status),
        [200, 200, 200, 200, 200],
      );
      assert.equal(
        new Set(replies.map((r) => r.body.continuationRunId)).size,
        1,
      );
      assert.equal((await owner(path)).body.status, "resuming");
      assert.equal(
        (await owner(path, "POST", { ...answer, text: "Different answer" }))
          .status,
        409,
      );
      const run = (
        await pool.query(
          'SELECT "questionContinuation" FROM agent_runs WHERE id=$1',
          [replies[0].body.continuationRunId],
        )
      ).rows[0];
      assert.equal(run.questionContinuation.requireSessionResume, true);
      assert.equal(
        run.questionContinuation.originSessionId,
        f.q.originSessionId,
      );
      const independent = await fixture("context");
      for (const mode of ["cancelled", "revoked", "expired", "deleted"]) {
        const waiting = await fixture("decision");
        const url = `/api/factory/questions/${waiting.questionId}`;
        const input = {
          reference: questionReference(waiting.q),
          answerId: randomUUID(),
          text: "Proceed",
        };
        if (mode === "expired")
          await pool.query(
            `UPDATE factory_questions SET "expiresAt"=now()-interval '1 second' WHERE id=$1`,
            [waiting.questionId],
          );
        else if (mode === "deleted")
          await pool.query(
            `UPDATE issues SET content='{"attrs":{"mikka":{"deletedAt":"2026-10-25T00:00:00Z"}}}' WHERE id=$1`,
            [waiting.issueId],
          );
        else
          await store.apply(userId, waiting.q.waitingBinding, randomUUID(), {
            action: mode === "cancelled" ? "cancel" : "revoke",
            reason: "HTTP fixture stop",
          });
        const r = await owner(url, "POST", input);
        assert.ok([404, 409].includes(r.status), `${mode}: ${r.status}`);
        assert.equal(
          (
            await pool.query(
              'SELECT count(*)::int AS n FROM agent_runs WHERE "issueId"=$1 AND "dispatchKey" IS NOT NULL',
              [waiting.issueId],
            )
          ).rows[0].n,
          0,
        );
      }
      assert.equal(
        (await owner(`/api/factory/questions/${independent.questionId}`)).body
          .status,
        "open",
      );
      const wrong = {
        reference: {
          ...questionReference(independent.q),
          originSessionId: "different-session",
        },
        answerId: randomUUID(),
        text: "Proceed",
      };
      assert.equal(
        (
          await owner(
            `/api/factory/questions/${independent.questionId}`,
            "POST",
            wrong,
          )
        ).status,
        409,
      );
      await owner("/api/auth/sign-out", "POST", {});
      assert.equal((await owner(path)).status, 401);
      console.log(
        `PASS ${events.length} actual HTTP requests; concurrent answer = one strict continuation`,
      );
    } finally {
      if (process.env.FACTORY_QUESTION_HTTP_EVIDENCE)
        await writeFile(
          process.env.FACTORY_QUESTION_HTTP_EVIDENCE,
          JSON.stringify(events, null, 2),
        );
      await pool.end();
    }
  },
);
