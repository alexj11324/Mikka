-- Exact #69 table DDL (commit-independent compatibility fixture).
create table if not exists conversation_reads (
  "userId" text not null,
  "conversationId" text not null,
  "lastReadPosition" integer not null default 0,
  "lastReadMessageId" text,
  "updatedAt" timestamptz not null default now(),
  constraint conversation_reads_pkey primary key ("userId", "conversationId")
);
