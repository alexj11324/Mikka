import { executePoolMigration } from "../../scripts/search-migrations.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { Pool } from "pg";
import { SessionMailbox } from "../session-mailbox";
import { orderMigrations } from "../../scripts/migration-order.mjs";

const target = process.env.AUDIT_APP_TEST_URL;
const enabled = Boolean(target) || process.env.REQUIRE_AUDIT_DB === "1";
test(
  "real PG: coordinated stop versus complete preserves audit and mailbox lock order",
  { skip: !enabled, timeout: 30000 },
  async () => {
    const url = new URL(target!);
    assert.equal(url.hostname, "127.0.0.1");
    assert.ok(url.pathname.endsWith("_e2e"));
    const schema = "audit_lock_" + randomUUID().replaceAll("-", ""),
      owner = "owner_" + randomUUID(),
      tenant = randomUUID(),
      marker = randomUUID().slice(0, 8);
    const admin = new Pool({ connectionString: url.href }),
      pool = new Pool({
        connectionString: url.href,
        options: `-c search_path=${schema}`,
      });
    const stopPool = new Pool({
      connectionString: url.href,
      options: `-c search_path=${schema}`,
      application_name: `audit_stop_${marker}`,
    });
    const completePool = new Pool({
      connectionString: url.href,
      options: `-c search_path=${schema}`,
      application_name: `audit_complete_${marker}`,
    });
    const gate = await admin.connect(),
      stopGate = Number.parseInt(marker.slice(0, 6), 16) + 100000,
      completeGate = stopGate + 1;
    const observations: unknown[] = [];
    const wait = async (check: () => Promise<boolean>) => {
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        if (await check()) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw Error("audit test barrier timeout");
    };
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      const dir = new URL("../../drizzle/", import.meta.url);
      for (const name of orderMigrations(
        (await readdir(dir)).filter((n) => n.endsWith(".sql")),
      ))
        await executePoolMigration(pool, name, await readFile(new URL(name, dir), "utf8"));
      const device = randomUUID(),
        agent = randomUUID(),
        a = randomUUID(),
        b = randomUUID(),
        boxA = randomUUID(),
        boxB = randomUUID(),
        coordinator = randomUUID();
      await pool.query(
        `INSERT INTO devices(id,"ownerId",name) VALUES($1,$2,'synthetic')`,
        [device, owner],
      );
      await pool.query(
        `INSERT INTO agents(id,"userId",name,harness,"deviceId") VALUES($1::uuid,$2,$1::text,'codex',$3)`,
        [agent, owner, device],
      );
      for (const id of [boxA, boxB])
        await pool.query(
          `INSERT INTO session_mailboxes(id,"userId","workspaceId",kind,"sessionKey",harness) VALUES($1::uuid,$2,'00000000-0000-4000-8000-000000000001','run',$1::text,'codex')`,
          [id, owner],
        );
      await pool.query(
        `INSERT INTO session_mailboxes(id,"userId","workspaceId",kind,"sessionKey") VALUES($1,$2,'00000000-0000-4000-8000-000000000001','coordinator','coordinator')`,
        [coordinator, owner],
      );
      const seed = await pool.connect();
      try {
        await seed.query("BEGIN");
        await seed.query("SELECT set_config('mikka.audit_workspace',$1,true)", [
          tenant,
        ]);
        for (const [id, box, status] of [
          [a, boxA, "queued"],
          [b, boxB, "running"],
        ])
          await seed.query(
            'INSERT INTO agent_runs(id,"userId","agentId","deviceId","mailboxId",status) VALUES($1,$2,$3,$4,$5,$6)',
            [id, owner, agent, device, box, status],
          );
        await seed.query("COMMIT");
      } finally {
        seed.release();
      }
      await pool.query(
        `CREATE FUNCTION audit_test_stop_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${a}' AND NEW."stopRequestedAt" IS DISTINCT FROM OLD."stopRequestedAt" THEN PERFORM pg_advisory_xact_lock(${stopGate}); END IF; RETURN NEW; END $$`,
      );
      await pool.query(
        "CREATE TRIGGER zz_audit_test_stop AFTER UPDATE ON agent_runs FOR EACH ROW EXECUTE FUNCTION audit_test_stop_barrier()",
      );
      await pool.query(
        `CREATE FUNCTION audit_test_complete_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${b}' AND NEW.status='stopped' THEN PERFORM pg_advisory_xact_lock(${completeGate}); END IF; RETURN NEW; END $$`,
      );
      await pool.query(
        "CREATE TRIGGER audit_test_complete BEFORE UPDATE ON agent_runs FOR EACH ROW EXECUTE FUNCTION audit_test_complete_barrier()",
      );
      await gate.query("SELECT pg_advisory_lock($1),pg_advisory_lock($2)", [
        stopGate,
        completeGate,
      ]);
      const gatePid = (await gate.query("SELECT pg_backend_pid() AS pid"))
        .rows[0].pid;
      const activity = async (name: string) =>
        (
          await admin.query(
            "SELECT pid,wait_event,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE application_name=$1",
            [name],
          )
        ).rows[0];
      const stop = new SessionMailbox(
          stopPool,
          "00000000-0000-4000-8000-000000000001",
        ),
        complete = new SessionMailbox(
          completePool,
          "00000000-0000-4000-8000-000000000001",
        );
      const stopped = stop.stop(owner, a).then(
        () => ({ ok: true, code: "" }),
        (e) => ({ ok: false, code: e.code ?? e.message }),
      );
      await wait(async () =>
        Boolean(
          (await activity(`audit_stop_${marker}`))?.blockers?.includes(gatePid),
        ),
      );
      const stopPid = (await activity(`audit_stop_${marker}`)).pid;
      const completed = complete
        .complete(owner, b, "stopped", "turn_ended", null)
        .then(
          () => ({ ok: true, code: "" }),
          (e) => ({ ok: false, code: e.code ?? e.message }),
        );
      await wait(async () => {
        const state = await activity(`audit_complete_${marker}`);
        return Boolean(
          state?.blockers?.includes(gatePid) ||
          state?.blockers?.includes(stopPid),
        );
      });
      const state = await activity(`audit_complete_${marker}`);
      observations.push({
        stage: "stop holds audit H at barrier; complete entered",
        stop: await activity(`audit_stop_${marker}`),
        complete: state,
      });
      await gate.query("SELECT pg_advisory_unlock($1)", [stopGate]);
      if (state.blockers.includes(gatePid))
        await wait(async () =>
          Boolean(
            (await activity(`audit_stop_${marker}`))?.blockers?.includes(
              state.pid,
            ),
          ),
        );
      await gate.query("SELECT pg_advisory_unlock($1)", [completeGate]);
      const result = await Promise.all([stopped, completed]);
      observations.push({ stage: "both barriers released", result });
      if (process.env.AUDIT_EXPECT_DEADLOCK === "1")
        assert.ok(
          result.some((r) => r.code === "40P01"),
          "baseline must reproduce actual PostgreSQL deadlock",
        );
      else
        assert.ok(
          result.every((r) => r.ok),
          JSON.stringify(result),
        );
      // Explicit retry of the aborted baseline transaction, without weakening audit persistence.
      if (!result[0].ok) await stop.stop(owner, a);
      if (!result[1].ok)
        await complete.complete(owner, b, "stopped", "turn_ended", null);
      const rows = (
        await pool.query(
          "SELECT id,status FROM agent_runs WHERE id=ANY($1::uuid[]) ORDER BY id",
          [[a, b]],
        )
      ).rows;
      assert.ok(rows.some((r) => r.id === a && r.status === "cancelled"));
      assert.ok(rows.some((r) => r.id === b && r.status === "stopped"));
      const receipt = {
        schema,
        tenant,
        owner,
        source: process.env.AUDIT_SOURCE_SHA ?? "working-tree",
        expectDeadlock: process.env.AUDIT_EXPECT_DEADLOCK === "1",
        observations,
        rows,
        utc: new Date().toISOString(),
      };
      if (process.env.AUDIT_LOCK_EVIDENCE)
        await writeFile(
          process.env.AUDIT_LOCK_EVIDENCE,
          JSON.stringify(receipt, null, 2),
        );
      console.log(JSON.stringify(receipt));
    } finally {
      await gate.query("SELECT pg_advisory_unlock_all()");
      gate.release();
      await Promise.all([
        pool.end(),
        stopPool.end(),
        completePool.end(),
        admin.end(),
      ]);
    }
  },
);
