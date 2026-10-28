import { lifecycleCases } from "./lifecycle.db-cases";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Pool } from "pg";
import { orderMigrations } from "../../scripts/migration-order.mjs";
import { createFactoryStore } from "./store";
import { FactoryError, type FactoryBinding } from "./contract";
const ci = process.env.CI === "true" && process.env.GITHUB_ACTIONS === "true";
const url =
  process.env.FACTORY_ROUTING_TEST_URL ??
  (ci ? process.env.E2E_DATABASE_URL : undefined);
if (ci) assert.ok(url, "CI must run actual isolated PostgreSQL, never skip");
if (url) {
  const u = new URL(url);
  assert.equal(u.hostname, "127.0.0.1");
  assert.equal(u.username, ci ? "e2e" : "factory192");
  assert.equal(u.pathname, "/mikka_e2e");
}
const denies = (fn: () => Promise<unknown>, code: string) =>
  assert.rejects(fn, (e) => e instanceof FactoryError && e.code === code);
test(
  "isolated PG: durable intake, Bot/source provenance, resolution, restart and stop fences",
  { skip: !url, timeout: 120000 },
  async (t) => {
    const admin = new Pool({ connectionString: url }),
      schema = "routing_" + randomUUID().replaceAll("-", "");
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = new Pool({
      connectionString: url,
      options: `-c search_path=${schema}`,
      max: 12,
    });
    try {
      const dir = new URL("../../drizzle/", import.meta.url);
      for (const f of orderMigrations(
        (await readdir(dir)).filter((f) => f.endsWith(".sql")),
      ))
        await pool.query(await readFile(new URL(f, dir), "utf8"));
      const migration = await readFile(
        new URL("20261028070000_factory_192_routing.sql", dir),
        "utf8",
      );
      await pool.query(migration);
      await pool.query(
        `INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ('owner','Fixture','route@example.invalid',true,now(),now()),('other','Other','other@example.invalid',true,now(),now())`,
      );
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
          `INSERT INTO issues(id,"userId",title,content,status,priority) VALUES ($1,'owner','Fixture','{}','todo','normal')`,
          [issueId],
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
            connectionString: url,
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
            [botId, randomUUID()],
          );
          const input = {
            ...(await fixture()),
            sourceEventId: await event("user_message", botId),
          };
          const scoped = createFactoryStore(pool, authorize, botId),
            state = await scoped.route("owner", input);
          assert.equal(state.task.botId, botId);
          assert.equal(
            (await scoped.listForIssue("owner", input.issueId)).tasks.length,
            1,
          );
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
      await pool.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  },
);
