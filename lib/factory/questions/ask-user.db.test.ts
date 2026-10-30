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
    const fixture: Record<string, { deviceId: string; agentId: string; repoId: string }> = {};
    for (const user of ["owner", "intruder"]) {
      const f = (fixture[user] = { deviceId: randomUUID(), agentId: randomUUID(), repoId: randomUUID() });
      await pool.query(`INSERT INTO devices (id,"ownerId",name,"lastSeenAt",harnesses) VALUES ($1,$2,'Disposable',now(),'[{"harness":"codex","installed":true}]')`, [f.deviceId, user]);
      await pool.query(`INSERT INTO agents (id,"userId",name,harness,"deviceId") VALUES ($1,$2,'Fixture','codex',$3)`, [f.agentId, user, f.deviceId]);
      await pool.query(`INSERT INTO device_repos (id,"deviceId","userId","repoPath") VALUES ($1,$2,$3,'/fixture/repo')`, [f.repoId, f.deviceId, user]);
    }
    const authorize = async (user: string, issue: string, tx: PoolClient) =>
      (await tx.query('SELECT id FROM issues WHERE id=$1 AND "userId"=$2', [issue, user])).rowCount === 1;
    const store = createFactoryStore(pool, authorize, null, { independent: factoryCheckIndependent });
    const dispatch = createFactoryDispatch(pool, store, async (tx, userId, input, botId) => {
      const runId = randomUUID();
      await tx.query(`INSERT INTO agent_runs (id,"userId","issueId","agentId","deviceId","deviceRepoId","botId",status,prompt) VALUES ($1,$2,$3,$4,$5,$6,$7,'queued','Fixture')`, [runId, userId, input.issueId, input.agentId, fixture[userId].deviceId, input.deviceRepoId, botId]);
      return { runId };
    }, { configure: { execute: async () => {} }, freeze: async (tx, _task, id) => { await tx.query('UPDATE agent_runs SET "agentDefinition"=$2 WHERE id=$1', [id, JSON.stringify({ schemaVersion: 1, definitionDigest: "fixture", harness: "codex" })]); } });
    const questions = createFactoryQuestions(pool, authorize, store, dispatch);
    const asked = async (kind: string, text: string, options: string[], user = "owner") => {
      const { agentId, repoId } = fixture[user];
      const issueId = randomUUID(), src = randomUUID(), questionId = randomUUID();
      await pool.query(`INSERT INTO issues(id,"userId",title,content,status,priority) VALUES ($1,$2,'Fixture','{"type":"doc","content":[]}','todo','normal')`, [issueId, user]);
      await pool.query(`INSERT INTO coordinator_events (id,"userId",kind,"dedupeKey",payload) VALUES ($1,$3,'user_message',$2,'{"text":"synthetic"}')`, [src, src, user]);
      const r = await store.route(user, { issueId, sourceEventId: src, eventId: randomUUID(), rationale: "Task requested", missingInformation: [], missingPermissions: [], needsSpec: false });
      const { runId } = await dispatch(user, { binding: factoryBinding(r.task), agentId, deviceRepoId: repoId });
      await pool.query(`UPDATE agent_runs SET status='stopped',"stopReason"=$2,report=$3,"sessionId"='session:'||id,"startedAt"=now(),"finishedAt"=now() WHERE id=$1`, [runId, kind === "external" ? "blocked" : "asked_human",
        JSON.stringify({ summary: "Synthetic hand-in", openQuestions: [text], question: { questionId, kind, question: text, options } })]);
      await questions.record(user, runId);
      return { taskId: r.task.id, runId, questionId };
    };
    const get = (userId: string | null, query = "") =>
      handleFactoryQuestionList(questions, { actor: userId ? { userId } : null, authorization: null, method: "GET", url: `https://mikka.test/api/factory/questions${query}` });

    // Whole-database fingerprint: every public table's rows (with xmin, so no-op writes like SET status=status are caught) plus the sequences, so a GET that writes anywhere is caught.
    const dbHash = async () => {
      const { rows: tables } = await pool.query<{ t: string }>("SELECT quote_ident(tablename) AS t FROM pg_tables WHERE schemaname='public' ORDER BY 1");
      const parts: string[] = [];
      for (const { t } of tables)
        parts.push(t + ":" + (await pool.query(`SELECT count(*)::text||':'||coalesce(md5(string_agg(x.xmin::text||':'||x::text, '|' ORDER BY x::text)),'') AS h FROM ${t} x`)).rows[0].h);
      const { rows: seqs } = await pool.query<{ s: string }>("SELECT quote_ident(sequencename) AS s FROM pg_sequences WHERE schemaname='public' ORDER BY 1");
      for (const { s: q } of seqs) parts.push(q + ":" + (await pool.query(`SELECT last_value::text||is_called::text AS v FROM ${q}`)).rows[0].v);
      return parts.join("\n");
    };
    const allGets = async (q: { taskId: string; runId: string; questionId: string }) => {
      const one = await questions.read("owner", q.questionId);
      const listed = (await questions.list("owner", q.taskId)).find((x) => x.id === q.questionId);
      const http = [await get("owner", `?taskId=${q.taskId}`), await get("owner", `?runId=${q.runId}`), await get("owner")];
      return { one, listed, http };
    };

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

    await t.test("question text is masked like the ledger notes", async () => {
      const token = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
      const m = await asked("decision", `Rotate ${token} now?`, ["Yes"]);
      const [q] = ((await get("owner", `?taskId=${m.taskId}`)).body as { questions: { question: string; originalText: string }[] }).questions;
      assert.ok(!q.question.includes(token) && !q.originalText.includes(token), "token leaked");
      assert.equal(q.originalText, q.question);
      await pool.query("UPDATE factory_questions SET status='resolved' WHERE id=$1", [m.questionId]);
    });

    await t.test("another user's runId and task: empty list and the same 404 body as a missing task", async () => {
      const x = await asked("decision", "Intruder question", ["A"], "intruder");
      assert.deepEqual((await get("owner", `?runId=${x.runId}`)).body, { questions: [] });
      assert.deepEqual((await get("intruder", `?runId=${a.runId}`)).body, { questions: [] });
      const missing = await get("owner", `?taskId=${randomUUID()}`), foreign = await get("owner", `?taskId=${x.taskId}`);
      assert.equal(missing.status, 404);
      assert.equal(foreign.status, 404);
      assert.deepEqual(foreign.body, missing.body);
    });

    await t.test("list by task filters userId in SQL: a foreign row on the owner's task is not shown", async () => {
      const x = await asked("decision", "Planted on owner's task", ["A"], "intruder");
      await pool.query('UPDATE factory_questions f SET "taskId"=o."taskId","attemptId"=o."attemptId","candidateId"=o."candidateId" FROM factory_questions o WHERE f.id=$1 AND o.id=$2', [x.questionId, a.questionId]);
      const ids = ((await get("owner", `?taskId=${a.taskId}`)).body as { questions: { questionId: string }[] }).questions.map((q) => q.questionId);
      assert.deepEqual(ids, [a.questionId]);
      await pool.query("DELETE FROM factory_questions WHERE id=$1", [x.questionId]);
    });

    await t.test("pending: 50-row cap, userId and runId in SQL, newest first with id tiebreak", async () => {
      const mine: string[] = [];
      for (let i = 0; i < 51; i++) mine.push((await asked("decision", `Owner ${i}`, ["A"])).questionId);
      // Newer than every owner row: without the SQL userId filter they eat the quota.
      for (let i = 0; i < 50; i++) await asked("decision", `Intruder ${i}`, ["A"], "intruder");
      // Same createdAt for all owner rows so only `id DESC` orders them.
      await pool.query(`UPDATE factory_questions SET "createdAt"='2020-01-01T00:00:00Z' WHERE "userId"='owner'`);
      await pool.query(`UPDATE factory_questions SET "createdAt"='2019-01-01T00:00:00Z' WHERE id=$1`, [b.questionId]);
      await pool.query(`UPDATE factory_questions SET "createdAt"='2021-01-01T00:00:00Z' WHERE "userId"='intruder'`);
      const pendingOwner = (await pool.query(`SELECT id FROM factory_questions WHERE "userId"='owner' AND id<>$1 AND status IN ('open','waiting_user','resuming','blocked') ORDER BY id DESC`, [b.questionId])).rows.map((r) => r.id as string);
      assert.ok(pendingOwner.length > 50);
      const all = ((await get("owner")).body as { questions: { questionId: string }[] }).questions.map((q) => q.questionId);
      assert.deepEqual(all, pendingOwner.slice(0, 50));
      // b's run is outside the newest 50: found only because runId is filtered before LIMIT.
      assert.ok(!all.includes(b.questionId));
      assert.deepEqual(((await get("owner", `?runId=${b.runId}`)).body as { questions: { questionId: string }[] }).questions.map((q) => q.questionId), [b.questionId]);
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
      // Expired rows are filtered in SQL (before LIMIT 50), so pending never returns them.
      assert.ok(!(await questions.pending("owner", a.runId)).some((q) => q.id === a.questionId));
      const byTask = (await get("owner", `?taskId=${a.taskId}`)).body as { questions: unknown[] };
      assert.deepEqual(byTask.questions, [], "expired question is no longer pending");
      assert.deepEqual(await snap(), before, "GETs wrote nothing");
    });

    await t.test("pending: expiry is filtered in SQL before LIMIT 50", async () => {
      const live = (await pool.query(`SELECT id FROM factory_questions WHERE "userId"='owner' AND status IN ('open','waiting_user','resuming','blocked') AND ("expiresAt" IS NULL OR "expiresAt">now()) ORDER BY "createdAt" DESC, id DESC`)).rows.map((r) => r.id as string);
      assert.ok(live.length > 50, "fixture: more than 50 live pending rows");
      const newest = live.slice(0, 50), survivor = live[50];
      const saved = (await pool.query(`SELECT id,"expiresAt" FROM factory_questions WHERE id=ANY($1::uuid[])`, [newest])).rows;
      try {
        await pool.query(`UPDATE factory_questions SET "expiresAt"=now()-interval '1 second' WHERE id=ANY($1::uuid[])`, [newest]);
        const ids = ((await get("owner")).body as { questions: { questionId: string }[] }).questions.map((q) => q.questionId);
        assert.ok(ids.includes(survivor), "the 51st row is reachable once the 50 newer ones expire");
        assert.ok(!ids.some((id) => newest.includes(id)), "expired rows are not listed");
        assert.ok((await questions.pending("owner")).length > 0);
      } finally {
        for (const r of saved) await pool.query(`UPDATE factory_questions SET "expiresAt"=$2 WHERE id=$1`, [r.id, r.expiresAt]);
      }
    });

    await t.test("BE-16: superseded candidate is derived at read time; whole database unchanged", async () => {
      const s = await asked("decision", "Superseded?", ["A"]);
      const { rows: [row] } = await pool.query(`SELECT q."candidateId" AS q, t."candidateId" AS t FROM factory_questions q JOIN factory_tasks t ON t.id=q."taskId" WHERE q.id=$1`, [s.questionId]);
      assert.equal(row.q, row.t, "fixture: question starts on the task's candidate");
      // A new candidate lands on the task; the question still points at the old (here: none).
      const cand = randomUUID();
      await pool.query(`INSERT INTO factory_candidates (id,"taskId",sha,repository,environment,scope,"runId") VALUES ($1,$2,repeat('a',40),'fixture/repo','preview','fixture',$3)`, [cand, s.taskId, s.runId]);
      await pool.query(`UPDATE factory_tasks SET "candidateId"=$2 WHERE id=$1`, [s.taskId, cand]);
      const before = await dbHash();
      const { one, listed, http } = await allGets(s);
      assert.equal(one.status, "superseded");
      assert.equal(listed?.status, "superseded");
      for (const res of http) {
        assert.equal(res.status, 200);
        assert.ok(!(res.body as { questions: { questionId: string }[] }).questions.some((q) => q.questionId === s.questionId), "superseded is not pending");
      }
      assert.equal(await dbHash(), before, "GETs wrote nothing anywhere");
      assert.equal((await pool.query("SELECT status FROM factory_questions WHERE id=$1", [s.questionId])).rows[0].status, "open", "stored status untouched");
    });

    await t.test("BE-16: cancelled task is derived at read time; whole database unchanged", async () => {
      const c = await asked("decision", "Cancelled?", ["A"]);
      await pool.query(`UPDATE factory_tasks SET status='cancelled' WHERE id=$1`, [c.taskId]);
      const before = await dbHash();
      const { one, listed, http } = await allGets(c);
      assert.equal(one.status, "cancelled");
      assert.equal(listed?.status, "cancelled");
      for (const res of http) {
        assert.equal(res.status, 200);
        assert.ok(!(res.body as { questions: { questionId: string }[] }).questions.some((q) => q.questionId === c.questionId), "cancelled is not pending");
      }
      assert.equal(await dbHash(), before, "GETs wrote nothing anywhere");
      assert.equal((await pool.query("SELECT status FROM factory_questions WHERE id=$1", [c.questionId])).rows[0].status, "open", "stored status untouched");
    });

    await t.test("BE-16: expired GETs leave the whole database unchanged", async () => {
      const e = await asked("decision", "Expired?", ["A"]);
      await pool.query(`UPDATE factory_questions SET "expiresAt"=now()-interval '1 second' WHERE id=$1`, [e.questionId]);
      const before = await dbHash();
      const { one, listed } = await allGets(e);
      assert.equal(one.status, "expired");
      assert.equal(listed?.status, "expired");
      assert.equal(await dbHash(), before, "GETs wrote nothing anywhere");
    });

    await t.test("GETs do not block while another transaction holds FOR UPDATE on the task, question and issue", async () => {
      const writes: Promise<unknown>[] = [];
      const holder = await pool.connect();
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT 1 FROM factory_tasks WHERE id=$1 FOR UPDATE", [b.taskId]);
        await holder.query("SELECT 1 FROM factory_questions WHERE id=$1 FOR UPDATE", [b.questionId]);
        await holder.query('SELECT 1 FROM issues WHERE id=(SELECT "issueId" FROM factory_tasks WHERE id=$1) FOR UPDATE', [b.taskId]);
        const within = <T,>(p: Promise<T>, what: string) => Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} blocked on a row lock`)), 3000))]);
        assert.equal((await within(questions.read("owner", b.questionId), "read")).id, b.questionId);
        assert.ok((await within(questions.list("owner", b.taskId), "list")).some((q) => q.id === b.questionId));
        assert.ok((await within(questions.pending("owner", b.runId), "pending")).some((q) => q.id === b.questionId));
        assert.equal((await within(get("owner", `?taskId=${b.taskId}`), "GET route")).status, 200);
        // Task-detail GET (store.read) is a no-lock read too.
        assert.equal((await within(store.read("owner", b.taskId), "task-detail read")).task.id, b.taskId);
        const issueId = (await pool.query<{ issueId: string }>('SELECT "issueId" FROM factory_tasks WHERE id=$1', [b.taskId])).rows[0].issueId;
        assert.ok((await within(store.listForIssue("owner", issueId), "listForIssue")).tasks.some((x) => x.id === b.taskId));
        // Control: a real write path (dispatch -> lockForDispatch, FOR UPDATE on the task) does wait.
        const snap = await store.read("owner", b.taskId);
        const write = dispatch("owner", { binding: factoryBinding(snap.task), agentId: fixture.owner.agentId, deviceRepoId: fixture.owner.repoId }).then(() => "done", () => "done");
        writes.push(write);
        const blocked = await Promise.race([write, new Promise((r) => setTimeout(() => r("blocked"), 500))]);
        assert.equal(blocked, "blocked", "control: write path waits for the task lock");
      } finally {
        await holder.query("ROLLBACK");
        holder.release();
        await Promise.all(writes);
      }
    });

    await t.test("botId scope: a store bound to another bot sees nothing, on read and write paths", async () => {
      const other = createFactoryStore(pool, authorize, randomUUID(), { independent: factoryCheckIndependent });
      const otherQuestions = createFactoryQuestions(pool, authorize, other, dispatch);
      const notFound = { code: "factoryNotFound" };
      await assert.rejects(other.read("owner", b.taskId), notFound);
      await assert.rejects(otherQuestions.read("owner", b.questionId), notFound);
      await assert.rejects(otherQuestions.list("owner", b.taskId), notFound);
      assert.ok(!(await otherQuestions.pending("owner", b.runId)).some((q) => q.id === b.questionId));
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await assert.rejects(other.lockTask(c, "owner", b.taskId), notFound, "write path (lockTask) checks botId");
        await assert.rejects(other.readTask(c, "owner", b.taskId), notFound, "read path (readTask) checks botId");
      } finally { await c.query("ROLLBACK"); c.release(); }
      assert.equal((await store.read("owner", b.taskId)).task.id, b.taskId, "control: own bot scope reads it");
      // Task re-bound to another bot while its source event stays bot-less: only the task.botId check stops it.
      const rebound = await asked("decision", "Rebound", ["A"]), botId = randomUUID();
      await pool.query(`INSERT INTO bots (id,"workspaceId","ownerId",name) VALUES ($1,$2,'owner','Fixture bot')`, [botId, randomUUID()]);
      await pool.query('UPDATE factory_tasks SET "botId"=$2 WHERE id=$1', [rebound.taskId, botId]);
      await assert.rejects(store.read("owner", rebound.taskId), notFound, "read path checks task.botId");
      await assert.rejects(questions.read("owner", rebound.questionId), notFound);
      const d = await pool.connect();
      try {
        await d.query("BEGIN");
        await assert.rejects(store.lockTask(d, "owner", rebound.taskId), notFound, "write path checks task.botId");
      } finally { await d.query("ROLLBACK"); d.release(); }
    });

    // M10: the list() id tiebreak subtest QA's mutation plan refers to.
    await t.test("M10 list by task: newest first with id tiebreak", async () => {
      const first = await asked("decision", "Tiebreak 0", ["A"]);
      const ids = [first.questionId];
      // Move three more questions onto the same task, then give all four the same createdAt so only `id DESC` orders them.
      for (let i = 1; i < 4; i++) {
        const { questionId } = await asked("decision", `Tiebreak ${i}`, ["A"]);
        await pool.query('UPDATE factory_questions f SET "taskId"=o."taskId","attemptId"=o."attemptId","candidateId"=o."candidateId" FROM factory_questions o WHERE f.id=$1 AND o.id=$2', [questionId, first.questionId]);
        ids.push(questionId);
      }
      await pool.query(`UPDATE factory_questions SET "createdAt"='2020-06-01T00:00:00Z' WHERE "taskId"=$1`, [first.taskId]);
      const got = ((await get("owner", `?taskId=${first.taskId}`)).body as { questions: { questionId: string }[] }).questions.map((q) => q.questionId);
      assert.deepEqual(got, [...ids].sort().reverse());
    });

    await t.test("by continuation run: a resuming question is found by its continuationRunId", async () => {
      const q = await asked("decision", "Continue with which branch?", ["A"]);
      const c = await asked("decision", "Continuation run's own question", ["A"]);
      // c's run plays the continuation; its own question is resolved so only q can match.
      await pool.query("UPDATE factory_questions SET status='resolved' WHERE id=$1", [c.questionId]);
      await pool.query(`UPDATE factory_questions SET status='resuming',"continuationRunId"=$2 WHERE id=$1`, [q.questionId, c.runId]);
      const ids = ((await get("owner", `?runId=${c.runId}`)).body as { questions: { questionId: string }[] }).questions.map((x) => x.questionId);
      assert.deepEqual(ids, [q.questionId]);
      assert.deepEqual((await get("intruder", `?runId=${c.runId}`)).body, { questions: [] });
      await pool.query("UPDATE factory_questions SET status='resolved' WHERE id=$1", [q.questionId]);
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
