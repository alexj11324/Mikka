import { seedFixtureWorkspace } from '../../tests/helpers/task-workspace';
import { bindFixtureWorkspaceDatabase } from '../../tests/helpers/workspace-database';
import { lifecycleCases } from "./lifecycle.db-cases";
import { isolatedPostgresURL } from "../../tests/helpers/isolated-postgres.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Pool } from "pg";
import { orderMigrations } from "../../scripts/migration-order.mjs";
import { createFactoryStore } from "./store";
import { FactoryError, type FactoryBinding } from "./contract";
import { disposableDatabase } from '../../tests/helpers/e2e-target.mjs'
const ci = process.env.CI === "true" && process.env.GITHUB_ACTIONS === "true";
const url =
  process.env.FACTORY_ROUTING_TEST_URL ??
  (disposableDatabase() ? process.env.E2E_DATABASE_URL : undefined);
if (ci) assert.ok(url, "CI must run actual isolated PostgreSQL, never skip");
if (url) assert.ok(disposableDatabase(process.env, url), "loopback *_e2e only");
const denies = (fn: () => Promise<unknown>, code: string) =>
  assert.rejects(fn, (e) => e instanceof FactoryError && e.code === code);
test(
  "isolated PG: durable intake, Bot/source provenance, resolution, restart and stop fences",
  { skip: !url, timeout: 120000 },
  async (t) => {
    const fixtureURL = await isolatedPostgresURL(url!);
    const admin = new Pool({ connectionString: fixtureURL }),
      schema = "routing_" + randomUUID().replaceAll("-", "");
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = new Pool({
      connectionString: fixtureURL,
      options: `-c search_path=${schema}`,
      max: 12,
    });
    const closeWorkspace = await bindFixtureWorkspaceDatabase(pool);
    try {
      const dir = new URL("../../drizzle/", import.meta.url);
      for (const f of orderMigrations(
        (await readdir(dir)).filter((f) => f.endsWith(".sql")),
      ))
        await pool.query(await readFile(new URL(f, dir), "utf8"));
      const migration = await readFile(
        new URL("20261029044000_factory_192_routing.sql", dir),
        "utf8",
      );
      await pool.query(migration);
      await pool.query(
        `INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ('owner','Fixture','route@example.invalid',true,now(),now()),('other','Other','other@example.invalid',true,now(),now())`,
      );
      const workspaceId = await seedFixtureWorkspace(pool, 'owner');
      const authorize = async (
        user: string,
        issue: string,
        tx: import("pg").PoolClient,
      ) =>
        (
          await tx.query('SELECT id FROM issues WHERE id=$1 AND "userId"=$2', [
            issue,
            user,
          ])
        ).rowCount === 1;
      const store = createFactoryStore(pool, authorize);
      async function event(kind = "user_message", botId: string | null = null) {
        const id = randomUUID();
        await pool.query(
          `INSERT INTO coordinator_events (id,"userId",kind,"dedupeKey","botId",payload) VALUES ($1,'owner',$2,$3,$4,'{"text":"Actual synthetic personal request"}')`,
          [id, kind, id, botId],
        );
        return id;
      }
      async function fixture(missing = false) {
        const issueId = randomUUID();
        await pool.query(
          `INSERT INTO issues(id,"userId",title,content,status,priority,"workspaceId","ownershipState") VALUES ($1,'owner','Fixture','{}','todo','normal',$2,'bound')`,
          [issueId, workspaceId],
        );
        return {
          issueId,
          sourceEventId: await event(),
          eventId: randomUUID(),
          rationale: "Task requested",
          missingInformation: missing ? ["Which API?"] : [],
          missingPermissions: [],
          needsSpec: false,
        };
      }
      const bind = (
        task: Awaited<ReturnType<typeof store.route>>["task"],
      ): FactoryBinding => ({
        taskId: task.id,
        issueId: task.issueId,
        attemptId: task.attemptId,
        revision: task.revision,
        candidateId: task.candidateId,
      });
      const snapshotRead = (sql: string) => /^SELECT \* FROM factory_(?:attempts|candidates) WHERE/.test(sql.trim())
      const sourceRead = (sql: string) => /^SELECT (?:e\.)?id(?:,(?:e\.)?payload)? FROM coordinator_events/.test(sql.trim())
      const recordedRoute = async (input: Awaited<ReturnType<typeof fixture>>, replace?: (sql: string, result: unknown) => unknown) => {
        const tx = await pool.connect(), calls: string[] = []
        try {
          await tx.query('BEGIN')
          const observed = new Proxy(tx, { get(target, key) {
            if (key === 'query') return async (sql: string, ...args: unknown[]) => {
              calls.push(sql)
              const result = await Reflect.apply(target.query, target, [sql, ...args])
              return replace ? replace(sql, result) : result
            }
            const value = Reflect.get(target, key)
            return typeof value === 'function' ? value.bind(target) : value
          } })
          const result = await store.route('owner', input, observed)
          await tx.query('COMMIT')
          return { result, calls }
        } catch (error) { await tx.query('ROLLBACK'); throw error }
        finally { tx.release() }
      }
      await t.test('native snapshot batches preserve pg Date, JSON, row order and empty candidates', async () => {
        const input = await fixture()
        const { result, calls } = await recordedRoute(input)
        assert.equal(calls.filter(snapshotRead).length, 1, 'both existing SELECT results use one round trip')
        const attempts = (await pool.query('SELECT * FROM factory_attempts WHERE "taskId"=$1 ORDER BY position', [result.task.id])).rows
        const candidates = (await pool.query('SELECT * FROM factory_candidates WHERE "taskId"=$1 ORDER BY "createdAt"', [result.task.id])).rows
        assert.deepEqual(result, JSON.parse(JSON.stringify({ contractVersion: 1, task: result.task, attempts, candidates })))
        assert.equal(result.attempts.length, 1)
        assert.equal(result.candidates.length, 0)
      })
      await t.test('routing reads an authorized source and its payload once', async () => {
        const input = await fixture()
        const { result, calls } = await recordedRoute(input)
        assert.equal(result.task.sourceEventId, input.sourceEventId)
        assert.equal(calls.filter(sourceRead).length, 1)
      })
      await t.test('malformed snapshot results roll back the task, attempt and event writes', async () => {
        const one = { command: 'SELECT', rows: [] }
        for (const malformed of [one, [one], [one, one, one], [{ command: 'UPDATE', rows: [] }, one], [{ command: 'SELECT', rows: null }, one], [{ command: 'SELECT', rows: [null] }, one]]) {
          const input = await fixture()
          await assert.rejects(recordedRoute(input, (sql, result) => snapshotRead(sql) ? malformed : result), /Invalid Factory snapshot/)
          assert.equal((await pool.query('SELECT count(*)::int n FROM factory_tasks WHERE "issueId"=$1', [input.issueId])).rows[0].n, 0)
          assert.equal((await pool.query('SELECT count(*)::int n FROM factory_events WHERE "eventId"=$1', [input.eventId])).rows[0].n, 0)
        }
      })
      await t.test('null-Bot source remains row-locked until commit and a changed issue is freshly refused', async () => {
        const input = await fixture(), foreign = await fixture()
        const tx = await pool.connect(), writer = await pool.connect()
        try {
          await tx.query('BEGIN')
          await store.route('owner', input, tx)
          await writer.query('BEGIN')
          await writer.query("SET LOCAL lock_timeout='50ms'")
          await assert.rejects(writer.query('UPDATE coordinator_events SET "issueId"=$2 WHERE id=$1', [input.sourceEventId, foreign.issueId]), error => (error as { code?: string }).code === '55P03')
          await writer.query('ROLLBACK')
          await tx.query('ROLLBACK')
          await writer.query('UPDATE coordinator_events SET "issueId"=$2 WHERE id=$1', [input.sourceEventId, foreign.issueId])
          await denies(() => store.route('owner', input), 'factorySourceMismatch')
          assert.equal((await pool.query('SELECT count(*)::int n FROM factory_tasks WHERE "issueId"=$1', [input.issueId])).rows[0].n, 0)
        } finally {
          await Promise.all([tx.query('ROLLBACK').catch(() => {}), writer.query('ROLLBACK').catch(() => {})])
          tx.release(); writer.release()
        }
      })
      await t.test(
        "two-field mutation fence keeps owner checks, rejects stale revisions and replays legacy context",
        async () => {
          const changes = createFactoryStore(pool, authorize, null, {});
          const task = (await changes.route('owner', await fixture())).task;
          const minimal = { taskId: task.id, revision: task.revision };
          await denies(() => changes.apply('other', minimal, randomUUID(), { action: 'cancel', reason: 'foreign' }), 'factoryNotFound');
          await denies(() => changes.apply('owner', { ...minimal, revision: minimal.revision + 1 }, randomUUID(), { action: 'cancel', reason: 'stale' }), 'factoryStale');
          const eventId = randomUUID();
          const changed = await changes.apply('owner', minimal, eventId, { action: 'finish', status: 'blocked', reason: 'Waiting for external prerequisite', evidence: [], output: {} });
          assert.equal(changed.task.status, 'blocked');
          assert.equal(changed.task.revision, minimal.revision + 1);
          // Prior clients still send display/provenance fields. They cannot
          // alter the authorization fence or create a second mutation.
          assert.deepEqual(await changes.apply('owner', { ...minimal, issueId: randomUUID(), attemptId: randomUUID(), candidateId: randomUUID() }, eventId, { action: 'finish', status: 'blocked', reason: 'Waiting for external prerequisite', evidence: [], output: {} }), changed);
          await denies(() => changes.apply('owner', minimal, randomUUID(), { action: 'cancel', reason: 'stale' }), 'factoryStale');
          assert.equal((await pool.query('SELECT count(*)::int n FROM factory_events WHERE "taskId"=$1 AND "eventId"=$2', [task.id, eventId])).rows[0].n, 1);
        },
      );
      await t.test(
        "ten replays create one task and attempt; changed payload and wrong owner reject",
        async () => {
          const input = await fixture();
          const results = await Promise.all(
            Array.from({ length: 10 }, () => store.route("owner", input)),
          );
          assert.equal(new Set(results.map((r) => r.task.id)).size, 1);
          assert.equal(results[0].task.stage, "execute");
          assert.equal(results[0].task.status, "pending");
          assert.equal(results[0].attempts.length, 1);
          await denies(
            () => store.route("owner", { ...input, rationale: "changed" }),
            "factoryReplayMismatch",
          );
          await denies(
            () => store.read("other", results[0].task.id),
            "factoryNotFound",
          );
          const reconnected = new Pool({
            connectionString: fixtureURL,
            options: `-c search_path=${schema}`,
          });
          try {
            assert.deepEqual(
              await createFactoryStore(reconnected, authorize).read(
                "owner",
                results[0].task.id,
              ),
              await store.read("owner", results[0].task.id),
            );
          } finally {
            await reconnected.end();
          }
        },
      );
      await t.test(
        "peer events and another Bot chat cannot stand in for a user",
        async () => {
          const input = await fixture(),
            peer = await event("agent_message");
          await denies(
            () => store.route("owner", { ...input, sourceEventId: peer }),
            "factorySourceMismatch",
          );
          // A null Coordinator event is not a user event in another Bot chat, even with the same owner.
          await denies(
            () =>
              createFactoryStore(pool, authorize, randomUUID()).route(
                "owner",
                input,
              ),
            "factorySourceMismatch",
          );
        },
      );
      await t.test(
        "Bot routing survives restart without leaking to another chat after Bot deletion",
        async () => {
          const botId = randomUUID();
          await pool.query(
            `INSERT INTO bots(id,"workspaceId","ownerId",name) VALUES ($1,$2,'owner','Fixture Bot')`,
            [botId, workspaceId],
          );
          const input = {
            ...(await fixture()),
            sourceEventId: await event("user_message", botId),
          };
          const scoped = createFactoryStore(pool, authorize, botId),
            state = await scoped.route("owner", input);
          assert.equal(state.task.botId, botId);
          const listed = (await scoped.listForIssue("owner", input.issueId)).tasks;
          assert.equal(listed.length, 1);
          // BE-2: list carries candidate sha + latest publication summary.
          assert.ok("candidateSha" in listed[0] && "publication" in listed[0]);
          assert.equal(listed[0].publication, null);
          assert.equal(
            (await store.listForIssue("owner", input.issueId)).tasks.length,
            0,
          );
          await denies(
            () => store.read("owner", state.task.id),
            "factoryNotFound",
          );
          await pool.query("DELETE FROM bots WHERE id=$1", [botId]);
          await denies(
            () => scoped.read("owner", state.task.id),
            "factoryNotFound",
          );
          await denies(
            () => store.read("owner", state.task.id),
            "factoryNotFound",
          );
          await denies(() => store.route("owner", input), "factorySourceMismatch");
        },
      );
      await t.test(
        "only a subsequent human source resolves clarify; stale/replayed state is fenced",
        async () => {
          const input = await fixture(true),
            state = await store.route("owner", input);
          assert.equal(state.task.stage, "clarify");
          assert.equal(state.task.status, "waiting");
          const change = {
            action: "resolve" as const,
            sourceEventId: input.sourceEventId,
            rationale: "Answer recorded",
            missingInformation: [],
            missingPermissions: [],
            needsSpec: false,
          };
          await denies(
            () => store.apply("owner", bind(state.task), randomUUID(), change),
            "factorySourceMismatch",
          );
          await denies(
            () => store.apply("owner", bind(state.task), randomUUID(), {
              ...change, sourceEventId: input.sourceEventId.toUpperCase(),
            }),
            "factorySourceMismatch",
          );
          change.sourceEventId = await event();
          const eventId = randomUUID();
          const next = await store.apply(
            "owner",
            bind(state.task),
            eventId,
            change,
          );
          assert.equal(next.task.stage, "execute");
          assert.equal(next.attempts.length, 2);
          assert.equal(next.attempts[0].status, "passed");
          assert.notEqual(next.task.attemptId, state.task.attemptId);
          assert.deepEqual(
            await store.apply("owner", bind(state.task), eventId, change),
            next,
          );
          await denies(
            () =>
              store.apply("owner", bind(state.task), randomUUID(), {
                action: "cancel",
                reason: "stale",
              }),
            "factoryStale",
          );
        },
      );
      await t.test(
        "cancel/revoke prevent replay; consumer transitions fail closed",
        async () => {
          for (const action of ["cancel", "revoke"] as const) {
            const input = await fixture(),
              state = await store.route("owner", input);
            const stopped = await store.apply(
              "owner",
              bind(state.task),
              randomUUID(),
              { action, reason: "Stop" },
            );
            assert.equal(
              stopped.task.status,
              action === "cancel" ? "cancelled" : "revoked",
            );
            await denies(() => store.route("owner", input), "factoryStopped");
          }
          const state = await store.route("owner", await fixture());
          await denies(
            () =>
              store.apply("owner", bind(state.task), randomUUID(), {
                action: "advance",
                stage: "review",
                reason: "model claim",
              }),
            "factoryTransitionUnavailable",
          );
        },
      );
      await lifecycleCases(t,pool,authorize,fixture);
    } finally {
      await closeWorkspace();
      await pool.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  },
);
