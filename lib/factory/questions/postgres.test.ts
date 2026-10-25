import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { Pool, type PoolClient } from "pg";
import { orderMigrations } from "../../../scripts/migration-order.mjs";
import { FactoryError } from "../contract";
import { createFactoryStore } from "../store";
import { createFactoryDispatch } from "../dispatch";
import { factoryDispatchDatabase } from "../transaction";
import { insertRunOnce } from "../../run-dispatch";
import { createFactoryQuestions, questionReference } from "./store";
import { createFactoryReconciler } from "../reconcile";
import { lostRunOutcome } from "../../run-retry";
import { blockQuestionRetry } from "./retry";

const local = process.env.FACTORY_QUESTION_TEST_URL;
const dbURL =
  local ??
  (process.env.CI === "true" && process.env.GITHUB_ACTIONS === "true"
    ? process.env.E2E_DATABASE_URL
    : undefined);
if (dbURL) {
  const u = new URL(dbURL);
  assert.equal(u.hostname, "127.0.0.1");
  assert.equal(u.pathname, "/mikka_e2e");
  if (local) assert.equal(u.username, "factoryquestions192");
}
const rejects = (fn: () => Promise<unknown>, code: string) =>
  assert.rejects(
    fn,
    (e: unknown) => e instanceof FactoryError && e.code === code,
  );
test(
  "PG17 execution questions: durable waiting, exact facts/human source, one continuation, rollback and stop fences",
  { skip: !dbURL, timeout: 120000 },
  async (t) => {
    const schema = `questions_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString: dbURL, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = new Pool({
      connectionString: dbURL,
      max: 12,
      options: `-c search_path=${schema}`,
    });
    const userId = "owner",
      sessionId = randomUUID(),
      deviceId = randomUUID(),
      repoId = randomUUID(),
      agentId = randomUUID();
    const authorize = async (owner: string, issue: string, tx: PoolClient) =>
      (
        await tx.query(
          `SELECT id FROM issues WHERE id=$1 AND "userId"=$2 AND content #>> '{attrs,mikka,deletedAt}' IS NULL FOR SHARE`,
          [issue, owner],
        )
      ).rowCount === 1;
    const make = (p: Pool) => {
      const store = createFactoryStore(p, authorize);
      const dispatch = createFactoryDispatch(p, store, (tx, owner, input) =>
        insertRunOnce(factoryDispatchDatabase(tx), owner, input, {
          deviceId,
          baseBranch: "main",
          prompt: "Explicit Harness fixture",
        }),
      );
      return {
        store,
        questions: createFactoryQuestions(p, authorize, store, dispatch),
      };
    };
    const { store, questions } = make(pool);
    try {
      const dir = new URL("../../../drizzle/", import.meta.url);
      for (const name of orderMigrations(
        (await readdir(dir)).filter((n) => n.endsWith(".sql")),
      ))
        await pool.query(await readFile(new URL(name, dir), "utf8"));
      await pool.query(
        await readFile(
          new URL("20261025051205_factory_192_questions.sql", dir),
          "utf8",
        ),
      );
      await pool.query(
        `INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ('owner','Fixture owner','questions@example.invalid',true,now(),now())`,
      );
      await pool.query(
        `INSERT INTO "session" (id,"userId",token,"expiresAt","createdAt","updatedAt") VALUES ($1,'owner',$2,now()+interval '1 hour',now(),now())`,
        [sessionId, `fixture-${randomUUID()}`],
      );
      await pool.query(
        `INSERT INTO devices (id,"ownerId",name,enabled,"lastSeenAt",harnesses) VALUES ($1,'owner','Fixture device',true,now(),'[{"harness":"codex","installed":true}]')`,
        [deviceId],
      );
      await pool.query(
        `INSERT INTO device_repos (id,"deviceId","userId","repoPath","remoteUrl") VALUES ($1,$2,'owner','/isolated','fixture/repo')`,
        [repoId, deviceId],
      );
      await pool.query(
        `INSERT INTO agents (id,"userId",name,harness,"deviceId") VALUES ($1,'owner','Fixture agent','codex',$2)`,
        [agentId, deviceId],
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
          `INSERT INTO issues (id,"userId",title,content,status,priority) VALUES ($1,'owner','Use existing HTTP API','{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Keep the existing public API"}]}]}','todo','normal')`,
          [issueId],
        );
        await pool.query(
          `INSERT INTO coordinator_events (id,"userId",kind,"dedupeKey","issueId",payload) VALUES ($1,'owner','user_message',$2,$3,'{"text":"Keep the existing public API"}')`,
          [eventId, eventId, issueId],
        );
        let state = await store.route(userId, {
          issueId,
          eventId: randomUUID(),
          sourceEventId: eventId,
          rationale: "Explicit fixture",
        });
        await pool.query(
          `INSERT INTO agent_runs (id,"userId","issueId","agentId","deviceId","deviceRepoId",status,"sessionId") VALUES ($1,'owner',$2,$3,$4,$5,'running',$6)`,
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
      const facts = (f: Awaited<ReturnType<typeof fixture>>) => ({
        reference: questionReference(f.q),
        answerId: randomUUID(),
        facts: [{ kind: "issue", quote: "Keep the existing public API" }],
      });
      const human = { source: "human" as const, userId, sessionId };
      const orchestrator = { source: "orchestrator" as const, userId };
      const queued = async (issueId: string) =>
        (
          await pool.query(
            `SELECT count(*)::int AS n FROM agent_runs WHERE "issueId"=$1 AND "dispatchKey" IS NOT NULL`,
            [issueId],
          )
        ).rows[0].n;

      await t.test(
        "ten hand-in replays persist one question and waiting instead of cancellation",
        async () => {
          const f = await fixture("context", false);
          const states = await Promise.all(
            Array.from({ length: 10 }, () => questions.record(userId, f.runId)),
          );
          assert.equal(new Set(states.map((q) => q.id)).size, 1);
          assert.equal(
            (await store.read(userId, f.task.id)).task.status,
            "waiting",
          );
          assert.equal(
            (
              await pool.query(
                `SELECT count(*)::int AS n FROM coordinator_events WHERE "runId"=$1 AND kind='run_question'`,
                [f.runId],
              )
            ).rows[0].n,
            1,
          );
          assert.equal(
            (
              await pool.query(`SELECT status FROM agent_runs WHERE id=$1`, [
                f.runId,
              ])
            ).rows[0].status,
            "stopped",
          );
          await rejects(
            () =>
              store.apply(userId, states[0].waitingBinding, randomUUID(), {
                action: "retry",
                reason: "No answer",
              }),
            "factoryQuestionPending",
          );
        },
      );
      await t.test(
        "known context facts answer ten times creates one strict original-session continuation",
        async () => {
          const f = await fixture(),
            request = facts(f);
          const results = await Promise.all(
            Array.from({ length: 10 }, () =>
              questions.answer(orchestrator, request),
            ),
          );
          assert.equal(
            new Set(results.map((r) => r.continuationRunId)).size,
            1,
          );
          assert.equal(await queued(f.issueId), 1);
          const result = results[0],
            row = (
              await pool.query(`SELECT * FROM agent_runs WHERE id=$1`, [
                result.continuationRunId,
              ])
            ).rows[0];
          assert.equal(row.questionContinuation.originRunId, f.runId);
          assert.equal(
            row.questionContinuation.originSessionId,
            `session:${f.runId}`,
          );
          assert.equal(row.questionContinuation.requireSessionResume, true);
          assert.equal(result.task.id, f.task.id);
          assert.equal(result.task.status, "running");
          const claim = await questions.claimContinuation(
            userId,
            deviceId,
            result.continuationRunId,
            new Date(Date.now() + 60000).toISOString(),
          );
          assert.equal(claim.resumeSessionId, `session:${f.runId}`);
          assert.equal(claim.requireSessionResume, true);
          assert.equal(
            (await questions.record(userId, f.runId)).status,
            "resuming",
          );
          await pool.query(
            `UPDATE agent_runs SET status='succeeded',"stopReason"='submitted',"sessionId"=$2 WHERE id=$1`,
            [result.continuationRunId, `session:${f.runId}`],
          );
          assert.equal(
            (await questions.settle(userId, result.continuationRunId))?.status,
            "resolved",
          );
          assert.equal(
            (await questions.answer(orchestrator, request)).continuationRunId,
            result.continuationRunId,
          );
          await rejects(
            () =>
              questions.answer(orchestrator, {
                ...request,
                answerId: randomUUID(),
              }),
            "factoryQuestionAnswerConflict",
          );
        },
      );
      await t.test(
        "permission/decision require a real human source; fabricated facts and identity fail",
        async () => {
          for (const kind of ["permission", "decision", "external"] as const) {
            const f = await fixture(kind);
            await rejects(
              () => questions.answer(orchestrator, facts(f)),
              "factoryQuestionHumanRequired",
            );
            const request = {
              reference: questionReference(f.q),
              answerId: randomUUID(),
              text: "Continue within existing permissions",
            };
            await rejects(
              () =>
                questions.answer(
                  { ...human, sessionId: "missing-session" },
                  request,
                ),
              "factoryHumanRequired",
            );
            assert.equal(await queued(f.issueId), 0);
            assert.equal(
              (await questions.answer(human, request)).questionId,
              f.questionId,
            );
          }
          const f = await fixture();
          await rejects(
            () =>
              questions.answer(orchestrator, {
                ...facts(f),
                facts: [{ kind: "issue", quote: "I grant admin privileges" }],
              }),
            "factoryQuestionFactMismatch",
          );
          await rejects(
            () => questions.read("other", f.questionId),
            "factoryNotFound",
          );
          await rejects(
            () =>
              questions.answer(orchestrator, {
                ...facts(f),
                reference: {
                  ...questionReference(f.q),
                  originSessionId: "wrong-session",
                },
              }),
            "factoryQuestionStale",
          );
          assert.equal(await queued(f.issueId), 0);
        },
      );
      await t.test(
        "human-event answers require live attestation, exact text and question binding",
        async () => {
          const f = await fixture("permission");
          const sourceEventId = randomUUID();
          const request = {
            reference: questionReference(f.q),
            answerId: randomUUID(),
            sourceEventId,
            text: "Continue within existing permissions",
          };
          const actor = { source: "human_event" as const, userId };
          await pool.query(
            `INSERT INTO coordinator_events (id,"userId",kind,"dedupeKey","issueId",payload) VALUES ($1,$2,'user_message',$5,$3,$4)`,
            [
              sourceEventId,
              userId,
              f.issueId,
              JSON.stringify({ text: request.text, questionId: f.questionId }),
              sourceEventId,
            ],
          );
          await rejects(
            () => questions.answer(actor, request),
            "factoryHumanRequired",
          );
          const payload = {
            text: request.text,
            questionId: f.questionId,
            humanSessionId: sessionId,
          };
          await pool.query(
            "UPDATE coordinator_events SET payload=$2 WHERE id=$1",
            [
              sourceEventId,
              JSON.stringify({ ...payload, questionId: randomUUID() }),
            ],
          );
          await rejects(
            () => questions.answer(actor, request),
            "factoryQuestionStale",
          );
          await pool.query(
            "UPDATE coordinator_events SET payload=$2 WHERE id=$1",
            [sourceEventId, JSON.stringify(payload)],
          );
          await rejects(
            () =>
              questions.answer(actor, {
                ...request,
                text: "Model changed the permission",
              }),
            "factoryHumanRequired",
          );
          assert.equal(await queued(f.issueId), 0);
          const result = await questions.answer(actor, request);
          assert.equal(result.questionId, f.questionId);
          assert.equal(
            (await questions.answer(actor, request)).continuationRunId,
            result.continuationRunId,
          );
          assert.equal(await queued(f.issueId), 1);
        },
      );
      await t.test(
        "cancel/revoke, expiration, deleted issue and conflicting answers never reopen work",
        async () => {
          for (const action of ["cancel", "revoke"] as const) {
            const f = await fixture(),
              request = facts(f);
            const accepted = await questions.answer(orchestrator, request);
            await store.apply(
              userId,
              {
                taskId: accepted.task.id,
                issueId: accepted.task.issueId,
                attemptId: accepted.task.attemptId,
                revision: accepted.task.revision,
                candidateId: accepted.task.candidateId,
              },
              randomUUID(),
              { action, reason: "Explicit stop" },
            );
            await rejects(
              () => questions.answer(orchestrator, request),
              "factoryStopped",
            );
            await rejects(
              () =>
                questions.claimContinuation(
                  userId,
                  deviceId,
                  accepted.continuationRunId,
                  new Date().toISOString(),
                ),
              "factoryStopped",
            );
            assert.equal(
              (await questions.read(userId, f.questionId)).status,
              "cancelled",
            );
          }
          const expired = await fixture();
          await pool.query(
            `UPDATE factory_questions SET "expiresAt"=now()-interval '1 second' WHERE id=$1`,
            [expired.questionId],
          );
          await rejects(
            () => questions.answer(orchestrator, facts(expired)),
            "factoryQuestionExpired",
          );
          assert.equal(
            (await questions.read(userId, expired.questionId)).status,
            "expired",
          );
          const deleted = await fixture();
          await pool.query(
            `UPDATE issues SET content='{"attrs":{"mikka":{"deletedAt":"2026-10-25T00:00:00Z"}}}' WHERE id=$1`,
            [deleted.issueId],
          );
          await rejects(
            () => questions.answer(orchestrator, facts(deleted)),
            "factoryNotFound",
          );
          const competing = await fixture(),
            a = facts(competing);
          const settled = await Promise.allSettled([
            questions.answer(orchestrator, a),
            questions.answer(orchestrator, { ...a, answerId: randomUUID() }),
          ]);
          assert.equal(
            settled.filter((r) => r.status === "fulfilled").length,
            1,
          );
          assert.equal(await queued(competing.issueId), 1);
        },
      );
      await t.test(
        "real bind interruption rolls answer, attempt, queue and ledger back; reconnect replay is stable",
        async () => {
          const f = await fixture(),
            request = facts(f);
          await pool.query(
            `CREATE FUNCTION fail_question_bind() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.request->'change'->>'action'='bind_run' THEN RAISE EXCEPTION 'injected question bind interruption'; END IF; RETURN NEW; END $$`,
          );
          await pool.query(
            `CREATE TRIGGER fail_question_bind BEFORE INSERT ON factory_events FOR EACH ROW EXECUTE FUNCTION fail_question_bind()`,
          );
          await assert.rejects(
            () => questions.answer(orchestrator, request),
            /injected question bind interruption/,
          );
          assert.equal(await queued(f.issueId), 0);
          assert.equal(
            (await questions.read(userId, f.questionId)).answerId,
            null,
          );
          assert.equal(
            (await store.read(userId, f.task.id)).attempts.length,
            1,
          );
          await pool.query("DROP TRIGGER fail_question_bind ON factory_events");
          const result = await questions.answer(orchestrator, request);
          const reconnect = new Pool({
            connectionString: dbURL,
            options: `-c search_path=${schema}`,
          });
          try {
            assert.equal(
              (await make(reconnect).questions.answer(orchestrator, request))
                .continuationRunId,
              result.continuationRunId,
            );
          } finally {
            await reconnect.end();
          }
        },
      );
      await t.test(
        "wrong actual resume session blocks the original task and preserves the answer",
        async () => {
          const f = await fixture(),
            answer = await questions.answer(orchestrator, facts(f));
          await pool.query(
            `UPDATE agent_runs SET status='failed',"stopReason"='error',"sessionId"='different-session' WHERE id=$1`,
            [answer.continuationRunId],
          );
          assert.equal(
            (await questions.settle(userId, answer.continuationRunId))?.status,
            "blocked",
          );
          assert.equal(
            (await store.read(userId, f.task.id)).task.status,
            "blocked",
          );
          assert.equal(
            (await questions.read(userId, f.questionId)).answerId !== null,
            true,
          );
        },
      );
      await t.test(
        "lost continuation settles durably without generic replay on Coordinator recovery",
        async () => {
          const f = await fixture();
          const request = facts(f);
          const answer = await questions.answer(orchestrator, request);
          await questions.claimContinuation(
            userId,
            deviceId,
            answer.continuationRunId,
            new Date(Date.now() + 60000).toISOString(),
          );
          const {
            rows: [run],
          } = await pool.query("SELECT * FROM agent_runs WHERE id=$1", [
            answer.continuationRunId,
          ]);
          const outcome = lostRunOutcome(run);
          assert.equal(outcome.kind, "failed");
          if (outcome.kind !== "failed")
            throw new Error("Continuation must not retry");
          // Persist the same terminal result as the existing lease reclaimer.
          await pool.query(
            `UPDATE agent_runs SET status='failed',"stopReason"='device_lost',error=$2,"finishedAt"=now() WHERE id=$1`,
            [run.id, outcome.error],
          );
          const reconcile = createFactoryReconciler(pool, store, questions);
          await reconcile(userId);
          await reconcile(userId);
          assert.equal(
            (await questions.read(userId, f.questionId)).status,
            "blocked",
          );
          assert.equal(
            (await store.read(userId, f.task.id)).task.status,
            "blocked",
          );
          assert.equal(
            (
              await pool.query('SELECT id FROM agent_runs WHERE "retryOf"=$1', [
                run.id,
              ])
            ).rowCount,
            0,
          );
          assert.equal(
            (await questions.read(userId, f.questionId)).answerId,
            request.answerId,
          );
        },
      );
      await t.test(
        "missing continuation blocks durably and retains its answer",
        async () => {
          const f = await fixture();
          const request = facts(f);
          const answer = await questions.answer(orchestrator, request);
          await pool.query("DELETE FROM agent_runs WHERE id=$1", [
            answer.continuationRunId,
          ]);
          await createFactoryReconciler(pool, store, questions)(userId);
          assert.equal(
            (await questions.read(userId, f.questionId)).status,
            "blocked",
          );
          assert.equal(
            (await questions.read(userId, f.questionId)).answerId,
            request.answerId,
          );
          assert.equal(
            (await store.read(userId, f.task.id)).task.status,
            "blocked",
          );
        },
      );
      await t.test(
        "claim guard blocks historical retry descendants but preserves normal and strict original runs",
        async () => {
          const f = await fixture();
          const answer = await questions.answer(orchestrator, facts(f));
          const child = async (parent: string) => {
            const id = randomUUID();
            await pool.query(
              `INSERT INTO agent_runs (id,"userId","issueId","agentId","deviceId","deviceRepoId",status,"retryOf") VALUES ($1,$2,$3,$4,$5,$6,'queued',$7)`,
              [id, userId, f.issueId, agentId, deviceId, repoId, parent],
            );
            return id;
          };
          const first = await child(answer.continuationRunId);
          const second = await child(first);
          assert.equal(
            await blockQuestionRetry(pool, "foreign", f.issueId, first),
            false,
          );
          assert.equal(
            await blockQuestionRetry(pool, userId, randomUUID(), first),
            false,
          );
          for (const id of [first, second]) {
            assert.equal(
              await blockQuestionRetry(pool, userId, f.issueId, id),
              true,
            );
            assert.equal(
              (
                await pool.query(
                  'SELECT status,"stopReason" FROM agent_runs WHERE id=$1',
                  [id],
                )
              ).rows[0].stopReason,
              "blocked",
            );
          }
          assert.equal(
            await blockQuestionRetry(
              pool,
              userId,
              f.issueId,
              await child(f.runId),
            ),
            false,
          );
          assert.equal(
            await blockQuestionRetry(
              pool,
              userId,
              f.issueId,
              answer.continuationRunId,
            ),
            false,
          );
          await questions.claimContinuation(
            userId,
            deviceId,
            answer.continuationRunId,
            new Date(Date.now() + 60000).toISOString(),
          );
        },
      );
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  },
);
