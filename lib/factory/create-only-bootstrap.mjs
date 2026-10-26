// Test-only fresh-schema bootstrap. Never used by production migrations.
// Exact reviewed source-set pin: changing/adding/removing any migration requires
// a new review. This is NOT a general SQL rewrite or an upgrade path.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { orderMigrations } from "../../scripts/migration-order.mjs";
import { executeMigration } from "../../scripts/search-migrations.mjs";
export const FACTORY_BOOTSTRAP_SOURCE_SHA256 =
  "59c10418065b1c4cbd553f6959981cdad563b26ea5680174e4c4743dee47761e";
// Exact pairs: omit obsolete definitions along with their later removal; keep
// final constraints/triggers. Empty-schema precondition makes backfills empty.
const replacements = [
  [
    "20261023143000_decision_calls.sql",
    '-- One row per call to the decision model (AI Gateway Decisions API), so the\n-- month\'s spend can be capped. Mirrors decisionCalls in lib/db/schema.ts.\n-- Applied by scripts/migrate.mjs on production builds.\n\ncreate table if not exists decision_calls (\n  id uuid primary key,\n  purpose text not null,\n  model text not null,\n  "inputTokens" integer not null default 0,\n  "costUsd" numeric(12, 8) not null,\n  "createdAt" timestamptz not null default now()\n);\n\ncreate index if not exists decision_calls_created_idx on decision_calls ("createdAt");\n',
    "-- Fresh-schema-only: obsolete object is never created.\n",
  ],
  [
    "20261023170500_drop_decision_calls.sql",
    "-- The decision model's spend is now capped by the Vercel budget on its own AI\n-- Gateway key (DECISION_GATEWAY_API_KEY), so the app no longer keeps a ledger.\n-- Applied by scripts/migrate.mjs on production builds.\n\ndrop table if exists decision_calls;\n",
    "-- Fresh-schema-only: obsolete object is never created.\n",
  ],
  ["0004_linear_sync.sql", ',\n  unique ("threadId", "messageId")', ""],
  [
    "0005_linear_sync_retry_and_comment_keys.sql",
    'alter table linear_comment_links drop constraint if exists "linear_comment_links_threadId_messageId_key";',
    "",
  ],
  [
    "0006_workspace_tables.sql",
    '  "userId" text not null unique,',
    '  "userId" text not null,',
  ],
  [
    "0014_workspace_teams.sql",
    "do $$\ndeclare owner_constraint record;\nbegin\n  for owner_constraint in\n    select c.conname from pg_constraint c\n    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]\n    where c.conrelid = 'mikka_workspaces'::regclass and c.contype = 'u'\n      and cardinality(c.conkey) = 1 and a.attname = 'userId'\n  loop\n    execute format('alter table mikka_workspaces drop constraint %I', owner_constraint.conname);\n  end loop;\nend $$;",
    "",
  ],
  [
    "0001_agents_devices.sql",
    'create table if not exists run_messages (\n  id uuid primary key,\n  "runId" uuid not null references agent_runs (id) on delete cascade,',
    'create table if not exists run_messages (\n  id uuid primary key,\n  "runId" uuid references agent_runs (id) on delete cascade,',
  ],
  [
    "20261025052031_session_mailboxes.sql",
    'ALTER TABLE run_messages ALTER COLUMN "runId" DROP NOT NULL;',
    "",
  ],
  [
    "20261025052031_session_mailboxes.sql",
    "kind text NOT NULL CHECK (kind IN ('run', 'coordinator', 'bot')),",
    "kind text NOT NULL,",
  ],
  [
    "20261025052033_group_review_mailboxes.sql",
    "ALTER TABLE session_mailboxes DROP CONSTRAINT IF EXISTS session_mailboxes_kind_check;",
    "",
  ],
  [
    "20261025052032_group_artifact_review.sql",
    ' UNIQUE ("conversationId",id), UNIQUE ("triggerMessageId","agentId"),',
    ' UNIQUE ("conversationId",id),',
  ],
  [
    "20261025082237_group_turn_mailbox_policy.sql",
    'ALTER TABLE conversation_work DROP CONSTRAINT IF EXISTS "conversation_work_triggerMessageId_agentId_key";',
    "",
  ],
  [
    "20261025052200_credential_broker.sql",
    "state text NOT NULL CHECK (state IN ('pending', 'submitting', 'ready', 'using', 'active_session', 'consumed', 'cancelled', 'expired', 'failed', 'disconnected')),",
    "state text NOT NULL,",
  ],
  [
    "20261025052202_credential_handoff.sql",
    "ALTER TABLE credential_requests DROP CONSTRAINT credential_requests_state_check;",
    "",
  ],
  [
    "0004_linear_sync.sql",
    "drop trigger if exists linear_issue_sync_outbox on issues;",
    "",
  ],
  [
    "0004_linear_sync.sql",
    "drop trigger if exists linear_document_sync_outbox on issue_documents;",
    "",
  ],
  [
    "20261025052032_group_artifact_review.sql",
    "DROP TRIGGER IF EXISTS artifact_versions_immutable ON artifact_versions;",
    "",
  ],
  [
    "20261025170000_security_audit_application.sql",
    "DROP TRIGGER IF EXISTS security_audit_immutable ON security_audit_events;",
    "",
  ],
  [
    "20261025170000_security_audit_application.sql",
    "CREATE TRIGGER security_audit_immutable BEFORE UPDATE OR DELETE ON security_audit_events FOR EACH ROW EXECUTE FUNCTION security_audit_guard();",
    "",
  ],
  [
    "20261025170000_security_audit_application.sql",
    "   EXECUTE format('DROP TRIGGER IF EXISTS security_audit_transition ON %I',t);",
    "",
  ],
  [
    "20261025170001_security_audit_workspace.sql",
    "DROP TRIGGER IF EXISTS security_audit_immutable ON security_audit_events;",
    "",
  ],
  [
    "20261025170001_security_audit_workspace.sql",
    "DROP TRIGGER IF EXISTS security_audit_membership ON mikka_workspace_members;",
    "",
  ],
  [
    "20261025170001_security_audit_workspace.sql",
    "DROP TRIGGER IF EXISTS security_audit_invitation ON mikka_workspace_invitations;",
    "",
  ],
];

export async function readFactoryBootstrapSources() {
  const directory = new URL("../../drizzle/", import.meta.url);
  const names = (await readdir(directory))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  return Promise.all(
    names.map(async (name) => ({
      name,
      content: await readFile(new URL(name, directory), "utf8"),
    })),
  );
}
export function compileFactoryBootstrap(files) {
  assert.ok(Array.isArray(files));
  const ordered = [...files];
  // Use code-point ordering, the same as filesystem manifest generation.
  ordered.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const pairs = ordered.map(({ name, content }) => {
    assert.equal(typeof name, "string");
    assert.equal(typeof content, "string");
    return [name, content];
  });
  assert.equal(
    createHash("sha256").update(JSON.stringify(pairs)).digest("hex"),
    FACTORY_BOOTSTRAP_SOURCE_SHA256,
    "Factory bootstrap source set changed; review required",
  );
  const sql = new Map(pairs);
  for (const [name, before, after] of replacements) {
    const content = sql.get(name);
    assert.equal(
      content.split(before).length,
      2,
      `Factory bootstrap exact conversion mismatch: ${name}`,
    );
    sql.set(name, content.replace(before, after));
  }
  for (const [name, content] of sql) {
    // Defense in depth only, NOT an SQL parser or rewrite. Trust comes from the
    // full source digest + finite exact replacements, including dynamic SQL.
    const uncommented = content.replace(/--[^\n]*/g, "");
    assert.ok(
      !/\bDROP\b|\bTRUNCATE\b|\bDELETE\s+FROM\b/i.test(uncommented),
      `Destructive bootstrap SQL: ${name}`,
    );
  }
  return orderMigrations([...sql.keys()]).map((name) =>
    Object.freeze({ name, sql: sql.get(name) }),
  );
}

export function validateFactoryBootstrapTarget(databaseUrl, schema) {
  assert.match(schema, /^factory_192_[a-f0-9]{32}$/);
  const url = new URL(databaseUrl);
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.search, "");
  assert.equal(url.hash, "");
  assert.ok(
    (url.pathname === "/mikka_e2e" &&
      ["5432", "55479"].includes(url.port || "5432")) ||
      (url.pathname === "/factory193" && url.port === "55493"),
    "Not an isolated Factory database profile",
  );
  return {
    database: url.pathname.slice(1),
    user: decodeURIComponent(url.username),
  };
}

// Dedicated connection only. Fresh namespace creation is exclusive: existing
// schemas (even empty ones) are rejected, never reused/cleaned. Failure preserves
// partial objects; a retry must reserve a new schema. No caller-provided SQL.
export async function bootstrapFactoryCreateOnly(
  pool,
  { databaseUrl, schema },
) {
  const target = validateFactoryBootstrapTarget(databaseUrl, schema);
  assert.equal(
    pool.options?.connectionString,
    databaseUrl,
    "Pool must use the checked target URL",
  );
  for (const key of [
    "host",
    "port",
    "database",
    "user",
    "password",
    "connection",
    "Client",
  ])
    assert.equal(
      pool.options[key],
      undefined,
      "Pool target overrides forbidden",
    );
  const plan = compileFactoryBootstrap(await readFactoryBootstrapSources());
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT current_database() AS database,current_user AS username,
   current_setting('server_version_num') AS version,pg_my_temp_schema()::text AS temp,
   EXISTS(SELECT 1 FROM pg_namespace WHERE nspname=$1) AS occupied,
   EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') AS event_triggers,
   EXISTS(SELECT 1 FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='pg_trgm' AND n.nspname='public') AS trgm`,
      [schema],
    );
    const targetRow = rows[0];
    assert.equal(rows.length, 1);
    assert.equal(targetRow.database, target.database);
    if (target.user) assert.equal(targetRow.username, target.user);
    assert.match(targetRow.version, /^17\d{4}$/);
    assert.equal(targetRow.temp, "0");
    assert.equal(
      targetRow.occupied,
      false,
      "Factory bootstrap requires a never-created schema",
    );
    assert.equal(
      targetRow.event_triggers,
      false,
      "Unknown database event trigger side effects",
    );
    assert.equal(
      targetRow.trgm,
      true,
      "Preinstalled public pg_trgm required; bootstrap does not install extensions",
    );
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query("SELECT set_config('search_path',$1,false)", [schema]);
    const active = (await client.query("SELECT current_schema() AS schema"))
      .rows;
    assert.equal(active.length, 1);
    assert.equal(active[0].schema, schema);
    for (const migration of plan)
      await executeMigration(client, migration.name, migration.sql);
    return {
      schema,
      sourceSha256: FACTORY_BOOTSTRAP_SOURCE_SHA256,
      migrations: plan.length,
      mode: "create-only",
      equivalence:
        "logical final schema candidate; full catalog comparison pending",
      effectsComplete: false,
    };
  } finally {
    // Destroy only this client connection, not database objects. No rollback/
    // cleanup SQL: successful schema objects and synthetic records are retained.
    client.release(true);
  }
}

// Fresh 68-migration catalog compared with a separately created, previously
// verified 67-migration reference plus unchanged main native_coordinator SQL
// (blob 6ccee6bcfa09942e716b78f3b25af891d8fc8424). The reference's pre-extension
// catalog still matched historical hash 5b2734e0...; that old evidence is retained.
// PG17 schema-only dumps normalize namespace/extension/pg_dump noise only.
// Ownership, privileges, migration ledger and data are not equivalence claims.
export const FACTORY_CREATEONLY_CATALOG_SHA256 = '1d81dd4f63f12a1c691c5cf67cfd7d5ff216dd343caede069d3d162712ab329e';
export function normalizeFactorySchemaDump(raw,schema) {
 assert.match(schema,/^factory_192_[a-f0-9]{32}$/);
 return raw.split('\n').filter(line=>!line.startsWith('--')&&!/^\\(?:un)?restrict /.test(line)&&line.trim()).map(line=>line.replaceAll('public.gin_trgm_ops','EXT.gin_trgm_ops').replace(new RegExp('\\b'+schema+'\\b','g'),'FIXTURE_SCHEMA')).join('\n')+'\n';
}
