import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Pool } from "pg";
import { isE2eTarget, E2E_DB_RULE } from "./helpers/e2e-target.mjs";

const sql = (name) => readFile(new URL(`../drizzle/${name}`, import.meta.url), "utf8");

test("computer policy migration retires ask: rows become allow, deny stays, new rows default to allow", async () => {
  const target = new URL(process.env.E2E_DATABASE_URL ?? process.env.COMPUTER_TEST_DATABASE_URL);
  assert.ok(
    ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) &&
      (target.pathname === "/computer_test" || isE2eTarget(target.href)),
    E2E_DB_RULE,
  );
  const pool = new Pool({ connectionString: target.toString(), max: 1 });
  const client = await pool.connect();
  try {
    await client.query("begin");
    const schema = `computer_policy_${randomUUID().replaceAll("-", "")}`;
    await client.query(`create schema "${schema}"`);
    await client.query(`set local search_path to "${schema}"`);
    await client.query(await sql("20261027164515_workspace_computer_policy.sql"));
    await client.query(await sql("20261029010447_workspace_computer_policy_allow.sql"));
    const [materialized, adminAsk, allowed, denied] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await client.query(
      `insert into workspace_computer_policies ("workspaceId",permission,version) values
        ($1,'ask',0),($2,'ask',3),($3,'allow',1),($4,'deny',2)`,
      [materialized, adminAsk, allowed, denied],
    );
    const migration = await sql("20261030204751_workspace_computer_policy_default_allow.sql");
    await client.query(migration);
    await client.query(migration);
    const rows = await client.query(
      `select "workspaceId",permission,version from workspace_computer_policies order by version`,
    );
    assert.deepEqual(
      rows.rows.map((row) => [row.workspaceId, row.permission, row.version]),
      [
        [materialized, "allow", 0],
        [allowed, "allow", 1],
        [denied, "deny", 2],
        [adminAsk, "allow", 3],
      ],
      "every ask becomes allow, deny is untouched, versions are kept",
    );
    const fresh = randomUUID();
    await client.query(`insert into workspace_computer_policies ("workspaceId") values ($1)`, [fresh]);
    assert.equal(
      (await client.query(`select permission from workspace_computer_policies where "workspaceId"=$1`, [fresh])).rows[0].permission,
      "allow",
    );
    await client.query("savepoint retired");
    await assert.rejects(
      client.query(`update workspace_computer_policies set permission='ask' where "workspaceId"=$1`, [fresh]),
      { code: "23514" },
    );
    await client.query("rollback to savepoint retired");
  } finally {
    await client.query("rollback");
    client.release();
    await pool.end();
  }
});
