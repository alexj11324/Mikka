-- target: MIKKA_DATABASE_URL
-- #438 A: streamed output masking. Per streamed part, the raw text held back because it could
-- be the start of a workspace secret, sealed (AES-256-GCM, WORKSPACE_SECRETS_KEY) so no partial
-- secret is ever stored in plaintext. Rows live only while a part is streaming. Mirrors
-- lib/db/secrets-schema.ts runMaskBuffers.
-- Rollback: drop table run_mask_buffers;
--           delete from schema_migrations where name = '20261030114000_run_mask_buffers.sql';

create table run_mask_buffers (
  "runId" uuid not null references agent_runs(id) on delete cascade,
  "partKey" text not null,
  ciphertext text not null,
  iv text not null,
  "keyVersion" integer not null,
  "updatedAt" timestamptz not null default now(),
  primary key ("runId", "partKey")
);
