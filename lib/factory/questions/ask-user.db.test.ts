// BE-12: pending questions per task / run in AskUserQuestion shape, over a
// disposable *_e2e PG with real migrations and the real question store.
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Pool, type PoolClient } from "pg";
import { orderMigrations } from "../../../scripts/migration-order.mjs";
import { createFactoryStore } from "../store";
import { createFactoryDispatch, factoryBinding } from "../dispatch";
import { factoryCheckIndependent } from "../check-independence";
import { createFactoryQuestions } from "./store";
import { handleFactoryQuestionList } from "./ask-user";

const url = process.env.E2E_DATABASE_URL;
if (url) {
  const u = new URL(url);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(u.hostname), "loopback only");
  assert.match(u.pathname, /^\/[a-z0-9_]+_e2e$/, "database name must end in _e2e");
} else if (process.env.REQUIRE_DB === "1") assert.fail("REQUIRE_DB=1 needs E2E_DATABASE_URL");

test("pending Factory questions list by task and by run in AskUserQuestion shape", { skip: !url, timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: url, max: 1 });
  const database = `fac_askq_${randomUUID().replaceAll("-", "")}_e2e`;
  await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`);
  const target = new URL(url!);
  target.pathname = `/${database}`;
  const pool = new Pool({ connectionString: target.toString(), max: 6 });
  try {
    const dir = new URL("../../../drizzle/", import.meta.url);
    for (const f of orderMigrations((await readdir(dir)).filter((f) => f.endsWith(".sql"))))
      await pool.query(await readFile(new URL(f, dir), "utf8"));
    for (const id of ["owner", "intruder"])
      await pool.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,'Fixture',$1||'@example.invalid',true,now(),now())`, [id]);
    const deviceId = randomUUID(), agentId = randomUUID(), repoId = randomUUID();
    await pool.query(`INSERT INTO devices (id,"ownerId",name,"lastSeenAt",harnesses) VALUES ($1,'owner','Disposable',now(),'[{"harness":"codex","installed":true}]')`, [deviceId]);
    await pool.query(`INSERT INTO agents (id,"userId",name,harness,"deviceId") VALUES ($1,'owner','Fixture','codex',$2)`, [agentId, deviceId]);
    await pool.query(`INSERT INTO device_repos (id,"deviceId","userId","repoPath") VALUES ($1,$2,'owner','/fixture/repo')`, [repoId, deviceId]);
    const authorize = async (user: string, issue: string, tx: PoolClient) =>
      (await tx.query('SELECT id FROM issues WHERE id=$1 AND "userId"=$2', [issue, user])).rowCount === 1;
    const store = createFactoryStore(pool, authorize, null, { independent: factoryCheckIndependent });
    const dispatch = createFactoryDispatch(pool, store, async (tx, userId, input, botId) => {
      const runId = randomUUID();
      await tx.query(`INSERT INTO agent_runs (id,"userId","issueId","agentId","deviceId","deviceRepoId","botId",status,prompt) VALUES ($1,$2,$3,$4,$5,$6,$7,'queued','Fixture')`, [runId, userId, input.issueId, input.agentId, deviceId, input.deviceRepoId, botId]);
      return { runId };
    }, { configure: { execute: async () => {} }, freeze: async (tx, _task, id) => { await tx.query('UPDATE agent_runs SET "agentDefinition"=$2 WHERE id=$1', [id, JSON.stringify({ schemaVersion: 1, definitionDigest: "fixture", harness: "codex" })]); } });
    const questions = createFactoryQuestions(pool, authorize, store, dispatch);
    const asked = async (kind: string, text: string, options: string[]) => {
      const issueId = randomUUID(), src = randomUUID(), questionId = randomUUID();
      await pool.query(`INSERT INTO issues(id,"userId",title,content,status,priority) VALUES ($1,'owner','Fixture','{"type":"doc","content":[]}','todo','normal')`, [issueId]);
      await pool.query(`INSERT INTO coordinator_events (id,"userId",kind,"dedupeKey",payload) VALUES ($1,'owner','user_message',$2,'{"text":"synthetic"}')`, [src, src]);
      const r = await store.route("owner", { issueId, sourceEventId: src, eventId: randomUUID(), rationale: "Task requested", missingInformation: [], missingPermissions: [], needsSpec: false });
      const { runId } = await dispatch("owner", { binding: factoryBinding(r.task), agentId, deviceRepoId: repoId });
      await pool.query(`UPDATE agent_runs SET status='stopped',"stopReason"=$2,report=$3,"sessionId"='session:'||id,"startedAt"=now(),"finishedAt"=now() WHERE id=$1`, [runId, kind === "external" ? "blocked" : "asked_human",
        JSON.stringify({ summary: "Synthetic hand-in", openQuestions: [text], question: { questionId, kind, question: text, options } })]);
      await questions.record("owner", runId);
      return { taskId: r.task.id, runId, questionId };
    };
    const get = (userId: string | null, query = "") =>
      handleFactoryQuestionList(questions, { actor: userId ? { userId } : null, authorization: null, method: "GET", url: `https://mikka.test/api/factory/questions${query}` });

    const a = await asked("decision", "Which API should we keep?", ["REST", "GraphQL"]);
    const b = await asked("context", "Where is the staging config?", []);

    await t.test("by task: exact AskUserQuestion fields plus type and original text", async () => {
      const res = await get("owner", `?taskId=${a.taskId}`);
      assert.equal(res.status, 200);
      assert.deepEqual((res.body as { questions: unknown[] }).questions.map((q) => { const { reference: _r, ...rest } = q as Record<string, unknown>; return rest; }), [{
        questionId: a.questionId, taskId: a.taskId, runId: a.runId, status: "open", type: "decision",
        originalText: "Which API should we keep?", question: "Which API should we keep?", header: "Decision",
        options: [{ label: "REST", description: "", value: "REST" }, { label: "GraphQL", description: "", value: "GraphQL" }], multiSelect: false,
      }]);
    });

    await t.test("by run and all pending; other users see nothing", async () => {
      const byRun = (await get("owner", `?runId=${b.runId.toUpperCase()}`)).body as { questions: { questionId: string; header: string; options: unknown[] }[] };
      assert.deepEqual(byRun.questions.map((q) => [q.questionId, q.header, q.options.length]), [[b.questionId, "Context", 0]]);
      const all = (await get("owner")).body as { questions: { questionId: string }[] };
      assert.deepEqual(new Set(all.questions.map((q) => q.questionId)), new Set([a.questionId, b.questionId]));
      assert.deepEqual((await get("intruder")).body, { questions: [] });
      assert.equal((await get("intruder", `?taskId=${a.taskId}`)).status, 404);
    });

    await t.test("BE-16: GETs compute expiry from expiresAt and write nothing", async () => {
      await pool.query(`UPDATE factory_questions SET "expiresAt"=now()-interval '1 second' WHERE id=$1`, [a.questionId]);
      const tables = ["factory_questions", "factory_tasks", "factory_attempts", "factory_events", "agent_runs", "run_messages"];
      const snap = async () => Promise.all(tables.map(async (x) => (await pool.query(`SELECT * FROM ${x} ORDER BY 1`)).rows));
      const before = await snap();
      const one = await questions.read("owner", a.questionId);
      assert.equal(one.status, "expired");
      assert.equal(one.revision, before[0].find((r: { id: string }) => r.id === a.questionId).revision, "revision not bumped");
      assert.equal((await questions.list("owner", a.taskId))[0].status, "expired");
      assert.ok((await questions.pending("owner")).some((q) => q.id === a.questionId && q.status === "expired"));
      const byTask = (await get("owner", `?taskId=${a.taskId}`)).body as { questions: unknown[] };
      assert.deepEqual(byTask.questions, [], "expired question is no longer pending");
      assert.deepEqual(await snap(), before, "GETs wrote nothing");
    });

    await t.test("rejects bad input and anonymous callers", async () => {
      assert.equal((await get("owner", `?taskId=${a.taskId}&runId=${a.runId}`)).status, 422);
      assert.equal((await get("owner", "?runId=nope")).status, 422);
      assert.equal((await get(null)).status, 401);
    });
  } finally {
    await pool.end();
    // pool.end() resolves before the backends exit; wait before the FORCE drop.
    for (let i = 0; i < 100 && (await admin.query("SELECT 1 FROM pg_stat_activity WHERE datname=$1", [database])).rowCount; i++)
      await new Promise((r) => setTimeout(r, 50));
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await admin.end();
  }
});
