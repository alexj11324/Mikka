-- MIK-8: how far each person has read each conversation. Forward-only: the
-- read API only ever moves "lastReadPosition" up (greatest() in one upsert).
-- Mirrors conversationReads in lib/db/schema.ts.
-- Applied by scripts/migrate.mjs on production builds (one multi-statement
-- query, so no `create index concurrently` here).

create table if not exists conversation_reads (
  "userId" text not null,
  "conversationId" text not null,
  "lastReadPosition" integer not null default 0,
  "lastReadMessageId" text,
  "updatedAt" timestamptz not null default now(),
  constraint conversation_reads_pkey primary key ("userId", "conversationId")
);
