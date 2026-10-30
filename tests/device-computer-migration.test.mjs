import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Pool } from "pg";
import { isE2eTarget, E2E_DB_RULE } from "./helpers/e2e-target.mjs";
test("local computer metadata migration preserves devices and reruns safely", async () => {
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
    const schema = `device_computer_${randomUUID().replaceAll("-", "")}`;
    await client.query(`create schema "${schema}"`);
    await client.query(`set local search_path to "${schema}"`);
    await client.query(
      "create table devices (id text primary key, name text not null)",
    );
    await client.query("insert into devices values ('existing','Untouched')");
    const sql = await readFile(
      new URL(
        "../drizzle/20261029010446_device_computer_capability.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await client.query(sql);
    await client.query(sql);
    assert.deepEqual((await client.query("select * from devices")).rows, [
      {
        id: "existing",
        name: "Untouched",
        computerUse: { installed: false, version: null },
      },
    ]);
    await client.query(
      `update devices set "computerUse"='{"installed":true,"version":"cua-driver 0.38.0"}'`,
    );
    await client.query(sql);
    assert.equal(
      (await client.query('select "computerUse" from devices')).rows[0]
        .computerUse.installed,
      true,
    );
  } finally {
    await client.query("rollback");
    client.release();
    await pool.end();
  }
});
