import assert from "node:assert/strict";
import test from "node:test";
import { PgDialect } from "drizzle-orm/pg-core";
import type { QueryResult } from "pg";
import { policySqlClient } from "./sql-client";
test("transaction adapter binds repeated and reordered values without SQL interpolation", async () => {
  const dialect = new PgDialect(),
    malicious = "'; DROP TABLE issues; --";
  const client = policySqlClient(async (statement) => {
    const query = dialect.sqlToQuery(statement);
    assert.equal(query.sql, "SELECT $1::text, $2::text, $3::text");
    assert.deepEqual(query.params, ["second", malicious, malicious]);
    return {
      rows: [{ ok: true }],
      rowCount: 1,
      command: "SELECT",
      oid: 0,
      fields: [],
    } as QueryResult;
  });
  assert.equal(
    (
      await client.query("SELECT $2::text, $1::text, $1::text", [
        malicious,
        "second",
      ])
    ).rows[0].ok,
    true,
  );
  await assert.rejects(
    client.query("SELECT $2", [1]),
    /Policy parameter missing/,
  );
});
