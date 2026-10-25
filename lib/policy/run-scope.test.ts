import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { workerPolicyScope } from "./run-scope";
import { transaction } from "../audit/store";

const target = process.env.POLICY_APP_TEST_URL;
// The same real application schema and audit triggers used by Next.
test(
  "real PG worker scope validates continuation parents and rejects untrusted history",
  { skip: !target && process.env.REQUIRE_POLICY_DB !== "1" },
  async () => {
    const url = new URL(target ?? "");
    assert.ok(
      ["127.0.0.1", "localhost"].includes(url.hostname) &&
        url.pathname.endsWith("_e2e"),
    );
    const pool = new Pool({ connectionString: url.toString() });
    const owner = `scope_${randomUUID()}`,
      workspace = randomUUID(),
      other = randomUUID(),
      agent = randomUUID(),
      issue = randomUUID();
    try {
      await pool.query(
        `INSERT INTO agents(id,"userId",harness,name) VALUES($1,$2,'codex','Synthetic scope')`,
        [agent, owner],
      );
      await pool.query(
        `INSERT INTO issues(id,"userId",title,content,status,priority) VALUES($1,$2,'Synthetic scope','{"type":"doc","content":[]}','todo','normal')`,
        [issue, owner],
      );
      async function run(
        capture: string | undefined,
        parent?: string,
        question?: string,
      ) {
        const id = randomUUID();
        await transaction(pool, async (tx) => {
          if (capture)
            await tx.query(
              `SELECT set_config('mikka.audit_workspace',$1,true)`,
              [capture],
            );
          await tx.query(
            `INSERT INTO agent_runs(id,"userId","issueId","agentId",status,"continuesRunId","questionContinuation") VALUES($1,$2,$3,$4,'queued',$5,$6)`,
            [
              id,
              owner,
              issue,
              agent,
              parent ?? null,
              question ? { originRunId: question } : null,
            ],
          );
        });
        return id;
      }
      const root = await run(workspace),
        child = await run(workspace, root),
        question = await run(workspace, undefined, root);
      assert.deepEqual(await workerPolicyScope(pool, owner, child), {
        workspaceId: workspace,
        verified: true,
      });
      assert.deepEqual(await workerPolicyScope(pool, owner, question), {
        workspaceId: workspace,
        verified: true,
      });
      await assert.rejects(
        workerPolicyScope(pool, owner, child, other),
        /policyScopeMismatch/,
      );
      await assert.rejects(
        workerPolicyScope(pool, "other", child),
        /policyScopeUnverified/,
      );
      const historical = await run(undefined),
        historicalChild = await run(undefined, historical),
        historicalQuestion = await run(undefined, undefined, historical);
      assert.equal(
        (await workerPolicyScope(pool, owner, historical)).verified,
        false,
        "ordinary unmanaged new root remains compatible",
      );
      await assert.rejects(
        workerPolicyScope(pool, owner, historicalChild),
        /policyScopeUnverified/,
      );
      await assert.rejects(
        workerPolicyScope(pool, owner, historicalQuestion),
        /policyScopeUnverified/,
      );
      // Model a pre-audit row in synthetic data only; no production backfill.
      await pool.query(
        `DELETE FROM security_audit_resource_scopes WHERE source='agent_runs' AND resource=$1`,
        [historical],
      );
      await assert.rejects(
        workerPolicyScope(pool, owner, historical),
        /policyScopeUnverified/,
      );
      await assert.rejects(
        workerPolicyScope(pool, owner, historicalChild),
        /policyScopeUnverified/,
      );
    } finally {
      await pool.end();
    }
  },
);
